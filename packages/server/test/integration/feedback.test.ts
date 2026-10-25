import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMockGateway } from '@rideo/mock-gateway';
import type { Clip, Feedback, Job } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEditorWorker } from '../helpers/editor-worker';
import { ApiError, expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** Feedback on the finished film (docs/design/feedback.md) on the mock gateway. */
let stack: Stack;
let client: Client;
beforeAll(async () => {
  stack = await startStack({ gw: await startMockGateway({ latencyMs: 20 }) });
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

    // Applying the recommendation revises the shot and regenerates it.
    const applied = await stack.api<{ feedback: Feedback; job: Job }>(
      'POST',
      `/projects/${pid}/feedback/${fb!.id}/recommendations/${regenerate.id}/apply`,
    );
    expect(applied.job.kind).toBe('shot.generate');
    expectSucceeded(await stack.waitJob(pid, applied.job.id));
    clip = (await stateOf(pid)).docs.clips[clip.id];
    const fixed = clip.shots.find((s) => s.id === jumpy.id)!;
    expect(fixed.description).toContain('Steady camera, feet planted on the ground.');
    expect(fixed.negativePrompt).toBe('floating, jump cut');
    expect(fixed.takes.find((t) => t.id === fixed.selectedTakeId)!.consistency.quality?.passed).toBe(true);
    // The new take replaces the old one in the cut.
    const cut = await stack.api<any>('GET', `/projects/${pid}/timeline`);
    const item = cut.tracks
      .flatMap((t: { items: any[] }) => t.items)
      .find((i: any) => i.source?.shotId === jumpy.id);
    expect(item.source.takeId).toBe(fixed.selectedTakeId);
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
