import type { Clip } from '../schemas/clip';
import type { Probe } from '../schemas/common';
import {
  DESK_MODES,
  type DeskBrief,
  type DeskMode,
  type DeskMove,
  type DeskResultFile,
  type DeskResultMessage,
  type DeskShotResult,
} from '../schemas/desk';
import type { Project } from '../schemas/project';
import { deskFormat, deskFrames } from './brief';

/**
 * What rideo does with a desk's `result` (docs/design/director-desk.md#the-result), as a pure plan the studio's bridge
 * carries out: per shot, a refusal with its reason, or the clip to upload as the shot's motion reference, its probe
 * and poster, and the shot's PATCH.
 */

/**
 * A shot that carries clips of several modes (an `export` that asked for several) gets the mode last attached in the
 * project when it has it, else the first of these it has: the protocol's order. A shot of a desk's Send carries one,
 * the mode the desk's own Follow menu picked (docs/design/director-desk.md#the-result).
 */
export const DESK_MODE_FALLBACK: readonly DeskMode[] = DESK_MODES;

/** What ffprobe calls an MP4 file (the probe a result's clip is uploaded with). */
const MP4_FORMAT = 'mov,mp4,m4a,3gp,3g2,mj2';

export interface DeskShotAttach {
  ok: true;
  shotId: string;
  /** The shot's number in its clip (1, 2…). */
  shot: number;
  /** The reference mode the shot follows. */
  mode: DeskMode;
  /** The clip to upload, named `desk-c<clip>-s<shot>-<mode>.mp4`. */
  file: DeskResultFile;
  fileName: string;
  /** The probe made from the result: the resource is ready at once. */
  probe: Probe;
  /** The shot's still (PNG), the poster's source; null when the result has none. */
  poster: DeskResultFile | null;
  /** The shot's PATCH without the uploaded resource's id (`deskShotPatch`). */
  patch: { motionReference: { mode: DeskMode }; camera: { lensMm: number; move: DeskMove | null } };
  /** The camera shows the planned layout (null: the shot had none). */
  planAgrees: boolean | null;
}

export interface DeskShotRefusal {
  ok: false;
  shotId: string;
  /** The shot's number in its clip, when the clip still has it. */
  shot: number | null;
  reason: string;
}

export type DeskShotPlan = DeskShotAttach | DeskShotRefusal;

export const DESK_REFUSALS = {
  otherScene: 'the result is of another scene',
  shotGone: 'the shot is no longer in the clip',
  twice: 'the shot is in the result twice',
  approved: (clip: number) => `clip ${clip} is approved: unapprove it to change its shots`,
  /** The shot or the project changed in rideo since the brief the desk rendered from. */
  changed: 'the shot changed since the desk rendered it: render it again',
  /** Nothing changed in rideo: the person gave the shot another length in the desk. */
  length: (clipFrames: number, shotFrames: number, durationSec: number, fps: number) =>
    `the clip has ${clipFrames} frames and the shot ${shotFrames} (${seconds(durationSec)} s at ${fps} fps): set its length back in the desk, or change the shot's duration in the studio`,
  /**
   * Nothing changed in rideo since the brief, but the brief retimed the shot since the desk staged it, and the person
   * sent it without Update shots.
   */
  update: (clipFrames: number, shotFrames: number, durationSec: number, fps: number) =>
    `the clip has ${clipFrames} frames and the shot ${shotFrames} (${seconds(durationSec)} s at ${fps} fps): the brief changed the shot's length since the desk staged it; press Update shots in the desk, then send again`,
  /** Nothing changed in rideo: the desk rendered another size or frame rate than the brief's. */
  format: (
    clip: { width: number; height: number; fps: number },
    scene: { width: number; height: number; fps: number },
  ) =>
    `the clip is ${clip.width}×${clip.height} at ${clip.fps} fps, the scene ${scene.width}×${scene.height} at ${scene.fps} fps`,
  noClip: 'the result has no clip for the shot',
  missingFile: (name: string) => `the file ${name} is not in the result`,
  notMp4: (name: string) => `the file ${name} is not an MP4 clip`,
} as const;

/** A duration as the refusals say it: "3", "2.5", "0.33". */
const seconds = (sec: number) => String(Math.round(sec * 100) / 100);

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

/** An MP4 file starts with its `ftyp` box: bytes 4–7 are `ftyp` (the desk's clips put it first). */
export function looksLikeMp4(data: ArrayBuffer): boolean {
  return data.byteLength >= 8 && ascii(new Uint8Array(data, 0, 8), 4, 4) === 'ftyp';
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The size a PNG's `IHDR` (its first chunk) declares, or null for bytes that are not a PNG. */
export function pngSize(data: ArrayBuffer): { width: number; height: number } | null {
  if (data.byteLength < 24) return null;
  const head = new Uint8Array(data, 0, 24);
  if (PNG_SIGNATURE.some((b, i) => head[i] !== b) || ascii(head, 12, 4) !== 'IHDR') return null;
  const view = new DataView(data, 16, 8);
  return { width: view.getUint32(0), height: view.getUint32(4) };
}

/**
 * Whether the brief retimed the shot since the desk staged it (Update shots brings it to the brief), not the person in
 * the desk. The desk's own issue on the shot (`brief_length`) decides: the desk writes it at Send from its changes then,
 * pointing to Update shots for a shot the brief retimed and saying to set it back for a length changed in the desk (one
 * changed after Update shots too); the code alone does not tell the two apart. `retimed` (`opened.changes.retimed`,
 * which no later message updates) decides only for a shot without that issue.
 */
function retimedByBrief(
  shot: Pick<DeskShotResult, 'shotId' | 'issues'>,
  retimed: ReadonlySet<string>,
): boolean {
  const said = shot.issues.filter((i) => i.code === 'brief_length');
  if (said.length) return said.some((i) => /\bupdate shots\b/i.test(i.message));
  return retimed.has(shot.shotId);
}

/**
 * The plan of a result for one clip: its shots in the result's order, each refused (the shot is gone, the clip is
 * approved, the size, frame rate or the shot's frame count is not the clip's, its clip is missing) or attached in the
 * mode it carries; of several, `mode` (the mode last attached in the project) when the shot has it, else the first in
 * the protocol's order. `brief` is the brief the desk was opened with: a frame count or format that is not the clip's is
 * "changed" only when the shot or the project changed in rideo since that brief; otherwise the desk rendered something
 * else than the brief asked for, and the refusal says so with the numbers and what to do: Update shots for a shot the
 * brief retimed since it was staged, else set back the length the person changed in the desk, as the shot's own
 * `brief_length` issue says, or for a shot without one, as `retimed` (`opened.changes.retimed` of the desk's
 * connection) does.
 */
export function planDeskResult(input: {
  result: Pick<DeskResultMessage, 'sceneId' | 'fps' | 'width' | 'height' | 'shots' | 'files'>;
  project: Pick<Project, 'settings'>;
  clip: Pick<Clip, 'id' | 'index' | 'status' | 'shots'> | null | undefined;
  mode: DeskMode;
  brief?: Pick<DeskBrief, 'id' | 'fps' | 'width' | 'height' | 'shots'> | null;
  retimed?: readonly string[];
}): DeskShotPlan[] {
  const { result, project, clip, mode, brief } = input;
  const retimed = new Set(input.retimed ?? []);
  const format = deskFormat(project.settings);
  // the project's size and frame rate are still the ones of the brief the desk was opened with
  const briefFormat =
    !!brief &&
    brief.id === clip?.id &&
    brief.fps === format.fps &&
    brief.width === format.width &&
    brief.height === format.height;
  const files = new Map(result.files.map((f) => [f.name, f]));
  const seen = new Set<string>();
  return result.shots.map((r): DeskShotPlan => {
    const refuse = (reason: string, shot: number | null = null): DeskShotRefusal => ({
      ok: false,
      shotId: r.shotId,
      shot,
      reason,
    });
    if (!clip) return refuse(DESK_REFUSALS.shotGone);
    if (result.sceneId !== clip.id) return refuse(DESK_REFUSALS.otherScene);
    const shot = clip.shots.find((s) => s.id === r.shotId);
    if (!shot) return refuse(DESK_REFUSALS.shotGone);
    const number = shot.index + 1;
    // the shot's first entry is the one taken: another would upload a second clip and patch the shot again
    if (seen.has(r.shotId)) return refuse(DESK_REFUSALS.twice, number);
    seen.add(r.shotId);
    if (clip.status === 'approved') return refuse(DESK_REFUSALS.approved(clip.index + 1), number);
    const frames = deskFrames(shot.durationSec, format.fps);
    const sameFormat =
      result.fps === format.fps && result.width === format.width && result.height === format.height;
    if (!sameFormat || r.frames !== frames) {
      const sent = brief?.shots.find((s) => s.id === r.shotId);
      // nothing changed in rideo since the brief: the desk rendered something else than it asked for
      if (briefFormat && sent?.durationSec === shot.durationSec) {
        if (!sameFormat) return refuse(DESK_REFUSALS.format(result, format), number);
        const because = retimedByBrief(r, retimed) ? DESK_REFUSALS.update : DESK_REFUSALS.length;
        return refuse(because(r.frames, frames, shot.durationSec, format.fps), number);
      }
      return refuse(DESK_REFUSALS.changed, number);
    }
    const chosen = r.references[mode] ? mode : DESK_MODE_FALLBACK.find((m) => r.references[m]);
    if (!chosen) return refuse(DESK_REFUSALS.noClip, number);
    const name = r.references[chosen]!;
    const file = files.get(name);
    if (file?.mime !== 'video/mp4') return refuse(DESK_REFUSALS.missingFile(name), number);
    // the probe is made from the result, not from the bytes: at least they must be an MP4 file
    if (!looksLikeMp4(file.data)) return refuse(DESK_REFUSALS.notMp4(name), number);
    const still = r.still ? files.get(r.still) : undefined;
    const stillSize = still?.mime === 'image/png' ? pngSize(still.data) : null;
    return {
      ok: true,
      shotId: r.shotId,
      shot: number,
      mode: chosen,
      file,
      fileName: `desk-c${clip.index + 1}-s${number}-${chosen}.mp4`,
      probe: {
        formatName: MP4_FORMAT,
        durationSec: r.frames / result.fps,
        hasVideo: true,
        hasAudio: false,
        width: result.width,
        height: result.height,
        fps: result.fps,
        videoCodec: 'h264',
      },
      // a still that is not a PNG of the result's size is dropped: the browser never decodes an image of a size
      // the result did not announce
      poster: still && stillSize?.width === result.width && stillSize.height === result.height ? still : null,
      patch: { motionReference: { mode: chosen }, camera: { lensMm: r.camera.lensMm, move: r.camera.move } },
      planAgrees: r.planAgrees,
    };
  });
}

/** The shot's PATCH once its clip is uploaded: the reference to follow, and the lens and move the desk staged. */
export function deskShotPatch(plan: DeskShotAttach, resourceId: string) {
  return {
    motionReference: { resourceId, mode: plan.mode },
    camera: { lensMm: plan.patch.camera.lensMm, move: plan.patch.camera.move },
  };
}

/** What became of one shot of a result. */
export interface DeskShotOutcome {
  shotId: string;
  shot: number | null;
  ok: boolean;
  error?: string;
  planAgrees?: boolean | null;
  /** The mode attached (an attached shot). */
  mode?: DeskMode;
}

/**
 * The modes a result attached, with their counts: the most attached first, the protocol's order on a tie. The first is
 * the one remembered for the project, which the desk opens on next time (docs/design/director-desk.md#the-result).
 */
export function deskAttachedModes(outcomes: readonly DeskShotOutcome[]): { mode: DeskMode; count: number }[] {
  return DESK_MODES.map((mode) => ({ mode, count: outcomes.filter((o) => o.ok && o.mode === mode).length }))
    .filter((m) => m.count > 0)
    .sort((a, b) => b.count - a.count || DESK_MODES.indexOf(a.mode) - DESK_MODES.indexOf(b.mode));
}

/**
 * The one-line summary of a result, for `result-ack` and the studio's toast: what was attached, in which mode ("Attached
 * 4 camera references.", "Attached 4 references: 3 camera, 1 motion."), what was refused and why, and the shots whose
 * camera does not show the planned layout ("S3: the camera does not show the planned layout").
 */
export function deskResultSummary(outcomes: readonly DeskShotOutcome[]): { ok: boolean; message: string } {
  const total = outcomes.length;
  if (!total) return { ok: false, message: 'The result had no shots.' };
  const attached = outcomes.filter((o) => o.ok).length;
  const label = (o: DeskShotOutcome) => (o.shot ? `S${o.shot}` : o.shotId);
  const modes = deskAttachedModes(outcomes);
  const plural = (n: number) =>
    `${n} ${modes.length === 1 ? `${modes[0]!.mode} ` : ''}reference${n === 1 ? '' : 's'}`;
  const each = modes.length > 1 ? `: ${modes.map((m) => `${m.count} ${m.mode}`).join(', ')}` : '';
  const parts = [
    attached === total
      ? `Attached ${plural(total)}${each}.`
      : `Attached ${attached} of ${plural(total)}${each}.`,
    ...outcomes.filter((o) => !o.ok).map((o) => `${label(o)}: ${o.error ?? 'not attached'}.`),
    ...outcomes
      .filter((o) => o.ok && o.planAgrees === false)
      .map((o) => `${label(o)}: the camera does not show the planned layout.`),
  ];
  return { ok: attached === total, message: parts.join(' ') };
}
