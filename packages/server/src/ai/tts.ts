import type { TtsEndpoint } from '../config';
import { AppError } from '../errors';
import type { ProxyClient } from '../gateway/proxy-client';
import type { Metrics } from '../metrics';

/** A designed voice the user can pick: the provider's preview id and what it sounds like. */
export interface VoicePreview {
  voiceId: string;
  audio: Buffer;
  mime: string;
}

export interface Speech {
  audio: Buffer;
  mime: string;
  /** Where the words are within the audio (seconds), when the provider aligns them. */
  span?: { start: number; end: number };
}

/**
 * Text-to-speech through the mm-gateway proxy (docs/design/dialogue.md#providers). Every call is a proxy request,
 * so upstream keys stay in the gateway.
 */
export interface TtsClient {
  readonly provider: TtsEndpoint['provider'];
  readonly model: string;
  readonly canClone: boolean;
  design(req: {
    description: string;
    text: string;
    seed: number;
    signal?: AbortSignal;
  }): Promise<VoicePreview[]>;
  /** Makes a picked preview a permanent voice; returns its voice id. */
  save(req: {
    previewVoiceId: string;
    name: string;
    description: string;
    signal?: AbortSignal;
  }): Promise<string>;
  clone(req: {
    name: string;
    audio: Buffer;
    filename: string;
    mime: string;
    signal?: AbortSignal;
  }): Promise<string>;
  speak(req: {
    voiceId: string;
    text: string;
    seed: number;
    description: string;
    language?: string;
    signal?: AbortSignal;
  }): Promise<Speech>;
}

abstract class ProxiedTts {
  constructor(
    protected readonly proxy: ProxyClient,
    protected readonly endpoint: TtsEndpoint,
    protected readonly metrics?: Metrics,
  ) {}

  get model(): string {
    return this.endpoint.model;
  }

  protected async call(
    op: string,
    path: string,
    init: RequestInit & { timeoutMs?: number },
  ): Promise<Response> {
    const provider = this.endpoint.provider;
    let res: Response;
    try {
      res = await this.proxy.fetch(this.endpoint.domain, path, { timeoutMs: 120_000, ...init });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError' && init.signal?.aborted) throw err;
      this.metrics?.tts.inc({ provider, op, outcome: 'error' });
      throw new AppError(
        'gateway_error',
        `${provider} TTS via mm-gateway proxy failed: ${(err as Error).message}`,
        [],
        true,
      );
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 600);
      this.metrics?.tts.inc({ provider, op, outcome: 'error' });
      throw new AppError(
        'gateway_error',
        `${provider} TTS via mm-gateway proxy returned ${res.status}: ${body}`,
        [],
        res.status === 429 || res.status >= 500,
      );
    }
    this.metrics?.tts.inc({ provider, op, outcome: 'ok' });
    return res;
  }

  protected async json<T>(op: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.call(op, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    return (await res.json()) as T;
  }
}

/** ElevenLabs: voice design, instant cloning, and speech with per-character timestamps. */
export class ElevenLabsTts extends ProxiedTts implements TtsClient {
  readonly provider = 'elevenlabs' as const;
  readonly canClone = true;

  async design(req: { description: string; text: string; seed: number; signal?: AbortSignal }) {
    const description =
      req.description.trim().length >= 20
        ? req.description.trim().slice(0, 1000)
        : `${req.description.trim() || 'A natural'} speaking voice, clear and expressive`.slice(0, 1000);
    const text = req.text.trim();
    const json = await this.json<{
      previews?: { audio_base_64: string; generated_voice_id: string; media_type?: string }[];
    }>(
      'design',
      'v1/text-to-voice/design?output_format=mp3_44100_128',
      {
        voice_description: description,
        model_id: 'eleven_multilingual_ttv_v2',
        ...(text.length >= 100 ? { text: text.slice(0, 1000) } : { auto_generate_text: true }),
        seed: req.seed,
      },
      req.signal,
    );
    const previews = (json.previews ?? []).filter((p) => p.generated_voice_id && p.audio_base_64);
    if (!previews.length)
      throw new AppError('gateway_error', 'ElevenLabs returned no voice previews', [], true);
    return previews.map((p) => ({
      voiceId: p.generated_voice_id,
      audio: Buffer.from(p.audio_base_64, 'base64'),
      mime: p.media_type || 'audio/mpeg',
    }));
  }

  async save(req: { previewVoiceId: string; name: string; description: string; signal?: AbortSignal }) {
    const json = await this.json<{ voice_id?: string }>(
      'save',
      'v1/text-to-voice',
      {
        voice_name: req.name.slice(0, 100),
        voice_description: (req.description.trim() || `Voice of ${req.name}`).padEnd(20, '.').slice(0, 1000),
        generated_voice_id: req.previewVoiceId,
      },
      req.signal,
    );
    if (!json.voice_id) throw new AppError('gateway_error', 'ElevenLabs did not return a voice id', [], true);
    return json.voice_id;
  }

  async clone(req: { name: string; audio: Buffer; filename: string; mime: string; signal?: AbortSignal }) {
    const form = new FormData();
    form.set('name', req.name.slice(0, 100));
    form.set('files', new Blob([new Uint8Array(req.audio)], { type: req.mime }), req.filename);
    form.set('remove_background_noise', 'true');
    const res = await this.call('clone', 'v1/voices/add', {
      method: 'POST',
      body: form,
      signal: req.signal,
      timeoutMs: 300_000,
    });
    const json = (await res.json()) as { voice_id?: string };
    if (!json.voice_id) throw new AppError('gateway_error', 'ElevenLabs did not return a voice id', [], true);
    return json.voice_id;
  }

  async speak(req: {
    voiceId: string;
    text: string;
    seed: number;
    description: string;
    language?: string;
    signal?: AbortSignal;
  }): Promise<Speech> {
    // Only the turbo and flash models accept a forced language; the others detect it.
    const forceLanguage = !!req.language && /turbo|flash/.test(this.model);
    const json = await this.json<{
      audio_base64?: string;
      alignment?: { character_start_times_seconds?: number[]; character_end_times_seconds?: number[] } | null;
    }>(
      'speak',
      `v1/text-to-speech/${encodeURIComponent(req.voiceId)}/with-timestamps?output_format=mp3_44100_128`,
      {
        text: req.text,
        model_id: this.model,
        seed: req.seed,
        ...(forceLanguage ? { language_code: req.language!.slice(0, 2) } : {}),
      },
      req.signal,
    );
    if (!json.audio_base64) throw new AppError('gateway_error', 'ElevenLabs returned no audio', [], true);
    this.metrics?.ttsCharacters.inc({ provider: this.provider }, req.text.length);
    const starts = json.alignment?.character_start_times_seconds ?? [];
    const ends = json.alignment?.character_end_times_seconds ?? [];
    return {
      audio: Buffer.from(json.audio_base64, 'base64'),
      mime: 'audio/mpeg',
      ...(starts.length && ends.length ? { span: { start: starts[0]!, end: ends[ends.length - 1]! } } : {}),
    };
  }
}

/** OpenAI preset voices: a design picks three presets and steers them with the description. */
export const OPENAI_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
] as const;

export class OpenAiTts extends ProxiedTts implements TtsClient {
  readonly provider = 'openai' as const;
  readonly canClone = false;

  async design(req: { description: string; text: string; seed: number; signal?: AbortSignal }) {
    const start = req.seed % OPENAI_VOICES.length;
    const presets = [0, 4, 7].map((k) => OPENAI_VOICES[(start + k) % OPENAI_VOICES.length]!);
    const out: VoicePreview[] = [];
    for (const voice of presets) {
      const speech = await this.speak({
        voiceId: voice,
        text: req.text,
        seed: req.seed,
        description: req.description,
        signal: req.signal,
      });
      out.push({ voiceId: voice, audio: speech.audio, mime: speech.mime });
    }
    return out;
  }

  async save(req: { previewVoiceId: string }) {
    return req.previewVoiceId;
  }

  async clone(): Promise<string> {
    throw new AppError(
      'tts_unavailable',
      'OpenAI speech cannot clone voices; use ElevenLabs (RIDEO_TTS_PROVIDER=elevenlabs) to clone a recording',
    );
  }

  async speak(req: {
    voiceId: string;
    text: string;
    seed: number;
    description: string;
    signal?: AbortSignal;
  }): Promise<Speech> {
    const res = await this.call('speak', 'v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        voice: req.voiceId,
        input: req.text,
        ...(req.description.trim() ? { instructions: req.description.trim().slice(0, 1000) } : {}),
        response_format: 'mp3',
      }),
      signal: req.signal,
    });
    this.metrics?.ttsCharacters.inc({ provider: this.provider }, req.text.length);
    return { audio: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg' };
  }
}

export function createTts(proxy: ProxyClient, endpoint: TtsEndpoint, metrics?: Metrics): TtsClient {
  return endpoint.provider === 'openai'
    ? new OpenAiTts(proxy, endpoint, metrics)
    : new ElevenLabsTts(proxy, endpoint, metrics);
}
