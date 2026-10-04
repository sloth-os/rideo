import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage, StorageRequest } from '@rideo/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PreconditionFailedError } from '../../src/storage/backend';
import { FsBackend } from '../../src/storage/fs';
import { MemoryBackend } from '../../src/storage/memory';
import { RoutedStorage } from '../../src/storage/routed';
import { WorkspaceRegistry, workspaceContext } from '../../src/storage/workspaces';

const WS_A = `ws_${'a'.repeat(26)}`;
const WS_B = `ws_${'b'.repeat(26)}`;
const PRJ = 'prj_0123456789ab';

/** A tab that answers storage operations from memory, inline (the registry's message path). */
function fakeTab(registry: WorkspaceRegistry, id: string, backend = new MemoryBackend(), userId?: string) {
  const sent: ServerMessage[] = [];
  const send = (msg: ServerMessage) => {
    sent.push(msg);
    if (msg.type !== 'storage') return;
    void answer(msg).then((r) => registry.result(id, { type: 'storage-result', id: msg.id, ...r }));
  };
  const answer = async (m: StorageRequest) => {
    try {
      switch (m.op) {
        case 'stat':
          return { ok: true, result: await backend.stat(m.path) };
        case 'list':
          return { ok: true, result: await backend.list(m.path) };
        case 'write':
          return {
            ok: true,
            result: await backend.write(m.path, Buffer.from(m.data ?? '', 'base64'), {
              ...(m.ifNoneMatch ? { ifNoneMatch: m.ifNoneMatch } : {}),
              ...(m.ifMatch ? { ifMatch: m.ifMatch } : {}),
            }),
          };
        case 'read': {
          const buf = await backend.read(m.path);
          return buf
            ? {
                ok: true,
                result: { size: buf.length, start: 0, end: Math.max(0, buf.length - 1) },
                data: buf.toString('base64'),
              }
            : { ok: true, result: null };
        }
        case 'delete':
          await backend.delete(m.path);
          return { ok: true, result: {} };
        case 'move':
          await backend.move(m.path, m.to!);
          return { ok: true, result: {} };
      }
    } catch (err) {
      return {
        ok: false,
        error: { code: err instanceof PreconditionFailedError ? 'conflict' : 'error', message: String(err) },
      };
    }
  };
  return { session: { id, userId, send }, sent, backend };
}

describe('FsBackend (docs/design/browser-storage.md#fsbackend)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rideo-fs-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes atomically, reads ranges, lists, moves and deletes', async () => {
    const fs = new FsBackend(dir);
    const { etag } = await fs.write('/rideo/accounts/users/u.json', '{"a":1}');
    expect(etag).toMatch(/^"/);
    expect((await fs.read('/rideo/accounts/users/u.json'))?.toString()).toBe('{"a":1}');
    expect(await readFile(join(dir, 'rideo/accounts/users/u.json'), 'utf8')).toBe('{"a":1}');
    const r = await fs.readStream('/rideo/accounts/users/u.json', { start: 1, end: 3 });
    const chunks: Buffer[] = [];
    for await (const c of r!.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('"a"');
    expect(r).toMatchObject({ size: 7, start: 1, end: 3 });
    expect((await fs.list('/rideo/accounts')).map((e) => [e.name, e.isDir])).toEqual([['users', true]]);
    expect(await fs.list('/nowhere')).toEqual([]);
    await fs.move('/rideo/accounts', '/rideo/trash/accounts-1');
    expect(await fs.stat('/rideo/accounts')).toBeNull();
    expect(await fs.stat('/rideo/trash/accounts-1/users/u.json')).toMatchObject({ size: 7, isDir: false });
    await fs.delete('/rideo/trash');
    expect(await fs.stat('/rideo/trash')).toBeNull();
    expect(await fs.read('/missing')).toBeNull();
  });

  it('honours conditional writes and refuses paths that leave the store', async () => {
    const fs = new FsBackend(dir);
    await fs.write('/ref', 'one', { ifNoneMatch: '*' });
    await expect(fs.write('/ref', 'two', { ifNoneMatch: '*' })).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    const cur = await fs.stat('/ref');
    await expect(fs.write('/ref', 'three', { ifMatch: '"nope"' })).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    await fs.write('/ref', 'four', { ifMatch: cur!.etag });
    expect((await fs.read('/ref'))?.toString()).toBe('four');
    await expect(fs.read('/../../etc/passwd')).rejects.toThrow(/escapes the store/);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });
});

describe('workspaces and routing (docs/design/browser-storage.md#routing-on-the-server)', () => {
  let global: MemoryBackend;
  let registry: WorkspaceRegistry;
  let routed: RoutedStorage;
  beforeEach(() => {
    global = new MemoryBackend();
    registry = new WorkspaceRegistry({ waitMs: 200 });
    routed = new RoutedStorage(global, registry, '/rideo');
  });

  it('puts studio data in the data directory and a new project in the asking browser', async () => {
    const a = fakeTab(registry, 'ses_a');
    expect(registry.attach(a.session, WS_A)).toBe(true);
    await routed.write('/rideo/accounts/users/u.json', '{}');
    expect(await global.read('/rideo/accounts/users/u.json')).not.toBeNull();
    await workspaceContext.run(WS_A, () =>
      routed.write(`/rideo/projects/${PRJ}/.rideo/HEAD`, '{"branch":"main"}'),
    );
    expect(await a.backend.read(`/projects/${PRJ}/.rideo/HEAD`)).not.toBeNull();
    expect(registry.owner(PRJ)).toBe(WS_A);
    // reads by id need no context once the owner is known
    expect((await routed.read(`/rideo/projects/${PRJ}/.rideo/HEAD`))?.toString()).toBe('{"branch":"main"}');
    expect((await routed.list(`/rideo/projects/${PRJ}/.rideo`)).map((e) => e.path)).toEqual([
      `/rideo/projects/${PRJ}/.rideo/HEAD`,
    ]);
    expect(routed.externallyEditable(`/rideo/projects/${PRJ}`)).toBe(false);
    expect(routed.externallyEditable('/rideo/projects/prj_unknown00000')).toBe(true);
  });

  it('lists the caller’s workspace, or every attached one, beside the data directory’s projects', async () => {
    const a = fakeTab(registry, 'ses_a');
    const b = fakeTab(registry, 'ses_b');
    await a.backend.write(`/projects/${PRJ}/.rideo/HEAD`, '{}');
    await b.backend.write('/projects/prj_bbbbbbbbbbbb/.rideo/HEAD', '{}');
    await global.write('/rideo/projects/prj_gggggggggggg/.rideo/HEAD', '{}');
    registry.attach(a.session, WS_A);
    registry.attach(b.session, WS_B);
    await registry.waitFor(WS_A);
    await registry.waitFor(WS_B);
    const names = (list: { name: string }[]) => list.map((e) => e.name);
    expect(names(await workspaceContext.run(WS_A, () => routed.list('/rideo/projects')))).toEqual([
      PRJ,
      'prj_gggggggggggg',
    ]);
    expect(names(await routed.list('/rideo/projects'))).toEqual([
      PRJ,
      'prj_bbbbbbbbbbbb',
      'prj_gggggggggggg',
    ]);
    // the data directory's project stays there
    await routed.write('/rideo/projects/prj_gggggggggggg/x.json', '1');
    expect(await global.read('/rideo/projects/prj_gggggggggggg/x.json')).not.toBeNull();
    expect(a.sent.some((m) => m.type === 'workspace-ready')).toBe(true);
  });

  it('keeps a project’s trash with it', async () => {
    const a = fakeTab(registry, 'ses_a');
    registry.attach(a.session, WS_A);
    await workspaceContext.run(WS_A, () => routed.write(`/rideo/projects/${PRJ}/project.json`, '{}'));
    await routed.move(`/rideo/projects/${PRJ}`, `/rideo/trash/${PRJ}-1700000000000`);
    expect(await a.backend.read(`/trash/${PRJ}-1700000000000/project.json`)).not.toBeNull();
    expect(await global.stat('/rideo/trash')).toBeNull();
  });

  it('refuses another person’s workspace and fails fast when the browser is gone', async () => {
    const a = fakeTab(registry, 'ses_a', new MemoryBackend(), 'usr_mira000000');
    expect(registry.attach(a.session, WS_A)).toBe(true);
    const intruder = fakeTab(registry, 'ses_x', new MemoryBackend(), 'usr_ben0000000');
    expect(registry.attach(intruder.session, WS_A)).toBe(false);
    await workspaceContext.run(WS_A, () => routed.write(`/rideo/projects/${PRJ}/project.json`, '{}'));
    registry.detach('ses_a');
    await expect(routed.read(`/rideo/projects/${PRJ}/project.json`)).rejects.toMatchObject({
      code: 'storage_offline',
    });
    // without any browser a new project has nowhere to go
    await expect(routed.write('/rideo/projects/prj_newnewnewnew/project.json', '{}')).rejects.toMatchObject({
      code: 'storage_offline',
    });
    // a reconnecting tab is waited for
    const again = fakeTab(registry, 'ses_a2', a.backend, 'usr_mira000000');
    setTimeout(() => registry.attach(again.session, WS_A), 50);
    expect((await routed.read(`/rideo/projects/${PRJ}/project.json`))?.toString()).toBe('{}');
  });

  it('passes the browser’s precondition failures through, so ref updates stay safe', async () => {
    const a = fakeTab(registry, 'ses_a');
    registry.attach(a.session, WS_A);
    const path = `/rideo/projects/${PRJ}/.rideo/refs/heads/main`;
    await workspaceContext.run(WS_A, () => routed.write(path, '1', { ifNoneMatch: '*' }));
    await expect(routed.write(path, '2', { ifNoneMatch: '*' })).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
  });

  it('fails the operations of a tab that closes', async () => {
    const send = (_msg: ServerMessage) => undefined; // never answers
    registry.attach({ id: 'ses_silent', send }, WS_A);
    const pending = registry.storage(WS_A).stat('/projects');
    registry.detach('ses_silent');
    await expect(pending).rejects.toMatchObject({ code: 'storage_offline' });
  });
});
