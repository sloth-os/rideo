import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  LIBRARY_LIMITS,
  LibraryApplyInputSchema,
  LibraryDetachInputSchema,
  LibraryItemIdSchema,
  LibraryItemPatchSchema,
  LibraryListQuerySchema,
  LibrarySaveInputSchema,
  type LibraryUploadMeta,
  LibraryUploadMetaSchema,
  libraryEtag,
  Sha256HexSchema,
} from '@rideo/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LibraryConflictError, type LibraryUploadFiles, uploadPayloadLimit } from '../domain/library';
import type { Studio } from '../domain/studio';
import { type AppError, invalid, tooLarge } from '../errors';

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => schema.parse(value ?? {});
const ItemParam = z.object({ itemId: LibraryItemIdSchema });
const VersionParam = ItemParam.extend({ version: z.coerce.number().int().min(1).max(1000) });
const FileParam = VersionParam.extend({ sha256: Sha256HexSchema });
const ProjectParam = z.object({ id: z.string().regex(/^prj_[0-9a-z]{10,32}$/) });

/**
 * Writes a part to a file, counting its bytes: past `limit` nothing more is written and the rest of the part is read
 * and thrown away (the request is read to its end, so the refusal reaches the client). -1 when it was over the limit.
 * A client that goes away in the middle of the part ends it early: the promise rejects (premature close).
 */
export async function writeCounted(file: Readable, path: string, limit: number): Promise<number> {
  let size = 0;
  const count = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      done(null, size > limit ? undefined : chunk);
    },
  });
  await pipeline(file, count, createWriteStream(path));
  return size > limit ? -1 : size;
}

/**
 * The multipart parts of a library upload (docs/design/library.md#surfaces): `meta` first (JSON, at most 32 KiB),
 * then the file `payload` (its kind's limit), then an optional `thumbnail` (at most 64 KiB), each counted as it streams
 * to a temporary file. Out of order or bad `meta`: 422; a part over its limit: 413. The files are the caller's to
 * remove; a refusal removes them.
 */
export async function receiveLibraryUpload(
  req: FastifyRequest,
  tmp: (ext: string) => string,
  refused: (kind: string, reason: string, err: AppError) => AppError,
): Promise<LibraryUploadFiles> {
  if (!req.isMultipart())
    throw refused(
      'unknown',
      'order',
      invalid('send the upload as multipart form data: meta, then payload, then thumbnail', [
        { reason: 'order' },
      ]),
    );
  const files: string[] = [];
  let meta: LibraryUploadMeta | null = null;
  let payload: LibraryUploadFiles['payload'] | null = null;
  let thumbnail: LibraryUploadFiles['thumbnail'] = null;
  let refusal: { reason: string; err: AppError } | null = null;
  const refuse = (reason: string, err: AppError) => {
    refusal ??= { reason, err };
  };
  const order = () =>
    invalid('send the parts in this order: meta, payload, thumbnail', [{ reason: 'order' }]);
  try {
    for await (const part of req.parts()) {
      if (refusal) {
        if (part.type === 'file') part.file.resume();
        continue;
      }
      if (part.type === 'field') {
        if (part.fieldname !== 'meta' || meta) {
          refuse('order', order());
          continue;
        }
        const text = String(part.value);
        if (Buffer.byteLength(text) > LIBRARY_LIMITS.uploadMetaBytes) {
          refuse('meta', tooLarge('the part meta is at most 32 KiB'));
          continue;
        }
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          refuse('meta', invalid('the part meta is not JSON', [{ reason: 'meta' }]));
          continue;
        }
        const parsed = LibraryUploadMetaSchema.safeParse(json);
        if (!parsed.success) {
          refuse(
            'meta',
            invalid(
              'the part meta does not validate',
              parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
            ),
          );
          continue;
        }
        meta = parsed.data;
        continue;
      }
      const field = part.fieldname;
      const fits =
        !!meta && ((field === 'payload' && !payload) || (field === 'thumbnail' && !!payload && !thumbnail));
      if (!fits || !meta) {
        part.file.resume();
        refuse('order', order());
        continue;
      }
      const limit = field === 'payload' ? uploadPayloadLimit(meta) : LIBRARY_LIMITS.thumbnailBytes;
      const path = tmp(field === 'payload' ? 'bin' : 'png');
      files.push(path);
      const size = await writeCounted(part.file, path, limit);
      if (size < 0) {
        refuse(
          field === 'payload' ? 'size' : 'thumbnail',
          tooLarge(
            field === 'payload'
              ? `the payload is over its limit of ${limit} bytes`
              : 'a thumbnail is at most 64 KiB',
          ),
        );
        continue;
      }
      if (field === 'payload')
        payload = { path, size, filename: part.filename, mime: part.mimetype || 'application/octet-stream' };
      else thumbnail = { path, size, mime: part.mimetype || 'application/octet-stream' };
    }
  } catch (err) {
    await Promise.all(files.map((f) => rm(f, { force: true })));
    throw err;
  }
  if (!refusal && !meta) refuse('order', order());
  if (!refusal && !payload) refuse('order', invalid('the file payload is missing', [{ reason: 'order' }]));
  if (refusal) {
    await Promise.all(files.map((f) => rm(f, { force: true })));
    const { reason, err } = refusal as { reason: string; err: AppError };
    throw refused(meta?.kind ?? 'unknown', reason, err);
  }
  return { meta: meta!, payload: payload!, thumbnail };
}

const removeUpload = (u: LibraryUploadFiles) =>
  Promise.all([u.payload.path, u.thumbnail?.path].filter(Boolean).map((p) => rm(p!, { force: true })));

const ifMatchOf = (req: FastifyRequest) => {
  const v = req.headers['if-match'];
  return typeof v === 'string' && v.trim() ? v : undefined;
};

/** `bytes=a-b`, `bytes=a-` or `bytes=-n` of a file of `size` bytes; null for none, 'unsatisfiable' past its end. */
export function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | 'unsatisfiable' {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

/** A version's file: immutable, `ETag` its sha256, `304` on `If-None-Match`, `Range` (docs/design/library.md#surfaces). */
async function sendLibraryFile(studio: Studio, req: FastifyRequest, reply: FastifyReply) {
  const { itemId, version, sha256 } = parse(FileParam, req.params);
  const info = await studio.library.fileInfo(itemId, version, sha256);
  const etag = `"${sha256}"`;
  reply
    .header('etag', etag)
    .header('cache-control', 'private, max-age=31536000, immutable')
    .header('accept-ranges', 'bytes')
    .type(info.mime);
  const inm = req.headers['if-none-match'];
  if (
    typeof inm === 'string' &&
    inm.split(',').some((t) => t.trim() === '*' || t.trim().replace(/^W\//, '') === etag)
  )
    return reply.code(304).send();
  const range = byteRange(req.headers.range, info.size);
  if (range === 'unsatisfiable')
    return reply.code(416).header('content-range', `bytes */${info.size}`).send();
  const start = range?.start ?? 0;
  const end = range?.end ?? info.size - 1;
  reply.header('content-length', end - start + 1);
  if (range) reply.code(206).header('content-range', `bytes ${start}-${end}/${info.size}`);
  // HEAD: the headers only; an empty stream keeps the content-length set above (an empty body would reset it to 0)
  if (req.method === 'HEAD') return reply.send(Readable.from([]));
  const res = await studio.library.file(itemId, version, sha256, range ?? undefined);
  return reply.send(res.stream);
}

/** The studio library (docs/design/library.md#surfaces; docs/api/rest.md#library). */
export function registerLibraryRoutes(app: FastifyInstance, studio: Studio): void {
  const actor = () => studio.userActor();
  const item = (req: FastifyRequest) => parse(ItemParam, req.params).itemId;
  const project = (req: FastifyRequest) => parse(ProjectParam, req.params).id;
  const receive = (req: FastifyRequest) =>
    receiveLibraryUpload(
      req,
      (ext) => studio.deps.media.tmp(ext),
      (kind, reason, err) => studio.library.refused(kind, reason, err),
    );
  /** A 412 names the head's current ETag. */
  const conflicts = async <T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof LibraryConflictError) reply.header('etag', err.etag);
      throw err;
    }
  };

  app.get('/api/library/items', async (req) => studio.library.list(parse(LibraryListQuerySchema, req.query)));
  app.post('/api/library/items', async (req, reply) => {
    const upload = await receive(req);
    try {
      const out = await studio.library.create(actor(), upload);
      return reply.code(201).header('etag', libraryEtag(out.item)).send(out);
    } finally {
      await removeUpload(upload);
    }
  });
  app.get('/api/library/items/:itemId', async (req, reply) => {
    const out = await studio.library.get(item(req));
    reply.header('etag', libraryEtag(out));
    return out;
  });
  app.patch('/api/library/items/:itemId', async (req, reply) => {
    const out = await conflicts(reply, () =>
      studio.library.update(actor(), item(req), parse(LibraryItemPatchSchema, req.body), ifMatchOf(req)),
    );
    reply.header('etag', libraryEtag(out));
    return out;
  });
  app.post('/api/library/items/:itemId/versions', async (req, reply) => {
    const id = item(req);
    const upload = await receive(req);
    try {
      const out = await conflicts(reply, () =>
        studio.library.addVersion(actor(), id, upload, ifMatchOf(req)),
      );
      return reply
        .code(out.unchanged ? 200 : 201)
        .header('etag', libraryEtag(out.item))
        .send(out);
    } finally {
      await removeUpload(upload);
    }
  });
  app.get('/api/library/items/:itemId/versions/:version', async (req, reply) => {
    const { itemId, version } = parse(VersionParam, req.params);
    const out = await studio.library.version(itemId, version);
    reply.header('etag', `"${out.digest}"`).header('cache-control', 'private, max-age=31536000, immutable');
    return out;
  });
  app.get('/api/library/items/:itemId/versions/:version/files/:sha256', async (req, reply) =>
    sendLibraryFile(studio, req, reply),
  );
  app.get('/api/library/items/:itemId/uses', async (req) => studio.library.uses(item(req)));

  // A project's library (project permissions from the route table: read for the status, edit for the rest)
  app.get('/api/projects/:id/library', async (req) => studio.library.status(project(req)));
  app.post('/api/projects/:id/library/save', async (req, reply) => {
    const id = project(req);
    const out = await conflicts(reply, () =>
      studio.library.save(actor(), id, parse(LibrarySaveInputSchema, req.body)),
    );
    return reply.code(out.unchanged ? 200 : 201).send(out);
  });
  app.post('/api/projects/:id/library/apply', async (req) =>
    studio.library.apply(actor(), project(req), parse(LibraryApplyInputSchema, req.body)),
  );
  app.post('/api/projects/:id/library/detach', async (req) =>
    studio.library.detach(actor(), project(req), parse(LibraryDetachInputSchema, req.body)),
  );
}
