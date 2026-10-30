import { isTerminalJob, type Job, type StageReview, type WorkflowEvaluation } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectSucceeded, lockElements, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/**
 * Idea → movie on autopilot, every step reviewed and approved before the next
 * (docs/design/ai-review.md#autopilot-every-step-reviewed-and-approved), and the reviews that gate it: the cast,
 * production storyboards, takes watched whole, scenes watched as one video, the cut before export.
 */
let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
}, 60_000);
afterAll(async () => {
  await stack?.stop();
});

const stateOf = (pid: string) => stack.api<any>('GET', `/projects/${pid}/state`);
const workflowOf = (pid: string) => stack.api<WorkflowEvaluation>('GET', `/projects/${pid}/workflow`);

/** Waits until the project reaches a stage (autopilot moves it on as its reviews pass). */
async function waitStage(pid: string, stage: string, timeoutMs = 600_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const ev = await workflowOf(pid);
    if (ev.stage === stage) return ev;
    if (Date.now() > until) {
      const unmet = ev.stages
        .find((s) => s.id === ev.stage)
        ?.gate?.requirements.filter((r) => !r.ok)
        .map((r) => `${r.id}: ${r.message}`);
      throw new Error(`still at ${ev.stage} (waiting for ${stage}): ${unmet?.join('; ')}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Every job the server runs is done (the export's render waits for a studio tab, which no test opens here). */
async function serverIdle(pid: string, timeoutMs = 300_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const jobs = await stack.api<Job[]>('GET', `/projects/${pid}/jobs`);
    if (jobs.every((j) => isTerminalJob(j) || j.lane === 'client')) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('jobs did not settle');
}

describe('autopilot: every step reviewed and approved', () => {
  it('goes from the brief to the export, each gate approved by a review that passed', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'story',
      title: 'The Keeper',
      brief: { prompt: 'A lighthouse keeper receives letters from the future' },
      settings: {
        // The screenplay job writes the pilot's two scenes, which the storyboard stage draws; production writes the
        // rest, the third within the stage's three scenes, and storyboards each before its video
        targetDurationSec: 90,
        pilotDurationSec: 30,
        resolution: { width: 320, height: 180 },
        autopilot: true,
        storyboard: { enabled: true, scenes: 3, production: true },
        // A person picks the voices TTS dialogue needs: the film speaks through the video model's own sound
        dialogue: { mode: 'off' },
      },
    });
    const pid = p.id;
    // New projects review every step
    const settings = (await stateOf(pid)).docs.project.settings;
    expect(settings.review).toMatchObject({ cast: true, cut: true, watchTakes: true, extensions: true });
    expect(settings.blocking.enabled).toBe(true);
    await stack.api('POST', `/projects/${pid}/workflow/approve`, { gate: 'brief_submitted' });
    await waitStage(pid, 'export', 900_000);
    await serverIdle(pid);
    const state = await stateOf(pid);
    const docs = state.docs;
    // Every gate was approved by the system after its review
    for (const gate of [
      'screenplay_approved',
      'cast_locked',
      'resources_ready',
      'storyboard_approved',
      'pilot_approved',
      'production_approved',
      'cut_approved',
    ])
      expect(docs.project.workflow.approvals[gate]?.actor.kind, gate).toBe('system');
    const reviews = docs.aiReviews as Record<string, StageReview>;
    for (const stage of ['screenplay', 'cast', 'storyboard', 'cut'])
      expect(reviews[stage], stage).toMatchObject({ status: 'succeeded', verdict: { passed: true } });
    // The cast was approved and locked by its review
    for (const c of Object.values<any>(docs.characters)) expect(c.lock.locked).toBe(true);
    const clips = Object.values<any>(docs.clips).sort((a, b) => a.index - b.index);
    expect(clips.length).toBeGreaterThan(1);
    for (const clip of clips) {
      expect(clip.status, `clip ${clip.index + 1}`).toBe('approved');
      // Blocked, its frames drawn and approved before its video
      expect(clip.blocking?.source).toBe('ai');
      for (const s of clip.shots) expect(s.board?.approved).toBe(true);
      // Every take watched whole
      for (const s of clip.shots) {
        const take = s.takes.find((t: any) => t.id === s.selectedTakeId);
        expect(take.consistency.quality.watch).toMatchObject({ passed: true, via: 'vision' });
      }
      // The scene watched as one video (two or more shots)
      if (clip.shots.length >= 2)
        expect(clip.review).toMatchObject({ watched: 'video', verdict: { passed: true } });
    }
    // Production scenes were storyboarded and reviewed on their own, the one written within the stage's scenes too
    expect(clips.length).toBeGreaterThan(2);
    for (const c of clips.slice(2)) expect(c.boardReview?.verdict?.passed, `clip ${c.index + 1}`).toBe(true);
    // The export started: an editor job for a studio tab
    const exports = Object.values<any>(docs.exports);
    expect(exports).toHaveLength(1);
    const jobs = await stack.api<Job[]>('GET', `/projects/${pid}/jobs`);
    expect(jobs.some((j) => j.kind === 'export.render')).toBe(true);
    const metrics = await (await fetch(`${stack.url}/metrics`)).text();
    expect(metrics).toMatch(/rideo_autopilot_approvals_total\{step="cut"\} 1/);
    expect(metrics).toMatch(/rideo_take_watches_total\{model="vision",result="passed"\} \d+/);
    expect(metrics).toMatch(/rideo_clip_review_watched_total\{watched="video"\} \d+/);
  }, 1_200_000);

  it('keeps the cast gate for a person when the cast review does not pass after its rounds', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'story',
      title: 'Bad sheets',
      brief: { prompt: 'Two friends at the beach' },
      settings: {
        targetDurationSec: 20,
        pilotDurationSec: 10,
        resolution: { width: 320, height: 180 },
        dialogue: { mode: 'off' },
        review: { maxRounds: 1 },
      },
    });
    const pid = p.id;
    const gen = await stack.api<Job>('POST', `/projects/${pid}/screenplay/generate`, {});
    expectSucceeded(await stack.waitJob(pid, gen.id));
    await stack.waitIdle(pid);
    await stack.api('POST', `/projects/${pid}/workflow/approve`, { gate: 'screenplay_approved' });
    // A character whose views the mock finds inconsistent: drawn again, still inconsistent
    let state = await stateOf(pid);
    const c = Object.values<any>(state.docs.characters)[0];
    await stack.api('PATCH', `/projects/${pid}/characters/${c.id}`, {
      identity: { ...c.identity, face: `${c.identity.face}, inconsistent features` },
    });
    for (const x of Object.values<any>(state.docs.characters)) {
      const j = await stack.api<Job>('POST', `/projects/${pid}/characters/${x.id}/references/generate`, {
        views: ['front'],
      });
      expectSucceeded(await stack.waitJob(pid, j.id));
    }
    const drawnFirst = (await stateOf(pid)).docs.characters[c.id].references[0];
    await lockElements(stack, pid);
    await stack.waitIdle(pid, 300_000);
    state = await stateOf(pid);
    const review = state.docs.aiReviews.cast as StageReview;
    // Reviewed once the cast had references, a round of fixes made, and still failing
    expect(review.verdict?.passed).toBe(false);
    expect(review.round).toBe(2);
    expect(review.history.at(-1)).toMatchObject({ passed: false, applied: 1 });
    expect(review.recommendations.some((r) => r.action?.kind === 'regenerate_refs')).toBe(true);
    // Drawn again with the review's instruction, from the reference it replaced, which it then dismissed
    const jobs = await stack.api<Job[]>('GET', `/projects/${pid}/jobs`);
    const redraw = jobs.find(
      (j) => j.kind === 'character.refs' && j.parentId && j.params.characterId === c.id,
    )!;
    expect(redraw.params).toMatchObject({
      direction: 'the same face and outfit in every view',
      replaces: [drawnFirst.id],
    });
    expect(redraw.result).toEqual({ generated: 4, dismissed: 1 });
    for (const t of redraw.gatewayTasks) {
      const request = stack.gw.store.requests.get(t.id) as any;
      expect(request.input[0].text).toContain('Direction: the same face and outfit in every view.');
      expect(request.input.some((p: any) => p.type === 'image')).toBe(true);
    }
    const now = state.docs.characters[c.id].references;
    expect(now.map((r: any) => r.view)).toEqual(['front', 'three_quarter', 'profile', 'full_body']);
    expect(now.some((r: any) => r.id === drawnFirst.id)).toBe(false);
    let ev = await workflowOf(pid);
    const req = () =>
      ev.stages.find((s) => s.id === 'cast')!.gate!.requirements.find((r) => r.id === 'cast.reviewPassed')!;
    expect(req().ok).toBe(false);
    // A person continues anyway: the gate accepts it for the cast as it is
    await stack.api('POST', `/projects/${pid}/ai-reviews/cast/override`, { note: 'drawn by hand later' });
    ev = await workflowOf(pid);
    expect(req().ok).toBe(true);
  }, 900_000);
});

describe('takes watched whole', () => {
  it('generates again an attempt whose whole-take watch fails, and keeps what failed when every attempt does', async () => {
    const { projectId } = await readyStoryProject(stack, {
      review: { screenplay: false, storyboard: false, scenes: false, watchTakes: true },
      storyboard: { enabled: false },
      consistency: { maxAttempts: 2, qualityChecks: true },
    });
    const state = await stateOf(projectId);
    const scene = state.docs.screenplay.scenes[0];
    const plan = await stack.api<Job>('POST', `/projects/${projectId}/clips/plan`, { sceneId: scene.id });
    expectSucceeded(await stack.waitJob(projectId, plan.id));
    const clip = Object.values<any>((await stateOf(projectId)).docs.clips)[0];
    const shot = clip.shots[0];
    await stack.api('PATCH', `/projects/${projectId}/clips/${clip.id}/shots/${shot.id}`, {
      description: `${shot.description} (motion glitch)`,
    });
    const job = await stack.api<Job>(
      'POST',
      `/projects/${projectId}/clips/${clip.id}/shots/${shot.id}/regenerate`,
      {},
    );
    expectSucceeded(await stack.waitJob(projectId, job.id, 300_000));
    const take = (await stateOf(projectId)).docs.clips[clip.id].shots[0].takes.at(-1);
    expect(take.consistency.attempts).toBe(2);
    expect(take.consistency.quality.watch).toMatchObject({ passed: false, motion: 0.2 });
    expect(take.consistency.quality.passed).toBe(false);
    expect(take.consistency.quality.issues.join(' ')).toMatch(/watched: The figure morphs/);
  }, 600_000);

  it('watches the takes of the cut that were made before the watch, from their videos', async () => {
    const { projectId } = await readyStoryProject(stack, {
      review: { screenplay: false, storyboard: false, scenes: false, watchTakes: false },
      storyboard: { enabled: false },
    });
    await lockElements(stack, projectId);
    const state = await stateOf(projectId);
    const scene = state.docs.screenplay.scenes[0];
    const plan = await stack.api<Job>('POST', `/projects/${projectId}/clips/plan`, {
      sceneId: scene.id,
      generate: true,
    });
    expectSucceeded(await stack.waitJob(projectId, plan.id));
    await stack.waitIdle(projectId, 300_000);
    const clip = Object.values<any>((await stateOf(projectId)).docs.clips)[0];
    const takes = clip.shots.map((s: any) => ({ clipId: clip.id, shotId: s.id, takeId: s.selectedTakeId }));
    expect(clip.shots[0].takes[0].consistency.quality?.watch ?? null).toBeNull();
    const job = await stack.api<Job>('POST', `/projects/${projectId}/takes/watch`, { takes });
    const done = await stack.waitJob(projectId, job.id, 300_000);
    expectSucceeded(done);
    expect(done.result).toMatchObject({ watched: takes.length, failed: 0 });
    const after = (await stateOf(projectId)).docs.clips[clip.id];
    for (const s of after.shots) {
      const t = s.takes.find((x: any) => x.id === s.selectedTakeId);
      expect(t.consistency.quality.watch).toMatchObject({ passed: true });
    }
  }, 600_000);
});
