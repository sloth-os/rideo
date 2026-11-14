import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import {
  type Actor,
  type Clip,
  type ClipDeskState,
  DESK_STATE_FORMAT,
  DESK_STATE_MAX_BYTES,
  DESK_STATE_VERSION,
  type DeskBrief,
  deskBrief,
  docPath,
} from '@rideo/shared';
import { type AppError, invalid, notFound, tooLarge } from '../errors';
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
  body: Readable;
}

/**
 * The 3D-Editor's director's desk on the server (docs/design/director-desk.md#surfaces): the brief of a clip (REST
 * `desk-brief` and the MCP tool `desk_brief`) and the desk's opaque state, stored per clip as an immutable media file
 * that `clip.deskState` names.
 */
export class DeskService extends Service {
  private async clip(projectId: string, clipId: string): Promise<Clip> {
    const docs = await this.deps.projects.docs(projectId);
    const clip = docs.clips[clipId];
    if (!clip) throw notFound(`clip ${clipId}`);
    return clip;
  }

  /** The clip's `SceneBrief` (docs/design/director-desk.md#the-brief). */
  async brief(projectId: string, clipId: string): Promise<DeskBrief> {
    const docs = await this.deps.projects.docs(projectId);
    const clip = docs.clips[clipId];
    if (!clip) throw notFound(`clip ${clipId}`);
    const brief = deskBrief(docs, clipId);
    if (!brief) throw invalid(`plan the shots of clip ${clip.index + 1} first`);
    this.deps.metrics.deskBriefs.inc();
    return brief;
  }

  /** The stored state and a local, hash-checked copy of its bytes. */
  async state(projectId: string, clipId: string): Promise<{ deskState: ClipDeskState; file: string }> {
    const clip = await this.clip(projectId, clipId);
    if (!clip.deskState) throw notFound(`desk state of clip ${clip.index + 1}`);
    return {
      deskState: clip.deskState,
      file: await this.deps.media.localPath(projectId, clip.deskState.media),
    };
  }

  /**
   * Stores a state as it is given (docs/design/director-desk.md#the-desk-state): the bytes of the desk's format and
   * version, at most 64 MiB (the declared length is checked first, the body counted as it arrives and never held in
   * memory), as `media/desk/<scene-slug>-<hash12>.bin`. The bytes stored already change nothing: no new file, no
   * commit. Each write is a commit, coalesced per clip and author.
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
          current.deskState = {
            format: DESK_STATE_FORMAT,
            version: DESK_STATE_VERSION,
            media,
            updatedAt: new Date().toISOString(),
          };
          tx.set(docPath.clip(clipId), current);
          return { deskState: current.deskState, changed: true };
        },
        { message: `Save the desk of scene ${clip.index + 1}`, coalesce: { key: `desk:${clipId}` } },
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
          },
          'desk state saved',
        );
      return result.deskState;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /** The clip names no state (the file stays, as all media): the desk's next `open` stages the brief. */
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
 * is let through unread and a 413 `validation_error` is thrown.
 */
function receive(body: Readable, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
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
    body.once('error', fail);
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
