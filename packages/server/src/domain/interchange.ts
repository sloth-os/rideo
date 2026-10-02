import {
  type Actor,
  type CommitSummary,
  docPath,
  emptyTimeline,
  exportCut,
  fromOtio,
  INTERCHANGE_FORMATS,
  type InterchangeContext,
  type InterchangeFormat,
  interchangeFileName,
  normalizeMediaBase,
  type OtioClipRef,
  type ProjectDocs,
  type Source,
  SourceSchema,
  sortedClips,
  type Timeline,
} from '@rideo/shared';
import { ZodError } from 'zod';
import { conflict, invalid } from '../errors';
import { DAV_PREFIX } from '../storage/embedded-dav';
import { Service } from './base';

/** Every media file of a project and the source it plays as (a take where it is one). */
function mediaIndex(docs: ProjectDocs): { byPath: Map<string, Source>; byName: Map<string, Source> } {
  const byPath = new Map<string, Source>();
  const add = (s: Source) => {
    if (!byPath.has(s.media.path)) byPath.set(s.media.path, s);
  };
  for (const clip of sortedClips(docs))
    for (const shot of clip.shots)
      for (const take of shot.takes)
        if (take.video)
          add({ type: 'take', clipId: clip.id, shotId: shot.id, takeId: take.id, media: take.video });
  for (const r of Object.values(docs.resources)) add({ type: 'media', media: r.media, resourceId: r.id });
  for (const t of [docs.timeline, docs.animatic])
    for (const track of t?.tracks ?? [])
      for (const item of track.items) if (item.kind !== 'text') add(item.source);
  const byName = new Map<string, Source>();
  for (const [path, s] of byPath) {
    const name = path.split('/').at(-1)!;
    if (!byName.has(name)) byName.set(name, s);
  }
  return { byPath, byName };
}

/**
 * NLE interchange (docs/design/interchange.md): the cut as OTIO, FCPXML, FCP7 XML or EDL with its media on WebDAV,
 * and a cut back from OTIO. REST and MCP share it.
 */
export class InterchangeService extends Service {
  /** The WebDAV root as clients reach it: the external server, or the embedded `/dav`. */
  defaultMediaBase(): string {
    const { webdav, publicUrl } = this.deps.config;
    return webdav.url
      ? `${webdav.url.replace(/\/+$/, '')}${webdav.root}`
      : `${publicUrl}${DAV_PREFIX}${webdav.root}`;
  }

  async export(
    projectId: string,
    format: InterchangeFormat,
    opts: { mediaBase?: string | null; source?: 'timeline' | 'animatic' } = {},
  ): Promise<{ filename: string; mime: string; content: string }> {
    const docs = await this.deps.projects.docs(projectId);
    const t = opts.source === 'animatic' ? docs.animatic : docs.timeline;
    if (!t || t.tracks.every((tr) => tr.items.length === 0))
      throw conflict(
        opts.source === 'animatic' ? 'There is no animatic to hand off yet' : 'The cut is empty',
      );
    const base = normalizeMediaBase(opts.mediaBase?.trim() || this.defaultMediaBase());
    const ctx: InterchangeContext = {
      title: docs.project.title,
      mediaUrl: (m) => `${base}/projects/${projectId}/${m.path}`,
      // Open notes on the take an item plays travel as markers ([review](review.md)).
      notes: (item) =>
        item.source.type === 'take'
          ? Object.values(docs.comments)
              .filter(
                (c) =>
                  c.status === 'open' &&
                  c.at !== null &&
                  c.target.kind === 'take' &&
                  item.source.type === 'take' &&
                  c.target.takeId === item.source.takeId,
              )
              .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
              .map((c) => ({ at: c.at!, author: c.author.name, body: c.body }))
          : [],
    };
    const content = exportCut(format, t, ctx);
    this.deps.metrics.interchange.inc({ format, direction: 'export' });
    this.deps.log.info(
      {
        projectId,
        format,
        source: opts.source ?? 'timeline',
        items: t.tracks.reduce((n, tr) => n + tr.items.length, 0),
      },
      'cut handed off',
    );
    return {
      filename: interchangeFileName(docs.project.title, format),
      mime: INTERCHANGE_FORMATS[format].mime,
      content,
    };
  }

  /** Replaces the cut with an OTIO timeline's (one commit; history restores the previous cut). */
  async import(
    actor: Actor,
    projectId: string,
    otio: unknown,
  ): Promise<{
    clips: number;
    unresolved: { name: string; url: string | null }[];
    skipped: string[];
    commit: CommitSummary | null;
  }> {
    const docs = await this.deps.projects.docs(projectId);
    const s = docs.project.settings;
    const base: Timeline =
      docs.timeline ?? emptyTimeline({ fps: s.fps, width: s.resolution.width, height: s.resolution.height });
    const index = mediaIndex(docs);
    const resolve = (clip: OtioClipRef): Source | null => {
      // What Rideo wrote, when that media still belongs to the project
      const meta = (clip.rideo?.item as { source?: unknown } | undefined)?.source;
      const parsed = SourceSchema.safeParse(meta);
      if (parsed.success) {
        const known = index.byPath.get(parsed.data.media.path);
        if (known) return parsed.data.type === known.type ? { ...parsed.data, media: known.media } : known;
      }
      // Its URL under this project's folder, else a project file of the same name
      const url = clip.url ? safeDecode(clip.url) : null;
      const m = url ? new RegExp(`/projects/${projectId}/(media/[^?#]+)`).exec(url) : null;
      if (m && index.byPath.has(m[1]!)) return index.byPath.get(m[1]!)!;
      const name = (url ?? clip.name).split(/[\\/]/).at(-1) ?? '';
      return index.byName.get(name) ?? null;
    };
    let result: ReturnType<typeof fromOtio>;
    try {
      result = fromOtio(otio, { base, resolve });
    } catch (err) {
      if (err instanceof ZodError)
        throw invalid(
          'not an OpenTimelineIO timeline',
          err.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })),
        );
      throw err;
    }
    if (result.clips === 0) throw invalid('none of the timeline’s clips are media of this project');
    const { commit } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        tx.set(docPath.timeline(), result.timeline);
      },
      { message: `Import ${result.name ? `“${result.name}” ` : ''}from OTIO (${result.clips} clips)` },
    );
    this.deps.metrics.interchange.inc({ format: 'otio', direction: 'import' });
    this.deps.log.info(
      {
        projectId,
        clips: result.clips,
        unresolved: result.unresolved.length,
        skipped: result.skipped.length,
      },
      'cut imported from OTIO',
    );
    return { clips: result.clips, unresolved: result.unresolved, skipped: result.skipped, commit };
  }
}

function safeDecode(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}
