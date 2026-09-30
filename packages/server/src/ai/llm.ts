import type { ProxyClient } from '../gateway/proxy-client';

export type LlmPart = { type: 'text'; text: string } | { type: 'image'; data: Buffer; mime: string };

export interface LlmRequest {
  system: string;
  parts: LlmPart[];
  json: boolean;
  temperature: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
  usage?: { input?: number; output?: number };
}

export interface LlmAdapter {
  readonly provider: string;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  readonly code = 'llm_error';
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

async function failure(res: Response, provider: string): Promise<LlmError> {
  const body = (await res.text().catch(() => '')).slice(0, 600);
  return new LlmError(
    `${provider} via mm-gateway proxy returned ${res.status}: ${body}`,
    res.status,
    res.status === 429 || res.status >= 500,
  );
}

/** OpenAI Chat Completions (and any OpenAI-compatible upstream) through the gateway proxy. */
export class OpenAiAdapter implements LlmAdapter {
  readonly provider = 'openai';
  constructor(
    private readonly proxy: ProxyClient,
    private readonly domain: string,
    readonly model: string,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const content = req.parts.map((p) =>
      p.type === 'text'
        ? { type: 'text', text: p.text }
        : { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data.toString('base64')}` } },
    );
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content },
      ],
      temperature: req.temperature,
      ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
    };
    let res = await this.post(body, req.signal);
    if (res.status === 400) {
      // Some models reject temperature/response_format; retry once with the minimal request.
      const text = await res.clone().text();
      if (/temperature|response_format|max_tokens/.test(text)) {
        delete body.temperature;
        if (/response_format/.test(text)) delete body.response_format;
        if (/max_tokens/.test(text)) delete body.max_tokens;
        res = await this.post(body, req.signal);
      }
    }
    if (!res.ok) throw await failure(res, this.provider);
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: json.choices?.[0]?.message?.content ?? '',
      usage: { input: json.usage?.prompt_tokens, output: json.usage?.completion_tokens },
    };
  }

  private post(body: unknown, signal?: AbortSignal): Promise<Response> {
    return this.proxy.fetch(this.domain, 'v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  }
}

/** Google Gemini generateContent through the gateway proxy. */
export class GeminiAdapter implements LlmAdapter {
  readonly provider = 'gemini';
  constructor(
    private readonly proxy: ProxyClient,
    private readonly domain: string,
    readonly model: string,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const parts = req.parts.map((p) =>
      p.type === 'text'
        ? { text: p.text }
        : { inline_data: { mime_type: p.mime, data: p.data.toString('base64') } },
    );
    const res = await this.proxy.fetch(
      this.domain,
      `v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: req.temperature,
            ...(req.json ? { responseMimeType: 'application/json' } : {}),
            ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
          },
        }),
        signal: req.signal,
      },
    );
    if (!res.ok) throw await failure(res, this.provider);
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    return {
      text: (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join(''),
      usage: {
        input: json.usageMetadata?.promptTokenCount,
        output: json.usageMetadata?.candidatesTokenCount,
      },
    };
  }
}

/** Anthropic Messages through the gateway proxy (JSON mode via an assistant prefill of `{`). */
export class AnthropicAdapter implements LlmAdapter {
  readonly provider = 'anthropic';
  constructor(
    private readonly proxy: ProxyClient,
    private readonly domain: string,
    readonly model: string,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const content = req.parts.map((p) =>
      p.type === 'text'
        ? { type: 'text', text: p.text }
        : { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data.toString('base64') } },
    );
    const res = await this.proxy.fetch(this.domain, 'v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? 8192,
        system: req.system,
        temperature: req.temperature,
        messages: [{ role: 'user', content }, ...(req.json ? [{ role: 'assistant', content: '{' }] : [])],
      }),
      signal: req.signal,
    });
    if (!res.ok) throw await failure(res, this.provider);
    const json = (await res.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (json.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    return {
      text: req.json ? `{${text}` : text,
      usage: { input: json.usage?.input_tokens, output: json.usage?.output_tokens },
    };
  }
}

export function createAdapter(
  proxy: ProxyClient,
  endpoint: { provider: 'openai' | 'gemini' | 'anthropic'; domain: string; model: string },
): LlmAdapter {
  if (endpoint.provider === 'gemini') return new GeminiAdapter(proxy, endpoint.domain, endpoint.model);
  if (endpoint.provider === 'anthropic') return new AnthropicAdapter(proxy, endpoint.domain, endpoint.model);
  return new OpenAiAdapter(proxy, endpoint.domain, endpoint.model);
}

/** OpenAI-style speech-to-text through the proxy (optional; footage analysis). */
export class SttClient {
  constructor(
    private readonly proxy: ProxyClient,
    private readonly domain: string,
    private readonly model: string,
  ) {}

  async transcribe(
    audio: Buffer,
    filename: string,
    signal?: AbortSignal,
  ): Promise<{ start: number; end: number; text: string }[]> {
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(audio)]), filename);
    form.set('model', this.model);
    form.set('response_format', 'verbose_json');
    const res = await this.proxy.fetch(this.domain, 'v1/audio/transcriptions', {
      method: 'POST',
      body: form,
      signal,
      timeoutMs: 600_000,
    });
    if (!res.ok) throw await failure(res, 'stt');
    const json = (await res.json()) as {
      segments?: { start: number; end: number; text: string }[];
      text?: string;
      duration?: number;
    };
    if (json.segments?.length)
      return json.segments
        .map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }))
        .filter((s) => s.text);
    return json.text ? [{ start: 0, end: json.duration ?? 0, text: json.text.trim() }] : [];
  }
}
