import { describe, expect, it } from 'vitest';
import {
  DESK_REFUSALS,
  type DeskResultMessage,
  type DeskShotAttach,
  deskResultSummary,
  deskShotPatch,
  ProbeSchema,
  ProjectSettingsSchema,
  planDeskResult,
  ShotUpdateInputSchema,
} from '../src';
import * as f from '../src/testing/fixtures';

/** Which file of a result a shot gets, and when a shot is refused (docs/design/director-desk.md#the-result). */

const bytes = (n: number) => new Uint8Array(n).buffer as ArrayBuffer;

function setup() {
  const s0 = f.shot({ index: 0, durationSec: 3 });
  const s1 = f.shot({ index: 1, durationSec: 2.5 });
  const clip = f.clip({ index: 0, shots: [s0, s1] });
  const project = f.project({
    settings: ProjectSettingsSchema.parse({ fps: 24, resolution: { width: 1280, height: 720 } }),
  });
  const result: DeskResultMessage = {
    type: 'result',
    id: 'desk-1',
    sceneId: clip.id,
    fps: 24,
    width: 1280,
    height: 720,
    shots: [
      {
        shotId: s0.id,
        frames: 72,
        durationSec: 3,
        references: { camera: `${s0.id}.camera.mp4`, pose: `${s0.id}.pose.mp4` },
        still: `${s0.id}.still.png`,
        camera: { lensMm: 24, move: 'tracking_follow' },
        line: 'Mira is left of frame, facing right.',
        moves: null,
        planAgrees: true,
        issues: [],
      },
      {
        shotId: s1.id,
        frames: 60,
        durationSec: 2.5,
        references: { motion: `${s1.id}.motion.mp4` },
        still: null,
        camera: { lensMm: 85, move: null },
        line: '',
        moves: null,
        planAgrees: false,
        issues: [],
      },
    ],
    files: [
      { name: `${s0.id}.camera.mp4`, mime: 'video/mp4', data: bytes(8) },
      { name: `${s0.id}.pose.mp4`, mime: 'video/mp4', data: bytes(9) },
      { name: `${s0.id}.still.png`, mime: 'image/png', data: bytes(4) },
      { name: `${s1.id}.motion.mp4`, mime: 'video/mp4', data: bytes(10) },
    ],
  };
  return { s0, s1, clip, project, result };
}

describe('planDeskResult', () => {
  it("attaches the file of the person's mode with a probe, a poster and the shot's PATCH", () => {
    const { s0, clip, project, result } = setup();
    const [first] = planDeskResult({ result, project, clip, mode: 'pose' });
    expect(first!.ok).toBe(true);
    const plan = first as DeskShotAttach;
    expect(plan).toMatchObject({ shotId: s0.id, shot: 1, mode: 'pose', fileName: 'desk-c1-s1-pose.mp4' });
    expect(plan.file.name).toBe(`${s0.id}.pose.mp4`);
    expect(plan.poster?.name).toBe(`${s0.id}.still.png`);
    expect(plan.probe).toEqual({
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationSec: 3,
      hasVideo: true,
      hasAudio: false,
      width: 1280,
      height: 720,
      fps: 24,
      videoCodec: 'h264',
    });
    expect(ProbeSchema.safeParse(plan.probe).success).toBe(true);
    const patch = deskShotPatch(plan, 'res_0000000000000001');
    expect(patch).toEqual({
      motionReference: { resourceId: 'res_0000000000000001', mode: 'pose' },
      camera: { lensMm: 24, move: 'tracking_follow' },
    });
    expect(ShotUpdateInputSchema.safeParse(patch).success).toBe(true);
  });

  it('falls back to the first of camera, motion and pose the result has', () => {
    const { project, clip, result } = setup();
    const plans = planDeskResult({ result, project, clip, mode: 'motion' }) as DeskShotAttach[];
    expect(plans.map((p) => p.mode)).toEqual(['camera', 'motion']);
    expect(plans[1]).toMatchObject({ fileName: 'desk-c1-s2-motion.mp4', poster: null, planAgrees: false });
    expect(plans[1]!.patch.camera).toEqual({ lensMm: 85, move: null });
    const camera = planDeskResult({ result, project, clip, mode: 'camera' }) as DeskShotAttach[];
    expect(camera.map((p) => p.mode)).toEqual(['camera', 'motion']);
  });

  it('refuses a shot no longer in the clip, an approved clip, and a changed size, frame rate or length', () => {
    const { s0, s1, project, clip, result } = setup();
    const reasons = (plans: ReturnType<typeof planDeskResult>) => plans.map((p) => (p.ok ? 'ok' : p.reason));
    // the shot is gone
    expect(
      reasons(planDeskResult({ result, project, clip: { ...clip, shots: [s1] }, mode: 'camera' })),
    ).toEqual([DESK_REFUSALS.shotGone, 'ok']);
    expect(reasons(planDeskResult({ result, project, clip: null, mode: 'camera' }))).toEqual([
      DESK_REFUSALS.shotGone,
      DESK_REFUSALS.shotGone,
    ]);
    // approved
    const approved = planDeskResult({
      result,
      project,
      clip: { ...clip, status: 'approved' },
      mode: 'camera',
    });
    expect(reasons(approved)).toEqual([
      'clip 1 is approved: unapprove it to change its shots',
      'clip 1 is approved: unapprove it to change its shots',
    ]);
    expect(approved.map((p) => (p.ok ? null : p.shot))).toEqual([1, 2]);
    // size and frame rate
    const bigger = f.project({
      settings: ProjectSettingsSchema.parse({ fps: 24, resolution: { width: 1920, height: 1080 } }),
    });
    expect(reasons(planDeskResult({ result, project: bigger, clip, mode: 'camera' }))).toEqual([
      DESK_REFUSALS.changed,
      DESK_REFUSALS.changed,
    ]);
    const faster = f.project({ settings: ProjectSettingsSchema.parse({ fps: 30 }) });
    expect(reasons(planDeskResult({ result, project: faster, clip, mode: 'camera' }))).toEqual([
      DESK_REFUSALS.changed,
      DESK_REFUSALS.changed,
    ]);
    // the shot's length: 4 s is 96 frames, the desk rendered 72
    const longer = { ...clip, shots: [{ ...s0, durationSec: 4 }, s1] };
    expect(reasons(planDeskResult({ result, project, clip: longer, mode: 'camera' }))).toEqual([
      DESK_REFUSALS.changed,
      'ok',
    ]);
    // another scene's result, a clip missing from the result's files
    expect(
      reasons(
        planDeskResult({
          result: { ...result, sceneId: 'clp_0000000000other' },
          project,
          clip,
          mode: 'camera',
        }),
      ),
    ).toEqual([DESK_REFUSALS.otherScene, DESK_REFUSALS.otherScene]);
    const missing = { ...result, files: result.files.filter((x) => !x.name.endsWith('motion.mp4')) };
    expect(reasons(planDeskResult({ result: missing, project, clip, mode: 'camera' }))).toEqual([
      'ok',
      DESK_REFUSALS.missingFile(`${s1.id}.motion.mp4`),
    ]);
    const none = { ...result, shots: [{ ...result.shots[0]!, references: {} }] };
    expect(reasons(planDeskResult({ result: none, project, clip, mode: 'camera' }))).toEqual([
      DESK_REFUSALS.noClip,
    ]);
  });

  it('compares against the even size an odd resolution is rounded down to', () => {
    const { clip, result } = setup();
    const odd = f.project({
      settings: ProjectSettingsSchema.parse({ fps: 24, resolution: { width: 1281, height: 721 } }),
    });
    expect(planDeskResult({ result, project: odd, clip, mode: 'camera' }).every((p) => p.ok)).toBe(true);
  });
});

describe('deskResultSummary', () => {
  it('says what was attached, what was refused and where the camera disagrees with the plan', () => {
    expect(
      deskResultSummary([
        { shotId: 'sht_a', shot: 1, ok: true, planAgrees: true },
        { shotId: 'sht_b', shot: 3, ok: true, planAgrees: false },
      ]),
    ).toEqual({
      ok: true,
      message: 'Attached 2 references. S3: the camera does not show the planned layout.',
    });
    expect(
      deskResultSummary([
        { shotId: 'sht_a', shot: 1, ok: true, planAgrees: null },
        { shotId: 'sht_b', shot: 2, ok: false, error: DESK_REFUSALS.changed },
        { shotId: 'sht_c', shot: null, ok: false, error: DESK_REFUSALS.shotGone },
      ]),
    ).toEqual({
      ok: false,
      message:
        'Attached 1 of 3 references. S2: the shot changed since the desk rendered it: render it again. sht_c: the shot is no longer in the clip.',
    });
    expect(deskResultSummary([{ shotId: 'sht_a', shot: 1, ok: true }]).message).toBe('Attached 1 reference.');
    expect(deskResultSummary([])).toEqual({ ok: false, message: 'The result had no shots.' });
  });
});
