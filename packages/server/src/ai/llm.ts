import { attachWords, type TranscriptWord } from '@rideo/shared';
import type { ProxyApi } from '../config';
import type { ProxyClient, ProxyTarget } from '../gateway/proxy-client';

export type LlmPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: Buffer; mime: string }
  /** Audio input (the speaker check, docs/design/dialogue.md#rules): OpenAI audio models and Gemini. */
  | { type: 'audio'; data: Buffer; format: 'wav' | 'mp3' }
  /** A video with its sound, for the audio-visual model (docs/design/ai-gateway.md#proxy-usage-llm-vision-stt-embeddings). */
  | { type: 'video'; data: Buffer; mime: string };

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
    /** The answer's body (the gateway's problem or the provider's error). */
    readonly body?: string,
    /** How long the answer asked to wait before another try (`Retry-After`). */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** A `Retry-After` header (seconds or an HTTP date) in milliseconds. */
export function retryAfterOf(res: Response): number | undefined {
  const value = res.headers.get('retry-after');
  if (!value) return undefined;
  const sec = Number(value);
  const ms = Number.isFinite(sec) ? sec * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

async function failure(res: Response, provider: string): Promise<LlmError> {
  const body = (await res.text().catch(() => '')).slice(0, 600);
  return new LlmError(
    `${provider} via mm-gateway proxy returned ${res.status}: ${body}`,
    res.status,
    res.status === 429 || res.status >= 500,
    body,
    retryAfterOf(res),
  );
}

/** How long a call may wait for anything when none is configured (the proxy client's default). */
const DEFAULT_IDLE_MS = 180_000;
/** A streamed answer may take this many idle timeouts in all. */
const STREAM_TOTAL_FACTOR = 4;
/** Request fields some upstreams refuse, dropped when a 400 names them (whole words: "upstream" is not "stream"). */
const OPTIONAL_FIELDS: Record<string, RegExp> = {
  stream: /\bstream(_options)?\b/,
  temperature: /\btemperature\b/,
  response_format: /\bresponse_format\b/,
  max_tokens: /\bmax_tokens\b/,
};

/**
 * Aborts when nothing arrives for `ms`: before the first byte, then between chunks
 * (docs/design/ai-gateway.md#proxy-usage-llm-vision-stt-embeddings).
 */
class IdleTimer {
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly ms: number) {
    this.touch();
  }
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  touch(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () =>
        this.controller.abort(
          new DOMException(`the model sent nothing for ${Math.round(this.ms / 1000)} s`, 'TimeoutError'),
        ),
      this.ms,
    );
  }
  stop(): void {
    clearTimeout(this.timer);
  }
}

/**
 * A streamed chat completion (`text/event-stream`): the content deltas joined, the usage of the last event. An error
 * event ends the call with a retryable error.
 */
export async function readChatStream(res: Response, onChunk: () => void = () => {}): Promise<LlmResponse> {
  if (!res.body) return { text: '' };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage: LlmResponse['usage'];
  const take = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let event: {
      error?: unknown;
      choices?: { delta?: { content?: string | null }; message?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    };
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (event.error) {
      const body = JSON.stringify(event.error).slice(0, 600);
      throw new LlmError(`openai via mm-gateway proxy streamed an error: ${body}`, undefined, true, body);
    }
    const choice = event.choices?.[0];
    const piece = choice?.delta?.content ?? choice?.message?.content;
    if (typeof piece === 'string') text += piece;
    if (event.usage) usage = { input: event.usage.prompt_tokens, output: event.usage.completion_tokens };
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk();
    buffer += decoder.decode(value, { stream: true });
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      take(buffer.slice(0, nl).replace(/\r$/, ''));
      buffer = buffer.slice(nl + 1);
    }
  }
  take((buffer + decoder.decode()).trim());
  return { text, usage };
}

/** OpenAI Chat Completions (and any OpenAI-compatible upstream) through the gateway proxy, streamed. */
export class OpenAiAdapter implements LlmAdapter {
  readonly provider = 'openai';
  constructor(
    private readonly proxy: ProxyClient,
    private readonly api: ProxyTarget,
    readonly model: string,
    /** How long one call may take (`RIDEO_LLM_TIMEOUT_SEC`); else the proxy client's default. */
    private readonly timeoutMs?: number,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const content = req.parts.map((p) =>
      p.type === 'text'
        ? { type: 'text', text: p.text }
        : p.type === 'audio'
          ? { type: 'input_audio', input_audio: { data: p.data.toString('base64'), format: p.format } }
          : p.type === 'video'
            ? { type: 'video_url', video_url: { url: `data:${p.mime};base64,${p.data.toString('base64')}` } }
            : { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data.toString('base64')}` } },
    );
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content },
      ],
      // Omni models answer in text only when asked (Qwen-Omni)
      ...(req.parts.some((p) => p.type === 'video') ? { modalities: ['text'] } : {}),
      temperature: req.temperature,
      ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      stream: true,
      stream_options: { include_usage: true },
    };
    const idleMs = this.timeoutMs ?? DEFAULT_IDLE_MS;
    const idle = new IdleTimer(idleMs);
    const signal = req.signal ? AbortSignal.any([req.signal, idle.signal]) : idle.signal;
    try {
      let res = await this.post(body, signal, idleMs * STREAM_TOTAL_FACTOR);
      // Some upstreams refuse a field (streaming, temperature, JSON mode, a token limit): ask again without the ones
      // the error names.
      for (let tries = 0; res.status === 400 && tries < 2; tries++) {
        const text = await res.clone().text();
        const named = Object.keys(OPTIONAL_FIELDS).filter((f) => f in body && OPTIONAL_FIELDS[f]!.test(text));
        if (!named.length) break;
        for (const f of named) delete body[f];
        if (named.includes('stream')) delete body.stream_options;
        idle.touch();
        res = await this.post(body, signal, body.stream ? idleMs * STREAM_TOTAL_FACTOR : idleMs);
      }
      if (!res.ok) throw await failure(res, this.provider);
      idle.touch();
      if (res.headers.get('content-type')?.includes('text/event-stream'))
        return await readChatStream(res, () => idle.touch());
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        text: json.choices?.[0]?.message?.content ?? '',
        usage: { input: json.usage?.prompt_tokens, output: json.usage?.completion_tokens },
      };
    } catch (err) {
      // The idle timer's reason, not a bare AbortError, so the call is retried as a timeout.
      if (idle.signal.aborted && !req.signal?.aborted) throw idle.signal.reason;
      throw err;
    } finally {
      idle.stop();
    }
  }

  private post(body: unknown, signal: AbortSignal, timeoutMs: number): Promise<Response> {
    return this.proxy.fetch(this.api, 'v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      timeoutMs,
    });
  }
}

/** Google Gemini generateContent through the gateway proxy. */
export class GeminiAdapter implements LlmAdapter {
  readonly provider = 'gemini';
  constructor(
    private readonly proxy: ProxyClient,
    private readonly api: ProxyTarget,
    readonly model: string,
    /** How long one call may take (`RIDEO_LLM_TIMEOUT_SEC`); else the proxy client's default. */
    private readonly timeoutMs?: number,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const parts = req.parts.map((p) =>
      p.type === 'text'
        ? { text: p.text }
        : {
            inline_data: {
              mime_type: p.type === 'audio' ? (p.format === 'wav' ? 'audio/wav' : 'audio/mp3') : p.mime,
              data: p.data.toString('base64'),
            },
          },
    );
    const res = await this.proxy.fetch(
      this.api,
      `v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: 'POST',
        timeoutMs: this.timeoutMs,
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
    private readonly api: ProxyTarget,
    readonly model: string,
    /** How long one call may take (`RIDEO_LLM_TIMEOUT_SEC`); else the proxy client's default. */
    private readonly timeoutMs?: number,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (req.parts.some((p) => p.type === 'audio' || p.type === 'video'))
      throw new LlmError('Anthropic models do not accept audio or video input', undefined, false);
    const content = req.parts.map((p) =>
      p.type === 'text'
        ? { type: 'text', text: p.text }
        : {
            type: 'image',
            source: {
              type: 'base64',
              media_type: (p as { mime: string }).mime,
              data: p.data.toString('base64'),
            },
          },
    );
    const res = await this.proxy.fetch(this.api, 'v1/messages', {
      method: 'POST',
      timeoutMs: this.timeoutMs,
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
  endpoint: ProxyApi & { provider: 'openai' | 'gemini' | 'anthropic'; model: string },
  timeoutMs?: number,
): LlmAdapter {
  const api = { domain: endpoint.domain, prefix: endpoint.prefix };
  if (endpoint.provider === 'gemini') return new GeminiAdapter(proxy, api, endpoint.model, timeoutMs);
  if (endpoint.provider === 'anthropic') return new AnthropicAdapter(proxy, api, endpoint.model, timeoutMs);
  return new OpenAiAdapter(proxy, api, endpoint.model, timeoutMs);
}

/** OpenAI-style speech-to-text through the proxy (optional; footage analysis). */
export class SttClient {
  constructor(
    private readonly proxy: ProxyClient,
    private readonly api: ProxyTarget,
    private readonly model: string,
  ) {}

  async transcribe(
    audio: Buffer,
    filename: string,
    signal?: AbortSignal,
  ): Promise<{ start: number; end: number; text: string; words: TranscriptWord[]; approx?: boolean }[]> {
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(audio)]), filename);
    form.set('model', this.model);
    form.set('response_format', 'verbose_json');
    // Word timings for transcript editing (docs/design/editor.md#transcript-editing)
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
    const res = await this.proxy.fetch(this.api, 'v1/audio/transcriptions', {
      method: 'POST',
      body: form,
      signal,
      timeoutMs: 600_000,
    });
    if (!res.ok) throw await failure(res, 'stt');
    const json = (await res.json()) as {
      segments?: { start: number; end: number; text: string }[];
      words?: { word: string; start: number; end: number }[];
      text?: string;
      duration?: number;
    };
    const segments = json.segments?.length
      ? json.segments.map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })).filter((s) => s.text)
      : json.text
        ? [{ start: 0, end: json.duration ?? 0, text: json.text.trim() }]
        : [];
    return attachWords(segments, json.words);
  }
}
