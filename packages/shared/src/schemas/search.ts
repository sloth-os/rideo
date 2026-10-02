import { z } from 'zod';
import { IdSchema, IsoDateSchema, MediaRefSchema } from './common';
import { JobSchema } from './job';

/** What search covers (docs/design/search.md#the-index). */
export const SEARCH_KINDS = ['take', 'resource', 'reference'] as const;
export const SearchKindSchema = z.enum(SEARCH_KINDS);
export type SearchKind = z.infer<typeof SearchKindSchema>;

export const SearchSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('take'), clipId: IdSchema, shotId: IdSchema, takeId: IdSchema }),
  z.object({ kind: z.literal('resource'), resourceId: IdSchema }),
  z.object({
    kind: z.literal('reference'),
    characterId: IdSchema.optional(),
    elementId: IdSchema.optional(),
    referenceId: IdSchema,
  }),
]);
export type SearchSource = z.infer<typeof SearchSourceSchema>;

/** The longest caption kept. */
export const CAPTION_MAX = 300;

/** A frame's key: `<media hash>@<seconds>`. One caption per frame, whichever sources show it. */
export const FrameKeySchema = z.string().regex(/^[0-9a-f]{64}@\d+(\.\d+)?$/);

export const SearchEntrySchema = z.object({
  key: FrameKeySchema,
  source: SearchSourceSchema,
  media: MediaRefSchema,
  /** Seconds into the media (0 for stills). */
  at: z.number().nonnegative(),
  /** The vision model's description of the frame. */
  caption: z.string().min(1).max(CAPTION_MAX),
  /** Who and what the source is known to show (a take: its shot's cast and elements; a reference: its owner). */
  names: z.array(z.string().max(120)).max(40).default([]),
  /** The caption's embedding, when an embeddings model is configured. */
  vector: z.array(z.number()).nullable().default(null),
});
export type SearchEntry = z.infer<typeof SearchEntrySchema>;

/** A project's index (`<dataDir>/search/<projectId>.json`): derived, rebuilt when lost, never versioned. */
export const SearchIndexSchema = z.object({
  version: z.literal(1),
  projectId: IdSchema,
  /** The model the vectors come from; entries embedded by another model are embedded again. */
  embeddingModel: z.string().nullable().default(null),
  entries: z.array(SearchEntrySchema).default([]),
  /** Frames the vision model could not caption, not tried again until their media changes. */
  failed: z.array(FrameKeySchema).default([]),
  /** The last search: from then on new takes and uploads are indexed on their own. */
  usedAt: IsoDateSchema.nullable().default(null),
  updatedAt: IsoDateSchema.nullable().default(null),
});
export type SearchIndex = z.infer<typeof SearchIndexSchema>;

/** `semantic`: by the meaning of captions (embeddings); `words`: by their words (BM25). */
export const SearchModeSchema = z.enum(['semantic', 'words']);
export type SearchMode = z.infer<typeof SearchModeSchema>;

/** `GET /api/projects/:id/search` (and `media_search`). */
export const SearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(500),
  kinds: z
    .preprocess(
      (v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v),
      z.array(SearchKindSchema).min(1).max(SEARCH_KINDS.length),
    )
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const SearchResultSchema = z.object({
  source: SearchSourceSchema,
  media: MediaRefSchema,
  at: z.number().nonnegative(),
  caption: z.string(),
  names: z.array(z.string()),
  /** 0–1: the cosine similarity (semantic), or the share of the best match's BM25 score (words). */
  score: z.number(),
  /** The shot, the resource's name, or the reference's owner. */
  label: z.string(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchResponseSchema = z.object({
  query: z.string(),
  mode: SearchModeSchema,
  results: z.array(SearchResultSchema),
  /** Frames in the index, and frames waiting to be indexed. */
  indexed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const SearchStatusSchema = z.object({
  /** How searches rank: `semantic` when an embeddings model is configured. */
  mode: SearchModeSchema,
  indexed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** Media files with frames in the index. */
  files: z.number().int().nonnegative(),
  updatedAt: IsoDateSchema.nullable(),
  usedAt: IsoDateSchema.nullable(),
  /** The index job running or waiting, if any. */
  job: JobSchema.nullable(),
});
export type SearchStatus = z.infer<typeof SearchStatusSchema>;

/** The `frame.caption` task (docs/design/search.md#captions). */
export const FrameCaptionInputSchema = z.object({
  /** What the frame is from: a generated take, footage, a still, or an approved reference. */
  kind: z.enum(['take', 'footage', 'still', 'reference']),
  /** Who and what the source is known to show, with how they look. */
  known: z.array(z.object({ name: z.string(), description: z.string() })).max(40),
  /** Everyone and everything in the project, to name only when sure. */
  cast: z.array(z.string()).max(200),
});
export type FrameCaptionInput = z.infer<typeof FrameCaptionInputSchema>;

export const FrameCaptionOutputSchema = z.object({
  caption: z
    .string()
    .trim()
    .min(1)
    .transform((s) => s.slice(0, CAPTION_MAX)),
});
export type FrameCaptionOutput = z.infer<typeof FrameCaptionOutputSchema>;
