import type { SfxEndpoint } from '../config';
import { AppError } from '../errors';
import type { ProxyClient } from '../gateway/proxy-client';
import type { Metrics } from '../metrics';

export interface SoundEffect {
  audio: Buffer;
  mime: string;
}

/**
 * Sound effects through the mm-gateway proxy (docs/design/post-audio.md#effects-from-action-lines): ElevenLabs
 * sound generation. Upstream keys stay in the gateway.
 */
export class SfxClient {
  constructor(
    private readonly proxy: ProxyClient,
    private readonly endpoint: SfxEndpoint,
    private readonly metrics?: Metrics,
  ) {}

  get model(): string {
    return this.endpoint.model;
  }

  get provider(): string {
    return this.endpoint.provider;
  }

  async generate(req: { text: string; durationSec: number; signal?: AbortSignal }): Promise<SoundEffect> {
    let res: Response;
    try {
      res = await this.proxy.fetch(this.endpoint.domain, 'v1/sound-generation?output_format=mp3_44100_128', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: req.text.slice(0, 450),
          duration_seconds: Math.round(Math.min(22, Math.max(0.5, req.durationSec)) * 10) / 10,
          prompt_influence: 0.4,
          model_id: this.endpoint.model,
        }),
        signal: req.signal,
        timeoutMs: 120_000,
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError' && req.signal?.aborted) throw err;
      this.metrics?.postAudio.inc({ op: 'sfx', outcome: 'error' });
      throw new AppError(
        'gateway_error',
        `sound effects via mm-gateway proxy failed: ${(err as Error).message}`,
        [],
        true,
      );
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 600);
      this.metrics?.postAudio.inc({ op: 'sfx', outcome: 'error' });
      throw new AppError(
        'gateway_error',
        `sound effects via mm-gateway proxy returned ${res.status}: ${body}`,
        [],
        res.status === 429 || res.status >= 500,
      );
    }
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length < 64) {
      this.metrics?.postAudio.inc({ op: 'sfx', outcome: 'error' });
      throw new AppError('gateway_error', 'the sound-effects provider returned no audio', [], true);
    }
    this.metrics?.postAudio.inc({ op: 'sfx', outcome: 'ok' });
    return { audio, mime: res.headers.get('content-type')?.split(';')[0] || 'audio/mpeg' };
  }
}
