import type { Screenplay } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from 'webdav';
import { type Stack, startStack } from '../helpers/stack';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack?.stop();
});

describe('assets managed over WebDAV', () => {
  it('commits valid external edits, reports invalid ones and imports the inbox', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'story',
      title: 'WebDAV',
      brief: { prompt: 'x y z' },
    });
    await stack.api('PATCH', `/projects/${p.id}/screenplay`, {
      fields: { title: 'Original', logline: 'Draft' },
    });
    const dav = createClient(`${stack.url}/dav`);
    const root = `/rideo/projects/${p.id}`;
    const listing = (await dav.getDirectoryContents(root)) as { basename: string }[];
    expect(listing.map((e) => e.basename)).toEqual(
      expect.arrayContaining(['project.json', 'screenplay.json', 'screenplay.md', 'inbox', '.rideo']),
    );

    const sp = JSON.parse(
      (await dav.getFileContents(`${root}/screenplay.json`, { format: 'text' })) as string,
    ) as Screenplay;
    await dav.putFileContents(
      `${root}/screenplay.json`,
      JSON.stringify({ ...sp, title: 'Edited in Finder' }, null, 2),
    );
    const report = await stack.api<any>('POST', `/projects/${p.id}/sync`, {});
    expect(report.changed).toEqual(['screenplay.json']);
    const log = await stack.api<any[]>('GET', `/projects/${p.id}/history?limit=1`);
    expect(log[0]).toMatchObject({
      author: { kind: 'webdav' },
      message: 'External edit via WebDAV: screenplay.json',
    });
    expect(
      ((await stack.api<any>('GET', `/projects/${p.id}/state`)).docs.screenplay as Screenplay).title,
    ).toBe('Edited in Finder');

    await dav.putFileContents(`${root}/screenplay.json`, '{ "title": 42 ');
    const bad = await stack.api<any>('POST', `/projects/${p.id}/sync`, {});
    expect(bad.issues.map((i: { path: string }) => i.path)).toEqual(['screenplay.json']);
    expect((await stack.api<any>('GET', `/projects/${p.id}/state`)).syncIssues).toHaveLength(1);
    await stack.api('POST', `/projects/${p.id}/sync`, { discardInvalid: true });
    expect(
      JSON.parse((await dav.getFileContents(`${root}/screenplay.json`, { format: 'text' })) as string).title,
    ).toBe('Edited in Finder');

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    await dav.putFileContents(`${root}/inbox/costume.png`, png);
    const imported = await stack.api<any>('POST', `/projects/${p.id}/sync`, {});
    expect(imported.imported).toEqual(['costume.png']);
    const resources = Object.values<any>(
      (await stack.api<any>('GET', `/projects/${p.id}/state`)).docs.resources,
    );
    expect(resources[0]).toMatchObject({
      name: 'costume.png',
      kind: 'image',
      role: 'reference',
      origin: 'inbox',
    });
    expect(await dav.exists(`${root}/inbox/costume.png`)).toBe(false);
  });

  it('restores documents from history without rewriting it', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'story',
      title: 'History',
      brief: { prompt: 'abc' },
    });
    await stack.api('PATCH', `/projects/${p.id}/screenplay`, { fields: { title: 'First' } });
    const [first] = await stack.api<any[]>('GET', `/projects/${p.id}/history?limit=1`);
    await stack.api('PATCH', `/projects/${p.id}/screenplay`, { fields: { title: 'Second' } });
    const diff = await stack.api<any>('GET', `/projects/${p.id}/history/diff?from=${first.id}&to=main`);
    expect(diff.entries[0].ops).toEqual([
      { op: 'replace', pointer: '/title', before: 'First', after: 'Second' },
    ]);
    const restored = await stack.api<any>('POST', `/projects/${p.id}/history/restore`, {
      commit: first.id.slice(0, 12),
      paths: ['screenplay.json'],
    });
    expect(restored.meta.restoredFrom).toBe(first.id);
    expect((await stack.api<any>('GET', `/projects/${p.id}/state`)).docs.screenplay.title).toBe('First');
    const branch = await stack.api<any>('POST', `/projects/${p.id}/branches`, {
      name: 'alt-ending',
      from: first.id,
    });
    expect(branch.commit).toBe(first.id);
    const switched = await stack.api<any>('POST', `/projects/${p.id}/branches/alt-ending/switch`);
    expect(switched.branch).toBe('alt-ending');
    expect((await stack.api<any>('GET', `/projects/${p.id}/state`)).head.branch).toBe('alt-ending');
  });
});
