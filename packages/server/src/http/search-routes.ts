import { SearchQuerySchema } from '@rideo/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Studio } from '../domain/studio';

const ProjectParam = z.object({ id: z.string().regex(/^prj_[0-9a-z]{10,32}$/) });

/** Semantic media search (docs/design/search.md#searching). */
export function registerSearchRoutes(app: FastifyInstance, studio: Studio): void {
  const search = studio.search;
  const pid = (req: FastifyRequest) => ProjectParam.parse(req.params).id;

  app.get('/api/projects/:id/search', async (req) =>
    search.search(pid(req), SearchQuerySchema.parse(req.query ?? {})),
  );
  app.get('/api/projects/:id/search/status', async (req) => search.status(pid(req)));
  app.post('/api/projects/:id/search/index', async (req, reply) =>
    reply.code(202).send({ job: await search.index(studio.userActor(), pid(req)) }),
  );
}
