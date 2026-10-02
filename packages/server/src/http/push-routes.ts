import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Studio } from '../domain/studio';
import { AppError } from '../errors';
import { PushSubscriptionSchema } from '../push/service';
import type { AuthedRequest } from './auth-routes';

/** The Inbox and notifications on people's devices (docs/design/pwa.md). */
export function registerPushRoutes(app: FastifyInstance, studio: Studio): void {
  const me = (req: FastifyRequest) => {
    const p = (req as AuthedRequest).principal;
    if (!p) throw new AppError('unauthorized', 'Sign in first');
    return p.user.id;
  };
  app.get('/api/inbox', async (req) =>
    studio.inbox.inbox({
      fresh: z.object({ fresh: z.string().optional() }).parse(req.query ?? {}).fresh === '1',
    }),
  );
  app.get('/api/push/key', async () => ({ publicKey: studio.push.publicKey() }));
  app.get('/api/push/subscriptions', async (req) => ({ endpoints: await studio.push.devices(me(req)) }));
  app.post('/api/push/subscriptions', async (req, reply) => {
    await studio.push.subscribe(me(req), PushSubscriptionSchema.parse(req.body ?? {}));
    return reply.code(201).send({});
  });
  app.delete('/api/push/subscriptions', async (req, reply) => {
    const { endpoint } = z.object({ endpoint: z.string().url().max(2000) }).parse(req.body ?? {});
    await studio.push.unsubscribe(me(req), endpoint);
    return reply.code(204).send();
  });
}
