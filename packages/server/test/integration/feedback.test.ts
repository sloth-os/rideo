import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMockGateway } from '@rideo/mock-gateway';
import { type Clip, type Feedback, fixOutcome, type Job } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEditorWorker } from '../helpers/editor-worker';
import { ApiError, expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** Feedback on the finished film (docs/design/feedback.md) on the mock gateway. */
let stack: Stack;
let client: Client;
beforeAll(async () => {
  stack = await startStack({
    gw: await startMockGateway({ latencyMs: 20 }),
    // Prices for the estimates of the fixes (docs/design/feedback.md#what-a-fix-costs)
    env: {
      RIDEO_PRICES: JSON.stringify({
        'mock-video-v1': { videoSecond: 0.25 },
        'mock-image-v1': { image: 0.05 },
      }),
    },
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

const stateOf = (pid: string) => stack.api<any>('GET', `/projects/${pid}/state`);

async function feedbackJob(pid: string): Promise<Job> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const job = (await stack.api<Job[]>('GET', `/projects/${pid}/jobs`)).find(
      (j) => j.kind === 'export.feedback',
    );
    if (job) return stack.waitJob(pid, job.id, 180_000);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('no feedback job');
}

describe('feedback on an export', () => {
  it('watches a story export by itself, pins issues to shots, writes the retrospective and the report, and applies recommendations', async () => {
    const { projectId: pid, state } = await readyStoryProject(stack, {
      storyboard: { enabled: false },
      pilotDurationSec: 30,
      targetDurationSec: 30,
      dialogue: { mode: 'off', level: 'B1' },
      generation: { includeAudio: true },
    });
    const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, {
      sceneId: state.docs.screenplay.scenes[0].id,
    });
    expectSucceeded(await stack.waitJob(pid, plan.id));
    let clip = Object.values<Clip>((await stateOf(pid)).docs.clips)[0]!;
    const gen = await stack.api<Job>('POST', `/projects/${pid}/clips/${clip.id}/generate`);
    expectSucceeded(await stack.waitJob(pid, gen.id, 180_000));
    await stack.waitIdle(pid);
    // The last shot jumps on every attempt: it is kept, marked, and the export carries the jump.
    clip = (await stateOf(pid)).docs.clips[clip.id];
    const shots = [...clip.shots].sort((a, b) => a.index - b.index);
    const jumpy = shots[shots.length - 1]!;
    stack.gw.jumpVideos(3);
    const regen = await stack.api<Job>(
      'POST',
      `/projects/${pid}/clips/${clip.id}/shots/${jumpy.id}/regenerate`,
    );
    expectSucceeded(await stack.waitJob(pid, regen.id));
    clip = (await stateOf(pid)).docs.clips[clip.id];
    const kept = clip.shots.find((s) => s.id === jumpy.id)!;
    expect(kept.takes.find((t) => t.id === kept.selectedTakeId)!.consistency.quality?.passed).toBe(false);

    await stack.api('POST', `/projects/${pid}/clips/${clip.id}/approve`);
    await stack.api('POST', `/projects/${pid}/timeline/assemble`, {});
    const editor = await startEditorWorker(stack, pid);
    const exp = await stack.api<any>('POST', `/projects/${pid}/exports`, { quality: 'draft' });
    const done = await stack.waitExport(pid, exp.export.id);
    expect(done.status).toBe('succeeded');
    const fbJob = expectSucceeded(await feedbackJob(pid));
    await editor.stop();
    // Ready before it reached storage, which it does in the background (docs/design/storage-webdav.md#local-cache-and-staging)
    await expect
      .poll(async () => (await stateOf(pid)).docs.exports[done.id].upload, { timeout: 30_000 })
      .toBe('done');
    const log = await stack.api<{ message: string }[]>('GET', `/projects/${pid}/history?limit=30`);
    expect(log.some((c) => c.message.startsWith('Export written to storage'))).toBe(true);

    const [fb] = await stack.api<Feedback[]>('GET', `/projects/${pid}/feedback`);
    expect(fb).toMatchObject({ exportId: done.id, status: 'succeeded', jobId: fbJob.id });
    expect(fb!.model).toBeTruthy();
    expect(fb!.overall).toBeGreaterThan(0);
    expect(fb!.scenes).toHaveLength(1);
    expect(fb!.scenes[0]!.scores.storytelling).toBe(7);
    // The jump: measured on the export, inside the last shot, and seen by the scene review.
    const label = `C1·S${jumpy.index + 1}`;
    expect(fb!.signals.unexpectedCuts.length).toBeGreaterThan(0);
    expect(fb!.signals.takes.qualityFailed).toBe(1);
    // (The mock's slow zooms barely move, so frozen stretches are measured too.)
    const signalJump = fb!.issues.find(
      (i) => i.source === 'signal' && i.title === 'The picture jumps inside the shot',
    );
    expect(signalJump?.shot).toBe(label);
    expect(fb!.issues.some((i) => i.source === 'vision' && i.shot === label)).toBe(true);
    // Recommendations: regenerate the jumpy shot first.
    const regenerate = fb!.recommendations.find((r) => r.action?.kind === 'regenerate_shot')!;
    expect(regenerate.action).toMatchObject({ clipId: clip.id, shotId: jumpy.id });
    // What the fix costs: the shot's seconds times the takes' mean attempts, at the mock models' prices
    expect(regenerate.estimate?.videoSeconds).toBeGreaterThanOrEqual(jumpy.durationSec);
    expect(regenerate.estimate?.usd).toBeGreaterThan(0);
    expect(fb!.recommendations.find((r) => r.action?.kind === 'note')!.estimate).toBeUndefined();
    expect(fb!.recommendations[0]!.priority).toBe(1);
    expect(fb!.retrospective.map((r) => r.rule ?? r.source)).toEqual(
      expect.arrayContaining(['quality_failures', 'unexpected_cuts', 'vision']),
    );
    // The report is on WebDAV with the project's media.
    const report = await fetch(`${stack.url}/api/projects/${pid}/media/${fb!.report!.path}`);
    expect(report.status).toBe(200);
    const md = await report.text();
    expect(md).toContain('# Feedback:');
    expect(md).toContain('## Retrospective: what to improve next time');
    expect(md).toContain(label);

    // Applying the recommendation revises the shot and regenerates it. The judge is down meanwhile: the new take is
    // not verified, so the cut keeps the old one until a re-check passes it
    // (docs/design/character-consistency.md#re-checking-unverified-takes).
    const cutTake = async () =>
      (await stack.api<any>('GET', `/projects/${pid}/timeline`)).tracks
        .flatMap((t: { items: any[] }) => t.items)
        .find((i: any) => i.source?.shotId === jumpy.id).source.takeId;
    const cutBefore = await cutTake();
    await stack.api('PATCH', `/projects/${pid}`, { settings: { consistency: { judge: 'off' } } });
    const applied = await stack.api<{ feedback: Feedback; job: Job }>(
      'POST',
      `/projects/${pid}/feedback/${fb!.id}/recommendations/${regenerate.id}/apply`,
    );
    expect(applied.job.kind).toBe('shot.generate');
    expectSucceeded(await stack.waitJob(pid, applied.job.id));
    clip = (await stateOf(pid)).docs.clips[clip.id];
    const unverified = clip.shots.find((s) => s.id === jumpy.id)!.takes.at(-1)!;
    expect(unverified.consistency.status).toBe('unverified');
    expect(await cutTake()).toBe(cutBefore);
    await stack.api('PATCH', `/projects/${pid}`, { settings: { consistency: { judge: 'vision-llm' } } });
    const recheck = await stack.api<Job>('POST', `/projects/${pid}/consistency/recheck`, {});
    expectSucceeded(await stack.waitJob(pid, recheck.id));
    clip = (await stateOf(pid)).docs.clips[clip.id];
    const fixed = clip.shots.find((s) => s.id === jumpy.id)!;
    expect(fixed.description).toContain('Steady camera, feet planted on the ground.');
    expect(fixed.negativePrompt).toBe('floating, jump cut');
    // The fix names who is in frame: the shot's cast becomes them (docs/design/feedback.md#actions)
    const named = regenerate.action?.kind === 'regenerate_shot' ? (regenerate.action.characters ?? []) : [];
    expect(named.length).toBeGreaterThan(0);
    const people = (await stateOf(pid)).docs.characters as Record<string, { name: string }>;
    expect(fixed.characterIds.map((id) => people[id]!.name).sort()).toEqual([...named].sort());
    expect(fixed.selectedTakeId).toBe(unverified.id);
    expect(fixed.takes.find((t) => t.id === fixed.selectedTakeId)!.consistency).toMatchObject({
      status: 'passed',
      note: 're-checked',
      quality: { passed: true },
    });
    // The new take replaces the old one in the cut.
    expect(await cutTake()).toBe(fixed.selectedTakeId);
    const rec = applied.feedback.recommendations.find((r) => r.id === regenerate.id)!;
    expect(rec).toMatchObject({ status: 'applied', jobId: applied.job.id });

    // A note is dismissed; acting on it again is stale.
    const note = fb!.recommendations.find((r) => r.action?.kind === 'note')!;
    const dismissed = await stack.api<Feedback>(
      'POST',
      `/projects/${pid}/feedback/${fb!.id}/recommendations/${note.id}/dismiss`,
    );
    expect(dismissed.recommendations.find((r) => r.id === note.id)!.status).toBe('dismissed');
    await expect(
      stack.api('POST', `/projects/${pid}/feedback/${fb!.id}/recommendations/${note.id}/apply`),
    ).rejects.toMatchObject({ status: 409, body: { code: 'feedback_stale' } });
    // The film's settings recommendation changes the project.
    const settingsRec = fb!.recommendations.find((r) => r.action?.kind === 'settings')!;
    await stack.api('PATCH', `/projects/${pid}`, { settings: { consistency: { qualityChecks: false } } });
    await stack.api('POST', `/projects/${pid}/feedback/${fb!.id}/recommendations/${settingsRec.id}/apply`);
    expect((await stateOf(pid)).docs.project.settings.consistency.qualityChecks).toBe(true);
    // A film with only its cast is a setting like the others (docs/design/continuity.md#quality-checks-in-the-gate)
    expect((await stateOf(pid)).docs.project.settings.consistency.castOnly).toBe(false);
    await stack.api('PATCH', `/projects/${pid}`, { settings: { consistency: { castOnly: true } } });
    expect((await stateOf(pid)).docs.project.settings.consistency).toMatchObject({
      castOnly: true,
      qualityChecks: true,
    });

    // MCP sees the same feedback, and runs it again on request.
    const viaMcp = await call<Feedback>('feedback_get', { projectId: pid });
    expect(viaMcp.id).toBe(fb!.id);
    const again = await call<{ feedback: Feedback; job: Job }>('export_feedback', {
      projectId: pid,
      exportId: done.id,
    });
    expect(again.feedback.status).toBe('running');
    expectSucceeded(await stack.waitJob(pid, again.job.id, 180_000));
    const metrics = await (await fetch(`${stack.url}/metrics`)).text();
    expect(metrics).toMatch(/rideo_feedback_total\{outcome="succeeded"\} 2/);
    expect(metrics).toMatch(
      /rideo_feedback_recommendations_total\{action="regenerate_shot",outcome="applied"\} 1/,
    );

    // The next export's feedback compares the re-taken shot then and now, even though the first feedback was run
    // again since (docs/design/feedback.md#what-changed-since-the-last-feedback)
    const nextEditor = await startEditorWorker(stack, pid);
    const exp2 = await stack.api<any>('POST', `/projects/${pid}/exports`, { quality: 'draft' });
    const done2 = await stack.waitExport(pid, exp2.export.id);
    expect(done2.status).toBe('succeeded');
    let fb2Job: Job | undefined;
    for (let t = Date.now(); !fb2Job && Date.now() - t < 60_000; ) {
      fb2Job = (await stack.api<Job[]>('GET', `/projects/${pid}/jobs`)).find(
        (j) => j.kind === 'export.feedback' && j.params.exportId === done2.id,
      );
      if (!fb2Job) await new Promise((r) => setTimeout(r, 200));
    }
    expectSucceeded(await stack.waitJob(pid, fb2Job!.id, 180_000));
    await nextEditor.stop();
    const fb2 = (await stack.api<Feedback[]>('GET', `/projects/${pid}/feedback`)).find(
      (x) => x.exportId === done2.id,
    )!;
    expect(fb2.previousFeedbackId).toBe(fb!.id);
    expect(fb2.retakes).toHaveLength(1);
    const retake = fb2.retakes[0]!;
    expect(retake).toMatchObject({
      shotId: jumpy.id,
      shot: label,
      outcome: 'better',
      after: { takeId: fixed.selectedTakeId },
    });
    expect(retake.before.issues).toBeGreaterThan(retake.after.issues);
    expect(fb2.retrospective.map((r) => r.rule)).toContain('retake_results');
    const md2 = await (await fetch(`${stack.url}/api/projects/${pid}/media/${fb2.report!.path}`)).text();
    expect(md2).toContain('## What changed since the last feedback');
    expect(md2).toContain(`- ${label}: ${retake.before.issues} → ${retake.after.issues} (better)`);
  });

  it('refuses an export that has not finished, and one that does not exist', async () => {
    const { projectId: pid } = await readyStoryProject(stack, { storyboard: { enabled: false } });
    const err = await stack
      .api('POST', `/projects/${pid}/exports/exp_0000000000aaaaaa/feedback`)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });
});

describe('listening feedback (an audio-visual model)', () => {
  let heard: Stack;
  beforeAll(async () => {
    heard = await startStack({
      gw: await startMockGateway({ latencyMs: 20 }),
      env: { RIDEO_OMNI_MODEL: 'mock-omni' },
    });
  }, 60_000);
  afterAll(async () => {
    await heard?.stop();
    await heard?.gw.close();
  });

  it('watches and hears each scene, finds the line nobody heard and recommends generating its shot again', async () => {
    const { projectId: pid, state } = await readyStoryProject(heard, {
      storyboard: { enabled: false },
      pilotDurationSec: 30,
      targetDurationSec: 30,
      dialogue: { mode: 'off', level: 'B1' },
      generation: { includeAudio: true },
    });
    const plan = await heard.api<Job>('POST', `/projects/${pid}/clips/plan`, {
      sceneId: state.docs.screenplay.scenes[0].id,
    });
    expectSucceeded(await heard.waitJob(pid, plan.id));
    let clip = Object.values<Clip>((await heard.api<any>('GET', `/projects/${pid}/state`)).docs.clips)[0]!;
    // The speaker of the first spoken shot mumbles: no take of it is heard, so the best one is kept, marked.
    const spoken = clip.shots.find((s) => s.dialogue.some((d) => d.characterId))!;
    await heard.api('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${spoken.id}`, {
      description: `${spoken.description} The speaker mumbles.`,
    });
    const gen = await heard.api<Job>('POST', `/projects/${pid}/clips/${clip.id}/generate`);
    expectSucceeded(await heard.waitJob(pid, gen.id, 180_000));
    await heard.waitIdle(pid);
    clip = (await heard.api<any>('GET', `/projects/${pid}/state`)).docs.clips[clip.id];
    const kept = clip.shots.find((s) => s.id === spoken.id)!;
    const keptTake = kept.takes.find((t) => t.id === kept.selectedTakeId)!;
    expect(keptTake.consistency.quality).toMatchObject({ passed: false, sound: { lines: [{ heard: 0 }] } });
    expect(keptTake.consistency.attempts).toBe(3);

    await heard.api('POST', `/projects/${pid}/clips/${clip.id}/approve`);
    await heard.api('POST', `/projects/${pid}/timeline/assemble`, {});
    const editor = await startEditorWorker(heard, pid);
    const exp = await heard.api<any>('POST', `/projects/${pid}/exports`, { quality: 'draft' });
    const done = await heard.waitExport(pid, exp.export.id);
    expect(done.status).toBe('succeeded');
    const deadline = Date.now() + 60_000;
    let fbJob: Job | undefined;
    while (!fbJob && Date.now() < deadline) {
      fbJob = (await heard.api<Job[]>('GET', `/projects/${pid}/jobs`)).find(
        (j) => j.kind === 'export.feedback',
      );
      if (!fbJob) await new Promise((r) => setTimeout(r, 200));
    }
    expectSucceeded(await heard.waitJob(pid, fbJob!.id, 180_000));
    await editor.stop();

    const [fb] = await heard.api<Feedback[]>('GET', `/projects/${pid}/feedback`);
    // The picture seen in strips by the vision model, the sound heard by the audio-visual model
    expect(fb).toMatchObject({ status: 'succeeded', listener: 'mock-omni', listened: true });
    expect(fb!.model).not.toBe('mock-omni');
    expect(fb!.scores.dialogue).toBe(4);
    expect(fb!.scores.sound).not.toBeNull();
    const voiced = clip.shots.flatMap((s) => s.dialogue.filter((d) => d.characterId));
    expect(fb!.signals.dialogue).toMatchObject({ lines: voiced.length, heard: voiced.length - 1 });
    const label = `C1·S${spoken.index + 1}`;
    expect(fb!.signals.dialogue!.missing).toMatchObject([{ shot: label, heard: 0 }]);
    const notHeard = fb!.issues.find((i) => i.source === 'signal' && i.dimension === 'dialogue')!;
    expect(notHeard).toMatchObject({ shot: label, shotId: spoken.id, severity: 'major' });
    const regenerate = fb!.recommendations.find(
      (r) => r.action?.kind === 'regenerate_shot' && r.action.shotId === spoken.id,
    )!;
    expect(regenerate).toBeTruthy();
    expect(fb!.retrospective.map((r) => r.rule)).toContain('undelivered_lines');
    const md = await (await fetch(`${heard.url}/api/projects/${pid}/media/${fb!.report!.path}`)).text();
    expect(md).toContain(`watched by ${fb!.model}, heard by mock-omni`);
    expect(md).toContain(`Lines heard: ${voiced.length - 1} of ${voiced.length}.`);

    // The fix's take is not heard either: it fails its checks, so the cut keeps the previous take
    // (docs/design/feedback.md#when-a-fix-does-not-pass)
    const cutTake = async () =>
      (await heard.api<any>('GET', `/projects/${pid}/timeline`)).tracks
        .flatMap((t: { items: any[] }) => t.items)
        .find((i: any) => i.source?.shotId === spoken.id).source.takeId;
    const before = await cutTake();
    heard.gw.muffleSpeech(3);
    const applied = await heard.api<{ feedback: Feedback; job: Job }>(
      'POST',
      `/projects/${pid}/feedback/${fb!.id}/recommendations/${regenerate.id}/apply`,
    );
    expectSucceeded(await heard.waitJob(pid, applied.job.id, 180_000));
    await heard.waitIdle(pid);
    const fixedDocs = (await heard.api<any>('GET', `/projects/${pid}/state`)).docs;
    const rec = fixedDocs.feedback[fb!.id].recommendations.find(
      (r: { id: string }) => r.id === regenerate.id,
    );
    const outcome = fixOutcome(rec, fixedDocs);
    expect(outcome).toMatchObject({ state: 'not_fixed', inCut: false });
    expect(outcome?.state === 'not_fixed' && outcome.issues.join(' ')).toContain('not heard');
    expect(await cutTake()).toBe(before);
    // A person uses it anyway: selected and in the cut, one commit
    const takeId = outcome?.state === 'not_fixed' ? outcome.takeId : '';
    await heard.api('POST', `/projects/${pid}/clips/${clip.id}/shots/${spoken.id}/takes/${takeId}/select`, {
      inCut: true,
    });
    expect(await cutTake()).toBe(takeId);
    const after = (await heard.api<any>('GET', `/projects/${pid}/state`)).docs;
    expect(fixOutcome(rec, after)).toMatchObject({ state: 'not_fixed', inCut: true });
    const log = await heard.api<any[]>('GET', `/projects/${pid}/history?limit=5`);
    expect(log[0].message).toMatch(/^Select take .* and put it in the cut$/);
  });
});
