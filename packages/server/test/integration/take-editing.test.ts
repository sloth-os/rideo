import type { Clip, Job, Resource, Shot, Take, Timeline } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFootage, uploadReady } from '../helpers/media';
import { ApiError, expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** Editing and extending takes, generative extend in the cut (docs/design/take-editing.md). */
let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
}, 60_000);
afterAll(async () => stack?.stop());

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

const requestOf = (taskId: string) => stack.gw.store.requests.get(taskId) as any;
const shotNow = async (pid: string, clipId: string, shotId: string) =>
  ((await stack.api<any>('GET', `/projects/${pid}/state`)).docs.clips[clipId] as Clip).shots.find(
    (s) => s.id === shotId,
  )!;

/** A project whose first scene has a generated, passing take per shot. */
async function generated() {
  const { projectId: pid, state } = await readyStoryProject(stack, { storyboard: { enabled: false } });
  const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, {
    sceneId: state.docs.screenplay.scenes[0].id,
    generate: true,
  });
  expectSucceeded(await stack.waitJob(pid, plan.id));
  await stack.waitIdle(pid);
  const clip = Object.values<Clip>((await stack.api<any>('GET', `/projects/${pid}/state`)).docs.clips)[0]!;
  const shot = [...clip.shots].sort((a, b) => a.index - b.index)[0]!;
  const take = shot.takes.find((t) => t.id === shot.selectedTakeId)!;
  expect(take.consistency.status).toBe('passed');
  return { pid, clip, shot, take };
}

describe('take edits', () => {
  it('relights a take into a verified, signed derived take that keeps the sound and the dialogue', async () => {
    const { pid, clip, shot, take } = await generated();
    await rejects(
      stack.api('POST', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/takes/${take.id}/edit`, {
        kind: 'relight',
        instruction: 'x',
      }),
      'validation_error',
    );
    const job = await stack.api<Job>(
      'POST',
      `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/takes/${take.id}/edit`,
      {
        kind: 'relight',
        instruction: 'warm golden-hour light from the window',
      },
    );
    expect(job).toMatchObject({ kind: 'take.edit', lane: 'video' });
    expectSucceeded(await stack.waitJob(pid, job.id));
    const after = await shotNow(pid, clip.id, shot.id);
    const derived = after.takes.at(-1)!;
    expect(derived.derivedFrom).toEqual({
      takeId: take.id,
      op: 'edit',
      kind: 'relight',
      instruction: 'warm golden-hour light from the window',
    });
    expect(derived.consistency.status).toBe('passed');
    expect(after.selectedTakeId).toBe(derived.id);
    expect(derived.request.prompt).toBe(
      'Relight the video: warm golden-hour light from the window. Keep the people, their faces, the action and the camera move unchanged.',
    );
    expect(derived.audio).toEqual(take.audio);
    expect(derived.watermarkId).toMatch(/^wm_/);
    const request = requestOf(derived.gatewayTaskIds[0]!);
    expect(request.input.map((p: { type: string; role?: string }) => p.role ?? p.type)).toEqual(
      expect.arrayContaining(['text', 'reference_video', 'reference_image']),
    );
    expect(request.parameters.include_audio).toBe(false);
    // The derived take is an AI edit of its parent: its manifest carries the parent as an ingredient.
    const detect = await stack.api<any>('POST', '/watermark/detect', {
      projectId: pid,
      mediaPath: derived.video!.path,
    });
    expect(detect).toMatchObject({ found: true, id: derived.watermarkId });
    expect(detect.contentCredentials).toMatchObject({ present: true, aiGenerated: true, ingredients: 1 });
  }, 300_000);

  it('shows the same moment from a new angle', async () => {
    const { pid, clip, shot, take } = await generated();
    const job = await stack.api<Job>(
      'POST',
      `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/takes/${take.id}/edit`,
      {
        kind: 'angle',
        instruction: 'from behind the keeper, over her shoulder',
      },
    );
    expectSucceeded(await stack.waitJob(pid, job.id));
    const derived = (await shotNow(pid, clip.id, shot.id)).takes.at(-1)!;
    expect(derived.derivedFrom).toMatchObject({ op: 'edit', kind: 'angle' });
    expect(derived.consistency.status).toBe('passed');
    // as long as the parent (its container can be padded by its sound)
    expect(Math.abs(derived.durationSec! - take.durationSec!)).toBeLessThan(1);
  }, 300_000);
});

describe('take extensions', () => {
  it('continues a take from its last frame into a longer derived take', async () => {
    const { pid, clip, shot, take } = await generated();
    await rejects(
      stack.api('POST', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/takes/${take.id}/extend`, {
        seconds: 20,
      }),
      'validation_error',
    );
    const job = await stack.api<Job>(
      'POST',
      `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/takes/${take.id}/extend`,
      { seconds: 3, prompt: 'she turns to the window' },
    );
    expect(job).toMatchObject({ kind: 'take.extend', lane: 'video' });
    expectSucceeded(await stack.waitJob(pid, job.id));
    const derived: Take = (await shotNow(pid, clip.id, shot.id)).takes.at(-1)!;
    expect(derived.derivedFrom).toEqual({
      takeId: take.id,
      op: 'extend',
      seconds: 3,
      instruction: 'she turns to the window',
    });
    expect(derived.consistency.status).toBe('passed');
    expect(derived.durationSec!).toBeGreaterThan(take.durationSec! + 2.5);
    expect(derived.durationSec!).toBeLessThan(take.durationSec! + 3.5);
    const request = requestOf(derived.gatewayTaskIds[0]!);
    expect(request.input.some((p: { role?: string }) => p.role === 'first_frame')).toBe(true);
    expect(request.parameters.duration_seconds).toBe(3);
    expect(derived.request.prompt).toContain(
      'Continue the action seamlessly from the first frame: she turns to the window.',
    );
  }, 300_000);
});

describe('generative extend in the cut', () => {
  it('inserts generated frames after a take and before footage, signed as AI-generated', async () => {
    const { pid, clip } = await generated();
    await stack.api('POST', `/projects/${pid}/clips/${clip.id}/approve`);
    const { timeline } = await stack.api<{ timeline: Timeline }>(
      'POST',
      `/projects/${pid}/timeline/assemble`,
      {},
    );
    const video = timeline.tracks[0]!;
    const first = video.items[0]!;
    const before = video.items.length;
    const total = (t: Timeline) =>
      t.tracks[0]!.items.reduce((n, i) => n + ((i as { out: number }).out - (i as { in: number }).in), 0);
    const job = await stack.api<Job>('POST', `/projects/${pid}/timeline/items/${first.id}/extend`, {
      edge: 'end',
      seconds: 2,
    });
    expect(job).toMatchObject({ kind: 'timeline.extend', lane: 'video' });
    const done = expectSucceeded(await stack.waitJob(pid, job.id));
    const after = await stack.api<Timeline>('GET', `/projects/${pid}/timeline`);
    expect(after.tracks[0]!.items).toHaveLength(before + 1);
    const inserted = after.tracks[0]!.items[1] as { id: string; source: { resourceId: string }; out: number };
    expect(inserted.id).toBe((done.result as { itemId: string }).itemId);
    expect(inserted.out).toBe(2);
    expect(total(after)).toBeCloseTo(total(timeline) + 2, 1);
    const resource = (await stack.api<any>('GET', `/projects/${pid}/state`)).docs.resources[
      inserted.source.resourceId
    ] as Resource;
    expect(resource).toMatchObject({
      kind: 'video',
      role: 'extension',
      origin: 'generated',
      status: 'ready',
    });
    expect(resource.media.durationSec).toBeCloseTo(2, 0);
    const detect = await stack.api<any>('POST', '/watermark/detect', {
      projectId: pid,
      mediaPath: resource.media.path,
    });
    expect(detect.found).toBe(true);
    expect(detect.provenance.asset).toMatchObject({ kind: 'resource', id: resource.id });
    expect(detect.contentCredentials).toMatchObject({ present: true, aiGenerated: true, ingredients: 1 });
    // A model without last frames cannot lead into an item.
    await stack.api('PATCH', `/projects/${pid}`, { settings: { models: { video: 'mock-video-lite-v1' } } });
    await rejects(
      stack.api('POST', `/projects/${pid}/timeline/items/${first.id}/extend`, { edge: 'start', seconds: 1 }),
      'validation_error',
    );
  }, 300_000);

  it('leads into footage of an edit project with generated frames', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'edit',
      title: 'Footage extend',
      settings: { resolution: { width: 320, height: 180 } },
    });
    const footage = await uploadReady(stack, p.id, await makeFootage(stack.dataDir), {
      mime: 'video/mp4',
      name: 'src.mp4',
      role: 'source',
    });
    const track = (await stack.api<Timeline>('GET', `/projects/${p.id}/timeline`)).tracks[0]!.id;
    const t = await stack.api<{ timeline: Timeline }>('POST', `/projects/${p.id}/timeline/ops`, {
      ops: [
        {
          op: 'insert',
          trackId: track,
          item: { kind: 'video', source: { type: 'media', media: footage.media }, in: 1, out: 4 },
        },
      ],
    });
    const item = t.timeline.tracks[0]!.items[0]!;
    const job = await stack.api<Job>('POST', `/projects/${p.id}/timeline/items/${item.id}/extend`, {
      edge: 'start',
      seconds: 1.5,
      prompt: 'the camera settles',
    });
    expectSucceeded(await stack.waitJob(p.id, job.id));
    const after = await stack.api<Timeline>('GET', `/projects/${p.id}/timeline`);
    expect(after.tracks[0]!.items.map((i) => (i as { out: number }).out)).toEqual([1.5, 4]);
    const task = [...stack.gw.store.requests.values()].at(-1) as any;
    expect(task.input[0].text).toBe('Lead into the last frame seamlessly: the camera settles.');
    expect(task.input[1].role).toBe('last_frame');
  }, 300_000);
});

export type { Shot };
