import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Studio } from '../domain/studio';

const ProjectParam = z.object({ id: z.string().regex(/^prj_[0-9a-z]{10,32}$/) });

/** The model of a project's performance takes (docs/design/performance.md#surfaces). */
export function registerPerformanceRoutes(app: FastifyInstance, studio: Studio): void {
  app.get('/api/projects/:id/performance', async (req) =>
    studio.performance.model(ProjectParam.parse(req.params).id),
  );
}
