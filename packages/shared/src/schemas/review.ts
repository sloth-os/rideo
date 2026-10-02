import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common';

/** Who wrote a comment or decided (docs/design/review.md): a member, an agent, or a guest of a share link. */
export const AuthorSchema = z.object({
  kind: z.enum(['user', 'agent', 'guest', 'system', 'webdav']),
  id: z.string().min(1).max(200),
  name: z.string().max(200),
});
export type Author = z.infer<typeof AuthorSchema>;

const Point = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** A drawing on a frame, in 0–1 frame coordinates. */
export const ShapeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stroke'), points: z.array(Point).min(2).max(2000), color: Color }),
  z.object({ kind: z.literal('arrow'), from: Point, to: Point, color: Color }),
  z.object({ kind: z.literal('box'), from: Point, to: Point, color: Color }),
]);
export type Shape = z.infer<typeof ShapeSchema>;
export const AnnotationSchema = z.object({ shapes: z.array(ShapeSchema).min(1).max(50) });
export type Annotation = z.infer<typeof AnnotationSchema>;

export const CommentTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('take'), clipId: IdSchema, shotId: IdSchema, takeId: IdSchema }),
  z.object({ kind: z.literal('export'), exportId: IdSchema }),
]);
export type CommentTarget = z.infer<typeof CommentTargetSchema>;

export const CommentReplySchema = z.object({
  id: IdSchema,
  author: AuthorSchema,
  body: z.string().min(1).max(4000),
  mentions: z.array(IdSchema).max(50).default([]),
  createdAt: IsoDateSchema,
});
export type CommentReply = z.infer<typeof CommentReplySchema>;

/** A comment thread (`comments/<id>.json`, docs/design/review.md#comments). */
export const CommentThreadSchema = z.object({
  id: IdSchema,
  target: CommentTargetSchema,
  /** Seconds into the take or export; null for the whole of it. */
  at: z.number().nonnegative().nullable().default(null),
  annotation: AnnotationSchema.nullable().default(null),
  author: AuthorSchema,
  body: z.string().min(1).max(4000),
  mentions: z.array(IdSchema).max(50).default([]),
  replies: z.array(CommentReplySchema).max(500).default([]),
  status: z.enum(['open', 'resolved']).default('open'),
  resolvedBy: AuthorSchema.nullable().default(null),
  resolvedAt: IsoDateSchema.nullable().default(null),
  reviewId: IdSchema.nullable().default(null),
  createdAt: IsoDateSchema,
});
export type CommentThread = z.infer<typeof CommentThreadSchema>;

export const ReviewTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('export'), exportId: IdSchema }),
  z.object({ kind: z.literal('clip'), clipId: IdSchema }),
]);
export type ReviewTarget = z.infer<typeof ReviewTargetSchema>;

export const ReviewDecisionSchema = z.object({
  author: AuthorSchema,
  decision: z.enum(['approve', 'changes']),
  note: z.string().max(2000).default(''),
  at: IsoDateSchema,
});
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

/** A request for a decision (`reviews/<id>.json`, docs/design/review.md#reviews-and-share-links). */
export const ReviewSchema = z.object({
  id: IdSchema,
  title: z.string().min(1).max(200),
  target: ReviewTargetSchema,
  /** The workflow gate this review decides, or null. */
  gate: z.string().max(100).nullable().default(null),
  /** The share link: only the secret's SHA-256 is stored. */
  link: z
    .object({
      hash: z.string().length(64),
      expiresAt: IsoDateSchema.nullable().default(null),
      revokedAt: IsoDateSchema.nullable().default(null),
    })
    .nullable()
    .default(null),
  decisions: z.array(ReviewDecisionSchema).max(500).default([]),
  required: z.number().int().min(1).max(50).default(1),
  status: z.enum(['open', 'approved', 'changes_requested', 'closed']).default('open'),
  createdBy: AuthorSchema,
  createdAt: IsoDateSchema,
  /** When the review's gate was approved through it. */
  gateApprovedAt: IsoDateSchema.nullable().default(null),
});
export type Review = z.infer<typeof ReviewSchema>;

/** Something for a person to see (docs/design/review.md#notifications). */
export const NotificationSchema = z.object({
  id: IdSchema,
  at: IsoDateSchema,
  /** `job`: an export, a generation or a recipe ended (docs/design/pwa.md#notifications-on-the-phone-web-push). */
  kind: z.enum(['mention', 'reply', 'comment', 'decision', 'gate', 'job']),
  projectId: z.string().nullable(),
  title: z.string().max(300),
  body: z.string().max(1000).default(''),
  /** Where it leads in the app. */
  link: z.string().max(500),
  read: z.boolean().default(false),
});
export type Notification = z.infer<typeof NotificationSchema>;
