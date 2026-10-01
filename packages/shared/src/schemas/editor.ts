import { z } from 'zod';
import { IdSchema, ProbeSchema, TimeRangeSchema } from './common';
import {
  type EditorJobKind,
  EditorJobKindSchema,
  ExportQualitySchema,
  RenderEngineChoiceSchema,
  RenderEngineSchema,
} from './job';
import { DisclosurePositionSchema } from './project';
import { ResourceKindSchema, ResourceRoleSchema } from './resource';

/** Editor jobs: params, results and the REST bodies of the claim protocol (docs/design/editor.md#editor-jobs). */

/** A file an editor job uploads into its staging folder. */
export const StagedNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, 'invalid staged file name');

export const MediaProcessParamsSchema = z.object({ resourceId: IdSchema });
export const AnalysisSignalsParamsSchema = z.object({
  analysisId: IdSchema,
  resourceId: IdSchema,
  /** Extract a speech track for speech-to-text (the server has STT configured). */
  speech: z.boolean().default(false),
  maxThumbnails: z.number().int().min(0).max(48).default(12),
});
export const ExportRenderParamsSchema = z.object({
  exportId: IdSchema,
  quality: ExportQualitySchema,
  engine: RenderEngineChoiceSchema,
  chunkSec: z.number().min(2).max(600).default(30),
  /** The timeline commit the render was requested at (the tab renders that version). */
  timelineCommit: z.string().nullable().default(null),
  /** The document rendered: the cut, the animatic or a derived render timeline (a language variant). */
  timelinePath: z
    .string()
    .regex(/^(timeline\.json|animatic\.json|renders\/[a-z]{3}_[0-9a-z]{10,32}\.json)$/)
    .default('timeline.json'),
  /** The disclosure label to burn in (docs/design/provenance.md#disclosure-label); null = none. */
  disclosure: z
    .object({ text: z.string().min(1).max(60), position: DisclosurePositionSchema })
    .nullable()
    .default(null),
  /** Also render the dialogue, music and effects stems (docs/design/post-audio.md#stems). */
  stems: z.boolean().default(false),
});

export const EditorParamsSchemas = {
  'media.process': MediaProcessParamsSchema,
  'analysis.signals': AnalysisSignalsParamsSchema,
  'export.render': ExportRenderParamsSchema,
} satisfies Record<EditorJobKind, z.ZodType>;
export type EditorParams<K extends EditorJobKind> = z.infer<(typeof EditorParamsSchemas)[K]>;

export const MediaProcessResultSchema = z.object({
  probe: ProbeSchema,
  poster: StagedNameSchema.optional(),
});
export type MediaProcessResult = z.infer<typeof MediaProcessResultSchema>;

export const AnalysisSignalsSchema = z.object({
  scenes: z.array(TimeRangeSchema).max(10_000),
  silences: z.array(TimeRangeSchema).max(10_000),
  blackSegments: z.array(TimeRangeSchema).max(10_000),
  loudness: z.object({ integratedLufs: z.number() }).nullable(),
});
export type AnalysisSignals = z.infer<typeof AnalysisSignalsSchema>;

export const AnalysisSignalsResultSchema = z.object({
  probe: ProbeSchema,
  signals: AnalysisSignalsSchema,
  thumbnails: z
    .array(
      z.object({
        sceneIndex: z.number().int().nonnegative(),
        at: z.number().nonnegative(),
        file: StagedNameSchema,
      }),
    )
    .max(48),
  speech: StagedNameSchema.optional(),
});
export type AnalysisSignalsResult = z.infer<typeof AnalysisSignalsResultSchema>;

export const ExportRenderResultSchema = z.object({
  engine: RenderEngineSchema,
  codec: z.string().min(1).max(100),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  durationSec: z.number().positive(),
  parts: z.array(StagedNameSchema).min(1).max(10_000),
  /** Lossless (`soundtrack.flac`); older tabs staged AAC (`soundtrack.m4a`). */
  soundtrack: StagedNameSchema.nullable(),
  stems: z
    .object({ dialogue: StagedNameSchema, music: StagedNameSchema, effects: StagedNameSchema })
    .nullable()
    .default(null),
});
export type ExportRenderResult = z.infer<typeof ExportRenderResultSchema>;

export const EditorResultSchemas = {
  'media.process': MediaProcessResultSchema,
  'analysis.signals': AnalysisSignalsResultSchema,
  'export.render': ExportRenderResultSchema,
} satisfies Record<EditorJobKind, z.ZodType>;
export type EditorResult<K extends EditorJobKind> = z.infer<(typeof EditorResultSchemas)[K]>;

const SessionIdSchema = z.string().min(1).max(100);

export const EditorClaimInputSchema = z.object({
  sessionId: SessionIdSchema,
  projectId: IdSchema,
  kinds: z.array(EditorJobKindSchema).min(1).optional(),
});
export const EditorHeartbeatInputSchema = z.object({
  sessionId: SessionIdSchema,
  progress: z
    .object({
      done: z.number().nonnegative(),
      total: z.number().nonnegative(),
      message: z.string().max(300).optional(),
    })
    .optional(),
});
export const EditorCompleteInputSchema = z.object({ sessionId: SessionIdSchema, result: z.unknown() });
export const EditorFailInputSchema = z.object({
  sessionId: SessionIdSchema,
  error: z.object({ code: z.string().min(1).max(100), message: z.string().max(4000) }),
});

/** The JSON `meta` part of an upload (the browser's probe makes the resource ready at once). */
export const UploadMetaSchema = z.object({
  probe: ProbeSchema.optional(),
  kind: ResourceKindSchema.optional(),
  role: ResourceRoleSchema.optional(),
  name: z.string().min(1).max(300).optional(),
});
export type UploadMeta = z.infer<typeof UploadMetaSchema>;
