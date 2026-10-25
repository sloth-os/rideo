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
import { extractJson, LlmTasks, SYSTEM_PROMPTS, SYSTEM_PROMPTS_V2 } from '../../src/ai/tasks';
import type { ProxyClient } from '../../src/gateway/proxy-client';
import { Metrics } from '../../src/metrics';

class FakeProxy {
  calls: { domain: string; path: string; body: any; headers: Headers; timeoutMs?: number }[] = [];
  /** A JSON body, or a function answering each call (the call's index and its signal). */
  constructor(private readonly reply: unknown | ((i: number, signal: AbortSignal) => Response)) {}
  async fetch(domain: string, path: string, init: RequestInit & { timeoutMs?: number }) {
    this.calls.push({
      domain,
      path,
      body: JSON.parse(String(init.body)),
      headers: new Headers(init.headers),
      timeoutMs: init.timeoutMs,
    });
    if (typeof this.reply === 'function')
      return (this.reply as (i: number, signal: AbortSignal) => Response)(
        this.calls.length - 1,
        init.signal!,
      );
    return new Response(JSON.stringify(this.reply), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
}

/** An event stream as an upstream sends it: `data:` lines, split across chunks anywhere. */
function eventStream(chunks: string[], signal?: AbortSignal, opts: { hang?: boolean } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      if (!opts.hang) controller.close();
      // A real fetch errors its body when the signal aborts
      else signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
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
  it('OpenAI chat completions are streamed: the deltas joined, the usage of the last event', async () => {
    const proxy = new FakeProxy((_i: number, signal: AbortSignal) =>
      eventStream(
        [
          'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
          'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\ndata: {"choices":[{"delta":{"content":"{\\"a\\""}}]}\n',
          '\ndata: {"choices":[{"delta":{"content":":1}"}}]}\r\n\r\n: keep-alive\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\ndata: [DONE]\n\n',
        ],
        signal,
      ),
    );
    const res = await new OpenAiAdapter(proxy as unknown as ProxyClient, 'api.openai.com', 'gpt-x').complete(
      req,
    );
    expect(res).toEqual({ text: '{"a":1}', usage: { input: 3, output: 4 } });
    expect(proxy.calls[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it('asks again without a field the upstream refuses, and keeps it when the error only says "upstream"', async () => {
    const refused = (text: string) => () => new Response(text, { status: 400 });
    const proxy = new FakeProxy((i: number) =>
      i === 0
        ? refused('{"error":{"message":"stream_options is not supported by this model"}}')()
        : new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    );
    const adapter = new OpenAiAdapter(proxy as unknown as ProxyClient, 'api.openai.com', 'gpt-x', 600_000);
    expect((await adapter.complete(req)).text).toBe('{}');
    expect(proxy.calls[1]!.body).not.toHaveProperty('stream');
    expect(proxy.calls[1]!.body).not.toHaveProperty('stream_options');
    expect(proxy.calls[1]!.body.temperature).toBe(0.2);
    // Not streamed: one timeout for the whole answer.
    expect(proxy.calls.map((c) => c.timeoutMs)).toEqual([2_400_000, 600_000]);

    const upstream = new FakeProxy(refused('{"error":{"message":"upstream_error: the image is too large"}}'));
    await expect(
      new OpenAiAdapter(upstream as unknown as ProxyClient, 'api.openai.com', 'gpt-x').complete(req),
    ).rejects.toMatchObject({ status: 400, retryable: false });
    expect(upstream.calls).toHaveLength(1);
  });

  it('ends a stream that goes quiet for the timeout with a TimeoutError', async () => {
    const proxy = new FakeProxy((_i: number, signal: AbortSignal) =>
      eventStream(['data: {"choices":[{"delta":{"content":"{"}}]}\n\n'], signal, { hang: true }),
    );
    const adapter = new OpenAiAdapter(proxy as unknown as ProxyClient, 'api.openai.com', 'gpt-x', 50);
    await expect(adapter.complete(req)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('a streamed error event is a retryable LlmError', async () => {
    const proxy = new FakeProxy((_i: number, signal: AbortSignal) =>
      eventStream(['data: {"error":{"message":"system cpu overloaded"}}\n\n'], signal),
    );
    await expect(
      new OpenAiAdapter(proxy as unknown as ProxyClient, 'api.openai.com', 'gpt-x').complete(req),
    ).rejects.toMatchObject({ code: 'llm_error', retryable: true });
  });

  it('OpenAI chat completions answered as plain JSON', async () => {
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

  it('sends a video with its sound to the audio-visual model: video_url with text answers, inline video, never Anthropic', async () => {
    const watch: LlmRequest = {
      ...req,
      parts: [
        { type: 'text', text: 'INPUT:\n{}' },
        { type: 'video', data: Buffer.from('mp4'), mime: 'video/mp4' },
      ],
    };
    const openai = new FakeProxy({ choices: [{ message: { content: '{}' } }] });
    await new OpenAiAdapter(
      openai as unknown as ProxyClient,
      'newapi.example.com',
      'qwen3.8-omni-flash',
    ).complete(watch);
    expect(openai.calls[0]!.body.messages[1].content[1]).toEqual({
      type: 'video_url',
      video_url: { url: `data:video/mp4;base64,${Buffer.from('mp4').toString('base64')}` },
    });
    expect(openai.calls[0]!.body.modalities).toEqual(['text']);
    // Images alone do not ask for modalities
    const still = new FakeProxy({ choices: [{ message: { content: '{}' } }] });
    await new OpenAiAdapter(still as unknown as ProxyClient, 'api.openai.com', 'gpt-x').complete(req);
    expect(still.calls[0]!.body).not.toHaveProperty('modalities');

    const gemini = new FakeProxy({ candidates: [{ content: { parts: [{ text: '{}' }] } }] });
    await new GeminiAdapter(
      gemini as unknown as ProxyClient,
      'generativelanguage.googleapis.com',
      'g',
    ).complete(watch);
    expect(gemini.calls[0]!.body.contents[0].parts[1].inline_data.mime_type).toBe('video/mp4');

    const anthropic = new FakeProxy({ content: [] });
    await expect(
      new AnthropicAdapter(anthropic as unknown as ProxyClient, 'api.anthropic.com', 'c').complete(watch),
    ).rejects.toMatchObject({ retryable: false });
    expect(anthropic.calls).toHaveLength(0);
  });

  it('gives every call the configured timeout (RIDEO_LLM_TIMEOUT_SEC), else the proxy default; streamed calls four times it in all', async () => {
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
      ).toEqual(provider === 'openai' ? [2_400_000, 720_000] : [600_000, undefined]);
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
    ]) {
      const once = new FlakyAdapter([err]);
      await expect(
        new LlmTasks(once, once, { retry }).run('clip.plan', ClipPlanOutputSchema, {}),
      ).rejects.toBe(err);
      expect(once.calls).toBe(1);
    }
    // A call that timed out or lost its connection is not repeated at once, but the job runs again
    for (const [err, message] of [
      [new DOMException('the model sent nothing for 600 s', 'TimeoutError'), 'did not answer in time'],
      [
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }),
        'UND_ERR_HEADERS_TIMEOUT',
      ],
    ] as const) {
      const once = new FlakyAdapter([err as Error]);
      await expect(
        new LlmTasks(once, once, { retry }).run('clip.plan', ClipPlanOutputSchema, {}),
      ).rejects.toMatchObject({
        code: 'llm_error',
        retryable: true,
        message: expect.stringContaining(message),
      });
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

  it('watches videos with the audio-visual model and its listening prompt, and only with it', async () => {
    const text = new ScriptedAdapter(['{}']);
    const omni = new ScriptedAdapter([
      JSON.stringify({ speech: [{ text: 'Hello', speaker: 'Rosie' }], music: 'no', score: 0.9 }),
      JSON.stringify({
        scores: { dialogue: 6 },
        summary: 's',
        transcript: [{ time: 1, speaker: 'Rosie', text: 'Hi' }],
      }),
    ]);
    const tasks = new LlmTasks(text, text, { omni });
    const heard = await tasks.checkSound(
      {
        shot: { description: 'd', action: 'a', place: 'p', durationSec: 5 },
        lines: [{ character: 'Rosie', voice: 'a young female voice', line: 'Hello' }],
        cast: [],
        music: false,
      },
      Buffer.from('mp4'),
    );
    expect(heard).toMatchObject({ speech: [{ text: 'Hello', speaker: 'Rosie' }], music: false, score: 0.9 });
    expect(omni.calls[0]!.system).toMatch(/^rideo-task: sound\.check/);
    expect(omni.calls[0]!.parts.find((p) => p.type === 'video')).toMatchObject({ mime: 'video/mp4' });
    const scene = await tasks.feedbackScene({} as never, [], undefined, Buffer.from('mp4'));
    expect(scene.transcript).toEqual([{ time: 1, speaker: 'Rosie', text: 'Hi' }]);
    expect(omni.calls[1]!.system).toContain('the scene itself as a video with its sound');
    expect(text.calls).toHaveLength(0);
    // Strips still go to the vision model with the prompt that cannot hear
    await tasks.feedbackScene({} as never, [{ label: '0: C1·S1', data: Buffer.from('jpg') }]);
    expect(text.calls[0]!.system).toContain('You cannot hear the sound.');
    await expect(new LlmTasks(text, text).checkSound({} as never, Buffer.from('mp4'))).rejects.toMatchObject({
      code: 'llm_error',
      retryable: false,
    });
  });

  it('asks the version 2 writer for complete outfits and for places and props without characters', () => {
    expect(SYSTEM_PROMPTS_V2['screenplay.generate']).toContain('Each wardrobe entry is a complete outfit');
    expect(SYSTEM_PROMPTS_V2['screenplay.generate']).toContain(
      'the first is what the character wears most of the film',
    );
    expect(SYSTEM_PROMPTS_V2['screenplay.generate']).toContain('with no character in it');
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
