import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type Actor,
  isTerminalJob,
  type Job,
  planIndex,
  rankEntries,
  type SearchIndex,
  SearchIndexSchema,
  type SearchMode,
  type SearchQuery,
  type SearchResponse,
  type SearchStatus,
  SYSTEM_ACTOR,
  searchLabel,
  searchNames,
  searchTargets,
} from '@rideo/shared';
import { Service } from './base';

/** Documents whose changes can bring frames to index (docs/design/search.md#indexing). */
const INDEXED_DOCS = /^(clips|resources|characters|elements)\//;
/** Commits settle this long before an automatic index run. */
export const AUTO_INDEX_DELAY_MS = 3000;
/** How often a search records that the project's search is in use. */
const USED_EVERY_MS = 60_000;
/** Query embeddings remembered, and project indexes kept in memory. */
const QUERY_CACHE = 200;
const INDEX_CACHE = 20;

const encodeVector = (v: readonly number[]) => Buffer.from(new Float32Array(v).buffer).toString('base64');
function decodeVector(s: string): number[] {
  const b = Buffer.from(s, 'base64');
  return Array.from({ length: b.byteLength >> 2 }, (_, i) => b.readFloatLE(i * 4));
}

/**
 * Semantic media search (docs/design/search.md): a derived index of captioned frames per project on the server's
 * data dir, searched by meaning (embeddings) or by words; the `search.index` job fills it.
 */
export class SearchService extends Service {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly cache = new Map<string, SearchIndex>();
  private readonly queries = new Map<string, number[]>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  /** `semantic` when an embeddings model is configured. */
  get mode(): SearchMode {
    return this.deps.embeddings ? 'semantic' : 'words';
  }

  private file(projectId: string): string {
    return join(this.deps.config.dataDir, 'search', `${projectId}.json`);
  }

  /** The project's index (empty when there is none or it cannot be read). Callers must not change it. */
  async load(projectId: string): Promise<SearchIndex> {
    const hit = this.cache.get(projectId);
    if (hit) return hit;
    let index: SearchIndex;
    try {
      const raw = JSON.parse(await readFile(this.file(projectId), 'utf8'));
      for (const e of raw.entries ?? []) if (typeof e.vector === 'string') e.vector = decodeVector(e.vector);
      index = SearchIndexSchema.parse(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        this.deps.log.warn({ err, projectId }, 'search index unreadable: it is rebuilt');
      index = SearchIndexSchema.parse({ version: 1, projectId });
    }
    this.remember(projectId, index);
    return index;
  }

  private remember(projectId: string, index: SearchIndex): void {
    this.cache.delete(projectId);
    this.cache.set(projectId, index);
    if (this.cache.size > INDEX_CACHE) this.cache.delete(this.cache.keys().next().value!);
  }

  /** Changes a project's index, one change at a time; written atomically. */
  async update<R>(projectId: string, fn: (index: SearchIndex) => R | Promise<R>): Promise<R> {
    const prev = this.locks.get(projectId) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(async () => {
        const index = structuredClone(await this.load(projectId));
        const result = await fn(index);
        const path = this.file(projectId);
        await mkdir(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        await writeFile(
          tmp,
          JSON.stringify({
            ...index,
            entries: index.entries.map((e) => ({ ...e, vector: e.vector ? encodeVector(e.vector) : null })),
          }),
        );
        await rename(tmp, path);
        this.remember(projectId, index);
        return result;
      });
    this.locks.set(projectId, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(projectId) === run) this.locks.delete(projectId);
    }
  }

  private job(projectId: string): Job | null {
    return this.deps.jobs.list(projectId, { kind: 'search.index' }).find((j) => !isTerminalJob(j)) ?? null;
  }

  async status(projectId: string): Promise<SearchStatus> {
    const [docs, index] = await Promise.all([this.deps.projects.docs(projectId), this.load(projectId)]);
    const targets = searchTargets(docs);
    const plan = planIndex(index, targets);
    const keys = new Set(targets.map((t) => t.key));
    return {
      mode: this.mode,
      indexed: plan.keep.length,
      pending: plan.todo.length + plan.copied.length,
      failed: index.failed.filter((k) => keys.has(k)).length,
      files: new Set(plan.keep.map((e) => e.media.hash)).size,
      updatedAt: index.updatedAt,
      usedAt: index.usedAt,
      job: this.job(projectId),
    };
  }

  /** Starts indexing what is new (one index job per project at a time). */
  async index(actor: Actor, projectId: string): Promise<Job> {
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'search.index',
      params: {},
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: 'search.index',
    });
  }

  async search(projectId: string, query: SearchQuery, signal?: AbortSignal): Promise<SearchResponse> {
    const [docs, index] = await Promise.all([this.deps.projects.docs(projectId), this.load(projectId)]);
    const plan = planIndex(index, searchTargets(docs));
    const vector = await this.queryVector(projectId, index, query.q, signal);
    const mode: SearchMode = vector ? 'semantic' : 'words';
    const ranked = rankEntries(plan.keep, query.q, {
      names: searchNames(docs),
      vector,
      kinds: query.kinds,
      limit: query.limit,
    });
    this.deps.metrics.searches.inc({ mode });
    if (!index.usedAt || Date.now() - Date.parse(index.usedAt) > USED_EVERY_MS)
      await this.update(projectId, (i) => {
        i.usedAt = new Date().toISOString();
      });
    return {
      query: query.q,
      mode,
      results: ranked.map(({ entry, score }) => ({
        source: entry.source,
        media: entry.media,
        at: entry.at,
        caption: entry.caption,
        names: entry.names,
        score,
        label: searchLabel(docs, entry.source),
      })),
      indexed: plan.keep.length,
      pending: plan.todo.length + plan.copied.length,
    };
  }

  /** The query's embedding, when the index is embedded by the configured model; words otherwise. */
  private async queryVector(
    projectId: string,
    index: SearchIndex,
    q: string,
    signal?: AbortSignal,
  ): Promise<number[] | null> {
    const emb = this.deps.embeddings;
    if (!emb || index.embeddingModel !== emb.model || !index.entries.some((e) => e.vector)) return null;
    const key = `${emb.model}\n${q.trim().toLowerCase()}`;
    const hit = this.queries.get(key);
    if (hit) {
      this.queries.delete(key);
      this.queries.set(key, hit);
      return hit;
    }
    try {
      const [v] = await emb.embed([q], signal);
      this.queries.set(key, v!);
      if (this.queries.size > QUERY_CACHE) this.queries.delete(this.queries.keys().next().value!);
      return v!;
    } catch (err) {
      // The embeddings model is down: search by words, and say so in the response
      this.deps.log.warn({ err, projectId }, 'query embedding failed: searching by words');
      return null;
    }
  }

  /**
   * A commit on the checked-out branch (docs/design/search.md#indexing): when the project's search is in use and it
   * brought frames to index, an index run starts once commits settle.
   */
  committed(projectId: string, docs: Record<string, unknown>): void {
    if (!Object.keys(docs).some((p) => INDEXED_DOCS.test(p))) return;
    clearTimeout(this.timers.get(projectId));
    const timer = setTimeout(() => {
      this.timers.delete(projectId);
      this.autoIndex(projectId).catch((err) =>
        this.deps.log.warn({ err, projectId }, 'automatic search indexing failed'),
      );
    }, AUTO_INDEX_DELAY_MS);
    timer.unref();
    this.timers.set(projectId, timer);
  }

  private async autoIndex(projectId: string): Promise<void> {
    const index = await this.load(projectId);
    if (!index.usedAt) return;
    const plan = planIndex(index, searchTargets(await this.deps.projects.docs(projectId)));
    if (!plan.todo.length && !plan.copied.length && !plan.dropped) return;
    const job = await this.index(SYSTEM_ACTOR, projectId);
    this.deps.log.info(
      { projectId, jobId: job.id, frames: plan.todo.length },
      'search: indexing new frames on its own',
    );
  }

  close(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
