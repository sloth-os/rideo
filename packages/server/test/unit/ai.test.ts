import { ClipPlanOutputSchema } from '@rideo/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicAdapter,
  createAdapter,
  GeminiAdapter,
  type LlmAdapter,
  LlmError,
  type LlmRequest,
  OpenAiAdapter,
  retryAfterOf,
} from '../../src/ai/llm';
import { extractJson, LlmTasks, SYSTEM_PROMPTS } from '../../src/ai/tasks';
import type { ProxyClient } from '../../src/gateway/proxy-client';
import { Metrics } from '../../src/metrics';

class FakeProxy {
  calls: { domain: string; path: string; body: any; headers: Headers; timeoutMs?: number }[] = [];
  constructor(private readonly reply: unknown) {}
  async fetch(domain: string, path: string, init: RequestInit & { timeoutMs?: number }) {
    this.calls.push({
      domain,
      path,
      body: JSON.parse(String(init.body)),
      headers: new Headers(init.headers),
      timeoutMs: init.timeoutMs,
    });
    return new Response(JSON.stringify(this.reply), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
}

const req: LlmRequest = {
  system: 'rideo-task: clip.plan',
  parts: [
    { type: 'text', text: 'INPUT:\n{}' },
    { type: 'image', data: Buffer.from('png'), mime: 'image/png' },
  ],
  json: true,
  temperature: 0.2,
};

describe('LLM adapters speak each upstream through the gateway proxy', () => {
  it('OpenAI chat completions', async () => {
    const proxy = new FakeProxy({
      choices: [{ message: { content: '{"a":1}' } }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
    const res = await new OpenAiAdapter(proxy as unknown as ProxyClient, 'api.openai.com', 'gpt-x').complete(
      req,
    );
    expect(res).toEqual({ text: '{"a":1}', usage: { input: 3, output: 4 } });
    const call = proxy.calls[0]!;
    expect([call.domain, call.path]).toEqual(['api.openai.com', 'v1/chat/completions']);
    expect(call.body.response_format).toEqual({ type: 'json_object' });
    expect(call.body.messages[1].content[1].image_url.url).toBe(
      `data:image/png;base64,${Buffer.from('png').toString('base64')}`,
    );
  });

  it('Gemini generateContent', async () => {
    const proxy = new FakeProxy({
      candidates: [{ content: { parts: [{ text: '{"b":' }, { text: '2}' }] } }],
    });
    const res = await new GeminiAdapter(
      proxy as unknown as ProxyClient,
      'generativelanguage.googleapis.com',
      'gemini-x',
    ).complete(req);
    expect(res.text).toBe('{"b":2}');
    const call = proxy.calls[0]!;
    expect(call.path).toBe('v1beta/models/gemini-x:generateContent');
    expect(call.body.generationConfig.responseMimeType).toBe('application/json');
    expect(call.body.contents[0].parts[1].inline_data.mime_type).toBe('image/png');
  });

  it('Anthropic messages with a JSON prefill', async () => {
    const proxy = new FakeProxy({ content: [{ type: 'text', text: '"c":3}' }] });
    const res = await new AnthropicAdapter(
      proxy as unknown as ProxyClient,
      'api.anthropic.com',
      'claude-x',
    ).complete(req);
    expect(res.text).toBe('{"c":3}');
    const call = proxy.calls[0]!;
    expect(call.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(call.body.messages.at(-1)).toEqual({ role: 'assistant', content: '{' });
    expect(call.body.messages[0].content[1].source.type).toBe('base64');
  });

  it('gives every call the configured timeout (RIDEO_LLM_TIMEOUT_SEC), else the proxy default', async () => {
    const replies = {
      openai: { choices: [{ message: { content: '{}' } }] },
      gemini: { candidates: [{ content: { parts: [{ text: '{}' }] } }] },
      anthropic: { content: [{ type: 'text', text: '}' }] },
    } as const;
    for (const provider of ['openai', 'gemini', 'anthropic'] as const) {
      const proxy = new FakeProxy(replies[provider]);
      const endpoint = { provider, domain: 'ai.example.com', model: 'm' };
      await createAdapter(proxy as unknown as ProxyClient, endpoint, 600_000).complete(req);
      await createAdapter(proxy as unknown as ProxyClient, endpoint).complete(req);
      expect(
        proxy.calls.map((c) => c.timeoutMs),
        provider,
      ).toEqual([600_000, undefined]);
    }
  });
});

class ScriptedAdapter implements LlmAdapter {
  readonly provider = 'fake';
  readonly model = 'fake-1';
  calls: LlmRequest[] = [];
  constructor(private readonly answers: string[]) {}
  async complete(r: LlmRequest) {
    this.calls.push(r);
    return { text: this.answers[Math.min(this.calls.length - 1, this.answers.length - 1)]! };
  }
}

describe('structured tasks', () => {
  it('extracts JSON from fences and prose', () => {
    expect(extractJson('```json\n{"x":1}\n```')).toEqual({ x: 1 });
    expect(extractJson('Sure! {"y":[1,2]} Hope that helps.')).toEqual({ y: [1, 2] });
    expect(() => extractJson('no json here')).toThrow();
  });

  it('repairs invalid output once, then fails with llm_invalid_output', async () => {
    const good = JSON.stringify({ shots: [{ description: 'Wide', durationSec: 5 }] });
    const repaired = new ScriptedAdapter(['{"shots": []}', good]);
    const tasks = new LlmTasks(repaired, repaired);
    const out = await tasks.run('clip.plan', ClipPlanOutputSchema, { scene: {} });
    expect(out.shots[0]!.description).toBe('Wide');
    expect(repaired.calls).toHaveLength(2);
    expect((repaired.calls[1]!.parts.at(-1) as { text: string }).text).toContain('did not match');
    expect(repaired.calls[0]!.system).toBe(SYSTEM_PROMPTS['clip.plan']);

    const broken = new ScriptedAdapter(['nope', 'still nope']);
    await expect(
      new LlmTasks(broken, broken).run('clip.plan', ClipPlanOutputSchema, {}),
    ).rejects.toMatchObject({ code: 'llm_invalid_output', retryable: true });
  });

  it('makes a call again while the provider turns it away for load, and only then', async () => {
    const good = JSON.stringify({ shots: [{ description: 'Wide', durationSec: 5 }] });
    const problem = (code: string) =>
      JSON.stringify({ type: `urn:mm-gateway:problem:${code}`, code, title: code, status: 503 });
    class FlakyAdapter implements LlmAdapter {
      readonly provider = 'fake';
      readonly model = 'fake-1';
      calls = 0;
      constructor(private readonly failures: Error[]) {}
      async complete() {
        this.calls++;
        const err = this.failures.shift();
        if (err) throw err;
        return { text: good };
      }
    }
    const metrics = new Metrics();
    const info = vi.fn();
    const retry = { retries: 3, baseMs: 1, maxMs: 50 };
    const overloaded = new FlakyAdapter([
      new LlmError('503', 503, true, 'system cpu overloaded'),
      new LlmError('429', 429, true, '', 30),
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }),
    ]);
    const tasks = new LlmTasks(overloaded, overloaded, { metrics, log: { info }, retry });
    const started = Date.now();
    expect((await tasks.run('clip.plan', ClipPlanOutputSchema, {})).shots).toHaveLength(1);
    expect(overloaded.calls).toBe(4);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30); // the 429's Retry-After
    expect(metrics.llmRetries.get({ task: 'clip.plan', status: '503' })).toBe(1);
    expect(metrics.llmRetries.get({ task: 'clip.plan', status: '429' })).toBe(1);
    expect(metrics.llmRetries.get({ task: 'clip.plan', status: 'ECONNRESET' })).toBe(1);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'clip.plan', status: '503', attempt: 1 }),
      'LLM call turned away; retrying',
    );

    // gives up after its retries with the provider's error
    const down = new FlakyAdapter(Array.from({ length: 5 }, () => new LlmError('502', 502, true)));
    await expect(
      new LlmTasks(down, down, { retry }).run('clip.plan', ClipPlanOutputSchema, {}),
    ).rejects.toMatchObject({
      status: 502,
    });
    expect(down.calls).toBe(4);
    // ...and does not repeat what waiting does not fix
    for (const err of [
      new LlmError('400', 400, false),
      new LlmError('504', 504, true),
      new LlmError('503', 503, true, problem('provider_not_configured')),
      Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
    ]) {
      const once = new FlakyAdapter([err]);
      await expect(
        new LlmTasks(once, once, { retry }).run('clip.plan', ClipPlanOutputSchema, {}),
      ).rejects.toBe(err);
      expect(once.calls).toBe(1);
    }
    // mm-gateway's own load problems are worth waiting for
    const busy = new FlakyAdapter([new LlmError('503', 503, true, problem('upstream_error'))]);
    await new LlmTasks(busy, busy, { retry }).run('clip.plan', ClipPlanOutputSchema, {});
    expect(busy.calls).toBe(2);
    // a cancelled job stops waiting
    const controller = new AbortController();
    const slow = new FlakyAdapter([new LlmError('503', 503, true)]);
    const pending = new LlmTasks(slow, slow, { retry: { retries: 3, baseMs: 10_000, maxMs: 60_000 } }).run(
      'clip.plan',
      ClipPlanOutputSchema,
      {},
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reads Retry-After in seconds or as a date', () => {
    const answer = (value: string) => new Response('', { status: 503, headers: { 'retry-after': value } });
    expect(retryAfterOf(answer('2'))).toBe(2000);
    expect(retryAfterOf(answer(new Date(Date.now() + 5000).toUTCString()))).toBeGreaterThan(3000);
    expect(retryAfterOf(answer('soon'))).toBeUndefined();
    expect(retryAfterOf(new Response('', { status: 503 }))).toBeUndefined();
  });

  it('routes image tasks to the vision adapter with labelled parts', async () => {
    const text = new ScriptedAdapter(['{}']);
    const vision = new ScriptedAdapter([JSON.stringify({ frames: [{ index: 0, characters: [] }] })]);
    await new LlmTasks(text, vision).judge(
      {
        characters: [{ id: 'chr_x', name: 'X', identity: '', referenceCount: 1 }],
        frameCount: 1,
        shotDescription: '',
      },
      new Map([['chr_x', [Buffer.from('r')]]]),
      [Buffer.from('f')],
    );
    expect(text.calls).toHaveLength(0);
    const labels = vision.calls[0]!.parts.filter((p) => p.type === 'text').map(
      (p) => (p as { text: string }).text,
    );
    expect(labels.slice(1)).toEqual(['Reference images for character chr_x (X):', 'Candidate frame 0:']);
  });
});
