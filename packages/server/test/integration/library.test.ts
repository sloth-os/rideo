import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Character, LibraryItem, LibraryUploadResult, ProjectDocs } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DESK_UNIT_MAGIC } from '../../src/domain/library-files';
import { sha256 } from '../../src/util/crypto';
import { ff, makeStill, uploadReady } from '../helpers/media';
import { ApiError, type Stack, startStack } from '../helpers/stack';
import { attachWorkspace, WorkspaceApiError, type WorkspaceClient } from '../helpers/workspace-client';

/** The studio library (docs/design/library.md): REST and MCP over one service. */

function unitFile(kind: 'set' | 'prop' | 'figure', body: string) {
  const json = Buffer.from(JSON.stringify({ format: '3d-editor.desk-unit', version: 1, kind, name: body }));
  const prefix = Buffer.alloc(16);
  DESK_UNIT_MAGIC.copy(prefix, 0);
  prefix[8] = 1;
  prefix.writeUInt32LE(json.length, 12);
  return Buffer.concat([prefix, json, Buffer.from(body.repeat(64))]);
}
const META = {
  dimensionsM: [40, 30, 12],
  objects: 22,
  triangles: 48_000,
  actor: null,
  credits: [{ name: 'Harbour crane', author: null, license: 'CC0-1.0' }],
  deskVersion: '1.4.0',
  digest: 'c'.repeat(64),
};
const unitMeta = (kind: 'desk-set' | 'desk-prop' | 'desk-figure', extra: Record<string, unknown> = {}) => ({
  kind,
  unit: {
    format: '3d-editor.desk-unit',
    formatVersion: 1,
    meta: kind === 'desk-figure' ? { ...META, actor: { kind: 'mannequin', heightM: 1.68 } } : META,
  },
  ...extra,
});

function form(meta: unknown, payload: Buffer, thumbnail?: Buffer) {
  const f = new FormData();
  f.append('meta', JSON.stringify(meta));
  f.append('payload', new Blob([new Uint8Array(payload)], { type: 'application/octet-stream' }), 'unit.bin');
  if (thumbnail)
    f.append('thumbnail', new Blob([new Uint8Array(thumbnail)], { type: 'image/png' }), 'thumbnail.png');
  return f;
}

/** A request with its headers: what the routes' caching and preconditions are about. */
async function call(
  stack: Stack,
  method: string,
  path: string,
  init: { body?: string | FormData; headers?: Record<string, string> } = {},
) {
  const headers = { ...init.headers };
  if (typeof init.body === 'string') headers['content-type'] = 'application/json';
  const res = await fetch(`${stack.url}/api${path}`, { method, headers, body: init.body });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try {
    json = buf.length ? JSON.parse(buf.toString('utf8')) : null;
  } catch {}
  return { status: res.status, headers: res.headers, buf, json };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError || err instanceof WorkspaceApiError)
      return { status: err.status, body: err.body };
    throw err;
  }
  throw new Error('expected the request to fail');
};

/** The value of a counter line carrying all of these labels. */
function metric(text: string, name: string, labels: Record<string, string>): number {
  const line = text
    .split('\n')
    .find(
      (l) => l.startsWith(`${name}{`) && Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)),
    );
  return line ? Number(line.split(' ').at(-1)) : 0;
}

describe('the studio library', () => {
  let stack: Stack;
  let mcp: Client;
  let dir: string;
  let thumb: Buffer;
  const tool = async <T = any>(name: string, args: Record<string, unknown>) => {
    const r = await mcp.callTool({ name, arguments: args });
    const body = JSON.parse((r.content as { text: string }[])[0]!.text);
    return { error: !!r.isError, body: body as T };
  };

  beforeAll(async () => {
    stack = await startStack();
    mcp = new Client({ name: 'library-test', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${stack.url}/mcp`)));
    dir = await mkdtemp(join(tmpdir(), 'rideo-lib-it-'));
    const png = join(dir, 'thumb.png');
    await ff.run(['-y', '-f', 'lavfi', '-i', 'color=c=teal:size=96x54', '-frames:v', '1', png]);
    thumb = await readFile(png);
  }, 60_000);
  afterAll(async () => {
    await mcp?.close();
    await stack?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  let harbor: LibraryItem;

  it('publishes a 3D set, lists it, serves its file immutably with ranges, and keeps versions with preconditions', async () => {
    const v1 = unitFile('set', 'harbor');
    const created = await call(stack, 'POST', '/library/items', {
      body: form(
        unitMeta('desk-set', { name: 'Harbor', tags: ['Season 1', 'docks'], note: 'first pass' }),
        v1,
        thumb,
      ),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('etag')).toBe('"r1"');
    const out = created.json as LibraryUploadResult;
    harbor = out.item;
    expect(out).toMatchObject({
      unchanged: false,
      item: {
        kind: 'desk-set',
        name: 'Harbor',
        tags: ['season 1', 'docks'],
        current: 1,
        latest: 1,
        unit: { sha256: sha256(v1), bytes: v1.length, formatVersion: 1, dimensionsM: [40, 30, 12] },
        thumbnail: { version: 1, mime: 'image/png', width: 96, height: 54 },
      },
      version: { version: 1, digest: sha256(v1), note: 'first pass' },
    });

    // the list: filters by kinds, tag and words
    const list = await stack.api<any>('GET', '/library/items?kinds=desk-set,desk-prop&tag=docks&q=harb');
    expect(list.items.map((i: any) => i.id)).toEqual([harbor.id]);
    expect(list.items[0]).toMatchObject({ unit: { sha256: sha256(v1) }, thumbnail: { version: 1 } });
    expect((await stack.api<any>('GET', '/library/items?kinds=character')).items).toEqual([]);
    expect((await failure(stack.api('GET', '/library/items?kinds=voice'))).status).toBe(422);

    // the file: immutable, its ETag the sha256, 304, ranges, HEAD
    const url = `/library/items/${harbor.id}/versions/1/files/${sha256(v1)}`;
    const file = await call(stack, 'GET', url);
    expect(file.status).toBe(200);
    expect(file.buf.equals(v1)).toBe(true);
    expect(file.headers.get('etag')).toBe(`"${sha256(v1)}"`);
    expect(file.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect((await call(stack, 'GET', url, { headers: { 'if-none-match': `"${sha256(v1)}"` } })).status).toBe(
      304,
    );
    const part = await call(stack, 'GET', url, { headers: { range: 'bytes=0-15' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-15/${v1.length}`);
    expect(part.buf.equals(v1.subarray(0, 16))).toBe(true);
    expect((await call(stack, 'GET', url, { headers: { range: `bytes=${v1.length}-` } })).status).toBe(416);
    const head = await call(stack, 'HEAD', url);
    expect([head.status, head.buf.length, head.headers.get('content-length')]).toEqual([
      200,
      0,
      String(v1.length),
    ]);
    expect(
      (await call(stack, 'GET', `/library/items/${harbor.id}/versions/1/files/${'0'.repeat(64)}`)).status,
    ).toBe(404);
    const thumbFile = await call(
      stack,
      'GET',
      `/library/items/${harbor.id}/versions/1/files/${sha256(thumb)}`,
    );
    expect([thumbFile.status, thumbFile.headers.get('content-type')]).toEqual([200, 'image/png']);
    const manifest = await call(stack, 'GET', `/library/items/${harbor.id}/versions/1`);
    expect(manifest.headers.get('etag')).toBe(`"${sha256(v1)}"`);
    expect(manifest.json.payload.meta.credits).toHaveLength(1);

    // the same bytes again: no version
    const same = await call(stack, 'POST', `/library/items/${harbor.id}/versions`, {
      body: form(unitMeta('desk-set'), v1),
    });
    expect([same.status, same.json.unchanged, same.json.version.version]).toEqual([200, true, 1]);

    // v2 with the precondition met
    const v2 = unitFile('set', 'harbor-two');
    const next = await call(stack, 'POST', `/library/items/${harbor.id}/versions`, {
      body: form(unitMeta('desk-set', { basedOn: 1 }), v2),
      headers: { 'if-match': '"r1"' },
    });
    expect([
      next.status,
      next.headers.get('etag'),
      next.json.item.current,
      next.json.version.version,
    ]).toEqual([201, '"r2"', 2, 2]);
    // a stale If-Match: 412 with the current ETag; a stale basedOn: 412 with the latest
    const staleRev = await call(stack, 'POST', `/library/items/${harbor.id}/versions`, {
      body: form(unitMeta('desk-set'), unitFile('set', 'three')),
      headers: { 'if-match': '"r1"' },
    });
    expect([staleRev.status, staleRev.json.code, staleRev.headers.get('etag')]).toEqual([
      412,
      'library_conflict',
      '"r2"',
    ]);
    const staleBase = await call(stack, 'POST', `/library/items/${harbor.id}/versions`, {
      body: form(unitMeta('desk-set', { basedOn: 1 }), unitFile('set', 'three')),
    });
    expect([staleBase.status, staleBase.json.code, staleBase.json.errors]).toEqual([
      412,
      'library_conflict',
      [{ latest: 2 }],
    ]);
    // a file of another kind
    const wrong = await call(stack, 'POST', `/library/items/${harbor.id}/versions`, {
      body: form(unitMeta('desk-prop'), unitFile('prop', 'crate')),
    });
    expect([wrong.status, wrong.json.code]).toEqual([422, 'validation_error']);

    // rename with the right revision, archive: gone from the default list, still served
    const renamed = await call(stack, 'PATCH', `/library/items/${harbor.id}`, {
      body: JSON.stringify({ name: 'Old harbor' }),
      headers: { 'if-match': '"r2"' },
    });
    expect([renamed.status, renamed.json.name, renamed.headers.get('etag')]).toEqual([
      200,
      'Old harbor',
      '"r3"',
    ]);
    expect(
      (
        await call(stack, 'PATCH', `/library/items/${harbor.id}`, {
          body: JSON.stringify({ name: 'x' }),
          headers: { 'if-match': '"r2"' },
        })
      ).status,
    ).toBe(412);
    // MCP: the same item, the same refusal of a stale revision
    const viaMcp = await tool('library_get', { itemId: harbor.id, version: 2 });
    expect(viaMcp.body).toMatchObject({
      item: { id: harbor.id, name: 'Old harbor', rev: 3 },
      version: { version: 2 },
    });
    expect(await tool('library_update', { itemId: harbor.id, expectedRev: 2, archived: true })).toMatchObject(
      {
        error: true,
        body: { code: 'library_conflict' },
      },
    );
    expect(
      (await tool('library_update', { itemId: harbor.id, expectedRev: 3, archived: true })).body,
    ).toMatchObject({
      archived: true,
      rev: 4,
    });
    expect((await stack.api<any>('GET', '/library/items')).items).toEqual([]);
    expect((await tool('library_list', { archived: true })).body.items.map((i: any) => i.id)).toEqual([
      harbor.id,
    ]);
    expect((await call(stack, 'GET', url)).status).toBe(200);
    harbor = (await tool('library_update', { itemId: harbor.id, archived: false })).body;
  });

  let a: string;
  let b: string;
  let mira: Character;
  let miraItem: string;

  it('saves Mira from one project after her consent is acknowledged, and uses her in another with her id and seed', async () => {
    a = (await stack.api<{ id: string }>('POST', '/projects', { kind: 'story', title: 'Episode 1' })).id;
    b = (await stack.api<{ id: string }>('POST', '/projects', { kind: 'story', title: 'Episode 2' })).id;
    const created = await stack.api<Character>('POST', `/projects/${a}/characters`, {
      name: 'Mira',
      identity: { age: 'thirties', hair: 'red curls' },
    });
    const photo = await makeStill(dir, 'mira.png', 'orange');
    const ref = new FormData();
    ref.set('view', 'front');
    ref.set(
      'consent',
      JSON.stringify({
        depictsRealPerson: true,
        subject: 'Mira Actor',
        grantedBy: 'Mira Actor',
        grantedAt: '2026-11-01',
        scope: 'the studio',
      }),
    );
    ref.set('file', new Blob([await readFile(photo)], { type: 'image/png' }), 'mira.png');
    await stack.api('POST', `/projects/${a}/characters/${created.id}/references`, ref);
    let state = await stack.api<{ docs: ProjectDocs }>('GET', `/projects/${a}/state`);
    for (const r of state.docs.characters[created.id]!.references)
      if (!r.approved)
        await stack.api('PATCH', `/projects/${a}/characters/${created.id}/references/${r.id}`, {
          approved: true,
        });
    await stack.api('POST', `/projects/${a}/characters/${created.id}/lock`);
    state = await stack.api('GET', `/projects/${a}/state`);
    mira = state.docs.characters[created.id]!;

    const refused = await failure(
      stack.api('POST', `/projects/${a}/library/save`, { entity: { kind: 'character', id: mira.id } }),
    );
    expect(refused).toMatchObject({
      status: 422,
      body: {
        code: 'consent_required',
        errors: [{ what: 'reference', subject: 'Mira Actor', scope: 'the studio' }],
      },
    });
    const saved = await stack.api<any>('POST', `/projects/${a}/library/save`, {
      entity: { kind: 'character', id: mira.id },
      acknowledgeConsent: true,
      tags: ['cast'],
    });
    miraItem = saved.item.id;
    expect(saved).toMatchObject({
      unchanged: false,
      item: { kind: 'character', name: 'Mira', entityId: mira.id, realPerson: true, current: 1 },
      version: { version: 1, realPerson: true, source: { projectId: a, entityId: mira.id } },
      commit: expect.any(String),
    });
    state = await stack.api('GET', `/projects/${a}/state`);
    expect(state.docs.characters[mira.id]!.library).toMatchObject({
      itemId: miraItem,
      version: 1,
      mode: 'saved',
    });
    // saving again changes nothing
    const again = await stack.api<any>('POST', `/projects/${a}/library/save`, {
      entity: { kind: 'character', id: mira.id },
      acknowledgeConsent: true,
    });
    expect(again).toMatchObject({ unchanged: true, version: { version: 1 } });

    // project B: the plan, then the use (consent acknowledged again for this project)
    expect(
      (await failure(stack.api('POST', `/projects/${b}/library/apply`, { itemId: miraItem }))).body.code,
    ).toBe('consent_required');
    const plan = await stack.api<any>('POST', `/projects/${b}/library/apply`, {
      itemId: miraItem,
      acknowledgeConsent: true,
      dryRun: true,
    });
    expect(plan).toMatchObject({
      applied: false,
      commit: null,
      plan: {
        mode: 'create',
        keepsLibraryId: true,
        entity: { id: mira.id, exists: false },
        lock: { locked: true, to: 1 },
        files: { toCopy: 1 },
      },
    });
    const used = await stack.api<any>('POST', `/projects/${b}/library/apply`, {
      itemId: miraItem,
      acknowledgeConsent: true,
    });
    expect(used).toMatchObject({
      applied: true,
      entity: { kind: 'character', id: mira.id },
      commit: expect.any(String),
    });
    const inB = (await stack.api<{ docs: ProjectDocs }>('GET', `/projects/${b}/state`)).docs.characters[
      mira.id
    ]!;
    expect(inB).toMatchObject({
      id: mira.id,
      seed: mira.seed,
      name: 'Mira',
      lock: { locked: true, version: 1 },
    });
    expect(inB.library).toMatchObject({ itemId: miraItem, version: 1, mode: 'used' });
    expect(inB.references[0]!.media.hash).toBe(mira.references[0]!.media.hash);
    expect(inB.references[0]!.consent).toMatchObject({ subject: 'Mira Actor' });
    const copy = await fetch(`${stack.url}/api/projects/${b}/media/${inB.references[0]!.media.path}`);
    expect(sha256(Buffer.from(await copy.arrayBuffer()))).toBe(mira.references[0]!.media.hash);
    // a second use is a conflict: her id is taken
    expect(
      (
        await failure(
          stack.api('POST', `/projects/${b}/library/apply`, { itemId: miraItem, acknowledgeConsent: true }),
        )
      ).body,
    ).toMatchObject({
      code: 'conflict',
      errors: [{ reason: 'exists', entityId: mira.id }],
    });
  });

  it('makes B behind after a v2 from A, and updates B with a new lock version', async () => {
    await stack.api('POST', `/projects/${a}/characters/${mira.id}/unlock`);
    await stack.api('PATCH', `/projects/${a}/characters/${mira.id}`, { identity: { hair: 'silver crop' } });
    await stack.api('POST', `/projects/${a}/characters/${mira.id}/lock`);
    const v2 = await stack.api<any>('POST', `/projects/${a}/library/save`, {
      entity: { kind: 'character', id: mira.id },
      acknowledgeConsent: true,
      basedOn: 1,
      note: 'new hair',
    });
    expect(v2).toMatchObject({ version: { version: 2, basedOn: 1, note: 'new hair' }, item: { current: 2 } });
    const status = await stack.api<any>('GET', `/projects/${b}/library`);
    expect(status).toMatchObject({
      behind: 1,
      links: [{ entity: { id: mira.id }, via: 'library', version: 1, state: 'behind', modified: false }],
    });
    expect((await tool('library_status', { projectId: b })).body).toEqual(status);
    const dry = await stack.api<any>('POST', `/projects/${b}/library/apply`, {
      itemId: miraItem,
      target: { kind: 'character', id: mira.id },
      acknowledgeConsent: true,
      dryRun: true,
    });
    expect(dry.plan).toMatchObject({
      mode: 'update',
      changes: ['identity'],
      lock: { from: 1, to: 2 },
      staleTakes: 0,
      needs: 'project.edit',
    });
    const updated = await tool('library_apply', {
      projectId: b,
      itemId: miraItem,
      target: { kind: 'character', id: mira.id },
      acknowledgeConsent: true,
    });
    expect(updated.body).toMatchObject({ applied: true, plan: { mode: 'update' } });
    const inB = (await stack.api<{ docs: ProjectDocs }>('GET', `/projects/${b}/state`)).docs.characters[
      mira.id
    ]!;
    expect(inB).toMatchObject({
      identity: { hair: 'silver crop' },
      lock: { version: 2 },
      library: { version: 2, mode: 'updated' },
    });
    expect((await stack.api<any>('GET', `/projects/${b}/library`)).behind).toBe(0);
    // where she is used: both projects, each with its version
    const uses = await stack.api<any>('GET', `/library/items/${miraItem}/uses`);
    expect(uses.incomplete).toBe(false);
    expect(uses.projects.map((p: any) => [p.title, p.uses[0].version, p.uses[0].via])).toEqual([
      ['Episode 1', 2, 'library'],
      ['Episode 2', 2, 'library'],
    ]);
    expect((await tool('library_uses', { itemId: miraItem })).body).toEqual(uses);
  });

  it('links a same-named character instead, and uses a resource as a new resource', async () => {
    const c = (await stack.api<{ id: string }>('POST', '/projects', { kind: 'story', title: 'Episode 3' }))
      .id;
    const other = await stack.api<Character>('POST', `/projects/${c}/characters`, { name: 'mira' });
    const clash = await failure(
      stack.api('POST', `/projects/${c}/library/apply`, { itemId: miraItem, acknowledgeConsent: true }),
    );
    expect(clash.body).toMatchObject({ code: 'conflict', errors: [{ reason: 'name', entityId: other.id }] });
    const linked = await stack.api<any>('POST', `/projects/${c}/library/apply`, {
      itemId: miraItem,
      target: { kind: 'character', id: other.id },
      acknowledgeConsent: true,
    });
    expect(linked.plan).toMatchObject({ mode: 'link', entity: { id: other.id } });
    const inC = (await stack.api<{ docs: ProjectDocs }>('GET', `/projects/${c}/state`)).docs.characters[
      other.id
    ]!;
    expect(inC).toMatchObject({
      id: other.id,
      name: 'Mira',
      library: { itemId: miraItem, version: 2, mode: 'linked' },
    });

    // a resource: saved from A, used in B as a new resource
    const still = await makeStill(dir, 'map.png', 'navy');
    const res = await uploadReady(stack, a, still, { mime: 'image/png', name: 'map.png', role: 'reference' });
    const saved = await stack.api<any>('POST', `/projects/${a}/library/save`, {
      entity: { kind: 'resource', id: res.id },
    });
    expect(saved.item).toMatchObject({ kind: 'resource', entityId: null, thumbnail: { mime: 'image/png' } });
    const used = await stack.api<any>('POST', `/projects/${b}/library/apply`, { itemId: saved.item.id });
    expect(used.plan).toMatchObject({ mode: 'create', entity: { kind: 'resource' } });
    const resources = Object.values(
      (await stack.api<{ docs: ProjectDocs }>('GET', `/projects/${b}/state`)).docs.resources,
    );
    expect(resources.map((r) => [r.origin, r.media.hash, r.library?.itemId])).toEqual([
      ['library', res.media.hash, saved.item.id],
    ]);
    expect(used.entity.id).not.toBe(res.id);
  });

  it('takes an image resource only as a raster picture and serves files that never run as a page', async () => {
    const resource = (name: string, bytes: Buffer, type: string) => {
      const f = new FormData();
      f.append(
        'meta',
        JSON.stringify({ kind: 'resource', name, resource: { kind: 'image', role: 'reference', name } }),
      );
      f.append('payload', new Blob([new Uint8Array(bytes)], { type }), name);
      return f;
    };
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/projects")</script></svg>';
    const refused = {
      svg: await call(stack, 'POST', '/library/items', {
        body: resource('logo.svg', Buffer.from(svg), 'image/svg+xml'),
      }),
      // a page that calls itself a PNG
      html: await call(stack, 'POST', '/library/items', {
        body: resource('logo.png', Buffer.from('<!doctype html><script>alert(1)</script>'), 'image/png'),
      }),
    };
    expect({
      svg: [refused.svg.status, refused.svg.json.errors],
      html: [refused.html.status, refused.html.json.errors],
    }).toEqual({ svg: [422, [{ reason: 'payload' }]], html: [422, [{ reason: 'payload' }]] });
    // a PNG is kept as a PNG, whatever its part says it is
    const png = await readFile(await makeStill(dir, 'logo.png', 'teal'));
    const kept = await call(stack, 'POST', '/library/items', {
      body: resource('logo.png', png, 'image/svg+xml'),
    });
    expect(kept.status).toBe(201);
    const media = kept.json.version.payload.media as { hash: string; mime: string };
    expect(media).toMatchObject({ hash: sha256(png), mime: 'image/png' });

    // a library file and a project's media file are served so that no browser runs them as a page
    const inert = (h: Headers) => [
      h.get('content-type'),
      h.get('x-content-type-options'),
      h.get('content-security-policy'),
    ];
    const file = await call(
      stack,
      'GET',
      `/library/items/${kept.json.item.id}/versions/1/files/${media.hash}`,
    );
    const still = await uploadReady(stack, a, await makeStill(dir, 'board.png', 'navy'), {
      mime: 'image/png',
      name: 'board.png',
      role: 'reference',
    });
    const served = await fetch(`${stack.url}/api/projects/${a}/media/${still.media.path}`);
    await served.body?.cancel();
    expect({ library: inert(file.headers), project: inert(served.headers) }).toEqual({
      library: ['image/png', 'nosniff', "default-src 'none'; sandbox"],
      project: ['image/png', 'nosniff', "default-src 'none'; sandbox"],
    });
  });

  it('pins a figure on a character and a set on a location, then removes the pin', async () => {
    const figure = (
      await call(stack, 'POST', '/library/items', {
        body: form(unitMeta('desk-figure', { name: 'Mira look' }), unitFile('figure', 'mira')),
      })
    ).json as LibraryUploadResult;
    const lighthouse = await stack.api<{ id: string }>('POST', `/projects/${b}/elements`, {
      kind: 'location',
      name: 'Lighthouse',
    });
    const viaRest = await stack.api<any>('POST', `/projects/${b}/library/apply`, {
      itemId: figure.item.id,
      target: { kind: 'character', id: mira.id },
    });
    expect(viaRest.plan).toMatchObject({ mode: 'pin', changes: ['deskUnit'], lock: { from: 2, to: 2 } });
    const viaMcp = await tool('library_apply', {
      projectId: b,
      itemId: harbor.id,
      target: { kind: 'element', id: lighthouse.id },
    });
    expect(viaMcp.body).toMatchObject({ applied: true, plan: { mode: 'pin' } });
    let docs = (await stack.api<{ docs: ProjectDocs }>('GET', `/projects/${b}/state`)).docs;
    expect(docs.characters[mira.id]!.deskUnit).toMatchObject({
      kind: 'desk-figure',
      itemId: figure.item.id,
      version: 1,
      sha256: figure.version.digest,
      actorKind: 'mannequin',
      heightM: 1.68,
    });
    expect(docs.characters[mira.id]!.lock.version).toBe(2);
    expect(docs.elements[lighthouse.id]!.deskUnit).toMatchObject({
      kind: 'desk-set',
      itemId: harbor.id,
      version: 2,
      name: 'Old harbor',
    });
    // a set is no figure: refused with the target named
    expect(
      (
        await failure(
          stack.api('POST', `/projects/${b}/library/apply`, {
            itemId: harbor.id,
            target: { kind: 'character', id: mira.id },
          }),
        )
      ).status,
    ).toBe(422);
    // the pin's where-used row
    const uses = await stack.api<any>('GET', `/library/items/${harbor.id}/uses`);
    expect(uses.projects).toEqual([
      expect.objectContaining({
        projectId: b,
        uses: [
          expect.objectContaining({
            via: 'deskUnit',
            version: 2,
            entity: { kind: 'element', id: lighthouse.id, name: 'Lighthouse' },
          }),
        ],
      }),
    ]);
    const unpinned = await tool('library_detach', {
      projectId: b,
      target: { kind: 'element', id: lighthouse.id },
      what: 'deskUnit',
    });
    expect(unpinned).toMatchObject({ error: false, body: { commit: expect.any(String) } });
    await stack.api('POST', `/projects/${b}/library/detach`, {
      target: { kind: 'character', id: mira.id },
      what: 'deskUnit',
    });
    docs = (await stack.api<{ docs: ProjectDocs }>('GET', `/projects/${b}/state`)).docs;
    expect([docs.elements[lighthouse.id]!.deskUnit, docs.characters[mira.id]!.deskUnit]).toEqual([
      null,
      null,
    ]);
    expect((await stack.api<any>('GET', `/library/items/${harbor.id}/uses`)).projects).toEqual([]);
  });

  it('records audit events and counts what happened', async () => {
    const publish = await stack.api<any[]>('GET', '/audit?type=library.publish');
    expect(publish.map((e) => e.detail.itemId)).toEqual(expect.arrayContaining([harbor.id, miraItem]));
    expect(publish.find((e) => e.detail.itemId === miraItem && e.detail.version === 1)).toMatchObject({
      projectId: a,
      detail: { kind: 'character', realPerson: true },
    });
    const applied = await stack.api<any[]>('GET', '/audit?type=library.apply');
    expect(new Set(applied.map((e) => e.detail.mode))).toEqual(new Set(['create', 'update', 'link', 'pin']));
    const changed = await stack.api<any[]>('GET', '/audit?type=library.change');
    expect(changed.map((e) => e.detail.what)).toEqual(expect.arrayContaining(['archived', 'unarchived']));
    const text = await (await fetch(`${stack.url}/metrics`)).text();
    expect(metric(text, 'rideo_library_total', { event: 'created', kind: 'desk-set' })).toBe(1);
    // two stale uploads, a stale PATCH and a stale library_update
    expect(metric(text, 'rideo_library_total', { event: 'conflict', kind: 'desk-set' })).toBe(4);
    expect(metric(text, 'rideo_library_total', { event: 'unchanged', kind: 'desk-set' })).toBe(1);
    expect(metric(text, 'rideo_library_total', { event: 'refused', kind: 'desk-prop' })).toBe(1);
    expect(metric(text, 'rideo_library_total', { event: 'pinned', kind: 'desk-set' })).toBe(1);
    expect(metric(text, 'rideo_library_items', { kind: 'character' })).toBe(1);
    expect(metric(text, 'rideo_library_bytes_total', { op: 'to_project' })).toBeGreaterThan(0);
  });
});

describe('the studio library with projects in browsers', () => {
  let stack: Stack;
  let tab: WorkspaceClient;
  beforeAll(async () => {
    stack = await startStack({ env: { RIDEO_STORAGE: 'browser' } });
  }, 60_000);
  afterAll(async () => {
    await tab?.close();
    await stack?.stop();
  });

  it('keeps the library in the data directory and applies through the tab that holds the project', async () => {
    // no tab needed to publish: the library is the server's
    const set = (
      await call(stack, 'POST', '/library/items', {
        body: form(unitMeta('desk-set', { name: 'Harbor' }), unitFile('set', 'h')),
      })
    ).json as LibraryUploadResult;
    expect(existsSync(join(stack.dataDir, 'dav', 'rideo', 'library', 'items', `${set.item.id}.json`))).toBe(
      true,
    );
    tab = await attachWorkspace(stack);
    const p = await tab.api<{ id: string }>('POST', '/projects', { kind: 'story', title: 'In the browser' });
    const loc = await tab.api<{ id: string }>('POST', `/projects/${p.id}/elements`, {
      kind: 'location',
      name: 'Harbour',
    });
    const out = await tab.api<any>('POST', `/projects/${p.id}/library/apply`, {
      itemId: set.item.id,
      target: { kind: 'element', id: loc.id },
    });
    expect(out).toMatchObject({ applied: true, plan: { mode: 'pin' } });
    const state = await tab.api<{ docs: ProjectDocs }>('GET', `/projects/${p.id}/state`);
    expect(state.docs.elements[loc.id]!.deskUnit).toMatchObject({ itemId: set.item.id, version: 1 });
    // the project's commit is in the browser, none of it on the server
    expect(await tab.backend.stat(`/projects/${p.id}/.rideo/HEAD`)).not.toBeNull();
    expect(existsSync(join(stack.dataDir, 'dav', 'rideo', 'projects', p.id))).toBe(false);
    // where-used can never be sure of projects in browsers
    expect((await tab.api<any>('GET', `/library/items/${set.item.id}/uses`)).incomplete).toBe(true);
    await tab.close();
    const offline = await failure(
      stack.api('POST', `/projects/${p.id}/library/detach`, {
        target: { kind: 'element', id: loc.id },
        what: 'deskUnit',
      }),
    );
    expect([offline.status, offline.body.code]).toEqual([503, 'storage_offline']);
  }, 60_000);
});
