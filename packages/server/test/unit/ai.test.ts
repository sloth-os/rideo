import { ClipPlanOutputSchema } from '@rideo/shared';
import { describe, expect, it } from 'vitest';
import {
  AnthropicAdapter,
  GeminiAdapter,
  type LlmAdapter,
  type LlmRequest,
  OpenAiAdapter,
} from '../../src/ai/llm';
import { extractJson, LlmTasks, SYSTEM_PROMPTS } from '../../src/ai/tasks';
import type { ProxyClient } from '../../src/gateway/proxy-client';

class FakeProxy {
  calls: { domain: string; path: string; body: any; headers: Headers }[] = [];
  constructor(private readonly reply: unknown) {}
  async fetch(domain: string, path: string, init: RequestInit) {
    this.calls.push({
      domain,
      path,
      body: JSON.parse(String(init.body)),
      headers: new Headers(init.headers),
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
