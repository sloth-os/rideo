import { z } from 'zod';
import { IdSchema, IsoDateSchema, MediaRefSchema } from './common';
import { LibraryOriginSchema } from './library-link';

/** `lut`: a `.cube` 3D LUT (docs/design/editor.md#luts). */
export const ResourceKindSchema = z.enum(['image', 'video', 'audio', 'lut']);
export type ResourceKind = z.infer<typeof ResourceKindSchema>;

/** `extension`: frames generated to extend an item of the cut (docs/design/take-editing.md). */
export const ResourceRoleSchema = z.enum([
  'reference',
  'source',
  'music',
  'voiceover',
  'sfx',
  'extension',
  'other',
]);
export type ResourceRole = z.infer<typeof ResourceRoleSchema>;

export const ResourceSchema = z.object({
  id: IdSchema,
  kind: ResourceKindSchema,
  role: ResourceRoleSchema,
  name: z.string().min(1).max(300),
  media: MediaRefSchema,
  createdAt: IsoDateSchema,
  /** `library`: used from the studio library (docs/design/library.md#use-in-project-update-and-link-apply). */
  origin: z.enum(['upload', 'generated', 'inbox', 'url', 'library']),
  status: z.enum(['processing', 'ready', 'failed']).default('ready'),
  error: z.string().max(2000).optional(),
  notes: z.string().max(4000).optional(),
  generation: z
    .object({ prompt: z.string().max(4000), model: z.string().optional(), taskId: z.string().optional() })
    .optional(),
  /** The library version it came from or was saved as (docs/design/library.md#copy-on-apply). */
  library: LibraryOriginSchema.nullable().optional(),
});
export type Resource = z.infer<typeof ResourceSchema>;

export function kindFromMime(mime: string): ResourceKind | null {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/x-cube') return 'lut';
  return null;
}
