import { startMockGateway } from '@rideo/mock-gateway';
import type { Clip, Job } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** Continuity, storytelling and realism (docs/design/continuity.md) on the mock gateway. */
let stack: Stack;
beforeAll(async () => {
  // With an audio-visual model, so every take with a sound track is heard (the sound check).
  stack = await startStack({
    gw: await startMockGateway({ latencyMs: 20 }),
    env: { RIDEO_OMNI_MODEL: 'mock-omni' },
  });
}, 60_000);
afterAll(async () => {
  await stack?.stop();
  await stack?.gw.close();
});

const requestOf = (taskId: string) => stack.gw.store.requests.get(taskId) as any;
const stateOf = (pid: string) => stack.api<any>('GET', `/projects/${pid}/state`);

async function plannedClip(settings: Record<string, unknown> = {}) {
  const { projectId: pid, state } = await readyStoryProject(stack, {
    storyboard: { enabled: false },
    // Three 10 s shots on the mock model: cut, continuous, cut.
    pilotDurationSec: 30,
    targetDurationSec: 60,
    dialogue: { mode: 'off', level: 'B1' },
    generation: { includeAudio: true },
    ...settings,
  });
  const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, {
    sceneId: state.docs.screenplay.scenes[0].id,
  });
  expectSucceeded(await stack.waitJob(pid, plan.id));
  const clip = Object.values<Clip>((await stateOf(pid)).docs.clips)[0]!;
  return { pid, clip, state: await stateOf(pid) };
}

async function generate(pid: string, clipId: string) {
  const job = await stack.api<Job>('POST', `/projects/${pid}/clips/${clipId}/generate`);
  expectSucceeded(await stack.waitJob(pid, job.id, 180_000));
  await stack.waitIdle(pid);
  return (await stateOf(pid)).docs.clips[clipId] as Clip;
}

describe('continuity-aware generation (prompt version 2)', () => {
  it('sees a cast member who walks into a shot that is not theirs, in the keyframe and in the video', async () => {
    const { pid, clip } = await plannedClip();
    const single = [...clip.shots]
      .sort((a, b) => a.index - b.index)
      .find((s) => s.index > 0 && s.continuity === 'cut' && s.characterIds.length === 1)!;
    expect(single).toBeTruthy();
    await stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${single.id}`, {
      description: `${single.description} Another cast member photobombs the shot.`,
    });
    const job = await stack.api<Job>(
      'POST',
      `/projects/${pid}/clips/${clip.id}/shots/${single.id}/regenerate`,
    );
    expectSucceeded(await stack.waitJob(pid, job.id, 180_000));
    await stack.waitIdle(pid);
    const state = await stateOf(pid);
    const shot = (state.docs.clips[clip.id] as Clip).shots.find((s) => s.id === single.id)!;
    const other = Object.values<{ id: string; name: string }>(state.docs.characters).find(
      (c) => clip.shots.some((s) => s.characterIds.includes(c.id)) && !single.characterIds.includes(c.id),
    )!;
    const take = shot.takes.at(-1)!;
    expect(take.consistency.quality).toMatchObject({ passed: false, extras: [other.name] });
    expect(take.consistency.quality?.issues).toContain(
      `${other.name} is in the frame, though the shot is not theirs`,
    );
    expect(take.consistency.attempts).toBe(3);
    // The keyframe was drawn three times as well, told who is in frame
    const images = take.gatewayTaskIds
      .map(requestOf)
      .filter((r) => r && r.parameters?.duration_seconds === undefined);
    expect(images).toHaveLength(3);
    expect(images[0].input[0].text).toContain(`; ${other.name} is out of frame.`);
  });

  it('hears every take: a take whose line is not heard is generated again, and records what was heard', async () => {
    expect((await stack.api<any>('GET', '/config')).features.omni).toBe('mock-omni');
    const { pid, clip } = await plannedClip();
    const generated = await generate(pid, clip.id);
    const spoken = generated.shots.find((s) => s.dialogue.some((d) => d.characterId))!;
    expect(spoken).toBeTruthy();
    const first = spoken.takes.find((t) => t.id === spoken.selectedTakeId)!;
    expect(first.consistency.quality).toMatchObject({
      passed: true,
      sound: { lines: [{ heard: 1 }], music: false, unexpectedSpeech: false, score: 0.85 },
    });
    expect(first.consistency.quality?.sound?.transcript).toContain(spoken.dialogue[0]!.line);
    for (const s of generated.shots.filter((x) => !x.dialogue.length))
      expect(s.takes.find((t) => t.id === s.selectedTakeId)!.consistency.quality?.sound).toMatchObject({
        lines: [],
        unexpectedSpeech: false,
      });

    // The video model does not voice the line once: nothing is heard, and the shot is generated again.
    stack.gw.muffleSpeech(1);
    const job = await stack.api<Job>(
      'POST',
      `/projects/${pid}/clips/${clip.id}/shots/${spoken.id}/regenerate`,
    );
    expectSucceeded(await stack.waitJob(pid, job.id, 180_000));
    await stack.waitIdle(pid);
    const after = ((await stateOf(pid)).docs.clips[clip.id] as Clip).shots.find((s) => s.id === spoken.id)!;
    const take = after.takes.at(-1)!;
    expect(take.id).not.toBe(first.id);
    expect(take.consistency.attempts).toBe(2);
    expect(take.consistency.quality).toMatchObject({ passed: true, sound: { lines: [{ heard: 1 }] } });
    const metrics = await (await fetch(`${stack.url}/metrics`)).text();
    expect(metrics).toMatch(/rideo_quality_checks_total\{check="sound",result="failed"\} 1/);
  });

  it('generates a take with music again only when the film rejects music', async () => {
    const { pid, clip } = await plannedClip();
    const shot = [...clip.shots].sort((a, b) => a.index - b.index)[0]!;
    await stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}`, {
      description: `${shot.description} A radio plays music on the table.`,
    });
    const regenerate = async () => {
      const job = await stack.api<Job>(
        'POST',
        `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/regenerate`,
      );
      expectSucceeded(await stack.waitJob(pid, job.id, 180_000));
      await stack.waitIdle(pid);
      return ((await stateOf(pid)).docs.clips[clip.id] as Clip).shots
        .find((s) => s.id === shot.id)!
        .takes.at(-1)!;
    };
    // Advisory by default: reported, kept at the first attempt
    const heard = await regenerate();
    expect(heard.consistency.attempts).toBe(1);
    expect(heard.consistency.quality).toMatchObject({ passed: true, sound: { music: true } });
    expect(heard.consistency.quality?.issues).toContain(
      'music plays in the take (the film’s score is added later)',
    );
    // Rejected: every attempt is made, and the take fails its sound check
    await stack.api('PATCH', `/projects/${pid}`, { settings: { consistency: { rejectMusic: true } } });
    const rejected = await regenerate();
    expect(rejected.consistency.attempts).toBe(3);
    expect(rejected.consistency.quality).toMatchObject({ passed: false, sound: { music: true } });
  });

  it('fails a take with anything shown twice and generates it again', async () => {
    const { pid, clip } = await plannedClip();
    const shot = [...clip.shots].sort((a, b) => a.index - b.index)[0]!;
    // The mock judge sees a second beach ball in a shot that says something appears twice
    await stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}`, {
      description: `${shot.description} The beach ball appears twice.`,
    });
    const job = await stack.api<Job>('POST', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/regenerate`);
    expectSucceeded(await stack.waitJob(pid, job.id, 180_000));
    await stack.waitIdle(pid);
    const take = ((await stateOf(pid)).docs.clips[clip.id] as Clip).shots
      .find((s) => s.id === shot.id)!
      .takes.at(-1)!;
    expect(take.consistency.attempts).toBe(3);
    expect(take.consistency.quality).toMatchObject({ passed: false, duplicates: ['a second beach ball'] });
    expect(take.consistency.quality?.issues).toContain('shown twice: a second beach ball');
  });

  it('waits for a busy provider instead of failing the shot (docs/design/ai-gateway.md#sdk-usage)', async () => {
    const { pid, clip } = await plannedClip();
    const shot = [...clip.shots].sort((a, b) => a.index - b.index)[0]!;
    const before = stack.gw.counters.busy;
    stack.gw.busyCreates(3);
    const job = await stack.api<Job>('POST', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/regenerate`);
    const done = expectSucceeded(await stack.waitJob(pid, job.id, 180_000));
    // The waits are not runs of the job: the provider made no task
    expect(done.attempts).toBe(1);
    expect(stack.gw.counters.busy - before).toBe(3);
    const metrics = await (await fetch(`${stack.url}/metrics`)).text();
    const busy = [...metrics.matchAll(/rideo_gateway_tasks_total\{modality="\w+",status="busy"\} (\d+)/g)];
    expect(busy.reduce((n, m) => n + Number(m[1]), 0)).toBeGreaterThanOrEqual(3);
  });

  it('creates projects with version 2 prompts and quality checks, and plans with the brief, the level and lenses', async () => {
    const { pid, clip, state } = await plannedClip();
    const settings = state.docs.project.settings;
    expect(settings.generation.promptVersion).toBe(2);
    expect(settings.consistency.qualityChecks).toBe(true);
    expect(state.docs.screenplay.scenes[0].continuity).toMatch(/night|day/);
    expect(state.docs.screenplay.outline[0].purpose).toBe('setup');
    // The mock answers a lens and an end state only to a version 2 planning request.
    for (const shot of clip.shots) {
      expect(shot.camera.lensMm).toBeGreaterThan(0);
      expect(shot.endState).not.toBe('');
    }
    const generated = await generate(pid, clip.id);
    const shots = [...generated.shots].sort((a, b) => a.index - b.index);
    const takes = shots.map((s) => s.takes.find((t) => t.id === s.selectedTakeId)!);
    for (const t of takes) {
      expect(t.consistency.status).toBe('passed');
      expect(t.consistency.quality).toMatchObject({ passed: true, physics: 0.95 });
      expect(t.consistency.quality?.temporal?.jumps).toEqual([]);
    }
    // Video prompts are blocks; lines carry their voice; silent shots say so.
    const video = requestOf(takes[0]!.gatewayTaskIds.at(-1)!);
    // The structure first, nothing that reads as another shot (docs/design/continuity.md#what-the-video-model-reads)
    expect(video.input[0].text).toMatch(/^One continuous shot, no cuts\. /);
    expect(video.input[0].text).not.toContain('camera style');
    expect(video.input[0].text).toContain('Scene: ');
    expect(video.input[0].text).toContain('Physics:');
    expect(video.parameters.negative_prompt).toContain('morphing');
    const spoken = shots.findIndex((s) => s.dialogue.length > 0);
    if (spoken >= 0)
      expect(requestOf(takes[spoken]!.gatewayTaskIds.at(-1)!).input[0].text).toMatch(/says, in an? [^:]+: "/);
    // The first shot went first; later keyframes carry its keyframe as the scene reference.
    const keyframes = shots
      .slice(1)
      .filter((s, i) => s.continuity === 'cut' && takes[i + 1]!.request.firstFrameSource === 'keyframe');
    expect(keyframes.length).toBeGreaterThan(0);
    for (const s of keyframes) {
      const t = s.takes.find((x) => x.id === s.selectedTakeId)!;
      const image = requestOf(t.gatewayTaskIds[0]!);
      expect(image.input[0].text).toContain('The last image is the scene reference');
      // The previous shot's end state conditions the keyframe, never the video that starts from it
      expect(image.input[0].text).toContain('Continues from the previous shot:');
      expect(requestOf(t.gatewayTaskIds.at(-1)!).input[0].text).not.toContain(
        'Continues from the previous shot',
      );
      expect(image.input.filter((p: { type: string }) => p.type === 'image').length).toBe(
        t.request.referenceCount + 1,
      );
    }
    const jobs = await stack.api<Job[]>('GET', `/projects/${pid}/jobs`);
    const shotJobs = jobs
      .filter((j) => j.kind === 'shot.generate')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(shotJobs[0]!.params.shotId).toBe(shots[0]!.id);
    expect(Date.parse(shotJobs[1]!.createdAt)).toBeGreaterThanOrEqual(Date.parse(shotJobs[0]!.finishedAt!));
  });

  it('retries a take that jumps inside the shot, and keeps a take that fails physics on every attempt, marked', async () => {
    const { pid, clip } = await plannedClip();
    const generated = await generate(pid, clip.id);
    const shot = [...generated.shots].sort((a, b) => a.index - b.index)[0]!;
    // The next video jumps: the temporal check retries it.
    stack.gw.jumpVideos(1);
    const regen = await stack.api<Job>(
      'POST',
      `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/regenerate`,
    );
    expectSucceeded(await stack.waitJob(pid, regen.id));
    let now = (await stateOf(pid)).docs.clips[clip.id] as Clip;
    let take = now.shots.find((s) => s.id === shot.id)!.takes.at(-1)!;
    const videos = take.gatewayTaskIds.filter((id) => requestOf(id)?.parameters?.duration_seconds);
    expect(videos.length, `regenerated take: ${JSON.stringify(take.consistency.quality)}`).toBe(2);
    expect(take.consistency.attempts).toBe(2);
    expect(take.consistency.quality).toMatchObject({ passed: true });
    expect(take.gatewayTaskIds.filter((id) => requestOf(id)?.parameters?.duration_seconds).length).toBe(2);

    // A shot about floating fails physics every time: the best identity-passing take is kept, marked.
    await stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}`, {
      description: 'Mira floating above the floor',
    });
    const again = await stack.api<Job>(
      'POST',
      `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/regenerate`,
    );
    expectSucceeded(await stack.waitJob(pid, again.id));
    now = (await stateOf(pid)).docs.clips[clip.id] as Clip;
    take = now.shots.find((s) => s.id === shot.id)!.takes.at(-1)!;
    expect(take.consistency.status).toBe('passed');
    // Every attempt was made (the report keeps which one was kept: the first of equals).
    expect(take.gatewayTaskIds.filter((id) => requestOf(id)?.parameters?.duration_seconds).length).toBe(3);
    expect(take.consistency.quality).toMatchObject({ passed: false, physics: 0.2 });
    expect(take.consistency.quality?.issues).toContain('the character floats above the ground');
    const metrics = await (await fetch(`${stack.url}/metrics`)).text();
    expect(metrics).toMatch(/rideo_quality_checks_total\{check="temporal",result="failed"\} [1-9]/);
    expect(metrics).toMatch(/rideo_quality_checks_total\{check="physics",result="failed"\} [1-9]/);
  });

  it('re-checks takes the judge could not verify, from their evidence frames', async () => {
    const { pid, clip } = await plannedClip({ consistency: { judge: 'off' } });
    const generated = await generate(pid, clip.id);
    const takes = generated.shots.map((s) => s.takes.at(-1)!);
    expect(takes.every((t) => t.consistency.status === 'unverified')).toBe(true);
    const videos = stack.gw.counters.videos;
    // The judge is back: the takes are judged again without a new generation.
    await stack.api('PATCH', `/projects/${pid}`, { settings: { consistency: { judge: 'vision-llm' } } });
    const job = await stack.api<Job>('POST', `/projects/${pid}/consistency/recheck`, {});
    const done = expectSucceeded(await stack.waitJob(pid, job.id));
    expect(done.result).toMatchObject({ checked: takes.length, passed: takes.length, unverified: 0 });
    expect(stack.gw.counters.videos).toBe(videos);
    const now = (await stateOf(pid)).docs.clips[clip.id] as Clip;
    for (const s of now.shots) {
      const t = s.takes.at(-1)!;
      expect(t.consistency).toMatchObject({ status: 'passed', note: 're-checked' });
      expect(s.status).toBe('ready');
    }
  });

  it('leaves version 1 projects as they were', async () => {
    const { pid, clip } = await plannedClip({
      generation: { promptVersion: 1, includeAudio: true },
      consistency: { qualityChecks: false },
    });
    for (const shot of clip.shots) expect(shot.camera.lensMm ?? null).toBeNull();
    const generated = await generate(pid, clip.id);
    const take = generated.shots[0]!.takes.at(-1)!;
    expect(take.consistency.quality).toBeNull();
    const video = requestOf(take.gatewayTaskIds.at(-1)!);
    expect(video.input[0].text).not.toContain('One continuous shot');
    expect(video.parameters.negative_prompt).not.toContain('morphing');
  });

  it('uses a Wan 3.0-like model as it is documented: shots within 5 s, rendered as a sequence from a frame', async () => {
    const { pid, clip } = await plannedClip({ models: { video: 'mock-wan3-v1' } });
    // The model renders sequences from a first frame: 2-5 s shots, the first showing the whole cast
    // (docs/design/multi-shot.md#planning-for-sequences)
    const shots = [...clip.shots].sort((a, b) => a.index - b.index);
    for (const shot of shots) {
      expect(shot.durationSec).toBeGreaterThanOrEqual(2);
      expect(shot.durationSec).toBeLessThanOrEqual(5);
    }
    const cast = new Set(shots.flatMap((s) => s.characterIds));
    expect(new Set(shots[0]!.characterIds)).toEqual(cast);
    const generated = await generate(pid, clip.id);
    const jobs = await stack.api<Job[]>('GET', `/projects/${pid}/jobs`);
    const groups = jobs.filter((j) => j.kind === 'shot.group');
    expect(groups.length).toBeGreaterThan(0);
    const first = [...generated.shots].sort((a, b) => a.index - b.index)[0]!;
    const take = first.takes.find((t) => t.request.multiShot)!;
    const video = requestOf(take.gatewayTaskIds.at(-1)!);
    expect(video.model).toBe('mock-wan3-v1');
    // A first frame and no references (the modes are exclusive), no negative prompt field, no rewriting, its sound
    const roles = video.input
      .filter((p: { type: string }) => p.type !== 'text')
      .map((p: { role: string }) => p.role);
    expect(roles).toEqual(['first_frame']);
    expect(video.parameters).not.toHaveProperty('negative_prompt');
    expect(video.parameters.enhance_prompt).toBe(false);
    expect(video.parameters.include_audio).toBe(true);
    expect(video.input[0].text).toMatch(
      /A multi-shot sequence of \d+ shots separated by hard cuts\. Shot 1 \[0-/,
    );
    expect(video.input[0].text).toContain('No BGM');
  });
});
