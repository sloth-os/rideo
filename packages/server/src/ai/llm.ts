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
  /** `off`: answer without reasoning (checks and captions; docs/design/ai-gateway.md#reasoning). */
  reasoning?: 'off';
}

export interface LlmResponse {
  text: string;
  usage?: { input?: number; output?: number };
}

export interface LlmAdapter {
  readonly provider: string;
  readonly model: string;
  /** The proxy domain it calls, which with the model names the endpoint (docs/design/ai-gateway.md#outages). */
  readonly endpoint?: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

const domainOf = (api: ProxyTarget): string => (typeof api === 'string' ? api : api.domain);

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
  // Qwen's switch for its reasoning (docs/design/ai-gateway.md#reasoning)
  enable_thinking: /\benable_thinking\b/,
  // Omni models' text-only answer; a vision model that watches video may not know it (docs/design/ai-review.md)
  modalities: /\bmodalities\b/,
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

  /** Fields the upstream refused once: never sent again by this adapter. */
  private readonly refused = new Set<string>();

  get endpoint(): string {
    return domainOf(this.api);
  }

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
      ...(req.reasoning === 'off' ? { enable_thinking: false } : {}),
      stream: true,
      stream_options: { include_usage: true },
    };
    for (const f of this.refused) {
      delete body[f];
      if (f === 'stream') delete body.stream_options;
    }
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
        for (const f of named) {
          delete body[f];
          this.refused.add(f);
        }
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

/** The events of a `text/event-stream` answer: each event's name (if any) and its joined `data:` lines. */
async function* sseEvents(
  res: Response,
  onChunk: () => void,
): AsyncGenerator<{ event?: string; data: string }> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (value) {
      onChunk();
      buffer += decoder.decode(value, { stream: true });
    }
    if (done) buffer += `${decoder.decode()}\n\n`;
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line === '') {
        if (data.length) yield { event, data: data.join('\n') };
        event = undefined;
        data = [];
      } else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (done) return;
  }
}

/** One event's JSON, or undefined for a keep-alive or a line that is not JSON. */
function eventJson<T>(data: string): T | undefined {
  try {
    return JSON.parse(data) as T;
  } catch {
    return undefined;
  }
}

type GeminiChunk = {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
};

/** Google Gemini through the gateway proxy, streamed (`streamGenerateContent?alt=sse`). */
export class GeminiAdapter implements LlmAdapter {
  readonly provider = 'gemini';
  /** The model refused a thinking budget of 0 (some keep a minimum): checks are asked without it. */
  private noThinkingBudget = false;
  /** The upstream has no streamed endpoint: this adapter asks `generateContent` from then on. */
  private noStream = false;
  constructor(
    private readonly proxy: ProxyClient,
    private readonly api: ProxyTarget,
    readonly model: string,
    /** How long one call may take (`RIDEO_LLM_TIMEOUT_SEC`); else the proxy client's default. */
    private readonly timeoutMs?: number,
  ) {}

  get endpoint(): string {
    return domainOf(this.api);
  }

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
    const idleMs = this.timeoutMs ?? DEFAULT_IDLE_MS;
    const idle = new IdleTimer(idleMs);
    const signal = req.signal ? AbortSignal.any([req.signal, idle.signal]) : idle.signal;
    try {
      let res = await this.post(req, parts, signal, idleMs);
      // A model that refuses a thinking budget of 0, or an upstream without the streamed endpoint, is asked again
      // without it
      for (let tries = 0; !res.ok && tries < 2; tries++) {
        const text = await res.clone().text();
        if (res.status === 400 && req.reasoning === 'off' && !this.noThinkingBudget && /thinking/i.test(text))
          this.noThinkingBudget = true;
        else if (!this.noStream && (res.status === 404 || res.status === 405)) this.noStream = true;
        else break;
        idle.touch();
        res = await this.post(req, parts, signal, idleMs);
      }
      if (!res.ok) throw await failure(res, this.provider);
      idle.touch();
      let text = '';
      let usage: GeminiChunk['usageMetadata'];
      const take = (c: GeminiChunk | undefined) => {
        if (c?.error) {
          const body = JSON.stringify(c.error).slice(0, 600);
          throw new LlmError(`gemini via mm-gateway proxy streamed an error: ${body}`, undefined, true, body);
        }
        text += (c?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
        if (c?.usageMetadata) usage = c.usageMetadata;
      };
      if (res.headers.get('content-type')?.includes('text/event-stream')) {
        for await (const e of sseEvents(res, () => idle.touch())) take(eventJson<GeminiChunk>(e.data));
      } else {
        // `generateContent` answers one object; a stream asked without `alt=sse` answers an array of them
        const json = (await res.json()) as GeminiChunk | GeminiChunk[];
        for (const c of Array.isArray(json) ? json : [json]) take(c);
      }
      return { text, usage: { input: usage?.promptTokenCount, output: usage?.candidatesTokenCount } };
    } catch (err) {
      // The idle timer's reason, not a bare AbortError, so the call is retried as a timeout.
      if (idle.signal.aborted && !req.signal?.aborted) throw idle.signal.reason;
      throw err;
    } finally {
      idle.stop();
    }
  }

  private post(req: LlmRequest, parts: unknown[], signal: AbortSignal, idleMs: number): Promise<Response> {
    const method = this.noStream ? 'generateContent' : 'streamGenerateContent?alt=sse';
    return this.proxy.fetch(this.api, `v1beta/models/${encodeURIComponent(this.model)}:${method}`, {
      method: 'POST',
      timeoutMs: this.noStream ? idleMs : idleMs * STREAM_TOTAL_FACTOR,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: req.temperature,
          ...(req.json ? { responseMimeType: 'application/json' } : {}),
          ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
          // No reasoning for checks (docs/design/ai-gateway.md#reasoning); a model that refuses it is asked without
          ...(req.reasoning === 'off' && !this.noThinkingBudget
            ? { thinkingConfig: { thinkingBudget: 0 } }
            : {}),
        },
      }),
      signal,
    });
  }
}

type AnthropicEvent = {
  type?: string;
  delta?: { type?: string; text?: string };
  message?: { usage?: { input_tokens?: number } };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
};

/** Anthropic Messages through the gateway proxy, streamed (JSON mode via an assistant prefill of `{`). */
export class AnthropicAdapter implements LlmAdapter {
  readonly provider = 'anthropic';
  /** The upstream refused `stream` once (a 400 naming it): this adapter asks without it from then on. */
  private noStream = false;
  constructor(
    private readonly proxy: ProxyClient,
    private readonly api: ProxyTarget,
    readonly model: string,
    /** How long one call may take (`RIDEO_LLM_TIMEOUT_SEC`); else the proxy client's default. */
    private readonly timeoutMs?: number,
  ) {}

  get endpoint(): string {
    return domainOf(this.api);
  }

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
    const idleMs = this.timeoutMs ?? DEFAULT_IDLE_MS;
    const idle = new IdleTimer(idleMs);
    const signal = req.signal ? AbortSignal.any([req.signal, idle.signal]) : idle.signal;
    try {
      let res = await this.post(req, content, signal, idleMs);
      if (res.status === 400 && !this.noStream && OPTIONAL_FIELDS.stream!.test(await res.clone().text())) {
        this.noStream = true;
        idle.touch();
        res = await this.post(req, content, signal, idleMs);
      }
      if (!res.ok) throw await failure(res, this.provider);
      idle.touch();
      let text = '';
      const usage: { input?: number; output?: number } = {};
      if (res.headers.get('content-type')?.includes('text/event-stream')) {
        for await (const e of sseEvents(res, () => idle.touch())) {
          const d = eventJson<AnthropicEvent>(e.data);
          if (d?.type === 'error' || e.event === 'error') {
            const body = e.data.slice(0, 600);
            throw new LlmError(
              `anthropic via mm-gateway proxy streamed an error: ${body}`,
              undefined,
              true,
              body,
            );
          }
          if (d?.type === 'message_start') usage.input = d.message?.usage?.input_tokens;
          if (d?.type === 'content_block_delta' && d.delta?.type === 'text_delta') text += d.delta.text ?? '';
          if (d?.type === 'message_delta' && d.usage?.output_tokens !== undefined)
            usage.output = d.usage.output_tokens;
        }
      } else {
        const json = (await res.json()) as {
          content?: { type: string; text?: string }[];
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        text = (json.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('');
        usage.input = json.usage?.input_tokens;
        usage.output = json.usage?.output_tokens;
      }
      return { text: req.json ? `{${text}` : text, usage };
    } catch (err) {
      // The idle timer's reason, not a bare AbortError, so the call is retried as a timeout.
      if (idle.signal.aborted && !req.signal?.aborted) throw idle.signal.reason;
      throw err;
    } finally {
      idle.stop();
    }
  }

  private post(req: LlmRequest, content: unknown[], signal: AbortSignal, idleMs: number): Promise<Response> {
    return this.proxy.fetch(this.api, 'v1/messages', {
      method: 'POST',
      timeoutMs: this.noStream ? idleMs : idleMs * STREAM_TOTAL_FACTOR,
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? 8192,
        system: req.system,
        temperature: req.temperature,
        messages: [{ role: 'user', content }, ...(req.json ? [{ role: 'assistant', content: '{' }] : [])],
        ...(this.noStream ? {} : { stream: true }),
      }),
      signal,
    });
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
