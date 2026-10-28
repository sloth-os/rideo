import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMockGateway } from '@rideo/mock-gateway';
import { type Clip, clipReviewSubject, fixOutcome, type Job } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** A scene's takes watched before the edit (docs/design/ai-review.md#scenes-before-the-edit) on the mock gateway. */
let stack: Stack;
let client: Client;
beforeAll(async () => {
  stack = await startStack({
    gw: await startMockGateway({ latencyMs: 20 }),
    // Prices for the estimates of the fixes (docs/design/feedback.md#what-a-fix-costs)
    env: { RIDEO_PRICES: JSON.stringify({ 'mock-video-v1': { videoSecond: 0.25 } }) },
  });
  client = new Client({ name: 'Claude Code', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${stack.url}/mcp`)));
}, 60_000);
afterAll(async () => {
  await client?.close();
  await stack?.stop();
  await stack?.gw.close();
});

async function call<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[])[0]!.text;
  if (r.isError) throw Object.assign(new Error(text), { body: JSON.parse(text) });
  return JSON.parse(text) as T;
}

const docsOf = async (pid: string) => (await stack.api<any>('GET', `/projects/${pid}/state`)).docs;
const metric = async (name: string, outcome: string) => {
  const text = await (await fetch(`${stack.url}/metrics`)).text();
  return Number(new RegExp(`^${name}\\{outcome="${outcome}"\\} (\\d+)`, 'm').exec(text)?.[1] ?? 0);
};

describe('a scene watched before the edit', () => {
  it('finds a continuity break, generates the shot again, keeps a new take only when it passes, and watches again', async () => {
    const { projectId: pid, state } = await readyStoryProject(stack, {
      storyboard: { enabled: false },
      pilotDurationSec: 15,
      review: { screenplay: false, storyboard: false, scenes: true, sceneFixes: 3 },
    });
    const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, {
      sceneId: state.docs.screenplay.scenes[0].id,
    });
    expectSucceeded(await stack.waitJob(pid, plan.id));
    let clip = Object.values<Clip>((await docsOf(pid)).clips)[0]!;
    const shots = [...clip.shots].sort((a, b) => a.index - b.index);
    expect(shots.length).toBeGreaterThanOrEqual(2);
    const broken = shots[1]!;
    // A shot that breaks the scene: the mock reviewer sees the ball change paws
    await stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${broken.id}`, {
      description: `${broken.description} Continuity break.`,
    });

    // The clip job ends with its scene review, which fixes the shot before the edit
    const gen = await stack.api<Job>('POST', `/projects/${pid}/clips/${clip.id}/generate`);
    expectSucceeded(await stack.waitJob(pid, gen.id, 300_000));
    await stack.waitIdle(pid);
    const review = (await stack.api<Job[]>('GET', `/projects/${pid}/jobs`)).find(
      (j) => j.kind === 'clip.review',
    )!;
    expect(review).toMatchObject({ status: 'succeeded', parentId: gen.id });
    expect(review.result).toMatchObject({ round: 2, fixes: 1, fixed: 1 });
    let docs = await docsOf(pid);
    clip = docs.clips[clip.id];
    const r = clip.review!;
    expect(r).toMatchObject({
      status: 'succeeded',
      round: 2,
      jobId: review.id,
      subject: clipReviewSubject(clip),
    });
    expect(r.model).toBeTruthy();
    // Watched again after the fix: the break is gone and the score went up
    expect(r.before).toMatchObject({ scores: { continuity: 4 } });
    expect(r.before!.issues).toBeGreaterThan(0);
    expect(r.overall!).toBeGreaterThan(r.before!.overall!);
    expect(r.scores.continuity).toBeGreaterThan(4);
    expect(r.issues.some((i) => i.dimension === 'continuity')).toBe(false);
    // The fix: the shot revised and generated again, its new take passed and is selected
    expect(r.fixes).toHaveLength(1);
    const fix = r.fixes[0]!;
    expect(fix).toMatchObject({
      status: 'applied',
      priority: 1,
      action: { kind: 'regenerate_shot', clipId: clip.id, shotId: broken.id },
    });
    expect(fix.estimate?.usd).toBeGreaterThan(0);
    expect(fixOutcome(fix, docs)).toMatchObject({ state: 'fixed', shotId: broken.id });
    let fixed = clip.shots.find((s) => s.id === broken.id)!;
    expect(fixed.description).not.toMatch(/continuity break/i);
    expect(fixed.takes).toHaveLength(2);
    expect(fixed.takes.find((t) => t.id === fixed.selectedTakeId)!.jobId).toBe(fix.jobId);
    expect(await metric('rideo_clip_reviews_total', 'fixed')).toBeGreaterThanOrEqual(1);
    expect(await metric('rideo_clip_review_fixes_total', 'fixed')).toBeGreaterThanOrEqual(1);
    const log = await stack.api<any[]>('GET', `/projects/${pid}/history?limit=20`);
    expect(log.map((c) => c.message)).toContain('Fix 1 shot(s) of scene 1 before the edit');

    // A fix whose take fails its checks: the shot keeps the take it had (selectIfPasses)
    const kept = fixed.selectedTakeId;
    await stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${broken.id}`, {
      description: `${fixed.description} Continuity break.`,
    });
    stack.gw.jumpVideos(3);
    const again = await stack.api<Job>('POST', `/projects/${pid}/clips/${clip.id}/review`, {});
    expect(again.kind).toBe('clip.review');
    expect(expectSucceeded(await stack.waitJob(pid, again.id, 300_000)).result).toMatchObject({
      round: 2,
      fixes: 1,
      fixed: 0,
    });
    docs = await docsOf(pid);
    clip = docs.clips[clip.id];
    fixed = clip.shots.find((s) => s.id === broken.id)!;
    expect(fixed.takes).toHaveLength(3);
    expect(fixed.selectedTakeId).toBe(kept);
    expect(fixOutcome(clip.review!.fixes[0]!, docs)).toMatchObject({ state: 'not_fixed' });
    expect(await metric('rideo_clip_review_fixes_total', 'not_fixed')).toBeGreaterThanOrEqual(1);

    // Watching only, over MCP: REST and MCP call the same service. (The fix revised the shot's description even
    // though its take did not pass, as the feedback's fixes do; the break is put back to be seen.)
    expect(fixed.description).not.toMatch(/continuity break/i);
    await stack.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${broken.id}`, {
      description: `${fixed.description} Continuity break.`,
    });
    const watched = await call<Job>('clip_review', { projectId: pid, clipId: clip.id, fix: false });
    expect(watched).toMatchObject({ kind: 'clip.review', params: { clipId: clip.id, fix: false } });
    expect(expectSucceeded(await stack.waitJob(pid, watched.id)).result).toMatchObject({
      round: 1,
      fixes: 0,
    });
    clip = (await docsOf(pid)).clips[clip.id];
    expect(clip.review).toMatchObject({ round: 1, fixes: [], before: null });
    expect(clip.review!.issues.some((i) => i.dimension === 'continuity' && i.shotId === broken.id)).toBe(
      true,
    );
    expect(clip.shots.find((s) => s.id === broken.id)!.takes).toHaveLength(3);

    // Once the scene is cut, a passing fix goes into the cut as well, as a feedback fix does
    await stack.api('POST', `/projects/${pid}/clips/${clip.id}/approve`);
    await stack.api('POST', `/projects/${pid}/timeline/assemble`, {});
    const cutTake = async () =>
      (await stack.api<any>('GET', `/projects/${pid}/timeline`)).tracks
        .flatMap((t: { items: any[] }) => t.items)
        .find((i: any) => i.source?.shotId === broken.id).source.takeId;
    expect(await cutTake()).toBe(kept);
    // (the watch-only run left the break in the description)
    const cutReview = await stack.api<Job>('POST', `/projects/${pid}/clips/${clip.id}/review`, {});
    expect(expectSucceeded(await stack.waitJob(pid, cutReview.id, 300_000)).result).toMatchObject({
      fixes: 1,
      fixed: 1,
    });
    const recut = (await docsOf(pid)).clips[clip.id].shots.find((s: { id: string }) => s.id === broken.id);
    expect(recut.takes).toHaveLength(4);
    expect(recut.selectedTakeId).not.toBe(kept);
    expect(await cutTake()).toBe(recut.selectedTakeId);
  });

  it('needs a take for every shot, and stays off when the project turns it off', async () => {
    const { projectId: pid, state } = await readyStoryProject(stack, {
      storyboard: { enabled: false },
      pilotDurationSec: 15,
    });
    const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, {
      sceneId: state.docs.screenplay.scenes[0].id,
    });
    expectSucceeded(await stack.waitJob(pid, plan.id));
    const clip = Object.values<Clip>((await docsOf(pid)).clips)[0]!;
    await expect(stack.api('POST', `/projects/${pid}/clips/${clip.id}/review`, {})).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      stack.api('POST', `/projects/${pid}/clips/${clip.id}/review`, { fix: 'yes' }),
    ).rejects.toMatchObject({ status: 422, body: { code: 'validation_error' } });
    // review.scenes off (the helper's default here): the clip job makes no review
    const gen = await stack.api<Job>('POST', `/projects/${pid}/clips/${clip.id}/generate`);
    expectSucceeded(await stack.waitJob(pid, gen.id, 300_000));
    await stack.waitIdle(pid);
    expect(
      (await stack.api<Job[]>('GET', `/projects/${pid}/jobs`)).some((j) => j.kind === 'clip.review'),
    ).toBe(false);
    expect((await docsOf(pid)).clips[clip.id].review).toBeNull();
    // Every take carries the editor's lane files (docs/design/editor.md#waveforms-and-filmstrips)
    const take = (await docsOf(pid)).clips[clip.id].shots[0].takes[0];
    const strip = take.video.lanes.strip;
    expect(strip).toMatchObject({ everySec: 1, tileHeight: 72, tiles: Math.ceil(take.video.durationSec) });
    const sprite = await fetch(`${stack.url}/api/projects/${pid}/media/${strip.path}`);
    expect(sprite.headers.get('content-type')).toBe('image/jpeg');
    expect((await sprite.arrayBuffer()).byteLength).toBeGreaterThan(500);
    if (take.video.hasAudio) {
      const body = (await (
        await fetch(`${stack.url}/api/projects/${pid}/media/${take.video.lanes.peaks.path}`)
      ).json()) as { perSec: number; peaks: number[] };
      expect(body.perSec).toBe(100);
      // (a sound track may end a little before the picture)
      expect(body.peaks.length).toBeGreaterThan(take.video.durationSec * 100 * 0.8);
      expect(Math.max(...body.peaks)).toBeLessThanOrEqual(255);
    }
  });
});
