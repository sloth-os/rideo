import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Clip, Job, SearchResponse, SearchStatus } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ff, makeStill, uploadReady } from '../helpers/media';
import { expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** Semantic media search (docs/design/search.md): the index, words and meaning, keeping up, agents. */
let words: Stack;
let semantic: Stack;
beforeAll(async () => {
  [words, semantic] = await Promise.all([
    startStack(),
    startStack({
      env: { RIDEO_EMBEDDINGS_PROXY_DOMAIN: 'embeddings-test', RIDEO_EMBEDDINGS_MODEL: 'mock-embed-v1' },
    }),
  ]);
}, 120_000);
afterAll(async () => {
  await words?.stop();
  await semantic?.stop();
});

const search = (stack: Stack, pid: string, q: string, kinds?: string) =>
  stack.api<SearchResponse>(
    'GET',
    `/projects/${pid}/search?q=${encodeURIComponent(q)}${kinds ? `&kinds=${kinds}` : ''}`,
  );
const status = (stack: Stack, pid: string) =>
  stack.api<SearchStatus>('GET', `/projects/${pid}/search/status`);
async function index(stack: Stack, pid: string) {
  const { job } = await stack.api<{ job: Job }>('POST', `/projects/${pid}/search/index`);
  return expectSucceeded(await stack.waitJob(pid, job.id, 120_000));
}
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(v).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** 8 s of footage: dark blue (night) for 4 s, then yellow (daylight). */
async function nightThenDay(dir: string): Promise<string> {
  const out = join(dir, 'night-day.mp4');
  await ff.run([
    '-f',
    'lavfi',
    '-i',
    'color=c=0x000060:size=320x180:rate=24:duration=4',
    '-f',
    'lavfi',
    '-i',
    'color=c=yellow:size=320x180:rate=24:duration=4',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1[v]',
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    out,
  ]);
  return out;
}

describe('media search', () => {
  it('indexes footage and stills, finds them by words, and keeps up with new uploads', async () => {
    const p = await words.api<{ id: string }>('POST', '/projects', { kind: 'edit', title: 'Harbour' });
    const footage = await uploadReady(words, p.id, await nightThenDay(words.dataDir), {
      mime: 'video/mp4',
      name: 'night-day.mp4',
    });
    const green = await uploadReady(words, p.id, await makeStill(words.dataDir, 'green.png', 'green'), {
      mime: 'image/png',
      name: 'green.png',
    });
    expect(await status(words, p.id)).toMatchObject({ mode: 'words', indexed: 0, pending: 3, job: null });
    expect(await search(words, p.id, 'yellow')).toMatchObject({ results: [], indexed: 0, pending: 3 });

    const calls = () => Object.values(words.gw.counters.proxyCalls).reduce((n, c) => n + c, 0);
    const before = calls();
    const job = await index(words, p.id);
    expect(job.result).toMatchObject({ captioned: 3, failed: 0, embedded: 0 });
    expect(calls() - before).toBe(3);
    expect(await status(words, p.id)).toMatchObject({ indexed: 3, pending: 0, files: 2, failed: 0 });

    // Each file's best frame: the yellow half of the footage, by words
    const day = await search(words, p.id, 'yellow daylight');
    expect(day.mode).toBe('words');
    expect(day.results[0]).toMatchObject({
      source: { kind: 'resource', resourceId: footage.id },
      at: 6,
      label: 'night-day.mp4',
      caption: expect.stringContaining('yellow scene in bright daylight'),
      score: 1,
    });
    const night = await search(words, p.id, 'night', 'resource');
    expect(night.results.map((r) => [r.source, r.at])).toEqual([
      [{ kind: 'resource', resourceId: footage.id }, 2],
    ]);
    expect((await search(words, p.id, 'green')).results[0]!.source).toEqual({
      kind: 'resource',
      resourceId: green.id,
    });
    // words do not know that crimson is red
    expect((await search(words, p.id, 'crimson')).results).toEqual([]);
    expect((await search(words, p.id, 'yellow', 'take')).results).toEqual([]);

    // Nothing new: nothing is asked again
    const again = calls();
    expect((await index(words, p.id)).result).toMatchObject({ captioned: 0, copied: 0 });
    expect(calls()).toBe(again);

    // The search is in use: a new upload is indexed on its own
    await uploadReady(words, p.id, await makeStill(words.dataDir, 'red.png', 'red'), {
      mime: 'image/png',
      name: 'red.png',
    });
    const after = await until(
      () => status(words, p.id),
      (s) => s.indexed === 4 && !s.job,
    );
    expect(after.pending).toBe(0);
    const red = await search(words, p.id, 'red');
    expect(red.results[0]).toMatchObject({ label: 'red.png', caption: expect.stringContaining('red scene') });

    const metrics = await (await fetch(`${words.url}/metrics`)).text();
    expect(metrics).toMatch(/rideo_search_frames_total\{outcome="captioned"\} 4/);
    expect(metrics).toMatch(/rideo_searches_total\{mode="words"\} \d+/);
  }, 180_000);

  it('searches takes and references by meaning, names first, and drops what leaves the project', async () => {
    const { projectId: pid, state } = await readyStoryProject(semantic, { storyboard: { enabled: false } });
    const plan = await semantic.api<Job>('POST', `/projects/${pid}/clips/plan`, {
      sceneId: state.docs.screenplay.scenes[0].id,
    });
    expectSucceeded(await semantic.waitJob(pid, plan.id));
    const clip = Object.values<Clip>(
      (await semantic.api<any>('GET', `/projects/${pid}/state`)).docs.clips,
    )[0]!;
    const gen = await semantic.api<Job>('POST', `/projects/${pid}/clips/${clip.id}/generate`);
    expectSucceeded(await semantic.waitJob(pid, gen.id, 180_000));
    await semantic.waitIdle(pid);
    await uploadReady(semantic, pid, await makeStill(semantic.dataDir, 'red.png', 'red'), {
      mime: 'image/png',
      name: 'red.png',
    });
    const s0 = await status(semantic, pid);
    expect(s0.mode).toBe('semantic');
    const job = await index(semantic, pid);
    expect(job.result).toMatchObject({ failed: 0, embedded: expect.any(Number) });
    expect((job.result as { embedded: number }).embedded).toBeGreaterThan(0);
    expect(semantic.gw.counters.proxyCalls['embeddings-test']).toBeGreaterThan(0);
    const s1 = await status(semantic, pid);
    expect(s1).toMatchObject({ indexed: s0.pending, pending: 0 });

    // By meaning: crimson is red
    const crimson = await search(semantic, pid, 'crimson');
    expect(crimson.mode).toBe('semantic');
    expect(crimson.results[0]).toMatchObject({ label: 'red.png' });

    // A character's name: the takes of shots with them come first, named
    const docs = (await semantic.api<any>('GET', `/projects/${pid}/state`)).docs;
    const shot = clip.shots.find((s) => s.characterIds.length)!;
    const name: string = docs.characters[shot.characterIds[0]!].name;
    const takes = await search(semantic, pid, `${name} at night`, 'take');
    expect(takes.results.length).toBeGreaterThan(0);
    expect(takes.results[0]!.names).toContain(name);
    expect(takes.results[0]!.source).toMatchObject({ kind: 'take', clipId: clip.id });
    expect(takes.results[0]!.label).toMatch(/^Clip 1 · shot \d+: /);
    const refs = await search(semantic, pid, name, 'reference');
    const character = Object.values<any>(docs.characters).find((c) => c.name === name);
    expect(refs.results[0]!.source).toMatchObject({ kind: 'reference', characterId: character.id });

    // An unapproved reference leaves the index on its own (the project's search is in use)
    await semantic.api('POST', `/projects/${pid}/characters/${character.id}/unlock`);
    await semantic.api(
      'PATCH',
      `/projects/${pid}/characters/${character.id}/references/${character.references[0].id}`,
      {
        approved: false,
      },
    );
    await until(
      () => status(semantic, pid),
      (s) => s.indexed === s1.indexed - 1 && !s.job,
    );
    expect((await search(semantic, pid, name, 'reference')).results.map((r) => r.source)).not.toContainEqual(
      expect.objectContaining({ characterId: character.id, referenceId: character.references[0].id }),
    );

    // Agents
    const client = new Client({ name: 'Claude Code', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${semantic.url}/mcp`)));
    try {
      const call = async (tool: string, args: Record<string, unknown>) => {
        const r = await client.callTool({ name: tool, arguments: args });
        return { error: !!r.isError, body: JSON.parse((r.content as { text: string }[])[0]!.text) };
      };
      const found = await call('media_search', { projectId: pid, query: 'scarlet', kinds: ['resource'] });
      expect(found.body).toMatchObject({ mode: 'semantic', results: [{ label: 'red.png' }] });
      expect((await call('search_status', { projectId: pid })).body).toMatchObject({
        mode: 'semantic',
        pending: 0,
      });
      const started = await call('search_index', { projectId: pid });
      expect(started.body).toMatchObject({ kind: 'search.index' });
      expectSucceeded(await semantic.waitJob(pid, started.body.id));
    } finally {
      await client.close();
    }
  }, 300_000);
});
