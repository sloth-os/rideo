import {
  AuditQueryInputSchema,
  ProjectAccessInputSchema,
  TokenCreateInputSchema,
  UserUpdateInputSchema,
} from '@rideo/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SESSION_COOKIE } from '../auth/accounts';
import type { Principal } from '../auth/context';
import type { Studio } from '../domain/studio';
import { AppError, invalid } from '../errors';

export type AuthedRequest = FastifyRequest & { principal?: Principal | null };

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const r = schema.safeParse(value);
  if (!r.success)
    throw invalid(
      'invalid request',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  return r.data;
};

/** Sign-in, people, agent tokens, the audit log and project access (docs/design/accounts.md#surfaces). */
export function registerAuthRoutes(app: FastifyInstance, studio: Studio): void {
  const accounts = studio.deps.accounts;
  const who = (req: FastifyRequest): Principal => {
    const p = (req as AuthedRequest).principal;
    if (!p) throw new AppError('unauthorized', 'Sign in first');
    return p;
  };
  const secure = studio.config.publicUrl.startsWith('https://');
  const cookie = (value: string, maxAgeSec: number) =>
    `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;

  app.get('/api/auth/me', async (req) => accounts.me((req as AuthedRequest).principal ?? null));
  app.get('/api/auth/login', async (req, reply) => {
    const q = parse(
      z.object({ returnTo: z.string().max(2000).optional(), login_hint: z.string().max(320).optional() }),
      req.query ?? {},
    );
    return reply.redirect(await accounts.startLogin(q.returnTo ?? '/', q.login_hint));
  });
  app.get('/api/auth/callback', async (req, reply) => {
    const q = parse(
      z.object({
        code: z.string().max(2000).optional(),
        state: z.string().max(200).optional(),
        error: z.string().max(200).optional(),
        error_description: z.string().max(1000).optional(),
      }),
      req.query ?? {},
    );
    if (q.error || !q.code || !q.state)
      return reply.redirect(
        `/login?error=${encodeURIComponent(q.error_description ?? q.error ?? 'sign-in failed')}`,
      );
    try {
      const r = await accounts.finishLogin(q.code, q.state);
      reply.header('set-cookie', cookie(r.session, studio.config.auth.sessionDays * 86_400));
      return reply.redirect(r.returnTo);
    } catch (err) {
      return reply.redirect(`/login?error=${encodeURIComponent((err as Error).message)}`);
    }
  });
  app.post('/api/auth/logout', async (req, reply) => {
    await accounts.logout((req as AuthedRequest).principal ?? null, req.headers.cookie);
    reply.header('set-cookie', cookie('', 0));
    return { ok: true };
  });

  app.get('/api/users', async (req) => accounts.listUsers(who(req)));
  app.patch('/api/users/:userId', async (req) =>
    accounts.updateUser(
      who(req),
      parse(z.object({ userId: z.string() }), req.params).userId,
      parse(UserUpdateInputSchema, req.body),
    ),
  );

  app.get('/api/tokens', async (req) => accounts.listTokens(who(req)));
  app.post('/api/tokens', async (req, reply) =>
    reply.code(201).send(await accounts.createToken(who(req), parse(TokenCreateInputSchema, req.body))),
  );
  app.delete('/api/tokens/:tokenId', async (req) =>
    accounts.revokeToken(who(req), parse(z.object({ tokenId: z.string() }), req.params).tokenId),
  );

  app.get('/api/audit', async (req) => {
    const q = parse(AuditQueryInputSchema, req.query ?? {});
    return accounts.queryAudit(who(req), { ...q, actorId: q.actor });
  });

  app.get('/api/projects/:id/access', async (req) =>
    studio.projects.access(parse(z.object({ id: z.string() }), req.params).id),
  );
  app.put('/api/projects/:id/access', async (req) =>
    studio.projects.setAccess(
      studio.userActor(),
      parse(z.object({ id: z.string() }), req.params).id,
      parse(ProjectAccessInputSchema, req.body),
    ),
  );
}
