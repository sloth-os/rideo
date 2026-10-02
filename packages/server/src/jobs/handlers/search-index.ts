import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  entryId,
  isStillMedia,
  planIndex,
  type SearchEntry,
  type SearchTarget,
  searchNames,
  searchTargets,
} from '@rideo/shared';
import { toAppError } from '../../errors';
import { extractFrameNear } from '../../media/frames';
import type { JobContext } from '../queue';
import type { HandlerDeps } from './common';

/** Frames captioned at once. */
const CONCURRENCY = 3;
/** Captions between saves of the index: a retried or interrupted run resumes from the last save. */
const SAVE_EVERY = 6;
/** Runs over the project when frames arrive while one runs. */
const MAX_ROUNDS = 3;
/** The width frames are captioned at. */
const FRAME_WIDTH = 512;

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

/**
 * `search.index` (docs/design/search.md#indexing): drops frames whose source left the project, copies captions of
 * frames another source already has, samples and captions the rest with the vision model, then embeds new captions
 * when an embeddings model is configured.
 */
export async function searchIndex(deps: HandlerDeps, ctx: JobContext) {
  const projectId = ctx.job.projectId;
  const search = deps.services.search;
  const log = deps.log.child({ projectId, jobId: ctx.job.id, component: 'search' });
  const totals = { captioned: 0, copied: 0, failed: 0, dropped: 0, embedded: 0 };
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const docs = await deps.projects.docs(projectId);
    const targets = searchTargets(docs);
    const { todo, copied } = await search.update(projectId, (index) => {
      const plan = planIndex(index, targets);
      const keys = new Set(targets.map((t) => t.key));
      index.entries = [...plan.keep, ...plan.copied];
      index.failed = index.failed.filter((k) => keys.has(k));
      if (plan.copied.length || plan.dropped) index.updatedAt = new Date().toISOString();
      totals.dropped += plan.dropped;
      return { todo: plan.todo, copied: plan.copied.length };
    });
    totals.copied += copied;
    if (copied) deps.metrics.searchFrames.inc({ outcome: 'copied' }, copied);
    if (todo.length) await caption(deps, ctx, todo, searchNames(docs), totals);
    await embed(deps, ctx, totals);
    if (!todo.length) break;
  }
  log.info(totals, 'search index updated');
  return totals;
}

async function caption(
  deps: HandlerDeps,
  ctx: JobContext,
  todo: SearchTarget[],
  cast: string[],
  totals: { captioned: number; failed: number },
): Promise<void> {
  const projectId = ctx.job.projectId;
  const search = deps.services.search;
  // One caption per frame, for every source showing it
  const frames = new Map<string, SearchTarget[]>();
  for (const t of todo) frames.set(t.key, [...(frames.get(t.key) ?? []), t]);
  const byFile = new Map<string, string[]>();
  for (const [key, ts] of frames)
    byFile.set(ts[0]!.media.hash, [...(byFile.get(ts[0]!.media.hash) ?? []), key]);
  const total = frames.size;
  let done = 0;
  const added: SearchEntry[] = [];
  const failed: string[] = [];
  const save = async () => {
    if (!added.length && !failed.length) return;
    const entries = added.splice(0);
    const bad = failed.splice(0);
    await search.update(projectId, (index) => {
      const have = new Set(index.entries.map(entryId));
      index.entries.push(...entries.filter((e) => !have.has(entryId(e))));
      index.failed = [...new Set([...index.failed, ...bad])];
      index.updatedAt = new Date().toISOString();
    });
  };
  const fail = (keys: string[], err: unknown) => {
    failed.push(...keys);
    totals.failed += keys.length;
    done += keys.length;
    deps.metrics.searchFrames.inc({ outcome: 'failed' }, keys.length);
    deps.log.warn(
      { projectId, jobId: ctx.job.id, frames: keys.length, err: toAppError(err).message },
      'search: frames not captioned',
    );
  };
  ctx.progress(0, total, `captioning ${total} frame${total === 1 ? '' : 's'}`);
  await deps.media.withTmpDir(async (dir) => {
    for (const [hash, keys] of byFile) {
      ctx.signal.throwIfAborted();
      const media = frames.get(keys[0]!)![0]!.media;
      // Sample the file's frames
      const images = new Map<string, Buffer>();
      try {
        const local = await deps.media.localPath(projectId, media);
        for (const key of keys) {
          const { at } = frames.get(key)![0]!;
          const out = join(dir, `${hash.slice(0, 16)}-${at}.png`);
          if (isStillMedia(media))
            await deps.ff.run(
              ['-i', local, '-frames:v', '1', '-vf', `scale='min(${FRAME_WIDTH},iw)':-2`, out],
              {
                signal: ctx.signal,
              },
            );
          else await extractFrameNear(deps.ff, local, at, out, FRAME_WIDTH, ctx.signal);
          images.set(key, await readFile(out));
        }
      } catch (err) {
        if (toAppError(err).code === 'cancelled') throw err;
        fail(keys, err);
        continue;
      }
      await pool(keys, CONCURRENCY, async (key) => {
        const ts = frames.get(key)!;
        const t = ts[0]!;
        try {
          const { caption } = await deps.llm.captionFrame(
            { kind: t.kind, known: t.known, cast },
            images.get(key)!,
            ctx.signal,
          );
          for (const s of ts)
            added.push({
              key,
              source: s.source,
              media: s.media,
              at: s.at,
              caption,
              names: s.names,
              vector: null,
            });
          totals.captioned++;
          done++;
          deps.metrics.searchFrames.inc({ outcome: 'captioned' });
        } catch (err) {
          const e = toAppError(err);
          // Cancelled, or the provider is busy or down: the job stops (and retries); what is saved stays
          if (e.code === 'cancelled' || (e.retryable && e.code !== 'llm_invalid_output')) throw err;
          fail([key], err);
        }
        ctx.progress(done, total, `captioned ${done} of ${total} frames`);
        if (added.length >= SAVE_EVERY) await save();
      }).finally(save);
    }
  });
}

/** Embeds captions without a vector (all of them when the configured model changed). */
async function embed(deps: HandlerDeps, ctx: JobContext, totals: { embedded: number }): Promise<void> {
  const emb = deps.embeddings;
  if (!emb) return;
  const search = deps.services.search;
  const projectId = ctx.job.projectId;
  const need = await search.update(projectId, (index) => {
    if (index.embeddingModel !== emb.model) {
      for (const e of index.entries) e.vector = null;
      index.embeddingModel = emb.model;
    }
    return [...new Set(index.entries.filter((e) => !e.vector).map((e) => e.caption))];
  });
  if (!need.length) return;
  ctx.progress(1, 1, `embedding ${need.length} caption${need.length === 1 ? '' : 's'}`);
  const vectors = await emb.embed(need, ctx.signal);
  const byCaption = new Map(need.map((c, i) => [c, vectors[i]!]));
  await search.update(projectId, (index) => {
    if (index.embeddingModel !== emb.model) return;
    for (const e of index.entries) if (!e.vector) e.vector = byCaption.get(e.caption) ?? null;
    index.updatedAt = new Date().toISOString();
  });
  totals.embedded += need.length;
}
