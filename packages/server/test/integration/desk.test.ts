import { createHash } from 'node:crypto';
import { readdirSync, readlinkSync } from 'node:fs';
import { request } from 'node:http';
import { dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  type Clip,
  type CommitSummary,
  DESK_STATE_MAX_BYTES,
  DeskBriefSchema,
  docPath,
  SYSTEM_ACTOR,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DESK_UNIT_MAGIC } from '../../src/domain/library-files';
import { ApiError, type Stack, startStack } from '../helpers/stack';
import { attachWorkspace, type WorkspaceClient } from '../helpers/workspace-client';

/**
 * The 3D-Editor's director's desk on the server (docs/design/director-desk.md#surfaces): the brief over REST and MCP,
 * the desk state's routes, its limits, its commits and the metrics, on the built-in WebDAV server and in a browser.
 */
let stack: Stack;
let browser: Stack;
let tab: WorkspaceClient;
let client: Client;
beforeAll(async () => {
  stack = await startStack();
  browser = await startStack({ env: { RIDEO_STORAGE: 'browser' } });
  tab = await attachWorkspace(browser);
  client = new Client({ name: 'Desk agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${stack.url}/mcp`)));
}, 60_000);
afterAll(async () => {
  await client?.close();
  await tab?.close();
  await browser?.stop();
  await stack?.stop();
});

const FORMAT = { 'x-desk-state-format': '3d-editor.desk-state', 'x-desk-state-version': '1' };
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytes = (text: string) => new TextEncoder().encode(text);

/** A story project with a planned clip and one without shots, written as documents (no model needed). */
async function seeded(on: Stack, call: Stack['api'] = on.api) {
  const p = await call<{ id: string }>('POST', '/projects', { kind: 'story', title: 'The desk' });
  const mira = f.character({ name: 'Mira', identity: { ...f.character().identity, height: '1.6 m' } });
  const room = f.element({ name: 'Lamp room', description: 'Brass lantern room.' });
  const shot = f.shot({
    index: 0,
    durationSec: 3,
    characterIds: [mira.id],
    elementIds: [room.id],
    layout: [{ characterId: mira.id, side: 'left', facing: 'right' }],
  });
  const clip = f.clip({ index: 0, title: 'INT. LAMP ROOM - NIGHT', shots: [shot] });
  const empty = f.clip({ index: 1, title: 'Not planned' });
  const h = await on.server.studio.deps.projects.existing(p.id);
  await h.repo.transact(
    (tx) => {
      tx.set(docPath.character(mira.id), mira);
      tx.set(docPath.element(room.id), room);
      tx.set(docPath.clip(clip.id), clip);
      tx.set(docPath.clip(empty.id), empty);
    },
    { actor: SYSTEM_ACTOR, message: 'Seed the desk test' },
  );
  return { pid: p.id, clip, empty, shot, mira, room };
}

function deskUrl(on: Stack, pid: string, clipId: string) {
  return `${on.url}/api/projects/${pid}/clips/${clipId}/desk-state`;
}

function put(
  on: Stack,
  pid: string,
  clipId: string,
  body: NonNullable<RequestInit['body']>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(deskUrl(on, pid, clipId), {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', ...FORMAT, ...headers },
    body,
    duplex: 'half',
  } as RequestInit);
}

async function rejects(p: Promise<unknown>, code: string, status?: number) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).body.code).toBe(code);
    if (status) expect((err as ApiError).status).toBe(status);
    return;
  }
  throw new Error(`expected ${code}`);
}

/**
 * The clip names no state: `204` with no body, no `ETag` and no state headers, never cached
 * (docs/design/director-desk.md#the-routes). Not a `404`, which a browser logs as an error: that is for a project or a
 * clip that is not there.
 */
async function noState(on: Stack, pid: string, clipId: string, headers: Record<string, string> = {}) {
  const res = await fetch(deskUrl(on, pid, clipId), { headers });
  expect(res.status).toBe(204);
  expect(res.headers.get('etag')).toBeNull();
  expect(res.headers.get('x-desk-state-format')).toBeNull();
  expect(res.headers.get('x-desk-state-version')).toBeNull();
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(await res.text()).toBe('');
}

async function metric(name: string, labels = ''): Promise<number> {
  const text = await (await fetch(`${stack.url}/metrics`)).text();
  const line = text.split('\n').find((l) => l.startsWith(`${name}${labels} `));
  return line ? Number(line.split(' ').at(-1)) : 0;
}

const deskCommits = async (pid: string, clipId: string) =>
  (await stack.api<CommitSummary[]>('GET', `/projects/${pid}/history?path=clips/${clipId}.json`)).filter(
    (c) => c.message.includes('desk of scene'),
  );

describe('the brief (desk-brief and desk_brief)', () => {
  it('serves the same brief over REST and MCP, and counts it', async () => {
    const { pid, clip, empty, shot, mira, room } = await seeded(stack);
    const before = await metric('rideo_desk_briefs_total');
    const brief = await stack.api<any>('GET', `/projects/${pid}/clips/${clip.id}/desk-brief`);
    expect(DeskBriefSchema.safeParse(brief).success).toBe(true);
    expect(brief).toMatchObject({
      id: clip.id,
      name: 'INT. LAMP ROOM - NIGHT',
      fps: 24,
      width: 1280,
      height: 720,
    });
    expect(brief.cast).toEqual([expect.objectContaining({ id: mira.id, heightM: 1.6, kind: null })]);
    expect(brief.elements).toEqual([expect.objectContaining({ id: room.id, kind: 'location' })]);
    expect(brief.shots).toEqual([
      expect.objectContaining({
        id: shot.id,
        index: 0,
        castIds: [mira.id],
        layout: [{ castId: mira.id, side: 'left', facing: 'right' }],
      }),
    ]);
    const r = await client.callTool({ name: 'desk_brief', arguments: { projectId: pid, clipId: clip.id } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toEqual(brief);
    expect(await metric('rideo_desk_briefs_total')).toBe(before + 2);
    // a clip without shots has none; an unknown clip is not found, over both surfaces
    await rejects(stack.api('GET', `/projects/${pid}/clips/${empty.id}/desk-brief`), 'validation_error', 422);
    await rejects(
      stack.api('GET', `/projects/${pid}/clips/clp_0000000000000none/desk-brief`),
      'not_found',
      404,
    );
    const missing = await client.callTool({
      name: 'desk_brief',
      arguments: { projectId: pid, clipId: empty.id },
    });
    expect(missing.isError).toBe(true);
    expect(JSON.parse((missing.content as { text: string }[])[0]!.text)).toMatchObject({
      code: 'validation_error',
      message: 'plan the shots of clip 2 first',
    });
  });
});

describe('the desk state (docs/design/director-desk.md#the-routes)', () => {
  it('stores the bytes as a media file the clip names, gives them back, and changes nothing for the same bytes', async () => {
    const { pid, clip } = await seeded(stack);
    await noState(stack, pid, clip.id);
    const saved = await metric('rideo_desk_state_saves_total', '{outcome="saved"}');
    const unchanged = await metric('rideo_desk_state_saves_total', '{outcome="unchanged"}');

    const one = bytes('\u0000opaque desk state bytes\u0001');
    const res = await put(stack, pid, clip.id, one);
    expect(res.status).toBe(200);
    const { deskState } = (await res.json()) as { deskState: NonNullable<Clip['deskState']> };
    expect(deskState).toMatchObject({ format: '3d-editor.desk-state', version: 1 });
    expect(deskState.media).toMatchObject({
      hash: sha(one),
      size: one.length,
      mime: 'application/octet-stream',
    });
    expect(deskState.media.path).toBe(`media/desk/int-lamp-room-night-${sha(one).slice(0, 12)}.bin`);
    const state = await stack.api<any>('GET', `/projects/${pid}/state`);
    expect(state.docs.clips[clip.id].deskState).toEqual(deskState);
    expect((await deskCommits(pid, clip.id)).map((c) => c.message)).toEqual(['Save the desk of scene 1']);

    const got = await fetch(deskUrl(stack, pid, clip.id));
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('application/octet-stream');
    expect(got.headers.get('x-desk-state-format')).toBe('3d-editor.desk-state');
    expect(got.headers.get('x-desk-state-version')).toBe('1');
    expect(got.headers.get('etag')).toBe(`"${sha(one)}"`);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(one);

    // the same bytes again: the stored state, no new file, no commit
    const head = state.head.commit;
    const again = await put(stack, pid, clip.id, one);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { deskState: unknown }).deskState).toEqual(deskState);
    expect((await stack.api<any>('GET', `/projects/${pid}/state`)).head.commit).toBe(head);
    expect(await metric('rideo_desk_state_saves_total', '{outcome="saved"}')).toBe(saved + 1);
    expect(await metric('rideo_desk_state_saves_total', '{outcome="unchanged"}')).toBe(unchanged + 1);

    // DELETE: the clip names no state (the file stays); a second DELETE changes nothing
    const del = await fetch(deskUrl(stack, pid, clip.id), { method: 'DELETE' });
    expect(del.status).toBe(204);
    await noState(stack, pid, clip.id);
    const after = (await stack.api<any>('GET', `/projects/${pid}/state`)).head.commit;
    expect((await fetch(deskUrl(stack, pid, clip.id), { method: 'DELETE' })).status).toBe(204);
    expect((await stack.api<any>('GET', `/projects/${pid}/state`)).head.commit).toBe(after);
    expect((await fetch(`${stack.url}/api/projects/${pid}/media/${deskState.media.path}`)).status).toBe(200);
  });

  it('makes a commit per state, coalesced per clip and author, and a restored clip has its state again', async () => {
    const { pid, clip, shot } = await seeded(stack);
    const one = bytes('first staging');
    const two = bytes('second staging');
    const three = bytes('third staging');
    expect((await put(stack, pid, clip.id, one)).status).toBe(200);
    const first = (await deskCommits(pid, clip.id))[0]!;
    // another change in between: the next state is a commit of its own
    await stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}`, {
      description: 'Mira waits.',
    });
    expect((await put(stack, pid, clip.id, two)).status).toBe(200);
    // a state right after it, by the same author: the commit is amended (like typing)
    expect((await put(stack, pid, clip.id, three)).status).toBe(200);
    const commits = await deskCommits(pid, clip.id);
    expect(commits.map((c) => c.message)).toEqual(['Save the desk of scene 1', 'Save the desk of scene 1']);
    const current = await (await fetch(deskUrl(stack, pid, clip.id))).arrayBuffer();
    expect(new Uint8Array(current)).toEqual(three);
    // restored to the first state's commit, the clip names the first state's file
    await stack.api('POST', `/projects/${pid}/history/restore`, {
      commit: first.id,
      paths: [`clips/${clip.id}.json`],
    });
    const restored = await (await fetch(deskUrl(stack, pid, clip.id))).arrayBuffer();
    expect(new Uint8Array(restored)).toEqual(one);
  });

  it('refuses states over 64 MiB, by their length or as they arrive, and others than the desk format', async () => {
    const { pid, clip } = await seeded(stack);
    const refused = await metric('rideo_desk_state_saves_total', '{outcome="refused"}');
    const logged = vi.spyOn(stack.server.studio.deps.log, 'info');
    const problem = async (res: Response) => ({ status: res.status, code: ((await res.json()) as any).code });

    // the declared length
    const big = new Uint8Array(DESK_STATE_MAX_BYTES + 1);
    expect(await problem(await put(stack, pid, clip.id, big))).toEqual({
      status: 413,
      code: 'validation_error',
    });
    // counted as it arrives (no Content-Length): 65 chunks of 1 MiB
    let sent = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 65) return c.close();
        sent++;
        c.enqueue(chunk);
      },
    });
    expect(await problem(await put(stack, pid, clip.id, stream))).toEqual({
      status: 413,
      code: 'validation_error',
    });
    // a stream within the limit is stored
    const small = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes('streamed '));
        c.enqueue(bytes('state'));
        c.close();
      },
    });
    expect((await put(stack, pid, clip.id, small)).status).toBe(200);

    // the format and version headers, and the body's type: every other type is refused, its body never parsed
    // (malformed or empty JSON is no 400), counted and logged
    const body = bytes('x');
    const variants: [Record<string, string>, NonNullable<RequestInit['body']>][] = [
      [{ 'x-desk-state-format': '' }, body],
      [{ 'x-desk-state-version': '' }, body],
      [{ 'x-desk-state-format': 'yjs' }, body],
      [{ 'x-desk-state-version': '2' }, body],
      [{ 'content-type': 'application/json' }, '"x"'],
      [{ 'content-type': 'application/json' }, '{"malformed": '],
      [{ 'content-type': 'application/json' }, ''],
      [{ 'content-type': 'text/plain' }, 'a state as text'],
      [{ 'content-type': 'image/png' }, body],
    ];
    for (const [headers, sent] of variants) {
      const res = await put(stack, pid, clip.id, sent, headers);
      expect(await problem(res), JSON.stringify(headers)).toEqual({ status: 422, code: 'validation_error' });
    }
    // a JSON body that declares 70 MiB is answered at once, before it arrives, with the same 422
    const declared = await new Promise<{ status: number; code: string }>((resolve, reject) => {
      const req = request(
        deskUrl(stack, pid, clip.id),
        {
          method: 'PUT',
          headers: {
            ...FORMAT,
            'content-type': 'application/json',
            'content-length': String(70 * 1024 * 1024),
          },
        },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => {
            req.destroy();
            resolve({ status: res.statusCode ?? 0, code: (JSON.parse(text) as { code: string }).code });
          });
        },
      );
      req.on('error', (err) => (err.message.includes('socket hang up') ? undefined : reject(err)));
      req.write('{"state": "');
    });
    expect(declared).toEqual({ status: 422, code: 'validation_error' });
    expect(await metric('rideo_desk_state_saves_total', '{outcome="refused"}')).toBe(refused + 12);
    const refusals = logged.mock.calls.filter((c) => c[1] === 'desk state refused');
    expect(refusals.map((c) => (c[0] as { reason: string }).reason)).toEqual([
      'size',
      'size',
      'headers',
      'headers',
      'format',
      'format',
      'content-type',
      'content-type',
      'content-type',
      'content-type',
      'content-type',
      'content-type',
    ]);
    logged.mockRestore();
    // an unknown clip
    expect((await put(stack, pid, 'clp_0000000000000none', body)).status).toBe(404);
    // the stored state is the streamed one
    expect(new TextDecoder().decode(await (await fetch(deskUrl(stack, pid, clip.id))).arrayBuffer())).toBe(
      'streamed state',
    );
  });

  it('answers 204 when the clip names no state, 404 for a project or clip that is not there, and a retryable 503 when its file cannot be read', async () => {
    const { pid, clip } = await seeded(stack);
    await noState(stack, pid, clip.id);
    // not there: the project, the clip
    await rejects(
      stack.api('GET', `/projects/prj_0000000000nothere/clips/${clip.id}/desk-state`),
      'not_found',
      404,
    );
    await rejects(
      stack.api('GET', `/projects/${pid}/clips/clp_0000000000000none/desk-state`),
      'not_found',
      404,
    );
    // the clip names a state whose file is gone from storage (a restore from a copy without media, say)
    const h = await stack.server.studio.deps.projects.existing(pid);
    await h.repo.transact(
      (tx) => {
        const current = structuredClone(tx.require<Clip>(docPath.clip(clip.id), clip.id));
        current.deskState = {
          format: '3d-editor.desk-state',
          version: 1,
          media: f.media({
            path: 'media/desk/gone-000000000000.bin',
            hash: '0'.repeat(64),
            mime: 'application/octet-stream',
            size: 12,
          }),
          updatedAt: new Date().toISOString(),
        };
        tx.set(docPath.clip(clip.id), current);
      },
      { actor: SYSTEM_ACTOR, message: 'Name a state whose file is gone' },
    );
    await rejects(stack.api('GET', `/projects/${pid}/clips/${clip.id}/desk-state`), 'storage_error', 503);
    // a file that is gone for good: DELETE clears the state (the panel's Start over), and the next open has none
    expect((await fetch(deskUrl(stack, pid, clip.id), { method: 'DELETE' })).status).toBe(204);
    await noState(stack, pid, clip.id);
    // a new state, stored where none is
    expect(
      (await put(stack, pid, clip.id, bytes('a state that is there'), { 'if-none-match': '*' })).status,
    ).toBe(200);
    expect(new TextDecoder().decode(await (await fetch(deskUrl(stack, pid, clip.id))).arrayBuffer())).toBe(
      'a state that is there',
    );
  });

  it('commits a Replace on its own: the history keeps the state it replaced, even by the same author a moment ago', async () => {
    const { pid, clip, shot } = await seeded(stack);
    const a = bytes('panel A loaded this');
    const b = bytes('session B, newer');
    const edits = bytes('panel A edits');
    const later = bytes('panel A edits, later');
    expect((await put(stack, pid, clip.id, a, { 'if-none-match': '*' })).status).toBe(200);
    // another change in between: the next state is a commit of its own
    await stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}`, {
      description: 'Mira waits.',
    });
    // the same person's other session stores B over A
    expect((await put(stack, pid, clip.id, b, { 'if-match': `"${sha(a)}"` })).status).toBe(200);
    // panel A's write names A: refused, the stored state is B
    const refused = await put(stack, pid, clip.id, edits, { 'if-match': `"${sha(a)}"` });
    expect(refused.status).toBe(412);
    expect(refused.headers.get('etag')).toBe(`"${sha(b)}"`);
    // the person replaces B, seconds later and as the same author: a commit of its own, B's commit not amended
    const replaced = await put(stack, pid, clip.id, edits, {
      'if-match': `"${sha(b)}"`,
      'x-desk-state-replace': '1',
    });
    expect(replaced.status).toBe(200);
    const states = async () => {
      const commits = (await deskCommits(pid, clip.id)).filter((c) => c.message.startsWith('Save the desk'));
      const hashes: string[] = [];
      for (const c of commits) {
        const doc = await stack.api<Clip>('GET', `/projects/${pid}/docs/clips/${clip.id}.json?at=${c.id}`);
        hashes.push(doc.deskState!.media.hash);
      }
      return hashes;
    };
    expect(await states()).toEqual([sha(edits), sha(b), sha(a)]);
    // a later state right after it: stored as usual, and the Replace's commit is never amended
    expect((await put(stack, pid, clip.id, later, { 'if-match': `"${sha(edits)}"` })).status).toBe(200);
    expect(await states()).toEqual([sha(later), sha(edits), sha(b), sha(a)]);
    // and B can be restored from the history
    const commits = (await deskCommits(pid, clip.id)).filter((c) => c.message.startsWith('Save the desk'));
    await stack.api('POST', `/projects/${pid}/history/restore`, {
      commit: commits[2]!.id,
      paths: [`clips/${clip.id}.json`],
    });
    expect(new Uint8Array(await (await fetch(deskUrl(stack, pid, clip.id))).arrayBuffer())).toEqual(b);
  });

  it('stores a state only over the one its precondition names, else answers 412 desk_state_conflict', async () => {
    const { pid, clip } = await seeded(stack);
    const conflicts = await metric('rideo_desk_state_saves_total', '{outcome="conflict"}');
    const logged = vi.spyOn(stack.server.studio.deps.log, 'info');
    const stored = async () =>
      new TextDecoder().decode(await (await fetch(deskUrl(stack, pid, clip.id))).arrayBuffer());
    const problem = async (res: Response) => {
      const body = (await res.json()) as { code: string; detail: string };
      return { status: res.status, code: body.code, detail: body.detail, etag: res.headers.get('etag') };
    };
    // the answer's detail names the stored state, never "newer" (a restore of an older state is refused the same way)
    const changed = (state: Uint8Array) =>
      `the stored desk state of scene ${clip.index + 1} is not the one this write replaces: another session changed it (the stored state's ETag is "${sha(state)}")`;
    const one = bytes('session one');
    const two = bytes('session two');
    const three = bytes('session three');

    // none stored: If-None-Match: * stores the first state, and the answer's ETag names it
    const first = await put(stack, pid, clip.id, one, { 'if-none-match': '*' });
    expect(first.status).toBe(200);
    expect(first.headers.get('etag')).toBe(`"${sha(one)}"`);
    // a session that also saw none stored is refused, with the stored state's ETag
    expect(await problem(await put(stack, pid, clip.id, two, { 'if-none-match': '*' }))).toEqual({
      status: 412,
      code: 'desk_state_conflict',
      detail: changed(one),
      etag: `"${sha(one)}"`,
    });
    // If-Match with the ETag the PUT answered stores the next state
    const next = await put(stack, pid, clip.id, two, { 'if-match': first.headers.get('etag')! });
    expect(next.status).toBe(200);
    expect(next.headers.get('etag')).toBe(`"${sha(two)}"`);
    expect(((await next.json()) as { deskState: { media: { hash: string } } }).deskState.media.hash).toBe(
      sha(two),
    );
    // a stale ETag (a weak one never matches) is refused, and the newer state kept; nothing is written for it, not
    // even the file (the precondition is checked before the file is kept)
    const files = vi.spyOn(stack.server.studio.deps.media, 'putFile');
    expect(await problem(await put(stack, pid, clip.id, three, { 'if-match': `"${sha(one)}"` }))).toEqual({
      status: 412,
      code: 'desk_state_conflict',
      detail: changed(two),
      etag: `"${sha(two)}"`,
    });
    expect(files).not.toHaveBeenCalled();
    files.mockRestore();
    expect((await put(stack, pid, clip.id, three, { 'if-match': `W/"${sha(two)}"` })).status).toBe(412);
    expect(await stored()).toBe('session two');
    // a list that names the stored state, or *, holds while a state is stored
    expect(
      (await put(stack, pid, clip.id, three, { 'if-match': `"${sha(one)}", "${sha(two)}"` })).status,
    ).toBe(200);
    expect((await put(stack, pid, clip.id, two, { 'if-match': '*' })).status).toBe(200);
    // the bytes already stored: accepted whatever the precondition (what it asks for is done), nothing committed
    const head = (await stack.api<any>('GET', `/projects/${pid}/state`)).head.commit;
    const again = await put(stack, pid, clip.id, two, { 'if-match': `"${sha(one)}"` });
    expect(again.status).toBe(200);
    expect(again.headers.get('etag')).toBe(`"${sha(two)}"`);
    expect((await stack.api<any>('GET', `/projects/${pid}/state`)).head.commit).toBe(head);
    // cleared by another session: If-Match (even *) is refused, and the answer names no state
    expect((await fetch(deskUrl(stack, pid, clip.id), { method: 'DELETE' })).status).toBe(204);
    expect(await problem(await put(stack, pid, clip.id, three, { 'if-match': `"${sha(two)}"` }))).toEqual({
      status: 412,
      code: 'desk_state_conflict',
      detail: `scene ${clip.index + 1} has no stored desk state any more: another session cleared it`,
      etag: null,
    });
    expect((await put(stack, pid, clip.id, three, { 'if-match': '*' })).status).toBe(412);
    // a PUT without a precondition replaces whatever is stored, a state or none
    expect((await put(stack, pid, clip.id, one)).status).toBe(200);
    expect((await put(stack, pid, clip.id, three)).status).toBe(200);
    expect(await stored()).toBe('session three');

    // each conflict counted and logged with what the PUT named and what is stored
    expect(await metric('rideo_desk_state_saves_total', '{outcome="conflict"}')).toBe(conflicts + 5);
    const logs = logged.mock.calls.filter((c) => c[1] === 'desk state conflict').map((c) => c[0]);
    expect(logs).toHaveLength(5);
    expect(logs[0]).toEqual({
      projectId: pid,
      clipId: clip.id,
      ifMatch: null,
      ifNoneMatch: '*',
      stored: sha(one),
    });
    expect(logs[3]).toMatchObject({ ifMatch: `"${sha(two)}"`, ifNoneMatch: null, stored: null });
    logged.mockRestore();
  });

  it('checks the precondition again once the body has arrived: a state stored meanwhile is kept', async () => {
    const { pid, clip } = await seeded(stack);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(bytes('a slow '));
        await gate;
        c.enqueue(bytes('state'));
        c.close();
      },
    });
    // the slow write has read the clip (none stored) and waits for the rest of its body
    const pending = put(stack, pid, clip.id, slow, { 'if-none-match': '*' });
    await new Promise((r) => setTimeout(r, 500));
    const quick = await put(stack, pid, clip.id, bytes('a quick state'), { 'if-none-match': '*' });
    expect(quick.status).toBe(200);
    release();
    const late = await pending;
    expect(late.status).toBe(412);
    expect(late.headers.get('etag')).toBe(`"${sha(bytes('a quick state'))}"`);
    expect(new TextDecoder().decode(await (await fetch(deskUrl(stack, pid, clip.id))).arrayBuffer())).toBe(
      'a quick state',
    );
  });

  it('leaves no temporary file and no open file when the client goes away before its body is read', async () => {
    const { pid, clip } = await seeded(stack);
    const deps = stack.server.studio.deps;
    const tmpDir = dirname(deps.media.tmp('bin'));
    const leftovers = () => {
      const files = readdirSync(tmpDir).filter((n) => n.endsWith('.bin'));
      let open: string[] = [];
      try {
        open = readdirSync('/proc/self/fd')
          .map((fd) => {
            try {
              return readlinkSync(`/proc/self/fd/${fd}`);
            } catch {
              return '';
            }
          })
          .filter((target) => target.startsWith(tmpDir) && target.endsWith('.bin'));
      } catch {
        // no /proc: the files are checked alone
      }
      return { files, open };
    };
    const before = leftovers();
    // the service waits for the project while the client goes away
    const projects = deps.projects;
    const docs = projects.docs.bind(projects);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const waiting = new Promise<void>((r) => {
      entered = r;
    });
    projects.docs = (async (...args: Parameters<typeof docs>) => {
      entered();
      await gate;
      return docs(...args);
    }) as typeof projects.docs;
    const desk = stack.server.studio.desk;
    const save = desk.saveState.bind(desk);
    let outcome: Promise<unknown> | undefined;
    desk.saveState = ((...args: Parameters<typeof save>) => {
      outcome = save(...args);
      return outcome;
    }) as typeof desk.saveState;
    try {
      const req = request(deskUrl(stack, pid, clip.id), {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', ...FORMAT, 'content-length': '4096' },
      });
      req.on('error', () => undefined);
      req.write(Buffer.alloc(16));
      await waiting;
      req.destroy();
      await new Promise((r) => setTimeout(r, 200));
      release();
      const settled = await Promise.race([
        outcome!.then(
          () => 'stored',
          (err: { code?: string }) => err.code ?? 'failed',
        ),
        new Promise((r) => setTimeout(() => r('still waiting'), 5_000)),
      ]);
      expect(settled).toBe('cancelled');
    } finally {
      projects.docs = docs;
      desk.saveState = save;
    }
    expect(leftovers()).toEqual(before);
    await noState(stack, pid, clip.id);
  });

  it('answers 404 for clip ids that name members of every object, on every desk route and in desk_brief', async () => {
    const { pid } = await seeded(stack);
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      await rejects(stack.api('GET', `/projects/${pid}/clips/${id}/desk-brief`), 'not_found', 404);
      await rejects(stack.api('GET', `/projects/${pid}/clips/${id}/desk-state`), 'not_found', 404);
      expect((await put(stack, pid, id, bytes('x'))).status, id).toBe(404);
      expect((await fetch(deskUrl(stack, pid, id), { method: 'DELETE' })).status, id).toBe(404);
      const r = await client.callTool({ name: 'desk_brief', arguments: { projectId: pid, clipId: id } });
      expect(r.isError, id).toBe(true);
      expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toMatchObject({ code: 'not_found' });
    }
  });

  it("keeps the shot's planned framing and movement when a partial camera is set, over PATCH and shot_update", async () => {
    const { pid, clip, shot } = await seeded(stack);
    const path = `/projects/${pid}/clips/${clip.id}/shots/${shot.id}`;
    await stack.api('PATCH', path, { camera: { framing: 'close_up', movement: 'pan' } });
    // the desk's PATCH: the staged lens and move only
    const patched = await stack.api<Clip>('PATCH', path, { camera: { lensMm: 35, move: 'push_in' } });
    expect(patched.shots[0]!.camera).toMatchObject({
      framing: 'close_up',
      movement: 'pan',
      lensMm: 35,
      move: 'push_in',
    });
    const r = await client.callTool({
      name: 'shot_update',
      arguments: { projectId: pid, clipId: clip.id, shotId: shot.id, camera: { lensMm: 50 } },
    });
    expect(r.isError).toBeFalsy();
    const state = await stack.api<any>('GET', `/projects/${pid}/state`);
    expect(state.docs.clips[clip.id].shots[0].camera).toMatchObject({
      framing: 'close_up',
      movement: 'pan',
      lensMm: 50,
      move: 'push_in',
    });
  });

  it("keeps the state in the browser's storage on a studio that keeps projects in browsers", async () => {
    const { pid, clip } = await seeded(browser, tab.api);
    await noState(browser, pid, clip.id, { 'x-rideo-workspace': tab.id });
    const state = bytes('a state kept in the browser');
    const res = await fetch(deskUrl(browser, pid, clip.id), {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-rideo-workspace': tab.id, ...FORMAT },
      body: state,
    });
    expect(res.status).toBe(200);
    const { deskState } = (await res.json()) as { deskState: NonNullable<Clip['deskState']> };
    const stored = await tab.backend.read(`/projects/${pid}/${deskState.media.path}`);
    expect(stored && new Uint8Array(stored)).toEqual(state);
    const got = await fetch(deskUrl(browser, pid, clip.id), { headers: { 'x-rideo-workspace': tab.id } });
    expect(got.status).toBe(200);
    expect(got.headers.get('etag')).toBe(`"${sha(state)}"`);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(state);
  });
});

describe('the setting (docs/design/director-desk.md#the-setting)', () => {
  it('reaches every browser in GET /api/config once saved, and refuses a page that is not secure', async () => {
    expect((await stack.api<any>('GET', '/config')).features.desk).toBeNull();
    await rejects(
      stack.api('PUT', '/settings', { values: { RIDEO_DESK_URL: 'http://desk.example.com/desk.html' } }),
      'validation_error',
    );
    await stack.api('PUT', '/settings', { values: { RIDEO_DESK_URL: 'https://desk.example.com/desk.html' } });
    expect((await stack.api<any>('GET', '/config')).features.desk).toEqual({
      url: 'https://desk.example.com/desk.html',
    });
  });
});

describe('library units: what a stored state uses (docs/design/director-desk.md#what-a-stored-state-uses)', () => {
  const UNITS = 'x-desk-state-units';
  const stored = async (pid: string, clipId: string) =>
    (await stack.api<any>('GET', `/projects/${pid}/state`)).docs.clips[clipId].deskState as Clip['deskState'];

  it('keeps the rows with the state, none for -, unknown without the header, and clears them with it', async () => {
    const { pid, clip, mira } = await seeded(stack);
    const logged = vi.spyOn(stack.server.studio.deps.log, 'info');
    const rows = `set=lib_0j8kc4n2q1h7wz3x@3:unit, cast:${mira.id}=lib_0j8kc4n2q1h7mira@2:unit:local, el:ele_0j8kc3x0b5k9dn2p=lib_0j8kc4n2q1h7lamp@1:pending:missing`;
    const res = await put(stack, pid, clip.id, bytes('state with units'), { [UNITS]: rows });
    expect(res.status).toBe(200);
    const units = [
      { slot: 'set', ref: 'lib_0j8kc4n2q1h7wz3x', version: 3, staged: 'unit', local: false },
      { slot: `cast:${mira.id}`, ref: 'lib_0j8kc4n2q1h7mira', version: 2, staged: 'unit', local: true },
      {
        slot: 'el:ele_0j8kc3x0b5k9dn2p',
        ref: 'lib_0j8kc4n2q1h7lamp',
        version: 1,
        staged: 'pending',
        local: false,
        why: 'missing',
      },
    ];
    expect(((await res.json()) as any).deskState.units).toEqual(units);
    expect((await stored(pid, clip.id))!.units).toEqual(units);
    const saved = logged.mock.calls
      .filter((c) => c[1] === 'desk state saved')
      .map((c) => (c[0] as any).units);
    expect(saved).toEqual([3]);

    // the same bytes again keep the record, the rows included, whatever the header says
    const head = (await stack.api<any>('GET', `/projects/${pid}/state`)).head.commit;
    expect((await put(stack, pid, clip.id, bytes('state with units'), { [UNITS]: '-' })).status).toBe(200);
    expect((await put(stack, pid, clip.id, bytes('state with units'))).status).toBe(200);
    expect((await stored(pid, clip.id))!.units).toEqual(units);
    expect((await stack.api<any>('GET', `/projects/${pid}/state`)).head.commit).toBe(head);

    // `-`: none; no header: not known (no field at all, as before units)
    expect((await put(stack, pid, clip.id, bytes('state without units'), { [UNITS]: '-' })).status).toBe(200);
    expect((await stored(pid, clip.id))!.units).toEqual([]);
    expect((await put(stack, pid, clip.id, bytes('a state of an old desk'))).status).toBe(200);
    expect(await stored(pid, clip.id)).not.toHaveProperty('units');
    expect(
      logged.mock.calls.filter((c) => c[1] === 'desk state saved').map((c) => (c[0] as any).units),
    ).toEqual([3, 0, 'unknown']);
    logged.mockRestore();

    // DELETE clears them with the state
    expect((await put(stack, pid, clip.id, bytes('again'), { [UNITS]: rows })).status).toBe(200);
    await stack.api('DELETE', `/projects/${pid}/clips/${clip.id}/desk-state`);
    expect(await stored(pid, clip.id)).toBeNull();
  });

  it('refuses a header that does not parse with 422 before the body is kept, counted and logged', async () => {
    const { pid, clip } = await seeded(stack);
    expect(
      (await put(stack, pid, clip.id, bytes('kept'), { [UNITS]: 'set=lib_0j8kc4n2q1h7wz3x@1:unit' })).status,
    ).toBe(200);
    const before = await stored(pid, clip.id);
    const refused = await metric('rideo_desk_state_saves_total', '{outcome="refused"}');
    const logged = vi.spyOn(stack.server.studio.deps.log, 'info');
    const files = vi.spyOn(stack.server.studio.deps.media, 'putFile');
    const many = Array.from({ length: 129 }, (_, i) => `el:e${i}=lib_0j8kc4n2q1h7wz3x@1:unit`).join(', ');
    for (const bad of [
      'set=lib_0j8kc4n2q1h7wz3x@1:words',
      'set=lib_0j8kc4n2q1h7wz3x',
      'set=lib_0j8kc4n2q1h7wz3x@1:unit, set=lib_0j8kc4n2q1h7wz3x@2:unit',
      many,
      `el:${'x'.repeat(90)}=lib_0j8kc4n2q1h7wz3x@1:unit, `.repeat(90).slice(0, -2),
    ]) {
      const res = await put(stack, pid, clip.id, bytes('never kept'), { [UNITS]: bad });
      const body = (await res.json()) as { code: string; detail: string };
      expect([res.status, body.code], bad.slice(0, 60)).toEqual([422, 'validation_error']);
      expect(body.detail).toMatch(/^X-Desk-State-Units: /);
    }
    expect(files).not.toHaveBeenCalled();
    files.mockRestore();
    expect(await metric('rideo_desk_state_saves_total', '{outcome="refused"}')).toBe(refused + 5);
    const reasons = logged.mock.calls
      .filter((c) => c[1] === 'desk state refused')
      .map((c) => (c[0] as any).reason);
    expect(reasons).toEqual(['units', 'units', 'units', 'units', 'units']);
    logged.mockRestore();
    expect(await stored(pid, clip.id)).toEqual(before);
  });

  it("lists the clips whose stored state uses a library version where it is used ('deskState')", async () => {
    const { pid, clip } = await seeded(stack);
    const json = Buffer.from(
      JSON.stringify({ format: '3d-editor.desk-unit', version: 1, kind: 'set', name: 'Lamp room set' }),
    );
    const prefix = Buffer.alloc(16);
    DESK_UNIT_MAGIC.copy(prefix, 0);
    prefix[8] = 1;
    prefix.writeUInt32LE(json.length, 12);
    const unit = Buffer.concat([prefix, json, Buffer.from('lamp room set '.repeat(32))]);
    const meta = {
      kind: 'desk-set',
      name: 'Lamp room set',
      unit: {
        format: '3d-editor.desk-unit',
        formatVersion: 1,
        meta: {
          dimensionsM: [8, 6, 4],
          objects: 3,
          triangles: 1200,
          actor: null,
          credits: [],
          deskVersion: '1.4.0',
          digest: 'c'.repeat(64),
        },
      },
    };
    const form = new FormData();
    form.append('meta', JSON.stringify(meta));
    form.append(
      'payload',
      new Blob([new Uint8Array(unit)], { type: 'application/octet-stream' }),
      'unit.bin',
    );
    const created = await fetch(`${stack.url}/api/library/items`, { method: 'POST', body: form });
    expect(created.status).toBe(201);
    const itemId = ((await created.json()) as { item: { id: string } }).item.id;
    const header = `set=${itemId}@1:unit`;
    expect(
      (await put(stack, pid, clip.id, bytes('a state at the lamp room'), { [UNITS]: header })).status,
    ).toBe(200);
    const uses = await stack.api<any>('GET', `/library/items/${itemId}/uses`);
    expect(uses.projects.find((p: any) => p.projectId === pid)?.uses).toEqual([
      { itemId, version: 1, via: 'deskState', clips: 1, approved: 0 },
    ]);
  });
});
