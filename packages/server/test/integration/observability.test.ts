import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Clip, Insights, Job } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** Usage, cost, insights and telemetry (docs/design/observability.md) on the mock gateway. */
let stack: Stack;
let client: Client;
beforeAll(async () => {
  stack = await startStack({
    env: {
      RIDEO_PRICES: JSON.stringify({
        'mock-video-v1': { videoSecond: 0.1 },
        'mock-image-v1': { image: 0.02 },
      }),
    },
  });
  client = new Client({ name: 'Claude Code', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${stack.url}/mcp`)));
}, 60_000);
afterAll(async () => {
  await client?.close();
  await stack?.stop();
});

describe('observability', () => {
  it('fills job usage, the project ledger, insights and metrics as a clip is generated', async () => {
    const { projectId: pid, state } = await readyStoryProject(stack, { storyboard: { enabled: false } });
    const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, {
      sceneId: state.docs.screenplay.scenes[0].id,
    });
    expectSucceeded(await stack.waitJob(pid, plan.id));
    const clip = Object.values<Clip>((await stack.api<any>('GET', `/projects/${pid}/state`)).docs.clips)[0]!;
    const gen = await stack.api<Job>('POST', `/projects/${pid}/clips/${clip.id}/generate`);
    expectSucceeded(await stack.waitJob(pid, gen.id, 180_000));
    await stack.waitIdle(pid);

    const jobs = await stack.api<Job[]>('GET', `/projects/${pid}/jobs`);
    const shotJob = jobs.find((j) => j.kind === 'shot.generate')!;
    expect(shotJob.usage?.videoCount).toBeGreaterThanOrEqual(1);
    expect(shotJob.usage?.byModel['mock-video-v1']?.costUsd).toBeGreaterThan(0);
    expect(jobs.find((j) => j.kind === 'clip.plan')!.usage?.llmCalls).toBe(1);

    const insights = await stack.api<Insights>('GET', `/projects/${pid}/insights`);
    expect(insights.usage.totals.costUsd).toBeGreaterThan(0);
    expect(insights.usage.totals.images).toBeGreaterThan(0);
    expect(insights.usage.byKind['shot.generate']?.jobs).toBeGreaterThanOrEqual(1);
    expect(insights.jobs.find((j) => j.kind === 'shot.generate')).toMatchObject({ failed: 0 });
    expect(insights.takes.total).toBeGreaterThanOrEqual(clip.shots.length);
    expect(insights.takes.firstTry).toBe(clip.shots.length);
    expect(insights.characters.length).toBeGreaterThan(0);
    expect(insights.stages.length).toBeGreaterThan(0);
    // The same over MCP.
    const viaMcp = await client.callTool({ name: 'project_insights', arguments: { projectId: pid } });
    expect(JSON.parse((viaMcp.content as { text: string }[])[0]!.text).usage.totals.costUsd).toBe(
      insights.usage.totals.costUsd,
    );

    // The ledger is written behind the jobs (embedded WebDAV keeps it in the data directory).
    await new Promise((r) => setTimeout(r, 5500));
    const ledger = JSON.parse(
      await readFile(
        join(stack.dataDir, 'dav', 'rideo', 'projects', pid, '.rideo', 'usage.json'),
        'utf8',
      ).catch(async () =>
        readFile(join(stack.dataDir, 'dav', 'projects', pid, '.rideo', 'usage.json'), 'utf8'),
      ),
    );
    expect(ledger.totals.videoCount).toBe(insights.usage.totals.videoCount);

    const metrics = await (await fetch(`${stack.url}/metrics`)).text();
    expect(metrics).toMatch(/rideo_cost_usd_total\{modality="video",model="mock-video-v1"\} [0-9.]+/);
    expect(metrics).toMatch(
      /rideo_gateway_usage_total\{modality="video",model="mock-video-v1",unit="video_seconds"\}/,
    );
    expect(metrics).toMatch(/rideo_job_wait_seconds_count\{kind="shot.generate"\} [1-9]/);
    expect(metrics).toMatch(/rideo_llm_call_seconds_count\{model="[^"]+",task="clip.plan"\} 1/);
    expect(metrics).toMatch(/rideo_shot_step_seconds_count\{step="video"\} [1-9]/);
    expect(metrics).toMatch(/rideo_take_attempts_count\{stage="video"\} [1-9]/);
    expect(metrics).toMatch(
      /rideo_http_request_seconds_count\{method="GET",route="\/api\/projects\/:id\/insights",status="2xx"\} 1/,
    );
    expect(metrics).toContain('rideo_storage_ops_per_request_count');
  });

  it('takes telemetry from the studio as metrics, and refuses what it does not know', async () => {
    const res = await fetch(`${stack.url}/api/telemetry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [
          { kind: 'vital', name: 'lcp', value: 1.4, route: '/projects' },
          { kind: 'vital', name: 'cls', value: 0.02 },
          { kind: 'timing', name: 'editor_ready', value: 3.2 },
          { kind: 'error', name: 'api', value: 2 },
        ],
      }),
    });
    expect(res.status).toBe(204);
    const bad = await fetch(`${stack.url}/api/telemetry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ kind: 'vital', name: 'mood', value: 1 }] }),
    });
    expect(bad.status).toBe(422);
    const metrics = await (await fetch(`${stack.url}/metrics`)).text();
    expect(metrics).toMatch(/rideo_web_vitals_seconds_count\{metric="lcp"\} 1/);
    expect(metrics).toMatch(/rideo_web_cls_count 1/);
    expect(metrics).toMatch(/rideo_web_timing_seconds_count\{op="editor_ready"\} 1/);
    expect(metrics).toMatch(/rideo_web_errors_total\{kind="api"\} 2/);
  });
});
