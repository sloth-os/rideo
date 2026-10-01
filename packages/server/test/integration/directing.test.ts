import type { Clip, Job, Shot, Take } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFootage, makeStill, uploadReady } from '../helpers/media';
import { ApiError, expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** Directing controls (docs/design/directing.md) against the mock gateway. */
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

/** A project with its first scene planned (storyboard off: shots generate their own keyframes). */
async function planned(settings: Record<string, unknown> = {}) {
  const { projectId: pid, state } = await readyStoryProject(stack, {
    storyboard: { enabled: false },
    ...settings,
  });
  const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, {
    sceneId: state.docs.screenplay.scenes[0].id,
  });
  expectSucceeded(await stack.waitJob(pid, plan.id));
  const clip = Object.values<Clip>((await stack.api<any>('GET', `/projects/${pid}/state`)).docs.clips)[0]!;
  return { pid, clip, shot: [...clip.shots].sort((a, b) => a.index - b.index)[0]! };
}

async function generate(pid: string, clip: Clip, shot: Shot): Promise<Take> {
  const job = await stack.api<Job>('POST', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/regenerate`);
  expectSucceeded(await stack.waitJob(pid, job.id));
  const c = (await stack.api<any>('GET', `/projects/${pid}/state`)).docs.clips[clip.id] as Clip;
  return c.shots.find((s) => s.id === shot.id)!.takes.at(-1)!;
}

/** What Rideo asked the mock gateway for, by task id. */
const requestOf = (taskId: string) => stack.gw.store.requests.get(taskId) as any;

describe('directing controls', () => {
  it('compiles the move, lens and aperture into the prompt and camera_motion, with a fixed seed', async () => {
    const { pid, clip, shot } = await planned();
    await stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}`, {
      camera: { move: 'locked_off', lensMm: 85, aperture: 1.8 },
      seed: 4242,
    });
    const take = await generate(pid, clip, shot);
    expect(take.consistency.status).toBe('passed');
    expect(take.request.prompt).toContain(
      'locked-off static camera; 85mm lens, f/1.8 shallow depth of field.',
    );
    expect(take.request.seed).toBe(4242);
    const video = requestOf(take.gatewayTaskIds.at(-1)!);
    expect(video.parameters).toMatchObject({ camera_motion: 'fixed', seed: 4242 });
    // the keyframe gets the framing and the lens, not the move
    const keyframe = requestOf(take.gatewayTaskIds[0]!);
    expect(keyframe.input[0].text).toContain('; 85mm lens, f/1.8 shallow depth of field.');
    expect(keyframe.input[0].text).not.toContain('locked-off');
    await rejects(
      stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}`, {
        camera: { move: 'moonwalk' },
      }),
      'validation_error',
    );
  }, 300_000);

  it('generates and verifies an end frame, or uses an image resource, as the last frame', async () => {
    const { pid, clip, shot } = await planned();
    await rejects(
      stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}`, {
        endFrame: { mode: 'generate', description: ' ' },
      }),
      'validation_error',
    );
    await stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}`, {
      endFrame: { mode: 'generate', description: 'The keeper stands at the open door, rain behind her.' },
    });
    const take = await generate(pid, clip, shot);
    expect(take.consistency.status).toBe('passed');
    expect(take.endKeyframe).toMatchObject({ mime: 'image/png' });
    expect(take.request.lastFrameSource).toBe('generated');
    // keyframe, end keyframe, video
    expect(take.gatewayTaskIds).toHaveLength(3);
    const endRequest = requestOf(take.gatewayTaskIds[1]!);
    expect(endRequest.input[0].text).toContain('The keeper stands at the open door, rain behind her.');
    const video = requestOf(take.gatewayTaskIds[2]!);
    expect(video.input.filter((p: { role?: string }) => p.role === 'last_frame')).toHaveLength(1);

    // An image resource as the last frame; a model without last frames does not get it.
    const still = await uploadReady(stack, pid, await makeStill(stack.dataDir, 'door.png'), {
      mime: 'image/png',
      name: 'door.png',
    });
    expect(still).toMatchObject({ kind: 'image', status: 'ready' });
    await stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}`, {
      endFrame: { mode: 'resource', resourceId: still.id },
    });
    const withResource = await generate(pid, clip, shot);
    expect(withResource.request.lastFrameSource).toBe('resource');
    expect(withResource.endKeyframe).toBeNull();
    await stack.api('PATCH', `/projects/${pid}`, { settings: { models: { video: 'mock-video-lite-v1' } } });
    const lite = await generate(pid, clip, shot);
    expect(lite.request.lastFrameSource).toBeNull();
    expect(
      requestOf(lite.gatewayTaskIds.at(-1)!).input.some((p: { role?: string }) => p.role === 'last_frame'),
    ).toBe(false);
  }, 300_000);

  it('starts on an image resource and follows a reference video', async () => {
    const { pid, clip, shot } = await planned();
    const still = await uploadReady(stack, pid, await makeStill(stack.dataDir, 'start.png', 'orange'), {
      mime: 'image/png',
      name: 'start.png',
    });
    const footage = await uploadReady(stack, pid, await makeFootage(stack.dataDir), {
      mime: 'video/mp4',
      name: 'dance.mp4',
    });
    expect(footage).toMatchObject({ kind: 'video', status: 'ready' });
    await rejects(
      stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}`, {
        motionReference: { resourceId: still.id, mode: 'pose' },
      }),
      'validation_error',
    );
    await stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}`, {
      startFrame: { mode: 'resource', resourceId: still.id },
      motionReference: { resourceId: footage.id, mode: 'pose' },
    });
    const take = await generate(pid, clip, shot);
    expect(take.request.firstFrameSource).toBe('resource');
    expect(take.keyframe).toBeNull();
    // no keyframe generation: only video tasks (the plain still shows none of the cast, so the judge retries)
    expect(take.gatewayTaskIds.every((id) => id.startsWith('vid_'))).toBe(true);
    expect(take.request.motionReference).toEqual({ resourceId: footage.id, mode: 'pose' });
    expect(take.request.prompt).toContain('Match the body poses and blocking of the reference video.');
    const video = requestOf(take.gatewayTaskIds[0]!);
    expect(video.input.map((p: { role?: string }) => p.role)).toEqual(
      expect.arrayContaining(['first_frame', 'reference_video']),
    );
  }, 300_000);

  it('generates variations with offset seeds to compare', async () => {
    const { pid, clip, shot } = await planned();
    const jobs = await stack.api<Job[]>(
      'POST',
      `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/variations`,
      {
        count: 2,
      },
    );
    expect(jobs.map((j) => j.params)).toEqual([
      { clipId: clip.id, shotId: shot.id, variation: 1 },
      { clipId: clip.id, shotId: shot.id, variation: 2 },
    ]);
    for (const j of jobs) expectSucceeded(await stack.waitJob(pid, j.id));
    const takes = (
      (await stack.api<any>('GET', `/projects/${pid}/state`)).docs.clips[clip.id] as Clip
    ).shots.find((s) => s.id === shot.id)!.takes;
    expect(takes.map((t) => t.variation).sort()).toEqual([1, 2]);
    const [a, b] = takes.sort((x, y) => x.variation - y.variation);
    expect(b!.request.seed - a!.request.seed).toBe(104_729);
    // the next batch continues the numbering
    const more = await stack.api<Job[]>(
      'POST',
      `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/variations`,
      {
        count: 2,
      },
    );
    expect(more.map((j) => j.params.variation)).toEqual([3, 4]);
    await rejects(
      stack.api('POST', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/variations`, { count: 9 }),
      'validation_error',
    );
  }, 300_000);
});
