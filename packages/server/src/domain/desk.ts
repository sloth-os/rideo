import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { finished, type Readable } from 'node:stream';
import {
  type Actor,
  type Clip,
  type ClipDeskState,
  DESK_STATE_FORMAT,
  DESK_STATE_MAX_BYTES,
  DESK_STATE_VERSION,
  type DeskBrief,
  DeskStateUnitsError,
  type DeskStateUnitUse,
  deskBrief,
  docPath,
  parseDeskStateUnits,
} from '@rideo/shared';
import { AppError, invalid, notFound, toAppError, tooLarge } from '../errors';
import { sha256File } from '../util/crypto';
import { Service } from './base';

/** A desk state as a PUT sends it: the headers as given and the body, unread. */
export interface DeskStateUpload {
  /** `X-Desk-State-Format` and `X-Desk-State-Version`. */
  format: string | undefined;
  version: string | undefined;
  contentType: string | undefined;
  /** `Content-Length`, when the body declares it. */
  contentLength: number | undefined;
  /**
   * `If-Match` and `If-None-Match` as sent: the state the write replaces (its ETag, or `*` for none stored). Without
   * either the write replaces whatever is stored (docs/design/director-desk.md#the-routes).
   */
  ifMatch?: string | undefined;
  ifNoneMatch?: string | undefined;
  /**
   * `X-Desk-State-Replace: 1`: the person chose to replace the stored state (the panel's Replace the stored desk state).
   * The write is a commit of its own, never coalesced into the tip, so the history keeps the state it replaces.
   */
  replace?: boolean;
  /**
   * `X-Desk-State-Units`: what the state uses of the studio library, as the desk said
   * (docs/design/director-desk.md#what-a-stored-state-uses); absent when not known.
   */
  units?: string | undefined;
  body: Readable;
}

/**
 * A desk state write refused because the stored state is not the one its precondition named (`412`
 * `desk_state_conflict`): another session changed it (stored another state, or restored an older one: never called
 * newer, a restore is a conflict too) or cleared it. `stored` is the stored state's sha256, its ETag (null when the
 * clip names none), so the client can replace that one on purpose.
 */
export class DeskStateConflictError extends AppError {
  constructor(
    readonly stored: string | null,
    clip: number,
  ) {
    super(
      'desk_state_conflict',
      stored
        ? `the stored desk state of scene ${clip} is not the one this write replaces: another session changed it (the stored state's ETag is "${stored}")`
        : `scene ${clip} has no stored desk state any more: another session cleared it`,
    );
  }
}

/** The entity tags of a precondition header, trimmed (`*`, `"…"`, `W/"…"`). */
const entityTags = (header: string) =>
  header
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
const unquoted = (tag: string) => tag.replace(/^W\//, '').replace(/^"(.*)"$/, '$1');

/**
 * Whether a desk state write's precondition holds for the stored state's sha256 (null: none stored), evaluated as RFC
 * 9110 does: `If-Match` first (strong comparison, a weak tag never matches; `*` for any stored state), then
 * `If-None-Match` (`*` for none stored). A write without either holds: it replaces whatever is stored.
 */
export function deskPreconditionHolds(
  stored: string | null,
  ifMatch: string | undefined,
  ifNoneMatch: string | undefined,
): boolean {
  if (ifMatch?.trim()) {
    const tags = entityTags(ifMatch);
    if (stored === null) return false;
    if (!tags.some((t) => t === '*' || (!t.startsWith('W/') && unquoted(t) === stored))) return false;
  }
  if (ifNoneMatch?.trim() && stored !== null) {
    if (entityTags(ifNoneMatch).some((t) => t === '*' || unquoted(t) === stored)) return false;
  }
  return true;
}

/**
 * The 3D-Editor's director's desk on the server (docs/design/director-desk.md#surfaces): the brief of a clip (REST
 * `desk-brief` and the MCP tool `desk_brief`) and the desk's opaque state, stored per clip as an immutable media file
 * that `clip.deskState` names.
 */
/** The project's own clip of that id: an id such as `constructor` or `__proto__` names none (a 404, never a 500). */
function ownClip(clips: Record<string, Clip>, clipId: string): Clip {
  const clip = Object.hasOwn(clips, clipId) ? clips[clipId] : undefined;
  if (!clip) throw notFound(`clip ${clipId}`);
  return clip;
}

export class DeskService extends Service {
  private async clip(projectId: string, clipId: string): Promise<Clip> {
    return ownClip((await this.deps.projects.docs(projectId)).clips, clipId);
  }

  /** The clip's `SceneBrief` (docs/design/director-desk.md#the-brief). */
  async brief(projectId: string, clipId: string): Promise<DeskBrief> {
    const docs = await this.deps.projects.docs(projectId);
    const clip = ownClip(docs.clips, clipId);
    const brief = deskBrief(docs, clipId);
    if (!brief) throw invalid(`plan the shots of clip ${clip.index + 1} first`);
    this.deps.metrics.deskBriefs.inc();
    return brief;
  }

  /**
   * The stored state and a local, hash-checked copy of its bytes. `not_found` (404) only when the clip names no state:
   * a named state whose file cannot be read (storage answers 404 for it, fails, or the bytes fail their hash check) is
   * a retryable `storage_error` (503), so a browser never takes it for "none stored" and opens the desk without it
   * (docs/design/director-desk.md#the-routes).
   */
  async state(projectId: string, clipId: string): Promise<{ deskState: ClipDeskState; file: string }> {
    const clip = await this.clip(projectId, clipId);
    if (!clip.deskState) throw notFound(`desk state of clip ${clip.index + 1}`);
    try {
      return {
        deskState: clip.deskState,
        file: await this.deps.media.localPath(projectId, clip.deskState.media),
      };
    } catch (err) {
      const cause = toAppError(err);
      this.deps.log.warn(
        { projectId, clipId, path: clip.deskState.media.path, error: cause.message },
        'desk state unreadable',
      );
      throw new AppError(
        'storage_error',
        `the stored desk state of scene ${clip.index + 1} could not be read: ${cause.message}`,
        [],
        true,
      );
    }
  }

  /**
   * Stores a state as it is given (docs/design/director-desk.md#the-desk-state): the bytes of the desk's format and
   * version, at most 64 MiB (the declared length is checked first, the body counted as it arrives and never held in
   * memory), as `media/desk/<scene-slug>-<hash12>.bin`. The bytes stored already change nothing, whatever the
   * precondition (the change it asks for is made): no new file, no commit. Otherwise a precondition (`If-Match`,
   * `If-None-Match`) that does not name the stored state is a `412` `desk_state_conflict`, checked again in the
   * transaction; a write without one replaces whatever is stored. Each write is a commit, coalesced per clip and author,
   * but for a Replace (`upload.replace`), which is a commit of its own and never amends the tip: the history keeps the
   * state it replaces even when the tip is that state's commit by the same author a moment ago. The rows of
   * `X-Desk-State-Units` are kept with the state (`units`; none without the header: not known), and a header that does
   * not parse is refused before the body is read; the same bytes again keep the stored rows too.
   */
  async saveState(
    actor: Actor,
    projectId: string,
    clipId: string,
    upload: DeskStateUpload,
  ): Promise<ClipDeskState> {
    const refuse = (err: AppError, reason: string): AppError => {
      upload.body.resume();
      this.deps.metrics.deskStateSaves.inc({ outcome: 'refused' });
      this.deps.log.info({ projectId, clipId, reason, error: err.message }, 'desk state refused');
      return err;
    };
    const type = (upload.contentType ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/octet-stream')
      throw refuse(invalid('send the desk state as application/octet-stream'), 'content-type');
    if (!upload.format || !upload.version)
      throw refuse(
        invalid('send the desk state with its X-Desk-State-Format and X-Desk-State-Version headers'),
        'headers',
      );
    if (upload.format !== DESK_STATE_FORMAT || upload.version.trim() !== String(DESK_STATE_VERSION))
      throw refuse(
        invalid(
          `a desk state of format ${DESK_STATE_FORMAT} version ${DESK_STATE_VERSION}, not ${upload.format} version ${upload.version}`,
        ),
        'format',
      );
    let units: DeskStateUnitUse[] | null;
    try {
      units = parseDeskStateUnits(upload.units);
    } catch (err) {
      if (!(err instanceof DeskStateUnitsError)) throw err;
      throw refuse(invalid(`X-Desk-State-Units: ${err.message}`), 'units');
    }
    if (upload.contentLength !== undefined && upload.contentLength > DESK_STATE_MAX_BYTES)
      throw refuse(tooLarge('a desk state is at most 64 MiB'), 'size');
    let clip: Clip;
    try {
      clip = await this.clip(projectId, clipId);
    } catch (err) {
      upload.body.resume();
      throw err;
    }
    const tmp = this.deps.media.tmp('bin');
    try {
      let size: number;
      try {
        size = await receive(upload.body, tmp);
      } catch (err) {
        if ((err as { status?: number }).status === 413) throw refuse(err as AppError, 'size');
        throw err;
      }
      const hash = await sha256File(tmp);
      const same = (s: ClipDeskState | null | undefined) =>
        !!s && s.media.hash === hash && s.format === DESK_STATE_FORMAT && s.version === DESK_STATE_VERSION;
      if (same(clip.deskState)) {
        this.deps.metrics.deskStateSaves.inc({ outcome: 'unchanged' });
        return clip.deskState!;
      }
      // the state this write replaces must still be the stored one: a state another session stored or restored is
      // never replaced unseen
      const conflict = (stored: ClipDeskState | null | undefined): DeskStateConflictError | null => {
        const sha = stored?.media.hash ?? null;
        if (deskPreconditionHolds(sha, upload.ifMatch, upload.ifNoneMatch)) return null;
        this.deps.metrics.deskStateSaves.inc({ outcome: 'conflict' });
        this.deps.log.info(
          {
            projectId,
            clipId,
            ifMatch: upload.ifMatch ?? null,
            ifNoneMatch: upload.ifNoneMatch ?? null,
            stored: sha,
          },
          'desk state conflict',
        );
        return new DeskStateConflictError(sha, clip.index + 1);
      };
      const refused = conflict(clip.deskState);
      if (refused) throw refused;
      const media = await this.deps.media.putFile(projectId, tmp, {
        kind: 'desk',
        name: clip.title.trim() || `scene ${clip.index + 1}`,
        mime: 'application/octet-stream',
        probe: false,
      });
      const { result } = await this.mutate(
        actor,
        projectId,
        (tx) => {
          const current = structuredClone(tx.require<Clip>(docPath.clip(clipId), `clip ${clipId}`));
          if (same(current.deskState)) return { deskState: current.deskState!, changed: false };
          // another write may have landed while this one was read and stored
          const late = conflict(current.deskState);
          if (late) throw late;
          current.deskState = {
            format: DESK_STATE_FORMAT,
            version: DESK_STATE_VERSION,
            media,
            updatedAt: new Date().toISOString(),
            // what it uses, beside it: none without the header (not known)
            ...(units ? { units } : {}),
          };
          tx.set(docPath.clip(clipId), current);
          return { deskState: current.deskState, changed: true };
        },
        {
          message: `Save the desk of scene ${clip.index + 1}`,
          coalesce: upload.replace ? undefined : { key: `desk:${clipId}` },
        },
      );
      this.deps.metrics.deskStateSaves.inc({ outcome: result.changed ? 'saved' : 'unchanged' });
      if (result.changed)
        this.deps.log.info(
          {
            projectId,
            clipId,
            size,
            sha256: hash,
            format: DESK_STATE_FORMAT,
            version: DESK_STATE_VERSION,
            path: media.path,
            replace: !!upload.replace,
            units: units ? units.length : 'unknown',
          },
          'desk state saved',
        );
      return result.deskState;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /**
   * The clip names no state (the file stays, as all media). The desk's next `open` carries none: the desk restores its
   * own copy of the scene in a browser that has one (and the next state stored writes it back), else stages the brief.
   */
  async clearState(actor: Actor, projectId: string, clipId: string): Promise<void> {
    const clip = await this.clip(projectId, clipId);
    if (!clip.deskState) return;
    await this.mutate(
      actor,
      projectId,
      (tx) => {
        const current = structuredClone(tx.require<Clip>(docPath.clip(clipId), `clip ${clipId}`));
        if (!current.deskState) return;
        current.deskState = null;
        tx.set(docPath.clip(clipId), current);
      },
      { message: `Clear the desk of scene ${clip.index + 1}` },
    );
  }
}

/**
 * Writes a body to a file, counting its bytes as they arrive: past 64 MiB the file is dropped, the rest of the body
 * is let through unread and a 413 `validation_error` is thrown. A body whose client went away, before or while it is
 * read, fails at once (a destroyed request emits neither `end` nor, without a listener yet, `error`): its file is
 * closed and the caller removes it.
 */
export function receive(body: Readable, path: string): Promise<number> {
  // nobody reads the answer to a request whose client went away: a `cancelled`, not a server error
  const gone = (err?: unknown) =>
    new AppError(
      'cancelled',
      `the client went away before the desk state arrived${err instanceof Error ? ` (${err.message})` : ''}`,
    );
  return new Promise((resolve, reject) => {
    if (body.destroyed) {
      reject(gone());
      return;
    }
    const out = createWriteStream(path);
    let size = 0;
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      body.off('data', onData);
      out.destroy();
      body.resume();
      reject(err);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > DESK_STATE_MAX_BYTES) return fail(tooLarge('a desk state is at most 64 MiB'));
      if (!out.write(chunk)) {
        body.pause();
        out.once('drain', () => body.resume());
      }
    };
    body.on('data', onData);
    // an error, or a close before the end (the client went away): `finished` reports both
    finished(body, (err) => {
      if (err) fail(gone(err));
    });
    out.once('error', fail);
    body.once('end', () => {
      if (settled) return;
      out.end(() => {
        if (settled) return;
        settled = true;
        resolve(size);
      });
    });
  });
}
