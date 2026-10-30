import type { Character, Clip, Element, Job, Project } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** Right the first time (docs/design/first-pass.md), on the mock gateway. */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack?.stop();
});

describe('the first pass', () => {
  it('gates every score at 8, tells the writer and the planner what their reviewers know, draws whole figures', async () => {
    const created = await stack.api<Project>('POST', '/projects', {
      kind: 'story',
      title: 'The Riders',
      brief: { prompt: 'Two friends learn to ride ponies at a riding school; nobody else appears.' },
      settings: { targetDurationSec: 30, pilotDurationSec: 10, resolution: { width: 320, height: 180 } },
    });
    // New projects hold every score of every review at 8 (docs/design/first-pass.md#the-gate-at-8)
    expect(created.settings.review).toMatchObject({ threshold: 8, sceneThreshold: 8, minDimension: 8 });
    // Every framing spelled out, and the director's desk on request (docs/design/first-pass.md)
    expect(created.settings.generation.promptVersion).toBe(3);
    expect(created.settings.blocking).toMatchObject({ enabled: false, layoutImage: false });
    const pid = created.id;

    // The writer gets what the video model renders well and badly, as its reviewer does
    const gen = await stack.api<Job>('POST', `/projects/${pid}/screenplay/generate`, {});
    expectSucceeded(await stack.waitJob(pid, gen.id));
    // The review the screenplay queues when it is written
    await stack.waitIdle(pid);
    const written = stack.gw.counters.lastInputs['screenplay.generate'] as Record<string, any>;
    expect(written.video.weaknesses).toContain('quick repeated motion');
    expect(written.video.shotSeconds.max).toBeGreaterThan(0);
    expect(written.castOnly).toBe(false);
    const review = stack.gw.counters.lastInputs['screenplay.review'] as Record<string, any>;
    expect(review.video.weaknesses).toEqual(written.video.weaknesses);

    // The cast: the whole figure first, every view whole; a place or a prop drawn once
    let docs = (await stack.api<any>('GET', `/projects/${pid}/state`)).docs;
    const rosie = Object.values<Character>(docs.characters)[0]!;
    const refs = await stack.api<Job>(
      'POST',
      `/projects/${pid}/characters/${rosie.id}/references/generate`,
      {},
    );
    expectSucceeded(await stack.waitJob(pid, refs.id));
    const place = Object.values<Element>(docs.elements).find((e) => e.kind === 'location')!;
    const views = await stack.api<Job>(
      'POST',
      `/projects/${pid}/elements/${place.id}/references/generate`,
      {},
    );
    expectSucceeded(await stack.waitJob(pid, views.id));
    docs = (await stack.api<any>('GET', `/projects/${pid}/state`)).docs;
    expect(docs.characters[rosie.id].references.map((r: { view: string }) => r.view)).toEqual([
      'full_body',
      'three_quarter',
      'profile',
    ]);
    expect(docs.elements[place.id].references.map((r: { view: string }) => r.view)).toEqual(['establishing']);

    // The shot planner gets them too
    const scene = docs.screenplay.scenes[0];
    const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, { sceneId: scene.id });
    expectSucceeded(await stack.waitJob(pid, plan.id));
    const planned = stack.gw.counters.lastInputs['clip.plan'] as Record<string, any>;
    expect(planned.video.strengths).toContain('one or two characters in a shot, three at most');
    expect(typeof planned.castOnly).toBe('boolean');
  });
});

describe('the video reads its first frame (docs/design/first-pass.md#the-video-reads-its-first-frame)', () => {
  it("describes an approved frame as drawn in the video prompt, once per frame, and keeps the plan's words when they agree", async () => {
    const { projectId: pid } = await readyStoryProject(stack, { storyboard: { scenes: 1 } });
    let docs = (await stack.api<any>('GET', `/projects/${pid}/state`)).docs;
    const scene = [...docs.screenplay.scenes].sort((a: any, b: any) => a.index - b.index)[0];
    const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, { sceneId: scene.id });
    expectSucceeded(await stack.waitJob(pid, plan.id));
    docs = (await stack.api<any>('GET', `/projects/${pid}/state`)).docs;
    const clip = Object.values<Clip>(docs.clips)[0]!;
    const [first, second] = [...clip.shots].sort((a, b) => a.index - b.index);
    // The mock draws the first frame otherwise than its text says
    await stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${first!.id}`, {
      description: `${first!.description} The gate is closed, drawn otherwise.`,
    });
    const board = await stack.api<Job>('POST', `/projects/${pid}/storyboard/generate`, {});
    expectSucceeded(await stack.waitJob(pid, board.id, 180_000));
    await stack.waitIdle(pid);
    await stack.api('POST', `/projects/${pid}/storyboard/approve-all`);
    const gen = await stack.api<Job>('POST', `/projects/${pid}/clips/${clip.id}/generate`);
    expectSucceeded(await stack.waitJob(pid, gen.id));
    await stack.waitIdle(pid);
    docs = (await stack.api<any>('GET', `/projects/${pid}/state`)).docs;
    const shots = [...(docs.clips[clip.id] as Clip).shots].sort((a, b) => a.index - b.index);
    // The frame's reading is kept on the board, with what differs from the plan
    expect(shots[0]!.board!.seen).toMatchObject({
      keyframeHash: shots[0]!.board!.keyframe.hash,
      conflicts: ['the gate is open, not closed'],
    });
    const take = shots[0]!.takes.find((t) => t.id === shots[0]!.selectedTakeId)!;
    expect(take.request.firstFrameSource).toBe('storyboard');
    const video = stack.gw.store.requests.get(take.gatewayTaskIds.at(-1)!) as { input: { text?: string }[] };
    const prompt = video.input.find((p) => p.text)!.text!;
    expect(prompt).toContain('The gate stands open.');
    expect(prompt).not.toContain('The gate is closed');
    // A frame that agrees with its shot keeps the plan's words
    if (second?.continuity === 'cut') {
      expect(shots[1]!.board!.seen).toMatchObject({ conflicts: [] });
      expect(shots[1]!.board!.seen!.description).toBe(shots[1]!.description);
    }
    // Generated again from the same frame: read once
    const before = stack.gw.counters.lastInputs['frame.reconcile'];
    const again = await stack.api<Job>(
      'POST',
      `/projects/${pid}/clips/${clip.id}/shots/${shots[0]!.id}/regenerate`,
    );
    expectSucceeded(await stack.waitJob(pid, again.id));
    expect(stack.gw.counters.lastInputs['frame.reconcile']).toBe(before);
  }, 300_000);
});

describe('framings spelled out (docs/design/first-pass.md#framings-spelled-out)', () => {
  it('draws a close-up from the head and shoulders of the whole-figure reference', async () => {
    const { projectId: pid, state } = await readyStoryProject(stack, {}, { views: ['full_body'] });
    expect(state.docs.project.settings.generation.promptVersion).toBe(3);
    const scene = [...state.docs.screenplay.scenes].sort((a: any, b: any) => a.index - b.index)[0];
    const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, { sceneId: scene.id });
    expectSucceeded(await stack.waitJob(pid, plan.id));
    const docs = (await stack.api<any>('GET', `/projects/${pid}/state`)).docs;
    const clip = Object.values<Clip>(docs.clips)[0]!;
    const shot = clip.shots.find((s) => s.characterIds.length > 0)!;
    await stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}`, {
      camera: { ...shot.camera, framing: 'close_up' },
    });
    const board = await stack.api<Job>(
      'POST',
      `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/board/generate`,
    );
    expectSucceeded(await stack.waitJob(pid, board.id));
    const drawn = (
      (await stack.api<any>('GET', `/projects/${pid}/state`)).docs.clips[clip.id] as Clip
    ).shots.find((s) => s.id === shot.id)!;
    expect(drawn.board!.request.prompt).toContain('(head and shoulders)');
    expect(drawn.board!.request.prompt).toContain(
      'close-up: the face and the top of the shoulders fill the frame',
    );
    // The first image is the cropped whole figure: wider than it is tall
    const request = stack.gw.store.requests.get(drawn.board!.gatewayTaskIds[0]!) as {
      input: { type: string; uri?: string }[];
    };
    const png = Buffer.from(request.input.find((p) => p.type === 'image')!.uri!.split(',')[1]!, 'base64');
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width).toBeGreaterThan(height);
  }, 300_000);
});

describe('frames that follow their shot (docs/design/first-pass.md#frames-that-follow-their-shot)', () => {
  it('draws a frame again while it contradicts its shot, and once when it agrees', async () => {
    const { projectId: pid, state } = await readyStoryProject(stack, {
      storyboard: { scenes: 1 },
      pilotDurationSec: 20,
    });
    const scene = [...state.docs.screenplay.scenes].sort((a: any, b: any) => a.index - b.index)[0];
    const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, { sceneId: scene.id });
    expectSucceeded(await stack.waitJob(pid, plan.id));
    let docs = (await stack.api<any>('GET', `/projects/${pid}/state`)).docs;
    const clip = Object.values<Clip>(docs.clips)[0]!;
    const [first, second] = [...clip.shots].sort((a, b) => a.index - b.index);
    expect(second).toBeDefined();
    await stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${first!.id}`, {
      description: `${first!.description} The gate is closed, drawn otherwise.`,
    });
    for (const shot of [first!, second!]) {
      const board = await stack.api<Job>(
        'POST',
        `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/board/generate`,
      );
      expectSucceeded(await stack.waitJob(pid, board.id));
    }
    docs = (await stack.api<any>('GET', `/projects/${pid}/state`)).docs;
    const shots = [...(docs.clips[clip.id] as Clip).shots].sort((a, b) => a.index - b.index);
    // Every attempt of the contradicting frame was read and drawn again; the reading of the one kept is its board's
    const attempts = docs.project.settings.consistency.maxAttempts;
    expect(shots[0]!.board!.gatewayTaskIds).toHaveLength(attempts);
    expect(shots[0]!.board!.seen).toMatchObject({
      keyframeHash: shots[0]!.board!.keyframe.hash,
      conflicts: ['the gate is open, not closed'],
    });
    // The frame that agrees with its shot is drawn once, and its reading kept for the video
    expect(shots[1]!.board!.gatewayTaskIds).toHaveLength(1);
    expect(shots[1]!.board!.seen).toMatchObject({ conflicts: [] });
    const metrics = await (await fetch(`${stack.url}/metrics`)).text();
    const redraws = metrics
      .split('\n')
      .filter((l) => l.startsWith('rideo_frame_reconciles_total{') && l.includes('outcome="redraw"'));
    expect(redraws.some((l) => l.includes('source="storyboard"'))).toBe(true);
  }, 300_000);
});

describe('references that match their subject (docs/design/first-pass.md#references-that-match-their-subject)', () => {
  it('draws a reference again while it does not match its subject, and once when it does', async () => {
    const created = await stack.api<Project>('POST', '/projects', {
      kind: 'story',
      title: 'The Kite',
      brief: { prompt: 'Two friends fly a kite on a windy hill.' },
      settings: { targetDurationSec: 20, pilotDurationSec: 10, resolution: { width: 320, height: 180 } },
    });
    const pid = created.id;
    const gen = await stack.api<Job>('POST', `/projects/${pid}/screenplay/generate`, {});
    expectSucceeded(await stack.waitJob(pid, gen.id));
    await stack.waitIdle(pid);
    const docs = (await stack.api<any>('GET', `/projects/${pid}/state`)).docs;
    const [wrong, right] = Object.values<Character>(docs.characters);
    // The mock finds the first character's views do not match: each is drawn again, up to the attempts
    await stack.api('PATCH', `/projects/${pid}/characters/${wrong!.id}`, {
      identity: { ...wrong!.identity, face: `${wrong!.identity.face}, drawn wrong` },
    });
    for (const c of [wrong!, right!]) {
      const j = await stack.api<Job>('POST', `/projects/${pid}/characters/${c.id}/references/generate`, {
        views: ['full_body'],
      });
      expectSucceeded(await stack.waitJob(pid, j.id));
    }
    const jobs = await stack.api<Job[]>('GET', `/projects/${pid}/jobs`);
    const tasksOf = (id: string) =>
      jobs.find((j) => j.kind === 'character.refs' && j.params.characterId === id)!.gatewayTasks.length;
    expect(tasksOf(wrong!.id)).toBe(created.settings.consistency.maxAttempts);
    expect(tasksOf(right!.id)).toBe(1);
    const after = (await stack.api<any>('GET', `/projects/${pid}/state`)).docs;
    // One reference kept per view, whatever was drawn
    expect(after.characters[wrong!.id].references).toHaveLength(1);
    const metrics = await (await fetch(`${stack.url}/metrics`)).text();
    expect(metrics).toMatch(/rideo_reference_checks_total\{[^}]*outcome="mismatched"[^}]*\} \d+/);
  }, 300_000);
});
