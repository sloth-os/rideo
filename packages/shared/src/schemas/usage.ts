import { z } from 'zod';

/**
 * Usage and cost (docs/design/observability.md#usage-ledger): what a job's generations and model calls used, summed
 * per project in `.rideo/usage.json`.
 */
export const USAGE_MODALITIES = ['text', 'vision', 'image', 'video', 'music', 'speech'] as const;
export const UsageModalitySchema = z.enum(USAGE_MODALITIES);
export type UsageModality = z.infer<typeof UsageModalitySchema>;

const count = z.number().nonnegative().default(0);

export const ModelUsageSchema = z.object({
  modality: UsageModalitySchema,
  calls: count,
  /** Wall time of the calls (create to terminal for gateway tasks). */
  seconds: count,
  /** Images, seconds of video or music, tokens or characters: the unit the model is priced in. */
  units: count,
  costUsd: count,
  unpriced: count,
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

export const UsageSchema = z.object({
  llmCalls: count,
  llmRetries: count,
  tokensIn: count,
  tokensOut: count,
  images: count,
  videoSeconds: count,
  videoCount: count,
  musicSeconds: count,
  ttsCharacters: count,
  costUsd: count,
  /** Usage items of models without a price. */
  unpriced: count,
  /** Video attempts the gate threw away, and takes replaced by a regeneration. */
  discardedVideoSeconds: count,
  discardedCostUsd: count,
  byModel: z.record(z.string(), ModelUsageSchema).default({}),
});
export type Usage = z.infer<typeof UsageSchema>;

export function emptyUsage(): Usage {
  return UsageSchema.parse({});
}

export const KindUsageSchema = z.object({
  jobs: count,
  succeeded: count,
  failed: count,
  cancelled: count,
  /** Run time of finished jobs, and how long they waited for their lane before the first start. */
  runSeconds: count,
  waitSeconds: count,
  costUsd: count,
});
export type KindUsage = z.infer<typeof KindUsageSchema>;

export const ProjectUsageSchema = z.object({
  version: z.literal(1),
  projectId: z.string(),
  updatedAt: z.string(),
  totals: UsageSchema,
  byKind: z.record(z.string(), KindUsageSchema).default({}),
});
export type ProjectUsage = z.infer<typeof ProjectUsageSchema>;

/** Adds `b` into `a` (in place) and returns `a`. */
export function addUsage(a: Usage, b: Usage): Usage {
  for (const k of [
    'llmCalls',
    'llmRetries',
    'tokensIn',
    'tokensOut',
    'images',
    'videoSeconds',
    'videoCount',
    'musicSeconds',
    'ttsCharacters',
    'costUsd',
    'unpriced',
    'discardedVideoSeconds',
    'discardedCostUsd',
  ] as const)
    a[k] = round6(a[k] + b[k]);
  for (const [model, m] of Object.entries(b.byModel)) {
    const into = a.byModel[model] ?? ModelUsageSchema.parse({ modality: m.modality });
    a.byModel[model] = into;
    into.calls = round6(into.calls + m.calls);
    into.seconds = round6(into.seconds + m.seconds);
    into.units = round6(into.units + m.units);
    into.costUsd = round6(into.costUsd + m.costUsd);
    into.unpriced = round6(into.unpriced + m.unpriced);
  }
  return a;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Prices per model id (`RIDEO_PRICES`), in USD. */
export const ModelPriceSchema = z.object({
  image: z.number().nonnegative().optional(),
  videoSecond: z.number().nonnegative().optional(),
  musicSecond: z.number().nonnegative().optional(),
  request: z.number().nonnegative().optional(),
  inputMTokens: z.number().nonnegative().optional(),
  outputMTokens: z.number().nonnegative().optional(),
  character: z.number().nonnegative().optional(),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;
export const PricesSchema = z.record(z.string().min(1), ModelPriceSchema);
export type Prices = z.infer<typeof PricesSchema>;

/** Parses `RIDEO_PRICES` (JSON); an empty value is no prices. Throws with the problem for a broken value. */
export function parsePrices(text: string | undefined): Prices {
  if (!text?.trim()) return {};
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`RIDEO_PRICES is not JSON: ${(err as Error).message}`);
  }
  const res = PricesSchema.safeParse(json);
  if (!res.success)
    throw new Error(
      `RIDEO_PRICES: ${res.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join('; ')}`,
    );
  return res.data;
}

/** Telemetry from the studio (docs/design/observability.md#telemetry-from-the-studio): names are fixed lists. */
export const TELEMETRY_NAMES = {
  vital: ['lcp', 'fcp', 'ttfb', 'inp', 'cls'],
  timing: ['project_load', 'editor_ready', 'first_frame', 'export_chunk'],
  error: ['error', 'rejection', 'api'],
} as const;
export type TelemetryKind = keyof typeof TELEMETRY_NAMES;

export const TelemetryEventSchema = z
  .object({
    kind: z.enum(['vital', 'timing', 'error']),
    name: z.string().max(40),
    /** Seconds for vitals and timings (CLS is unitless), a count for errors. */
    value: z.number().min(0).max(86_400),
    route: z.string().max(100).optional(),
  })
  .refine((e) => (TELEMETRY_NAMES[e.kind] as readonly string[]).includes(e.name), {
    message: 'unknown telemetry name',
    path: ['name'],
  });
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
export const TelemetryInputSchema = z.object({ events: z.array(TelemetryEventSchema).min(1).max(50) });
export type TelemetryInput = z.infer<typeof TelemetryInputSchema>;
