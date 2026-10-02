import { z } from 'zod';
import type { ProxyClient } from '../gateway/proxy-client';
import { LlmError } from './llm';

const EmbeddingsResponseSchema = z.object({
  data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()).min(1) })),
});

/** Inputs per request. */
export const EMBEDDINGS_BATCH = 64;

/**
 * Text embeddings through the gateway proxy (docs/design/search.md#the-index): OpenAI-style `/v1/embeddings` in
 * batches, validated, in input order.
 */
export class EmbeddingsClient {
  constructor(
    private readonly proxy: ProxyClient,
    private readonly domain: string,
    readonly model: string,
  ) {}

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBEDDINGS_BATCH) {
      const batch = texts.slice(i, i + EMBEDDINGS_BATCH);
      const res = await this.proxy.fetch(this.domain, 'v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: batch }),
        signal,
        timeoutMs: 60_000,
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 600);
        throw new LlmError(
          `embeddings via mm-gateway proxy returned ${res.status}: ${body}`,
          res.status,
          res.status === 429 || res.status >= 500,
        );
      }
      const parsed = EmbeddingsResponseSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success || parsed.data.data.length !== batch.length)
        throw new LlmError(
          `embeddings: unexpected response (${parsed.success ? `${parsed.data.data.length} of ${batch.length}` : parsed.error.message.slice(0, 200)})`,
          res.status,
          true,
        );
      out.push(...[...parsed.data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding));
    }
    return out;
  }
}
