import type { Clip, Job, Project } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEditorWorker } from '../helpers/editor-worker';
import { ApiError, expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack?.stop();
});

async function rejects(p: Promise<unknown>, code: string): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).body.code).toBe(code);
    return err as ApiError;
  }
  throw new Error(`expected ${code}`);
}

describe('story → movie workflow (REST, mock gateway)', () => {
  it('runs brief → screenplay → cast → pilot → production → edit → watermarked export', async () => {
    const created = await stack.api<Project>('POST', '/projects', {
      kind: 'story',
      title: 'The Keeper',
      brief: { prompt: 'A lighthouse keeper receives letters from the future' },
      settings: { targetDurationSec: 30, pilotDurationSec: 10, resolution: { width: 320, height: 180 } },
    });
    expect(created.workflow.stage).toBe('brief');
    const pid = created.id;

    const gen = await stack.api<Job>('POST', `/projects/${pid}/screenplay/generate`, {});
    expectSucceeded(await stack.waitJob(pid, gen.id));
    let state = await stack.api<any>('GET', `/projects/${pid}/state`);
    expect(state.workflow.stage).toBe('screenplay');
    expect(
      state.docs.screenplay.outline.reduce(
        (s: number, b: { estDurationSec: number }) => s + b.estDurationSec,
        0,
      ),
    ).toBeCloseTo(30);
    const characters = Object.values<any>(state.docs.characters);
    expect(characters.length).toBe(2);

    await stack.api('POST', `/projects/${pid}/workflow/approve`, { gate: 'screenplay_approved' });
    const unmet = await rejects(
      stack.api('POST', `/projects/${pid}/workflow/approve`, { gate: 'cast_locked' }),
      'gate_unmet',
    );
    expect(unmet.body.errors.map((e: { requirement: string }) => e.requirement)).toEqual([
      'characters.allLocked',
      'characters.allHaveApprovedRefs',
    ]);

    // R1: shots cannot be generated before the cast is locked.
    const scene0 = state.docs.screenplay.scenes[0];
    const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, { sceneId: scene0.id });
    expectSucceeded(await stack.waitJob(pid, plan.id));
    state = await stack.api<any>('GET', `/projects/${pid}/state`);
    const pilot = Object.values<Clip>(state.docs.clips)[0]!;
    await rejects(stack.api('POST', `/projects/${pid}/clips/${pilot.id}/generate`), 'character_not_locked');
    await rejects(
      stack.api('POST', `/projects/${pid}/characters/${characters[0].id}/lock`),
      'validation_error',
    );

    for (const c of characters) {
      const j = await stack.api<Job>('POST', `/projects/${pid}/characters/${c.id}/references/generate`, {
        views: ['front', 'three_quarter'],
      });
      expectSucceeded(await stack.waitJob(pid, j.id));
    }
    state = await stack.api<any>('GET', `/projects/${pid}/state`);
    for (const c of Object.values<any>(state.docs.characters)) {
      expect(c.references.map((r: { view: string }) => r.view)).toEqual(['front', 'three_quarter']);
      for (const r of c.references)
        await stack.api('PATCH', `/projects/${pid}/characters/${c.id}/references/${r.id}`, {
          approved: true,
        });
      const locked = await stack.api<any>('POST', `/projects/${pid}/characters/${c.id}/lock`);
      expect(locked.lock).toMatchObject({ locked: true, version: 1 });
      await rejects(
        stack.api('PATCH', `/projects/${pid}/characters/${c.id}`, { identity: { hair: 'blonde' } }),
        'character_locked',
      );
    }
    await stack.api('POST', `/projects/${pid}/workflow/approve`, { gate: 'cast_locked' });
    await stack.api('POST', `/projects/${pid}/workflow/approve`, { gate: 'resources_ready' });

    const gc = await stack.api<Job>('POST', `/projects/${pid}/clips/${pilot.id}/generate`);
    expectSucceeded(await stack.waitJob(pid, gc.id));
    await stack.waitIdle(pid);
    state = await stack.api<any>('GET', `/projects/${pid}/state`);
    const generated = state.docs.clips[pilot.id] as Clip;
    expect(generated.status).toBe('review');
    for (const shot of generated.shots) {
      const take = shot.takes.find((t) => t.id === shot.selectedTakeId)!;
      expect(take.consistency.status).toBe('passed');
      expect(take.watermarkId).toMatch(/^wm_/);
      // C2PA Content Credentials signed after the watermark (docs/design/provenance.md#takes)
      expect(take.contentCredentials).toMatchObject({
        manifest: expect.stringMatching(/^urn:c2pa:/),
        signer: 'Rideo Studio (development)',
      });
      expect(take.video?.poster?.mime).toBe('image/jpeg');
      expect(take.video?.videoCodec).toBe('h264');
      expect(Object.keys(take.characterLocks).length).toBe(shot.characterIds.length);
    }

    await stack.api('POST', `/projects/${pid}/clips/${pilot.id}/approve`);
    await stack.api('POST', `/projects/${pid}/workflow/approve`, { gate: 'pilot_approved' });
    state = await stack.api<any>('GET', `/projects/${pid}/state`);
    expect(state.docs.project.settings.models).toMatchObject({
      image: 'mock-image-v1',
      video: 'mock-video-v1',
    });

    const batch = await stack.api<Job>('POST', `/projects/${pid}/batch`, {});
    const batchDone = expectSucceeded(await stack.waitJob(pid, batch.id, 180_000));
    expect((batchDone.result as { stopReason: string }).stopReason).toMatch(/target|outline/);
    await stack.waitIdle(pid);
    state = await stack.api<any>('GET', `/projects/${pid}/state`);
    for (const c of Object.values<Clip>(state.docs.clips))
      if (c.status !== 'approved') await stack.api('POST', `/projects/${pid}/clips/${c.id}/approve`);
    const wf = await stack.api<any>('POST', `/projects/${pid}/workflow/approve`, {
      gate: 'production_approved',
    });
    expect(wf.stage).toBe('edit');

    const music = await stack.api<Job>('POST', `/projects/${pid}/music`, {
      prompt: 'moody ambient piano',
      durationSec: 10,
    });
    const musicJob = expectSucceeded(await stack.waitJob(pid, music.id));
    const assembled = await stack.api<any>('POST', `/projects/${pid}/timeline/assemble`, {
      captions: true,
      musicResourceId: (musicJob.result as { resourceId: string }).resourceId,
    });
    const kinds = Object.fromEntries(
      assembled.timeline.tracks.map((t: { kind: string; items: unknown[] }) => [t.kind, t.items.length]),
    );
    expect(kinds.video).toBe(Object.keys(state.docs.clips).length);
    expect(kinds.audio).toBeGreaterThan(0);
    expect(kinds.text).toBeGreaterThan(0);
    await stack.api('POST', `/projects/${pid}/workflow/approve`, { gate: 'cut_approved' });

    // Rendering happens in an editor tab; the reference worker stands in for it (native ffmpeg, same plan).
    const editor = await startEditorWorker(stack, pid);
    const exp = await stack.api<any>('POST', `/projects/${pid}/exports`, { quality: 'draft' });
    expect(exp.job).toMatchObject({ kind: 'export.render', lane: 'client' });
    const done = await stack.waitExport(pid, exp.export.id);
    await editor.stop();
    expect(done).toMatchObject({ status: 'succeeded', method: 'browser', engine: 'ffmpeg' });
    expect(done.media.mime).toBe('video/mp4');
    const detect = await stack.api<any>('POST', '/watermark/detect', {
      projectId: pid,
      mediaPath: done.media.path,
    });
    expect(detect).toMatchObject({ found: true, id: done.watermarkId });
    expect(detect.provenance.asset).toMatchObject({ kind: 'export', id: done.id });
    // The export's manifest places every take (each with its own manifest) and the generated music.
    const takes = new Set(
      assembled.timeline.tracks
        .flatMap((t: { items: { source?: { type: string; media: { hash: string } } }[] }) => t.items)
        .filter((i: { source?: { type: string } }) => i.source?.type === 'take')
        .map((i: { source: { media: { hash: string } } }) => i.source.media.hash),
    );
    expect(done.disclosure).toMatchObject({ label: false, reason: null });
    expect(done.contentCredentials.ingredients).toBe(takes.size + 1);
    expect(detect.contentCredentials).toMatchObject({
      present: true,
      state: 'valid',
      aiGenerated: true,
      digitalSourceType:
        'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia',
      ingredients: takes.size + 1,
      watermarkId: done.watermarkId,
      bound: true,
      disclosure: { label: false, reason: null },
    });

    const media = await fetch(`${stack.url}/api/projects/${pid}/media/${done.media.path}`, {
      headers: { range: 'bytes=0-99' },
    });
    expect(media.status).toBe(206);
    expect(media.headers.get('content-range')).toBe(`bytes 0-99/${done.media.size}`);
    const md = await fetch(`${stack.url}/dav/rideo/projects/${pid}/screenplay.md`);
    expect(await md.text()).toContain('# The Lighthouse Keeper');

    const tags = (await stack.api<any[]>('GET', `/projects/${pid}/tags`)).map((t) => t.name);
    expect(tags).toEqual(
      expect.arrayContaining([
        'screenplay-approved',
        'cast-locked',
        'pilot-approved',
        'production-approved',
        'cut-approved',
      ]),
    );
    const log = await stack.api<any[]>('GET', `/projects/${pid}/history?limit=500`);
    expect(log.some((c) => c.author.kind === 'system' && c.author.onBehalfOf?.id === 'local')).toBe(true);
  }, 600_000);

  it('invalidates takes when a character is relocked with changes (R6) until regenerated', async () => {
    const { projectId: pid, state } = await readyStoryProject(stack);
    const scene = state.docs.screenplay.scenes[0];
    const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, {
      sceneId: scene.id,
      generate: true,
    });
    expectSucceeded(await stack.waitJob(pid, plan.id));
    await stack.waitIdle(pid);
    let s = await stack.api<any>('GET', `/projects/${pid}/state`);
    const clip = Object.values<Clip>(s.docs.clips)[0]!;
    const cid = clip.shots.flatMap((x) => x.characterIds)[0]!;
    await stack.api('POST', `/projects/${pid}/characters/${cid}/unlock`);
    await stack.api('PATCH', `/projects/${pid}/characters/${cid}`, {
      identity: { hair: 'silver pixie cut' },
    });
    const relocked = await stack.api<any>('POST', `/projects/${pid}/characters/${cid}/lock`);
    expect(relocked.lock.version).toBe(2);
    const blocked = await rejects(
      stack.api('POST', `/projects/${pid}/clips/${clip.id}/approve`),
      'consistency_gate',
    );
    expect(JSON.stringify(blocked.body.errors)).toContain('stale');
    const stale = clip.shots.filter((x) => x.characterIds.includes(cid));
    for (const shot of stale) {
      const j = await stack.api<Job>('POST', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/regenerate`);
      expectSucceeded(await stack.waitJob(pid, j.id));
    }
    s = await stack.api<any>('GET', `/projects/${pid}/state`);
    const approved = await stack.api<Clip>('POST', `/projects/${pid}/clips/${clip.id}/approve`);
    expect(approved.status).toBe('approved');
    expect(s.docs.clips[clip.id].shots.find((x: { id: string }) => x.id === stale[0]!.id).takes.length).toBe(
      2,
    );
  }, 300_000);

  it('fails closed without a judge (R9) and accepts only audited overrides; agents need permission', async () => {
    const { projectId: pid, state } = await readyStoryProject(stack, { consistency: { judge: 'off' } });
    const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, {
      sceneId: state.docs.screenplay.scenes[0].id,
      generate: true,
    });
    expectSucceeded(await stack.waitJob(pid, plan.id));
    await stack.waitIdle(pid);
    const s = await stack.api<any>('GET', `/projects/${pid}/state`);
    const clip = Object.values<Clip>(s.docs.clips)[0]!;
    const shot = clip.shots.find((x) => x.characterIds.length > 0)!;
    const take = shot.takes[0]!;
    expect(take.consistency.status).toBe('unverified');
    await rejects(stack.api('POST', `/projects/${pid}/clips/${clip.id}/approve`), 'consistency_gate');
    for (const sh of clip.shots) {
      const t = sh.takes.find((x) => x.id === sh.selectedTakeId)!;
      if (t.consistency.status !== 'passed') {
        await stack.api('POST', `/projects/${pid}/clips/${clip.id}/shots/${sh.id}/takes/${t.id}/override`, {
          reason: 'Visually verified against the references',
        });
      }
    }
    const approved = await stack.api<Clip>('POST', `/projects/${pid}/clips/${clip.id}/approve`);
    expect(approved.status).toBe('approved');
    const history = await stack.api<any[]>(
      'GET',
      `/projects/${pid}/history?path=${encodeURIComponent(`clips/${clip.id}.json`)}`,
    );
    expect(history.some((c) => c.message.includes('Visually verified'))).toBe(true);
  }, 300_000);
});

describe('consistency gate retries identity drift', () => {
  let flaky: Stack;
  beforeAll(async () => {
    flaky = await startStack({ flakyEvery: 2 });
  });
  afterAll(async () => {
    await flaky?.stop();
  });

  it('regenerates drifted keyframes and videos until the judge passes', async () => {
    const { projectId: pid, state } = await readyStoryProject(flaky);
    const plan = await flaky.api<Job>('POST', `/projects/${pid}/clips/plan`, {
      sceneId: state.docs.screenplay.scenes[0].id,
      generate: true,
    });
    expectSucceeded(await flaky.waitJob(pid, plan.id));
    await flaky.waitIdle(pid);
    const s = await flaky.api<any>('GET', `/projects/${pid}/state`);
    const shots = Object.values<Clip>(s.docs.clips)[0]!.shots.filter((x) => x.characterIds.length > 0);
    const takes = shots.map((x) => x.takes.find((t) => t.id === x.selectedTakeId)!);
    expect(takes.every((t) => t.consistency.status === 'passed')).toBe(true);
    expect(takes.some((t) => t.consistency.attempts > 1 || t.gatewayTaskIds.length > 2)).toBe(true);
    expect(flaky.gw.counters.flaky).toBeGreaterThan(0);
  }, 300_000);
});
