import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { BRAND_SLOTS, BrandKitInputSchema } from '@rideo/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Studio } from '../domain/studio';
import { invalid } from '../errors';

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => schema.parse(value ?? {});
const KitParam = z.object({ kitId: z.string().regex(/^bkt_[0-9a-z]{10,32}$/) });

/** Brand kits and a project's brand (docs/design/brand-kits.md#surfaces). */
export function registerBrandRoutes(app: FastifyInstance, studio: Studio): void {
  const brand = studio.brand;
  const actor = () => studio.userActor();
  const kit = (req: FastifyRequest) => parse(KitParam, req.params).kitId;

  app.get('/api/brand-kits', async () => brand.list());
  app.post('/api/brand-kits', async (req, reply) =>
    reply.code(201).send(await brand.create(actor(), parse(BrandKitInputSchema, req.body))),
  );
  app.patch('/api/brand-kits/:kitId', async (req) =>
    brand.update(actor(), kit(req), parse(BrandKitInputSchema.partial(), req.body)),
  );
  app.delete('/api/brand-kits/:kitId', async (req, reply) => {
    await brand.remove(actor(), kit(req));
    return reply.code(204).send();
  });
  app.put('/api/brand-kits/:kitId/files/:slot', async (req) => {
    const { slot } = parse(z.object({ slot: z.enum(BRAND_SLOTS) }), req.params);
    if (!req.isMultipart()) throw invalid('send the file as multipart form data');
    const part = await req.file();
    if (!part) throw invalid('no file');
    const tmp = studio.deps.media.tmp(extname(part.filename).slice(1) || 'bin');
    try {
      await pipeline(part.file, createWriteStream(tmp));
      if (part.file.truncated) throw invalid('the file is too large');
      return await brand.putFile(actor(), kit(req), slot, {
        path: tmp,
        filename: part.filename,
        mime: part.mimetype || 'application/octet-stream',
      });
    } finally {
      await rm(tmp, { force: true });
    }
  });
  app.get('/api/brand-kits/:kitId/files/:file', async (req, reply) => {
    const { file } = parse(z.object({ file: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,199}$/) }), req.params);
    const res = await brand.file(kit(req), file);
    reply.type(res.mime).header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(res.stream);
  });
  app.put('/api/projects/:id/brand', async (req) => {
    const { id } = parse(z.object({ id: z.string().regex(/^prj_[0-9a-z]{10,32}$/) }), req.params);
    const { kitId } = parse(
      z.object({
        kitId: z
          .string()
          .regex(/^bkt_[0-9a-z]{10,32}$/)
          .nullable(),
      }),
      req.body,
    );
    return { brand: await brand.apply(actor(), id, kitId) };
  });
}
