import type { Clip, Job } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** Multi-shot generation (docs/design/multi-shot.md) with the mock's multi-shot model. */
let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
}, 60_000);
afterAll(async () => stack?.stop());

const requestOf = (taskId: string) => stack.gw.store.requests.get(taskId) as any;
const clipNow = async (pid: string, clipId: string) =>
  (await stack.api<any>('GET', `/projects/${pid}/state`)).docs.clips[clipId] as Clip;
const jobsOf = (pid: string) => stack.api<Job[]>('GET', `/projects/${pid}/jobs`);

/**
 * A scene planned into three 10 s shots (on the 10 s mock model), then generated with the multi-shot model (four
 * shots, 20 s per request): the first two render together, the third alone.
 */
async function threeShotClip(settings: Record<string, unknown> = {}) {
  const { projectId: pid, state } = await readyStoryProject(stack, {
    storyboard: { enabled: false },
    targetDurationSec: 60,
    pilotDurationSec: 30,
    ...settings,
  });
  const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, {
    sceneId: state.docs.screenplay.scenes[0].id,
  });
  expectSucceeded(await stack.waitJob(pid, plan.id));
  const clip = Object.values<Clip>((await stack.api<any>('GET', `/projects/${pid}/state`)).docs.clips)[0]!;
  expect(clip.shots.map((s) => s.durationSec)).toEqual([10, 10, 10]);
  await stack.api('PATCH', `/projects/${pid}`, { settings: { models: { video: 'mock-multishot-v1' } } });
  return { pid, clip, shots: [...clip.shots].sort((a, b) => a.index - b.index) };
}

async function generate(pid: string, clipId: string) {
  const job = await stack.api<Job>('POST', `/projects/${pid}/clips/${clipId}/generate`);
  expectSucceeded(await stack.waitJob(pid, job.id, 180_000));
  await stack.waitIdle(pid);
}

describe('multi-shot generation', () => {
  it('renders consecutive shots in one request, splits at the detected cut and verifies every shot', async () => {
    const { pid, clip, shots } = await threeShotClip();
    await generate(pid, clip.id);
    const jobs = await jobsOf(pid);
    const groups = jobs.filter((j) => j.kind === 'shot.group');
    expect(groups.map((j) => j.params.shotIds)).toEqual([[shots[0]!.id, shots[1]!.id]]);
    expect(jobs.filter((j) => j.kind === 'shot.generate').map((j) => j.params.shotId)).toEqual([
      shots[2]!.id,
    ]);

    const done = await clipNow(pid, clip.id);
    const [a, b, c] = [...done.shots].sort((x, y) => x.index - y.index).map((s) => s.takes.at(-1)!);
    expect(a!.request.multiShot).toEqual({ index: 0, of: 2, cut: 'detected' });
    expect(b!.request.multiShot).toEqual({ index: 1, of: 2, cut: 'detected' });
    expect(c!.request.multiShot).toBeNull();
    for (const t of [a!, b!]) {
      expect(t.consistency.status).toBe('passed');
      expect(t.durationSec!).toBeGreaterThan(9);
      expect(t.durationSec!).toBeLessThan(11);
      expect(t.watermarkId).toMatch(/^wm_/);
    }
    // the first shot keeps its verified keyframe; both segments come from the same render
    expect(a!.keyframe).not.toBeNull();
    expect(a!.request.firstFrameSource).toBe('keyframe');
    expect(a!.gatewayTaskIds.at(-1)).toBe(b!.gatewayTaskIds[0]);
    const request = requestOf(b!.gatewayTaskIds[0]!);
    expect(request.model).toBe('mock-multishot-v1');
    expect(request.parameters.duration_seconds).toBe(20);
    expect(request.input[0].text).toContain('A multi-shot sequence of 2 shots separated by hard cuts.');
    expect(request.input[0].text).toContain('Shot 1 (10 s):');
    expect(request.input[0].text).toContain('Shot 2 (10 s):');
    expect(request.input.filter((p: { role?: string }) => p.role === 'first_frame')).toHaveLength(1);
    // speaking shots of the sequence carry their TTS dialogue
    for (const s of done.shots.filter((x) => x.index < 2 && x.dialogue.some((d) => d.characterId)))
      expect(s.takes.at(-1)!.audio).toMatchObject({ mode: 'tts', lipSync: 'none' });
    // the clip is approved like any other
    await stack.api('POST', `/projects/${pid}/clips/${clip.id}/approve`);
  }, 300_000);

  it('generates shot by shot when turned off or when a shot needs its own request', async () => {
    const off = await threeShotClip({ generation: { multiShot: 'off' } });
    await generate(off.pid, off.clip.id);
    let jobs = await jobsOf(off.pid);
    expect(jobs.filter((j) => j.kind === 'shot.group')).toHaveLength(0);
    expect(jobs.filter((j) => j.kind === 'shot.generate')).toHaveLength(3);
    expect(
      (await clipNow(off.pid, off.clip.id)).shots.every((s) => s.takes.at(-1)!.request.multiShot === null),
    ).toBe(true);

    // multi-shot on, but the second shot ends on a generated frame: no group can form around it
    const own = await threeShotClip();
    await stack.api('PATCH', `/projects/${own.pid}/clips/${own.clip.id}/shots/${own.shots[1]!.id}`, {
      endFrame: { mode: 'generate', description: 'The keeper closes the door.' },
    });
    await generate(own.pid, own.clip.id);
    jobs = await jobsOf(own.pid);
    expect(jobs.filter((j) => j.kind === 'shot.group')).toHaveLength(0);
    expect(jobs.filter((j) => j.kind === 'shot.generate')).toHaveLength(3);
  }, 300_000);
});
