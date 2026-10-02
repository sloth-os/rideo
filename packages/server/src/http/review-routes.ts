import {
  CommentCreateInputSchema,
  CommentReplyInputSchema,
  CommentStatusInputSchema,
  CommentTargetSchema,
  GuestInputSchema,
  IdSchema,
  ReviewCreateInputSchema,
  ReviewDecisionInputSchema,
} from '@rideo/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Studio } from '../domain/studio';
import { AppError } from '../errors';
import type { AuthedRequest } from './auth-routes';
import { sendMedia } from './routes';

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => schema.parse(value ?? {});
const Token = z.object({ token: z.string().min(10).max(400) });

/** Comments, reviews, the guest surface of share links and notifications (docs/design/review.md#surfaces). */
export function registerReviewRoutes(app: FastifyInstance, studio: Studio): void {
  const review = studio.review;
  const actor = () => studio.userActor();
  const pid = (req: FastifyRequest) =>
    parse(z.object({ id: z.string().regex(/^prj_[0-9a-z]{10,32}$/) }), req.params).id;
  const param = (req: FastifyRequest, key: string) => parse(z.object({ [key]: IdSchema }), req.params)[key]!;

  // Comments
  app.get('/api/projects/:id/comments', async (req) => {
    const q = parse(
      z.object({
        status: z.enum(['open', 'resolved']).optional(),
        /** `take:<clipId>:<shotId>:<takeId>` or `export:<exportId>`. */
        target: z.string().max(200).optional(),
      }),
      req.query,
    );
    const target = q.target ? parseTarget(q.target) : undefined;
    return review.comments(pid(req), { status: q.status, target });
  });
  app.post('/api/projects/:id/comments', async (req, reply) =>
    reply
      .code(201)
      .send(await review.createComment(actor(), pid(req), parse(CommentCreateInputSchema, req.body))),
  );
  app.post('/api/projects/:id/comments/:commentId/replies', async (req, reply) =>
    reply
      .code(201)
      .send(
        await review.reply(
          actor(),
          pid(req),
          param(req, 'commentId'),
          parse(CommentReplyInputSchema, req.body).body,
        ),
      ),
  );
  app.patch('/api/projects/:id/comments/:commentId', async (req) =>
    review.setStatus(
      actor(),
      pid(req),
      param(req, 'commentId'),
      parse(CommentStatusInputSchema, req.body).status,
    ),
  );

  // Reviews
  app.get('/api/projects/:id/reviews', async (req) => review.reviews(pid(req)));
  app.post('/api/projects/:id/reviews', async (req, reply) =>
    reply
      .code(201)
      .send(await review.createReview(actor(), pid(req), parse(ReviewCreateInputSchema, req.body))),
  );
  app.post('/api/projects/:id/reviews/:reviewId/decisions', async (req) =>
    review.decide(actor(), pid(req), param(req, 'reviewId'), parse(ReviewDecisionInputSchema, req.body)),
  );
  app.delete('/api/projects/:id/reviews/:reviewId/link', async (req) =>
    review.revokeLink(actor(), pid(req), param(req, 'reviewId')),
  );

  // Guests of a share link: the token is the access (and the only one).
  const token = (req: FastifyRequest) => parse(Token, req.params).token;
  app.get('/api/review/:token', async (req) => review.guestView(token(req)));
  app.get('/api/review/:token/media/*', async (req, reply) => {
    const path = (req.params as Record<string, string>)['*'] ?? '';
    const ok = await review.guestMedia(token(req), path);
    if (!ok) throw new AppError('not_found', 'Not part of this review');
    return sendMedia(studio, req, reply, ok.projectId, path);
  });
  app.post('/api/review/:token/comments', async (req, reply) => {
    const body = parse(CommentCreateInputSchema.merge(GuestInputSchema), req.body);
    const { name, ...input } = body;
    return reply.code(201).send(await review.guestComment(token(req), name, input));
  });
  app.post('/api/review/:token/comments/:commentId/replies', async (req, reply) => {
    const body = parse(CommentReplyInputSchema.merge(GuestInputSchema), req.body);
    const commentId = parse(z.object({ commentId: IdSchema }), req.params).commentId;
    return reply.code(201).send(await review.guestReply(token(req), body.name, commentId, body.body));
  });
  app.post('/api/review/:token/decisions', async (req) => {
    const { name, ...input } = parse(ReviewDecisionInputSchema.merge(GuestInputSchema), req.body);
    return review.guestDecide(token(req), name, input);
  });

  // Notifications of the caller
  const me = (req: FastifyRequest) => {
    const p = (req as AuthedRequest).principal;
    if (!p) throw new AppError('unauthorized', 'Sign in first');
    return p.user.id;
  };
  app.get('/api/notifications', async (req) =>
    studio.deps.notifications.list(
      me(req),
      parse(z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }), req.query).limit,
    ),
  );
  app.post('/api/notifications/read', async (req) =>
    studio.deps.notifications.markRead(
      me(req),
      parse(z.object({ ids: z.array(z.string().max(64)).max(500).optional() }), req.body).ids,
    ),
  );
}

/** `take:<clipId>:<shotId>:<takeId>` or `export:<exportId>` (query strings). */
export function parseTarget(s: string) {
  const [kind, a, b, c] = s.split(':');
  return CommentTargetSchema.parse(
    kind === 'take' ? { kind, clipId: a, shotId: b, takeId: c } : { kind, exportId: a },
  );
}
