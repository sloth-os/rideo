import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type RunningMockGateway, startMockGateway } from '@rideo/mock-gateway';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

  it('asks image and video models for no visible watermark, unless a request says otherwise', async () => {
    const parametersOf = (id: string) => (gw.store.requests.get(id) as { parameters?: object }).parameters;
    const image = await client.generateImage(
      { input: [{ type: 'text', text: 'a slope' }], parameters: { output_count: 1 } },
      { idempotencyKey: 'wm-image' },
    );
    expect(parametersOf(image.id)).toEqual({ watermark: false, output_count: 1 });
    // The request is what matters: the unit job has no ffmpeg to render the mock's video or music
    const created: string[] = [];
    const onTask = (t: { id: string }) => {
      if (!created.includes(t.id)) created.push(t.id);
    };
    await client
      .generateVideo(
        { input: [{ type: 'text', text: 'a run' }], parameters: { duration_seconds: 5 } },
        { idempotencyKey: 'wm-video', onTask },
      )
      .catch(() => undefined);
    expect(parametersOf(created[0]!)).toMatchObject({ watermark: false, duration_seconds: 5 });
    const marked = await client.generateImage(
      { input: [{ type: 'text', text: 'a slope' }], parameters: { watermark: true } },
      { idempotencyKey: 'wm-kept' },
    );
    expect(parametersOf(marked.id)).toEqual({ watermark: true });
    await client
      .generateMusic(
        { input: [{ type: 'text', text: 'a theme' }], parameters: { duration_seconds: 5 } },
        { idempotencyKey: 'wm-music', onTask },
      )
      .catch(() => undefined);
    expect(parametersOf(created[1]!)).not.toHaveProperty('watermark');
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

  it('waits for a busy provider to create the task: a 429 made no task (docs/design/ai-gateway.md#sdk-usage)', async () => {
    const local = new Metrics();
    const patient = new GatewayClient({
      url: gw.url,
      apiKey: 'k',
      pollMs: 20,
      timeoutsSec: { image: 30, video: 60, music: 30 },
      metrics: local,
    });
    const before = gw.counters.busy;
    gw.busyCreates(2);
    // An image (the unit job has no ffmpeg for the mock's videos): every modality creates the same way
    const done = await patient.generateImage(
      { input: [{ type: 'text', text: 'x' }] },
      { idempotencyKey: 'busy-1' },
    );
    expect(done.status).toBe('succeeded');
    expect(gw.counters.busy - before).toBe(2);
    expect(local.gatewayTasks.get({ modality: 'image', status: 'busy' })).toBe(2);
    expect(local.gatewayTasks.get({ modality: 'image', status: 'rejected' })).toBe(0);
    // Another answer than 429 is not waited for
    const bad = await patient
      .generateImage(
        { input: [{ type: 'text', text: 'x' }], parameters: { size: '1x1' } as never },
        { idempotencyKey: 'busy-2' },
      )
      .catch((e) => e);
    expect(bad).toMatchObject({ status: 422 });
    expect(local.gatewayTasks.get({ modality: 'image', status: 'busy' })).toBe(2);
    expect(local.gatewayTasks.get({ modality: 'image', status: 'rejected' })).toBe(1);
  });

  it('aborts the request in flight with the job and reports what the gateway answered', async () => {
    const seen: IncomingHttpHeaders[] = [];
    let closed = 0;
    // A gateway that never answers video creates and sits behind a proxy that fails images with an HTML page.
    const server = createServer((req, res) => {
      seen.push(req.headers);
      if (req.url === '/v1/videos') {
        res.on('close', () => closed++);
        return;
      }
      res.writeHead(502, { 'content-type': 'text/html' }).end('<html>bad gateway</html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const local = new Metrics();
    const stuck = new GatewayClient({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
      apiKey: 'secret',
      pollMs: 20,
      timeoutsSec: { image: 5, video: 5, music: 5 },
      metrics: local,
    });
    try {
      const ctrl = new AbortController();
      const pending = stuck
        .generateVideo(
          { input: [{ type: 'text', text: 'x' }] },
          { idempotencyKey: 'a1', signal: ctrl.signal },
        )
        .catch((e) => e);
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      ctrl.abort();
      expect(await pending).toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => expect(closed).toBe(1));
      expect(seen[0]).toMatchObject({
        authorization: 'Bearer secret',
        'idempotency-key': 'a1',
        'content-type': 'application/json',
        'user-agent': 'rideo/0.1 (@sloth-os/mm-gateway-ts)',
      });
      const html = await stuck
        .generateImage({ input: [{ type: 'text', text: 'x' }] }, { idempotencyKey: 'h1' })
        .catch((e) => e);
      expect(html).toBeInstanceOf(GatewayHttpError);
      expect(html).toMatchObject({ status: 502, problemCode: undefined, retryable: true });
      expect(html.message).toBe('mm-gateway 502: Request failed with status code 502');
      expect(local.gatewayTasks.get({ modality: 'video', status: 'rejected' })).toBe(0);
      expect(local.gatewayTasks.get({ modality: 'image', status: 'rejected' })).toBe(1);
    } finally {
      server.close();
    }
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

describe('ProxyClient connections', () => {
  /** Answers after `delayMs` with what it received: the content type and the body's length. */
  async function slowServer(delayMs: number) {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (d: Buffer) => chunks.push(d));
      req.on('end', () =>
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              type: req.headers['content-type'] ?? null,
              length: Buffer.concat(chunks).length,
              auth: req.headers.authorization ?? null,
            }),
          );
        }, delayMs),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('waits for slow headers as long as the call’s own timeout allows, and no longer', async () => {
    const upstream = await slowServer(300);
    try {
      const proxy = new ProxyClient({ baseUrl: upstream.url, apiKey: 'k' });
      const res = await proxy.fetch('api.openai.com', 'v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"stream":true}',
        timeoutMs: 5_000,
      });
      expect(await res.json()).toEqual({ type: 'application/json', length: 15, auth: 'Bearer k' });
      await expect(
        proxy.fetch('api.openai.com', 'v1/chat/completions', { method: 'POST', body: '{}', timeoutMs: 100 }),
      ).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      await upstream.close();
    }
  });

  it('sends uploads as multipart', async () => {
    const upstream = await slowServer(0);
    try {
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(100)]), 'a.wav');
      form.set('model', 'whisper-1');
      const res = await new ProxyClient({ baseUrl: upstream.url }).fetch(
        'api.openai.com',
        'v1/audio/transcriptions',
        { method: 'POST', body: form },
      );
      const seen = (await res.json()) as { type: string; length: number };
      expect(seen.type).toMatch(/^multipart\/form-data; boundary=/);
      expect(seen.length).toBeGreaterThan(100);
    } finally {
      await upstream.close();
    }
  });
});
