import { type RunningMockGateway, startMockGateway } from '@rideo/mock-gateway';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayClient, GatewayHttpError, GatewayTaskError } from '../../src/gateway/gateway-client';
import { ProxyClient } from '../../src/gateway/proxy-client';
import { Metrics } from '../../src/metrics';

let gw: RunningMockGateway;
let client: GatewayClient;
const metrics = new Metrics();

beforeAll(async () => {
  gw = await startMockGateway({ latencyMs: 20, apiKey: 'k' });
  client = new GatewayClient({
    url: gw.url,
    apiKey: 'k',
    pollMs: 20,
    timeoutsSec: { image: 30, video: 60, music: 30 },
    metrics,
  });
});
afterAll(async () => {
  await gw.close();
});

describe('GatewayClient (SDK)', () => {
  it('creates and polls tasks to completion with idempotency', async () => {
    const seen: string[] = [];
    const req = {
      input: [{ type: 'text' as const, text: 'a lighthouse' }],
      parameters: { dimensions: { width: 64, height: 64 } },
    };
    const task = await client.generateImage(req, {
      idempotencyKey: 'job-1:kf:0',
      onTask: (t) => seen.push(t.status),
      metadata: { rideo_job: 'job-1' },
    });
    expect(task.status).toBe('succeeded');
    expect(task.outputs?.[0]?.uri).toContain('/files/');
    expect(task.metadata?.rideo_job).toBe('job-1');
    expect(seen[0]).toBe('pending');
    // A re-run (e.g. after a restart) sends the identical body with the same key and gets the same task back.
    const replay = await client.generateImage(req, {
      idempotencyKey: 'job-1:kf:0',
      metadata: { rideo_job: 'job-1' },
    });
    expect(replay.id).toBe(task.id);
    expect(metrics.gatewayTasks.get({ modality: 'image', status: 'succeeded' })).toBe(2);
  });

  it('classifies task failures and HTTP problems', async () => {
    const failed = await client
      .generateVideo(
        { input: [{ type: 'text', text: 'x' }], metadata: { mock_fail: 'rate_limited' } },
        { idempotencyKey: 'f1' },
      )
      .catch((e) => e);
    expect(failed).toBeInstanceOf(GatewayTaskError);
    expect(failed).toMatchObject({ taskCode: 'rate_limited', retryable: true });
    const bad = await client
      .generateImage(
        { input: [{ type: 'text', text: 'x' }], parameters: { size: '1x1' } as never },
        { idempotencyKey: 'b1' },
      )
      .catch((e) => e);
    expect(bad).toBeInstanceOf(GatewayHttpError);
    expect(bad).toMatchObject({ status: 422, problemCode: 'validation_error', retryable: false });
    const offline = new GatewayClient({
      url: 'http://127.0.0.1:9',
      pollMs: 20,
      timeoutsSec: { image: 5, video: 5, music: 5 },
    });
    const net = await offline
      .generateImage({ input: [{ type: 'text', text: 'x' }] }, { idempotencyKey: 'n1' })
      .catch((e) => e);
    expect(net).toMatchObject({ retryable: true });
    expect(await offline.health()).toBe(false);
  });

  it('reads model limits and the proxy authenticates with the gateway key', async () => {
    expect((await client.limitsFor('video', 'auto')).limits?.max_duration_seconds).toBe(10);
    expect((await client.limitsFor('image', 'mock-image-v1')).model).toBe('mock-image-v1');
    const proxy = new ProxyClient({ baseUrl: gw.url, apiKey: 'k' });
    const res = await proxy.fetch('api.openai.com', '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    expect(() => proxy.url('evil/../x', 'y')).toThrow(/invalid proxy domain/);
    expect((await new ProxyClient({ baseUrl: gw.url }).fetch('api.openai.com', 'v1/models')).status).toBe(
      401,
    );
  });
});
