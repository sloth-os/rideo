import { startMockGateway } from '@rideo/mock-gateway';
import type { Job, StageReview, WorkflowEvaluation } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** AI review of the screenplay and the storyboard (docs/design/ai-review.md) on the mock gateway. */
let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ gw: await startMockGateway({ latencyMs: 20 }) });
}, 60_000);
afterAll(async () => {
  await stack?.stop();
  await stack?.gw.close();
});

const stateOf = (pid: string) => stack.api<any>('GET', `/projects/${pid}/state`);
const reviewOf = async (pid: string, stage: 'screenplay' | 'storyboard') =>
  (await stateOf(pid)).docs.aiReviews[stage] as StageReview | undefined;
const requirement = async (pid: string, gate: string, id: string) => {
  const ev = await stack.api<WorkflowEvaluation>('GET', `/projects/${pid}/workflow`);
  const g = ev.stages.find((s) => s.gate?.id === gate)!.gate!;
  return g.requirements.find((r) => r.id === id)!;
};

/** A story project at the screenplay stage, its screenplay written (and reviewed, the review being on). */
async function writtenProject(settings: Record<string, unknown> = {}) {
  const p = await stack.api<{ id: string }>('POST', '/projects', {
    kind: 'story',
    title: 'The Keeper',
    brief: { prompt: 'A lighthouse keeper receives letters from the future' },
    settings: {
      targetDurationSec: 30,
      pilotDurationSec: 10,
      resolution: { width: 320, height: 180 },
      ...settings,
    },
  });
  const job = await stack.api<Job>('POST', `/projects/${p.id}/screenplay/generate`, {});
  expectSucceeded(await stack.waitJob(p.id, job.id));
  await stack.waitIdle(p.id);
  return p.id;
}

/** Puts a crowd in the first scene: the mock reviewer finds it cannot be filmed (critical). */
async function addCrowd(pid: string) {
  const sp = (await stateOf(pid)).docs.screenplay;
  const scene = [...sp.scenes].sort((a: any, b: any) => a.index - b.index)[0];
  await stack.api('PATCH', `/projects/${pid}/screenplay`, {
    upsertScenes: [{ ...scene, action: `${scene.action} A crowd of tourists cheers on the pier.` }],
  });
  return scene.id as string;
}

async function runReview(pid: string, stage: 'screenplay' | 'storyboard') {
  const { job } = await stack.api<{ job: Job }>('POST', `/projects/${pid}/ai-reviews/${stage}/run`);
  expectSucceeded(await stack.waitJob(pid, job.id, 180_000));
  await stack.waitIdle(pid);
  return job;
}

describe('AI review of the screenplay', () => {
  it('reviews the screenplay after it is written, revises a scene the model cannot film, and the gate waits for a pass', async () => {
    const pid = await writtenProject();
    // Written, then reviewed by itself: the mock screenplay passes
    let review = (await reviewOf(pid, 'screenplay'))!;
    expect(review).toMatchObject({ status: 'succeeded', round: 1, verdict: { passed: true } });
    expect(review.scores.feasibility).toBe(8);
    expect(await requirement(pid, 'screenplay_approved', 'screenplay.reviewPassed')).toMatchObject({
      ok: true,
    });

    // An edit makes the review outdated: the gate waits
    const sceneId = await addCrowd(pid);
    expect(await requirement(pid, 'screenplay_approved', 'screenplay.reviewPassed')).toMatchObject({
      ok: false,
      message: 'The screenplay changed since its review: review again',
    });
    await expect(
      stack.api('POST', `/projects/${pid}/workflow/approve`, { gate: 'screenplay_approved' }),
    ).rejects.toMatchObject({ status: 409, body: { code: 'gate_unmet' } });

    // Reviewed again: the crowd fails it, the review rewrites the scene and passes the next round
    const job = await runReview(pid, 'screenplay');
    review = (await reviewOf(pid, 'screenplay'))!;
    expect(review).toMatchObject({ status: 'succeeded', round: 2, jobId: job.id, verdict: { passed: true } });
    const failed = review.history.at(-1)!;
    expect(failed).toMatchObject({ round: 1, passed: false, applied: 1 });
    expect(failed.score).toBeLessThan(review.verdict!.score);
    const scene = (await stateOf(pid)).docs.screenplay.scenes.find((s: any) => s.id === sceneId);
    expect(scene.action).not.toMatch(/crowd|tourists/i);
    await stack.api('POST', `/projects/${pid}/workflow/approve`, { gate: 'screenplay_approved' });
    const metrics = await (await fetch(`${stack.url}/metrics`)).text();
    expect(metrics).toMatch(/rideo_ai_reviews_total\{outcome="passed",stage="screenplay"\} [2-9]/);
    expect(metrics).toMatch(
      /rideo_ai_review_recommendations_total\{action="revise_scene",outcome="auto",stage="screenplay"\} 1/,
    );
    // The fix the first round applied stays listed beside the second round's recommendations
    expect(review.recommendations.find((r) => r.action?.kind === 'revise_scene')).toMatchObject({
      round: 1,
      status: 'applied',
      appliedBy: { kind: 'system' },
    });
  });

  it('stops after its rounds; a person applies, dismisses or continues anyway', async () => {
    const pid = await writtenProject({ review: { maxRounds: 0 } });
    const sceneId = await addCrowd(pid);
    await runReview(pid, 'screenplay');
    let review = (await reviewOf(pid, 'screenplay'))!;
    expect(review.verdict).toMatchObject({ passed: false });
    expect(review.verdict!.blocking[0]).toMatch(/^critical: Scene 1 needs a crowd/);
    expect(review.issues[0]).toMatchObject({
      scene: 1,
      sceneId,
      severity: 'critical',
      dimension: 'feasibility',
    });
    const fix = review.recommendations.find((r) => r.action?.kind === 'revise_scene')!;
    expect(fix).toMatchObject({ priority: 1, status: 'open', action: { sceneId } });
    expect((await requirement(pid, 'screenplay_approved', 'screenplay.reviewPassed')).message).toMatch(
      /^The screenplay review did not pass \(\d\.\d of 7\)$/,
    );

    // Continue anyway: the gate accepts the review for the screenplay as it is
    review = await stack.api<StageReview>('POST', `/projects/${pid}/ai-reviews/screenplay/override`, {
      note: 'the crowd is a painted backdrop',
    });
    expect(review.override).toMatchObject({ note: 'the crowd is a painted backdrop' });
    expect(await requirement(pid, 'screenplay_approved', 'screenplay.reviewPassed')).toMatchObject({
      ok: true,
    });

    // Dismiss the note; apply the fix: the writer rewrites the scene, and the review is outdated
    const note = review.recommendations.find((r) => r.action?.kind === 'note')!;
    await stack.api('POST', `/projects/${pid}/ai-reviews/screenplay/recommendations/${note.id}/dismiss`);
    const applied = await stack.api<{ review: StageReview; job: Job }>(
      'POST',
      `/projects/${pid}/ai-reviews/screenplay/recommendations/${fix.id}/apply`,
    );
    expect(applied.job.kind).toBe('screenplay.revise');
    expectSucceeded(await stack.waitJob(pid, applied.job.id));
    const state = await stateOf(pid);
    expect(state.docs.screenplay.scenes.find((s: any) => s.id === sceneId).action).not.toMatch(/crowd/i);
    review = state.docs.aiReviews.screenplay;
    expect(review.recommendations.find((r) => r.id === fix.id)).toMatchObject({
      status: 'applied',
      jobId: applied.job.id,
    });
    expect(review.recommendations.find((r) => r.id === note.id)!.status).toBe('dismissed');
    await expect(
      stack.api('POST', `/projects/${pid}/ai-reviews/screenplay/recommendations/${fix.id}/apply`),
    ).rejects.toMatchObject({ status: 409, body: { code: 'review_stale' } });
    expect((await requirement(pid, 'screenplay_approved', 'screenplay.reviewPassed')).ok).toBe(false);
  });

  it('approves the gate on autopilot when the review passes, and the next stage starts', async () => {
    const pid = await writtenProject({ autopilot: true });
    const state = await stateOf(pid);
    expect(state.docs.aiReviews.screenplay.verdict.passed).toBe(true);
    expect(state.docs.project.workflow.approvals.screenplay_approved.actor).toMatchObject({ kind: 'system' });
    expect(state.docs.project.workflow.stage).toBe('cast');
    // The cast stage's own auto actions ran: references were drawn
    const refs = Object.values<any>(state.docs.characters).flatMap((c) => c.references);
    expect(refs.length).toBeGreaterThan(0);
  });

  it('is off when the project says so, and MCP sees the same reviews', async () => {
    const off = await writtenProject({ review: { screenplay: false } });
    expect(await reviewOf(off, 'screenplay')).toBeUndefined();
    expect(await requirement(off, 'screenplay_approved', 'screenplay.reviewPassed')).toMatchObject({
      ok: true,
      message: 'The screenplay review is off',
    });
    const jobs = await stack.api<Job[]>('GET', `/projects/${off}/jobs`);
    expect(jobs.some((j) => j.kind === 'screenplay.review')).toBe(false);
    const listed = await stack.api<StageReview[]>('GET', `/projects/${off}/ai-reviews`);
    expect(listed).toEqual([]);
  });
});

describe('AI review of the storyboard', () => {
  it('reviews the frames after they are drawn and redraws a blurry one before any video', async () => {
    const { projectId: pid } = await readyStoryProject(stack, {
      review: { screenplay: false, storyboard: true },
      storyboard: { enabled: true, scenes: 1 },
    });
    const generate = await stack.api<Job>('POST', `/projects/${pid}/storyboard/generate`, {});
    expectSucceeded(await stack.waitJob(pid, generate.id, 180_000));
    await stack.waitIdle(pid);
    let review = (await reviewOf(pid, 'storyboard'))!;
    expect(review).toMatchObject({ status: 'succeeded', round: 1, verdict: { passed: true } });

    // A frame that reads badly: the review redraws it and passes the next round
    const clip = Object.values<any>((await stateOf(pid)).docs.clips)[0];
    const shot = [...clip.shots].sort((a: any, b: any) => a.index - b.index)[0];
    await stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}`, {
      description: `${shot.description} A blurry frame.`,
    });
    const draw = await stack.api<Job>(
      'POST',
      `/projects/${pid}/clips/${clip.id}/shots/${shot.id}/board/generate`,
    );
    expectSucceeded(await stack.waitJob(pid, draw.id, 120_000));
    const before = (await stateOf(pid)).docs.clips[clip.id].shots.find((s: any) => s.id === shot.id).board
      .keyframe.hash;
    await runReview(pid, 'storyboard');
    review = (await reviewOf(pid, 'storyboard'))!;
    expect(review).toMatchObject({ round: 2, verdict: { passed: true } });
    const redraw = review.recommendations.find((r) => r.action?.kind === 'redraw_board');
    expect(redraw).toMatchObject({ status: 'applied', appliedBy: { kind: 'system' } });
    const after = (await stateOf(pid)).docs.clips[clip.id].shots.find((s: any) => s.id === shot.id);
    expect(after.description).not.toMatch(/blurry/i);
    expect(after.board.keyframe.hash).not.toBe(before);
    expect(await requirement(pid, 'storyboard_approved', 'storyboard.reviewPassed')).toMatchObject({
      ok: true,
    });
  });
});
