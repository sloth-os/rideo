import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BUNDLE_MANIFEST,
  type Job,
  type ProjectSummary,
  parseProbe,
  parseTarHeader,
  posterCommand,
  probeCommand,
  type Resource,
  TAR_BLOCK,
  tarPadding,
} from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFootage } from '../helpers/media';
import { ApiError, expectSucceeded, type Stack, startStack } from '../helpers/stack';
import { attachWorkspace, WorkspaceApiError, type WorkspaceClient } from '../helpers/workspace-client';

/** Projects kept in browsers (docs/design/browser-storage.md), served through a stand-in tab. */
let stack: Stack;
let a: WorkspaceClient;
let b: WorkspaceClient | undefined;
beforeAll(async () => {
  stack = await startStack({ env: { RIDEO_STORAGE: 'browser' } });
});
afterAll(async () => {
  await a?.close();
  await b?.close();
  await stack?.stop();
});

async function failure(p: Promise<unknown>): Promise<{ status: number; body: any }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError || err instanceof WorkspaceApiError)
      return { status: err.status, body: err.body };
    throw err;
  }
  throw new Error('expected the request to fail');
}

/** The entries of a tar archive. */
function untar(buf: Buffer): { name: string; data: Buffer }[] {
  const out: { name: string; data: Buffer }[] = [];
  let at = 0;
  for (;;) {
    const h = parseTarHeader(buf.subarray(at, at + TAR_BLOCK));
    if (!h) return out;
    out.push({ name: h.name, data: buf.subarray(at + TAR_BLOCK, at + TAR_BLOCK + h.size) });
    at += TAR_BLOCK + h.size + tarPadding(h.size);
  }
}

let projectId: string;
let resource: Resource;

describe('browser storage (docs/design/browser-storage.md)', () => {
  it('keeps nothing on the server and creates projects in the browser that asks', async () => {
    expect((await stack.api<any>('GET', '/config')).features.storage).toBe('browser');
    expect((await stack.api<any>('GET', '/ready')).checks.storage).toMatchObject({
      ok: true,
      detail: 'browser',
    });
    // no browser connected: nothing to list, nowhere to keep a new project
    expect(await stack.api('GET', '/projects')).toEqual([]);
    const offline = await failure(stack.api('POST', '/projects', { kind: 'edit', title: 'Nowhere' }));
    expect(offline.status).toBe(503);
    expect(offline.body.code).toBe('storage_offline');

    a = await attachWorkspace(stack);
    const p = await a.api<{ id: string }>('POST', '/projects', { kind: 'edit', title: 'In the browser' });
    projectId = p.id;
    expect(await a.backend.stat(`/projects/${p.id}/.rideo/HEAD`)).not.toBeNull();
    expect(await a.backend.read(`/projects/${p.id}/project.json`)).not.toBeNull();
    expect(existsSync(join(stack.dataDir, 'dav', 'rideo', 'projects', p.id))).toBe(false);
    const state = await a.api<any>('GET', `/projects/${p.id}/state`);
    expect(state.docs.project.title).toBe('In the browser');
  });

  it('lists a browser’s projects to that browser, and every attached browser’s to agents', async () => {
    b = await attachWorkspace(stack);
    const ids = (list: ProjectSummary[]) => list.map((p) => p.id);
    expect(ids(await a.api('GET', '/projects'))).toEqual([projectId]);
    expect(ids(await b.api('GET', '/projects'))).toEqual([]);
    expect(ids(await stack.api('GET', '/projects'))).toEqual([projectId]);
    // the id is taken: a browser importing it by itself must make a copy
    expect(await b.api('GET', `/workspace/projects/${projectId}`)).toEqual({ elsewhere: true });
    expect(await a.api('GET', `/workspace/projects/${projectId}`)).toEqual({ elsewhere: false });
  });

  it('moves media to and from the browser, large payloads over transfers, with ranges', async () => {
    const file = await makeFootage(stack.dataDir);
    const ffmpeg = (args: string[]) => spawnSync('ffmpeg', ['-y', ...args], { encoding: 'utf8' });
    const probe = parseProbe(ffmpeg(probeCommand(file)).stderr)!;
    const poster = join(stack.dataDir, 'poster.jpg');
    expect(ffmpeg(posterCommand(file, poster, probe)).status).toBe(0);
    const bytes = await readFile(file);
    expect(bytes.length).toBeGreaterThan(256 * 1024);
    const form = new FormData();
    form.set('meta', JSON.stringify({ probe, role: 'source' }));
    form.set('file', new Blob([bytes], { type: 'video/mp4' }), 'clip.mp4');
    form.set('poster', new Blob([await readFile(poster)], { type: 'image/jpeg' }), 'poster.jpg');
    resource = await a.api<Resource>('POST', `/projects/${projectId}/uploads`, form);
    expect(resource.status).toBe('ready');
    const stored = await a.backend.read(`/projects/${projectId}/${resource.media!.path}`);
    expect(stored?.equals(bytes)).toBe(true);
    // the media route reads from the browser: a small range inline, the whole file over a transfer
    const url = `${stack.url}/api/projects/${projectId}/media/${resource.media!.path}?ws=${a.id}`;
    const part = await fetch(url, { headers: { range: 'bytes=100-199' } });
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(100, 200))).toBe(true);
    const whole = await fetch(url);
    expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);
    expect(a.ops.read).toBeGreaterThan(0);
  });

  it('runs jobs on a browser project and keeps their records in the browser', async () => {
    const story = await a.api<{ id: string }>('POST', '/projects', {
      kind: 'story',
      title: 'Generated in a browser',
      brief: { prompt: 'A lighthouse keeper' },
      settings: { targetDurationSec: 30, pilotDurationSec: 10 },
    });
    const job = await a.api<Job>('POST', `/projects/${story.id}/screenplay/generate`, {});
    const deadline = Date.now() + 60_000;
    let done = job;
    while (Date.now() < deadline && !['succeeded', 'failed'].includes(done.status)) {
      await new Promise((r) => setTimeout(r, 150));
      done = await a.api<Job>('GET', `/projects/${story.id}/jobs/${job.id}`);
    }
    expectSucceeded(done);
    expect(await a.backend.stat(`/projects/${story.id}/.rideo/jobs/${job.id}.json`)).not.toBeNull();
    const state = await a.api<any>('GET', `/projects/${story.id}/state`);
    expect(state.docs.screenplay.scenes.length).toBeGreaterThan(0);
  }, 90_000);

  it('serves the project again after a server restart, once the tab reconnects', async () => {
    const back = a.ready();
    await stack.restart();
    expect(await back).toBeGreaterThanOrEqual(2);
    const state = await a.api<any>('GET', `/projects/${projectId}/state`);
    expect(state.docs.resources[resource.id].status).toBe('ready');
  }, 60_000);

  it('exports a project file and imports it into another browser as a copy', async () => {
    const tar = await a.api<Buffer>('GET', `/projects/${projectId}/export`);
    const entries = untar(tar);
    expect(entries[0]!.name).toBe(BUNDLE_MANIFEST);
    const manifest = JSON.parse(entries[0]!.data.toString());
    expect(manifest).toMatchObject({
      format: 'rideo-project',
      version: 1,
      projectId,
      title: 'In the browser',
    });
    const names = entries.map((e) => e.name);
    expect(names).toContain('project/.rideo/HEAD');
    expect(names).toContain(`project/${resource.media!.path}`);
    expect(names.some((n) => n.startsWith('project/.rideo/jobs/'))).toBe(false);
    expect(manifest.files).toBe(entries.length - 1);

    // the server knows this id in browser A: B gets a copy (a new id, the history rewritten)
    const taken = await failure(b!.api('POST', '/projects/import', new Uint8Array(tar)));
    expect(taken.status).toBe(409);
    const copy = await b!.api<any>('POST', '/projects/import?mode=copy', new Uint8Array(tar));
    expect(copy).toMatchObject({ mode: 'copy', title: 'In the browser (copy)', kind: 'edit' });
    expect(copy.id).not.toBe(projectId);
    expect(await b!.backend.stat(`/projects/${copy.id}/.rideo/HEAD`)).not.toBeNull();
    expect(await a.backend.stat(`/projects/${copy.id}`)).toBeNull();
    const state = await b!.api<any>('GET', `/projects/${copy.id}/state`);
    expect(state.docs.project.id).toBe(copy.id);
    expect(state.docs.resources[resource.id].media.path).toBe(resource.media!.path);
    // every commit of the copied history names the new id
    const history = await b!.api<any[]>('GET', `/projects/${copy.id}/history`);
    expect(history.length).toBeGreaterThanOrEqual(3);
    const first = history[history.length - 1];
    const doc = await b!.api<any>('GET', `/projects/${copy.id}/docs/project.json?at=${first.id}`);
    expect(doc.id).toBe(copy.id);
    const media = await fetch(
      `${stack.url}/api/projects/${copy.id}/media/${resource.media!.path}?ws=${b!.id}`,
    );
    expect(media.status).toBe(200);
    expect(Buffer.from(await media.arrayBuffer()).length).toBe(resource.media!.size);
  }, 60_000);

  it('moves a deleted project to the browser’s trash', async () => {
    const p = await a.api<{ id: string }>('POST', '/projects', { kind: 'edit', title: 'Short-lived' });
    await a.api('DELETE', `/projects/${p.id}`);
    expect(await a.backend.stat(`/projects/${p.id}`)).toBeNull();
    expect((await a.backend.list('/trash')).some((e) => e.name.startsWith(`${p.id}-`))).toBe(true);
    expect((await a.api<ProjectSummary[]>('GET', '/projects')).map((x) => x.id)).not.toContain(p.id);
  });

  it('says the browser is not connected when its last tab closes', async () => {
    await a.close();
    const started = Date.now();
    const offline = await failure(stack.api('GET', `/projects/${projectId}/state`));
    expect(offline.status).toBe(503);
    expect(offline.body.code).toBe('storage_offline');
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_000);
  }, 30_000);
});
