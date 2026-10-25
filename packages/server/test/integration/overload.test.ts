import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FlakyDav, startFlakyDav } from '../helpers/flaky-dav';
import { type Stack, startStack } from '../helpers/stack';

/**
 * A studio on a slow, flaky WebDAV server with an overloaded model provider
 * (docs/design/storage-webdav.md#slow-and-flaky-servers, docs/design/ai-gateway.md#structured-tasks).
 */

let dav: FlakyDav;
let stack: Stack;
beforeAll(async () => {
  dav = await startFlakyDav();
  stack = await startStack({
    env: { RIDEO_STORAGE: 'webdav', RIDEO_WEBDAV_URL: dav.url, RIDEO_WEBDAV_ROOT: '/studio' },
  });
});
afterAll(async () => {
  await stack?.stop();
  await dav?.close();
});

/** A counter's value for the series with all these labels. */
async function metric(name: string, ...labels: string[]): Promise<number> {
  const text = await (await fetch(`${stack.url}/metrics`)).text();
  const line = text.split('\n').find((l) => l.startsWith(`${name}{`) && labels.every((x) => l.includes(x)));
  return line ? Number(line.split(' ').at(-1)) : 0;
}

const requests = () => Object.values(dav.seen).reduce((a, b) => a + b, 0);

/** Waits until the storage has seen no request for a while (the work tree writes behind the commits). */
async function quiet(): Promise<void> {
  for (let last = -1; last !== requests(); ) {
    last = requests();
    await new Promise((r) => setTimeout(r, 300));
  }
}

describe('a busy storage server', () => {
  it('serves a loaded project from memory and saves through locked, failing and dropped requests', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'story',
      title: 'Busy storage',
      brief: { prompt: 'a lighthouse' },
    });
    await stack.api('GET', `/projects/${p.id}/state`);
    await stack.api('GET', `/projects/${p.id}/history?limit=10`);
    await quiet();
    // Reads of a loaded project ask the storage nothing: not its existence, not its tip, not its tags
    const before = requests();
    for (let i = 0; i < 5; i++) await stack.api('GET', `/projects/${p.id}/state`);
    await stack.api('GET', `/projects/${p.id}/history?limit=10`);
    expect(requests()).toBe(before);

    // Saves go through a locked file, a failing server and a dropped connection
    dav.fail('PUT', /\/objects\//, { status: 423 }, 2);
    dav.fail('PUT', /\/refs\/heads\/main$/, { status: 503 }, 1);
    dav.fail('PUT', /\/refs\/heads\/main$/, 'drop', 1);
    await stack.api('PATCH', `/projects/${p.id}/screenplay`, { fields: { title: 'Through the storm' } });
    expect((await stack.api<any>('GET', `/projects/${p.id}/state`)).docs.screenplay.title).toBe(
      'Through the storm',
    );
    expect(await metric('rideo_storage_retries_total', 'reason="423"')).toBeGreaterThanOrEqual(2);
    expect(await metric('rideo_storage_retries_total', 'reason="503"')).toBeGreaterThanOrEqual(1);

    // After a restart, a false 404 for the project is looked at again before the project counts as gone
    await stack.restart();
    dav.fail('PROPFIND', /\/\.rideo\/HEAD$/, { status: 404 }, 1);
    expect((await stack.api<any>('GET', `/projects/${p.id}/state`)).docs.screenplay.title).toBe(
      'Through the storm',
    );
    // ...and the work tree catches up in the background
    await expect
      .poll(async () => {
        const res = await fetch(`${dav.url}/studio/projects/${p.id}/screenplay.json`);
        return res.ok ? ((await res.json()) as { title: string }).title : null;
      })
      .toBe('Through the storm');
  });
});

describe('an overloaded model provider', () => {
  it('writes the screenplay once the provider takes calls again', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'story',
      title: 'Overloaded',
      brief: { prompt: 'a keeper of letters' },
    });
    stack.gw.overloadChat(2);
    const job = await stack.api<{ id: string }>('POST', `/projects/${p.id}/screenplay/generate`, {});
    await stack.waitJob(p.id, job.id, 60_000);
    expect(stack.gw.counters.overloaded).toBe(2);
    expect(await metric('rideo_llm_retries_total', 'task="screenplay.generate"', 'status="503"')).toBe(2);
    expect((await stack.api<any>('GET', `/projects/${p.id}/state`)).docs.screenplay.title).toBeTruthy();
  });
});
