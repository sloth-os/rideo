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
    env: {
      RIDEO_STORAGE: 'webdav',
      RIDEO_WEBDAV_URL: dav.url,
      RIDEO_WEBDAV_ROOT: '/studio',
      // Pauses longer than a call's own retries wait, so a job meets one (docs/design/ai-gateway.md#outages)
      RIDEO_LLM_PAUSE_SEC: '8',
    },
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

describe('the project list and the Inbox (docs/design/storage-webdav.md#slow-and-flaky-servers)', () => {
  it('reads each project’s summary after a restart, not its documents', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'story',
      title: 'Listed',
      brief: { prompt: 'a keeper of letters' },
    });
    // Every project's summary is made once, then follows its commits and is written behind them
    await stack.api('GET', '/projects');
    await stack.api('PATCH', `/projects/${p.id}`, { title: 'Listed again' });
    expect(
      (await stack.api<{ id: string; title: string }[]>('GET', '/projects')).find((x) => x.id === p.id)
        ?.title,
    ).toBe('Listed again');
    await expect
      .poll(
        async () => {
          const res = await fetch(`${dav.url}/studio/projects/${p.id}/.rideo/summary.json`);
          return res.ok ? ((await res.json()) as { summary: { title: string } }).summary.title : null;
        },
        { timeout: 15_000, interval: 250 },
      )
      .toBe('Listed again');
    await quiet();
    await stack.restart();
    // (the restart warms the recently used projects in the background: let it finish)
    await quiet();
    dav.log.length = 0;
    const listed = await stack.api<{ id: string; title: string }[]>('GET', '/projects');
    expect(listed.find((x) => x.id === p.id)?.title).toBe('Listed again');
    await stack.api('GET', '/inbox');
    expect(dav.log.filter((l) => l.includes('/.rideo/objects/'))).toEqual([]);
    expect(await metric('rideo_project_digests_total', 'source="file"')).toBeGreaterThanOrEqual(1);
  });
});

describe('the recent log (docs/design/version-control.md#caching)', () => {
  it('reads a project’s history after a restart from its file, not one commit after another', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'story',
      title: 'Logged',
      brief: { prompt: 'a keeper of letters' },
    });
    for (let i = 0; i < 6; i++) await stack.api('PATCH', `/projects/${p.id}`, { title: `Logged ${i}` });
    const before = await stack.api<{ id: string; message: string }[]>(
      'GET',
      `/projects/${p.id}/history?limit=50`,
    );
    expect(before.length).toBeGreaterThanOrEqual(7);
    await expect
      .poll(async () => (await fetch(`${dav.url}/studio/projects/${p.id}/.rideo/logs/main.json`)).status, {
        timeout: 15_000,
        interval: 250,
      })
      .toBe(200);
    await quiet();
    await stack.restart();
    // (the restart warms the recently used projects in the background: let it finish)
    await quiet();
    dav.log.length = 0;
    const after = await stack.api<{ id: string }[]>('GET', `/projects/${p.id}/history?limit=50`);
    expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id));
    expect(dav.log.filter((l) => l.includes('/.rideo/objects/'))).toEqual([]);
  });
});

describe('a server that cannot move a folder to another folder', () => {
  it('deletes a project by renaming its folder where it is', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'story',
      title: 'Doomed',
      brief: { prompt: 'a short one' },
    });
    // OpenList on a cloud drive: a rename in the folder works, a move into trash/ answers 500
    dav.fail('MOVE', new RegExp(`/projects/${p.id}/?$`), { status: 500 }, 1);
    await stack.api('DELETE', `/projects/${p.id}`);
    await expect(stack.api('GET', `/projects/${p.id}/state`)).rejects.toMatchObject({ status: 404 });
    expect((await stack.api<{ id: string }[]>('GET', '/projects')).some((x) => x.id === p.id)).toBe(false);
    const listing = await (
      await fetch(`${dav.url}/studio/projects/`, { method: 'PROPFIND', headers: { Depth: '1' } })
    ).text();
    expect(listing).toMatch(new RegExp(`${p.id}\\.trashed-\\d+`));
  });
});

describe('emptying the trash (docs/design/storage-webdav.md#maintenance)', () => {
  it('removes a deleted project for good 7 days after its deletion, wherever it went', async () => {
    const make = async (title: string) =>
      (await stack.api<{ id: string }>('POST', '/projects', { kind: 'story', title, brief: { prompt: 'x' } }))
        .id;
    const moved = await make('Moved to the trash');
    const renamed = await make('Renamed in place');
    await stack.api('DELETE', `/projects/${moved}`);
    dav.fail('MOVE', new RegExp(`/projects/${renamed}/?$`), { status: 500 }, 1);
    await stack.api('DELETE', `/projects/${renamed}`);
    const listing = async (dir: string) =>
      await (
        await fetch(`${dav.url}/studio/${dir}/`, { method: 'PROPFIND', headers: { Depth: '1' } })
      ).text();
    expect(await listing('trash')).toContain(moved);
    expect(await listing('projects')).toMatch(new RegExp(`${renamed}\\.trashed-\\d+`));
    const projects = stack.server.studio.projects;
    // A day later both stay; eight days later both are gone
    expect(await projects.purgeTrash(Date.now() + 24 * 3600_000)).toEqual([]);
    const purged = await projects.purgeTrash(Date.now() + 8 * 24 * 3600_000);
    expect(purged.some((p) => p.includes(`trash/${moved}-`))).toBe(true);
    expect(purged.some((p) => p.includes(`projects/${renamed}.trashed-`))).toBe(true);
    expect(await listing('trash')).not.toContain(moved);
    expect(await listing('projects')).not.toContain(`${renamed}.trashed-`);
    const text = await (await fetch(`${stack.url}/metrics`)).text();
    expect(Number(/^rideo_trash_purged_total (\d+)/m.exec(text)?.[1])).toBeGreaterThanOrEqual(2);
  });
});

describe('a provider that refuses its own output (docs/design/ai-gateway.md#sdk-usage)', () => {
  it('draws the reference again as a new task instead of failing the job', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'story',
      title: 'Refused',
      brief: { prompt: 'a keeper of letters' },
    });
    const sp = await stack.api<{ id: string }>('POST', `/projects/${p.id}/screenplay/generate`, {});
    await stack.waitJob(p.id, sp.id, 60_000);
    const character = Object.values<{ id: string }>(
      (await stack.api<any>('GET', `/projects/${p.id}/state`)).docs.characters,
    )[0]!;
    const before = stack.gw.counters.refused;
    stack.gw.refuseOutputs(1);
    const job = await stack.api<{ id: string }>(
      'POST',
      `/projects/${p.id}/characters/${character.id}/references/generate`,
      { views: ['front'] },
    );
    const done = await stack.waitJob(p.id, job.id, 60_000);
    expect(done).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(stack.gw.counters.refused - before).toBe(1);
    expect(await metric('rideo_gateway_tasks_total', 'modality="image"', 'status="refused"')).toBe(1);
    const refs = (await stack.api<any>('GET', `/projects/${p.id}/state`)).docs.characters[character.id]
      .references;
    expect(refs).toHaveLength(1);
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
    // The screenplay review follows; its calls would take the next test's failures
    await stack.waitIdle(p.id);
  });

  it('pauses a model that keeps failing; the job waits for it without using up its attempts', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'story',
      title: 'Outage',
      brief: { prompt: 'a keeper of letters' },
    });
    const before = stack.gw.counters.overloaded;
    stack.gw.overloadChat(6);
    const job = await stack.api<{ id: string }>('POST', `/projects/${p.id}/screenplay/generate`, {});
    // Four calls in the first run, two in the second: the sixth pauses the model and the run waits for the pause
    await expect
      .poll(
        async () => (await stack.api<any>('GET', `/projects/${p.id}/jobs/${job.id}`)).error?.message ?? '',
        {
          timeout: 60_000,
          interval: 100,
        },
      )
      .toMatch(/is paused after 6 failed calls in a row; next try in \d+ s/);
    const done = await stack.waitJob(p.id, job.id, 60_000);
    expect(done).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(stack.gw.counters.overloaded - before).toBe(6);
    expect(await metric('rideo_llm_pauses_total')).toBe(1);
    expect(await metric('rideo_llm_calls_total', 'status="paused"', 'task="screenplay.generate"')).toBe(1);
    expect(await metric('rideo_llm_paused')).toBe(0);
  }, 120_000);
});
