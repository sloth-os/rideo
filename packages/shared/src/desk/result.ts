import type { Clip } from '../schemas/clip';
import type { Probe } from '../schemas/common';
import type { DeskMode, DeskMove, DeskResultFile, DeskResultMessage } from '../schemas/desk';
import type { Project } from '../schemas/project';
import { deskFormat, deskFrames } from './brief';

/**
 * What rideo does with a desk's `result` (docs/design/director-desk.md#the-result), as a pure plan the studio's bridge
 * carries out: per shot, a refusal with its reason, or the clip to upload as the shot's motion reference, its probe
 * and poster, and the shot's PATCH.
 */

/** When the result has no clip in the person's mode, the first of these it has. */
export const DESK_MODE_FALLBACK: readonly DeskMode[] = ['camera', 'motion', 'pose'];

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
  approved: (clip: number) => `clip ${clip} is approved: unapprove it to change its shots`,
  changed: 'the shot changed since the desk rendered it: render it again',
  noClip: 'the result has no clip for the shot',
  missingFile: (name: string) => `the file ${name} is not in the result`,
} as const;

/**
 * The plan of a result for one clip: its shots in the result's order, each refused (the shot is gone, the clip is
 * approved, the size, frame rate or the shot's frame count changed, its clip is missing) or attached in the person's
 * mode, else the first of camera, motion and pose the result has.
 */
export function planDeskResult(input: {
  result: Pick<DeskResultMessage, 'sceneId' | 'fps' | 'width' | 'height' | 'shots' | 'files'>;
  project: Pick<Project, 'settings'>;
  clip: Pick<Clip, 'id' | 'index' | 'status' | 'shots'> | null | undefined;
  mode: DeskMode;
}): DeskShotPlan[] {
  const { result, project, clip, mode } = input;
  const format = deskFormat(project.settings);
  const files = new Map(result.files.map((f) => [f.name, f]));
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
    if (clip.status === 'approved') return refuse(DESK_REFUSALS.approved(clip.index + 1), number);
    if (
      result.fps !== format.fps ||
      result.width !== format.width ||
      result.height !== format.height ||
      r.frames !== deskFrames(shot.durationSec, format.fps)
    )
      return refuse(DESK_REFUSALS.changed, number);
    const chosen = r.references[mode] ? mode : DESK_MODE_FALLBACK.find((m) => r.references[m]);
    if (!chosen) return refuse(DESK_REFUSALS.noClip, number);
    const name = r.references[chosen]!;
    const file = files.get(name);
    if (file?.mime !== 'video/mp4') return refuse(DESK_REFUSALS.missingFile(name), number);
    const still = r.still ? files.get(r.still) : undefined;
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
      poster: still?.mime === 'image/png' ? still : null,
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
}

/**
 * The one-line summary of a result, for `result-ack` and the studio's toast: what was attached, what was refused and
 * why, and the shots whose camera does not show the planned layout ("S3: the camera does not show the planned
 * layout").
 */
export function deskResultSummary(outcomes: readonly DeskShotOutcome[]): { ok: boolean; message: string } {
  const total = outcomes.length;
  if (!total) return { ok: false, message: 'The result had no shots.' };
  const attached = outcomes.filter((o) => o.ok).length;
  const label = (o: DeskShotOutcome) => (o.shot ? `S${o.shot}` : o.shotId);
  const plural = (n: number) => `${n} reference${n === 1 ? '' : 's'}`;
  const parts = [
    attached === total ? `Attached ${plural(total)}.` : `Attached ${attached} of ${plural(total)}.`,
    ...outcomes.filter((o) => !o.ok).map((o) => `${label(o)}: ${o.error ?? 'not attached'}.`),
    ...outcomes
      .filter((o) => o.ok && o.planAgrees === false)
      .map((o) => `${label(o)}: the camera does not show the planned layout.`),
  ];
  return { ok: attached === total, message: parts.join(' ') };
}
