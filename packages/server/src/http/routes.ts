import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  AddReferenceInputSchema,
  ApproveInputSchema,
  AssembleInputSchema,
  CharacterInputSchema,
  CharacterUpdateInputSchema,
  CreateProjectInputSchema,
  ExportInputSchema,
  GenerateRefsInputSchema,
  JobStatusSchema,
  MusicInputSchema,
  OverrideInputSchema,
  ReferenceViewSchema,
  ReopenInputSchema,
  ResourceInputSchema,
  RestoreInputSchema,
  ScreenplayPatchInputSchema,
  ShotUpdateInputSchema,
  SuggestionDecisionsInputSchema,
  TimelineOpsInputSchema,
  UpdateProjectInputSchema,
  UploadMetaSchema,
} from '@rideo/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Studio } from '../domain/studio';
import { AppError, invalid } from '../errors';

const IdParam = z.object({ id: z.string().regex(/^prj_[0-9a-z]{10,32}$/) });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value ?? {});
}

interface UploadedFile {
  path: string;
  filename: string;
  mime: string;
}

/** Multipart upload: file parts by field name (first one wins) and text fields. Callers remove the files. */
async function receiveUpload(
  studio: Studio,
  req: FastifyRequest,
): Promise<{
  file: UploadedFile | null;
  files: Record<string, UploadedFile>;
  fields: Record<string, string>;
}> {
  if (!req.isMultipart()) return { file: null, files: {}, fields: {} };
  const fields: Record<string, string> = {};
  const files: Record<string, UploadedFile> = {};
  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (files[part.fieldname]) {
          part.file.resume();
          continue;
        }
        const path = studio.deps.media.tmp(extname(part.filename).slice(1) || 'bin');
        files[part.fieldname] = { path, filename: part.filename, mime: part.mimetype };
        await pipeline(part.file, createWriteStream(path));
        if (part.file.truncated) throw invalid('upload exceeds the size limit');
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
  } catch (err) {
    await Promise.all(Object.values(files).map((f) => rm(f.path, { force: true })));
    throw err;
  }
  return { file: files.file ?? null, files, fields };
}

function coalesceHeader(req: FastifyRequest): string | undefined {
  const v = req.headers['x-rideo-coalesce'];
  return typeof v === 'string' && /^[\w:.#/-]{1,120}$/.test(v) ? v : undefined;
}

export function registerRoutes(app: FastifyInstance, studio: Studio): void {
  const actor = () => studio.userActor();
  const pid = (req: FastifyRequest) => parse(IdParam, req.params).id;
  const p = <T>(req: FastifyRequest, key: string): T => (req.params as Record<string, T>)[key]!;

  // Projects and documents
  app.get('/api/projects', async () => studio.projects.list());
  app.post('/api/projects', async (req, reply) =>
    reply.code(201).send(await studio.projects.create(actor(), parse(CreateProjectInputSchema, req.body))),
  );
  app.get('/api/projects/:id/state', async (req) => studio.projects.state(pid(req)));
  app.patch('/api/projects/:id', async (req) =>
    studio.projects.update(actor(), pid(req), parse(UpdateProjectInputSchema, req.body)),
  );
  app.delete('/api/projects/:id', async (req, reply) => {
    await studio.projects.remove(actor(), pid(req));
    return reply.code(204).send();
  });
  app.post('/api/projects/:id/sync', async (req) =>
    studio.projects.sync(pid(req), parse(z.object({ discardInvalid: z.boolean().optional() }), req.body)),
  );
  app.get('/api/projects/:id/docs/*', async (req) => {
    const at = (req.query as { at?: string }).at;
    return studio.projects.getDoc(pid(req), p<string>(req, '*'), at);
  });

  const serveMedia = async (req: FastifyRequest, reply: FastifyReply) => {
    const path = p<string>(req, '*');
    if (!path.startsWith('media/')) throw invalid('not a media path');
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    let r = range
      ? { start: range[1] ? Number(range[1]) : 0, end: range[2] ? Number(range[2]) : undefined }
      : undefined;
    if (range && !range[1] && range[2]) {
      const probe = await studio.deps.media.stream(pid(req), path);
      if (!probe) throw new AppError('not_found', `media ${path} not found`);
      probe.stream.destroy();
      r = { start: Math.max(0, probe.size - Number(range[2])), end: probe.size - 1 };
    }
    const res = await studio.deps.media.stream(pid(req), path, r);
    if (!res) throw new AppError('not_found', `media ${path} not found`);
    reply
      .header('accept-ranges', 'bytes')
      .header('cache-control', 'private, max-age=31536000, immutable')
      .type(res.mime);
    reply.header('content-length', res.end - res.start + 1);
    if (r) reply.code(206).header('content-range', `bytes ${res.start}-${res.end}/${res.size}`);
    if (req.method === 'HEAD') {
      res.stream.destroy();
      return reply.send();
    }
    return reply.send(res.stream);
  };
  app.get('/api/projects/:id/media/*', serveMedia);

  app.post('/api/projects/:id/uploads', async (req, reply) => {
    const { file, files, fields } = await receiveUpload(studio, req);
    try {
      if (!file) throw invalid('multipart field "file" is required');
      // `meta` is the browser's probe (docs/design/editor.md#media-preparation-uploads); plain fields still work.
      const meta = parse(UploadMetaSchema, {
        ...(fields.kind ? { kind: fields.kind } : {}),
        ...(fields.role ? { role: fields.role } : {}),
        ...(fields.name ? { name: fields.name } : {}),
        ...(fields.meta ? JSON.parse(fields.meta) : {}),
      });
      const resource = await studio.story.addResource(
        actor(),
        pid(req),
        { file: file.path, filename: file.filename, mime: file.mime },
        { kind: meta.kind, role: meta.role, name: meta.name || file.filename },
        { probe: meta.probe, poster: files.poster?.path },
      );
      return reply.code(201).send(resource);
    } finally {
      await Promise.all(Object.values(files).map((f) => rm(f.path, { force: true })));
    }
  });
  app.post('/api/projects/:id/resources', async (req, reply) => {
    const body = parse(ResourceInputSchema, req.body);
    return reply.code(201).send(await studio.story.addResource(actor(), pid(req), { uri: body.uri }, body));
  });

  // Workflow
  app.get('/api/projects/:id/workflow', async (req) => studio.workflow.evaluate(pid(req)));
  app.post('/api/projects/:id/workflow/approve', async (req) =>
    studio.workflow.approve(actor(), pid(req), parse(ApproveInputSchema, req.body).gate),
  );
  app.post('/api/projects/:id/workflow/reopen', async (req) =>
    studio.workflow.reopen(actor(), pid(req), parse(ReopenInputSchema, req.body).stage),
  );

  // Story and cast
  app.post('/api/projects/:id/screenplay/generate', async (req, reply) =>
    reply.code(202).send(
      await studio.story.generateScreenplay(
        actor(),
        pid(req),
        parse(
          z.object({
            prompt: z.string().max(20000).optional(),
            attachmentResourceIds: z.array(z.string()).optional(),
          }),
          req.body,
        ),
      ),
    ),
  );
  app.patch('/api/projects/:id/screenplay', async (req) =>
    studio.story.patchScreenplay(
      actor(),
      pid(req),
      parse(ScreenplayPatchInputSchema, req.body),
      coalesceHeader(req),
    ),
  );
  app.post('/api/projects/:id/screenplay/extend', async (req, reply) =>
    reply
      .code(202)
      .send(
        await studio.story.extendScreenplay(
          actor(),
          pid(req),
          parse(z.object({ beats: z.number().int().min(1).max(20).optional() }), req.body).beats,
        ),
      ),
  );
  app.post('/api/projects/:id/characters', async (req, reply) =>
    reply
      .code(201)
      .send(await studio.story.createCharacter(actor(), pid(req), parse(CharacterInputSchema, req.body))),
  );
  app.patch('/api/projects/:id/characters/:cid', async (req) =>
    studio.story.updateCharacter(
      actor(),
      pid(req),
      p(req, 'cid'),
      parse(CharacterUpdateInputSchema, req.body),
      coalesceHeader(req),
    ),
  );
  app.delete('/api/projects/:id/characters/:cid', async (req, reply) => {
    await studio.story.deleteCharacter(actor(), pid(req), p(req, 'cid'));
    return reply.code(204).send();
  });
  app.post('/api/projects/:id/characters/:cid/references/generate', async (req, reply) =>
    reply
      .code(202)
      .send(
        await studio.story.generateReferences(
          actor(),
          pid(req),
          p(req, 'cid'),
          parse(GenerateRefsInputSchema, req.body).views,
        ),
      ),
  );
  app.post('/api/projects/:id/characters/:cid/references', async (req, reply) => {
    if (req.isMultipart()) {
      const { file, fields } = await receiveUpload(studio, req);
      if (!file) throw invalid('multipart field "file" is required');
      try {
        const view = fields.view ? ReferenceViewSchema.parse(fields.view) : undefined;
        return reply
          .code(201)
          .send(
            await studio.story.addReference(
              actor(),
              pid(req),
              p(req, 'cid'),
              { file: file.path, filename: file.filename, mime: file.mime },
              { view },
            ),
          );
      } finally {
        await rm(file.path, { force: true });
      }
    }
    const body = parse(AddReferenceInputSchema, req.body);
    return reply
      .code(201)
      .send(await studio.story.addReference(actor(), pid(req), p(req, 'cid'), { uri: body.uri }, body));
  });
  app.patch('/api/projects/:id/characters/:cid/references/:rid', async (req) =>
    studio.story.setReferenceApproval(
      actor(),
      pid(req),
      p(req, 'cid'),
      p(req, 'rid'),
      parse(z.object({ approved: z.boolean() }), req.body).approved,
    ),
  );
  app.delete('/api/projects/:id/characters/:cid/references/:rid', async (req) =>
    studio.story.deleteReference(actor(), pid(req), p(req, 'cid'), p(req, 'rid')),
  );
  app.post('/api/projects/:id/characters/:cid/describe', async (req, reply) =>
    reply
      .code(202)
      .send(
        await studio.story.describeCharacter(
          actor(),
          pid(req),
          p(req, 'cid'),
          parse(z.object({ resourceId: z.string() }), req.body).resourceId,
        ),
      ),
  );
  app.post('/api/projects/:id/characters/:cid/lock', async (req) =>
    studio.story.lockCharacter(actor(), pid(req), p(req, 'cid')),
  );
  app.post('/api/projects/:id/characters/:cid/unlock', async (req) =>
    studio.story.unlockCharacter(actor(), pid(req), p(req, 'cid')),
  );
  app.post('/api/projects/:id/music', async (req, reply) =>
    reply
      .code(202)
      .send(await studio.story.generateMusic(actor(), pid(req), parse(MusicInputSchema, req.body))),
  );

  // Clips, shots, takes
  app.post('/api/projects/:id/clips/plan', async (req, reply) =>
    reply.code(202).send(
      await studio.clips.planClip(
        actor(),
        pid(req),
        parse(z.object({ sceneId: z.string(), generate: z.boolean().optional() }), req.body).sceneId,
        {
          thenGenerate: parse(z.object({ generate: z.boolean().optional() }).passthrough(), req.body)
            .generate,
        },
      ),
    ),
  );
  app.post('/api/projects/:id/clips/:clipId/generate', async (req, reply) =>
    reply.code(202).send(await studio.clips.generateClip(actor(), pid(req), p(req, 'clipId'))),
  );
  app.patch('/api/projects/:id/clips/:clipId/shots/:shotId', async (req) =>
    studio.clips.updateShot(
      actor(),
      pid(req),
      p(req, 'clipId'),
      p(req, 'shotId'),
      parse(ShotUpdateInputSchema, req.body),
    ),
  );
  app.post('/api/projects/:id/clips/:clipId/shots/:shotId/regenerate', async (req, reply) =>
    reply
      .code(202)
      .send(await studio.clips.regenerateShot(actor(), pid(req), p(req, 'clipId'), p(req, 'shotId'))),
  );
  app.post('/api/projects/:id/clips/:clipId/shots/:shotId/takes/:takeId/select', async (req) =>
    studio.clips.selectTake(actor(), pid(req), p(req, 'clipId'), p(req, 'shotId'), p(req, 'takeId')),
  );
  app.post('/api/projects/:id/clips/:clipId/shots/:shotId/takes/:takeId/override', async (req) =>
    studio.clips.overrideTake(
      actor(),
      pid(req),
      p(req, 'clipId'),
      p(req, 'shotId'),
      p(req, 'takeId'),
      parse(OverrideInputSchema, req.body).reason,
    ),
  );
  app.post('/api/projects/:id/clips/:clipId/approve', async (req) =>
    studio.clips.approveClip(actor(), pid(req), p(req, 'clipId')),
  );
  app.post('/api/projects/:id/clips/:clipId/unapprove', async (req) =>
    studio.clips.unapproveClip(actor(), pid(req), p(req, 'clipId')),
  );
  app.post('/api/projects/:id/batch', async (req, reply) =>
    reply
      .code(202)
      .send(
        await studio.clips.startBatch(
          actor(),
          pid(req),
          parse(z.object({ maxGenerations: z.number().int().min(1).optional() }), req.body),
        ),
      ),
  );
  app.delete('/api/projects/:id/batch', async (req) => studio.clips.pauseBatch(actor(), pid(req)));

  // Timeline, analysis, export
  app.get('/api/projects/:id/timeline', async (req) => studio.edit.timeline(pid(req)));
  app.post('/api/projects/:id/timeline/ops', async (req) =>
    studio.edit.applyOps(actor(), pid(req), parse(TimelineOpsInputSchema, req.body).ops, coalesceHeader(req)),
  );
  app.post('/api/projects/:id/timeline/assemble', async (req) =>
    studio.edit.assemble(actor(), pid(req), parse(AssembleInputSchema, req.body)),
  );
  app.post('/api/projects/:id/analyses', async (req, reply) =>
    reply
      .code(202)
      .send(
        await studio.edit.analyze(
          actor(),
          pid(req),
          parse(z.object({ resourceId: z.string() }), req.body).resourceId,
        ),
      ),
  );
  app.patch('/api/projects/:id/analyses/:aid/suggestions', async (req) =>
    studio.edit.reviewSuggestions(
      actor(),
      pid(req),
      p(req, 'aid'),
      parse(SuggestionDecisionsInputSchema, req.body).decisions,
    ),
  );
  app.post('/api/projects/:id/analyses/:aid/auto-edit', async (req) =>
    studio.edit.autoEdit(actor(), pid(req), p(req, 'aid')),
  );
  app.post('/api/projects/:id/exports', async (req, reply) =>
    reply
      .code(202)
      .send(await studio.edit.createExport(actor(), pid(req), parse(ExportInputSchema, req.body ?? {}))),
  );
  app.get('/api/projects/:id/exports', async (req) => studio.edit.exports(pid(req)));

  // Editor jobs (docs/design/editor.md#editor-jobs)
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
  const jobId = (req: FastifyRequest) =>
    parse(z.object({ jobId: z.string().regex(/^job_[0-9a-z]+$/) }), req.params).jobId;
  app.post('/api/editor/claim', async (req) => {
    const body = parse(z.object({ projectId: z.string() }).passthrough(), req.body);
    return { job: await studio.editor.claim(body.projectId, body) };
  });
  app.get('/api/editor/jobs/:jobId', async (req) => studio.editor.job(jobId(req)));
  app.post('/api/editor/jobs/:jobId/heartbeat', async (req) => studio.editor.heartbeat(jobId(req), req.body));
  app.put(
    '/api/editor/jobs/:jobId/files/:name',
    { bodyLimit: studio.config.editor.fileMaxBytes },
    async (req) => {
      const q = parse(z.object({ sessionId: z.string().min(1).max(100) }), req.query);
      const body = req.body as NodeJS.ReadableStream | undefined;
      if (!body || typeof (body as { pipe?: unknown }).pipe !== 'function')
        throw invalid('send the file as application/octet-stream');
      return studio.editor.stageFile(jobId(req), q.sessionId, p<string>(req, 'name'), body);
    },
  );
  app.post('/api/editor/jobs/:jobId/complete', async (req) => studio.editor.complete(jobId(req), req.body));
  app.post('/api/editor/jobs/:jobId/fail', async (req) => studio.editor.fail(jobId(req), req.body));

  // History
  app.get('/api/projects/:id/history', async (req) => {
    const q = parse(
      z.object({
        path: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        before: z.string().optional(),
        branch: z.string().optional(),
      }),
      req.query,
    );
    return studio.history.log(pid(req), q);
  });
  app.get('/api/projects/:id/history/diff', async (req) => {
    const q = parse(z.object({ from: z.string().optional(), to: z.string() }), req.query);
    return studio.history.diff(pid(req), q.from ?? null, q.to);
  });
  app.get('/api/projects/:id/history/:commit', async (req) =>
    studio.history.show(pid(req), p(req, 'commit')),
  );
  app.post('/api/projects/:id/history/restore', async (req) => {
    const b = parse(RestoreInputSchema, req.body);
    return studio.history.restore(actor(), pid(req), b.commit, b.paths);
  });
  app.get('/api/projects/:id/branches', async (req) => studio.history.branches(pid(req)));
  app.post('/api/projects/:id/branches', async (req, reply) => {
    const b = parse(z.object({ name: z.string(), from: z.string().optional() }), req.body);
    return reply.code(201).send(await studio.history.createBranch(actor(), pid(req), b.name, b.from));
  });
  app.post('/api/projects/:id/branches/:name/switch', async (req) =>
    studio.history.switchBranch(actor(), pid(req), p(req, 'name')),
  );
  app.delete('/api/projects/:id/branches/:name', async (req, reply) => {
    await studio.history.deleteBranch(actor(), pid(req), p(req, 'name'));
    return reply.code(204).send();
  });
  app.get('/api/projects/:id/tags', async (req) => studio.history.tags(pid(req)));
  app.post('/api/projects/:id/tags', async (req, reply) => {
    const b = parse(
      z.object({ name: z.string(), commit: z.string().optional(), message: z.string().max(500).optional() }),
      req.body,
    );
    return reply
      .code(201)
      .send(await studio.history.createTag(actor(), pid(req), b.name, b.commit, b.message));
  });

  // Jobs
  app.get('/api/projects/:id/jobs', async (req) => {
    const q = parse(z.object({ status: JobStatusSchema.optional() }), req.query);
    await studio.deps.projects.existing(pid(req));
    return studio.deps.jobs.list(pid(req), q);
  });
  app.get('/api/projects/:id/jobs/:jobId', async (req) => studio.deps.jobs.get(pid(req), p(req, 'jobId')));
  app.post('/api/projects/:id/jobs/:jobId/cancel', async (req) =>
    studio.deps.jobs.cancel(pid(req), p(req, 'jobId')),
  );

  // Watermark
  app.post('/api/watermark/detect', async (req) => {
    if (req.isMultipart()) {
      const { file } = await receiveUpload(studio, req);
      if (!file) throw invalid('multipart field "file" is required');
      try {
        return await studio.detectWatermark(file.path);
      } finally {
        await rm(file.path, { force: true });
      }
    }
    const b = parse(
      z.union([z.object({ uri: z.string() }), z.object({ projectId: z.string(), mediaPath: z.string() })]),
      req.body,
    );
    if ('uri' in b) {
      const tmp = studio.deps.media.tmp('mp4');
      try {
        await studio.deps.media.downloadTo(b.uri, tmp);
        return await studio.detectWatermark(tmp);
      } finally {
        await rm(tmp, { force: true });
      }
    }
    const res = await studio.deps.media.stream(b.projectId, b.mediaPath);
    if (!res) throw new AppError('not_found', 'media not found');
    const tmp = studio.deps.media.tmp(extname(b.mediaPath).slice(1) || 'mp4');
    try {
      await pipeline(res.stream, createWriteStream(tmp));
      return await studio.detectWatermark(tmp);
    } finally {
      await rm(tmp, { force: true });
    }
  });
  app.get('/api/watermark/:wmId', async (req) => {
    const rec = await studio.deps.watermark.lookup(p(req, 'wmId'));
    if (!rec) throw new AppError('not_found', 'watermark not registered');
    return rec;
  });
}
