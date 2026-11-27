import { describe, expect, it } from 'vitest';
import {
  DESK_MODE_FALLBACK,
  DESK_REFUSALS,
  type DeskResultMessage,
  type DeskShotAttach,
  deskAttachedModes,
  deskResultSummary,
  deskShotPatch,
  looksLikeMp4,
  ProbeSchema,
  ProjectSettingsSchema,
  planDeskResult,
  pngSize,
  ShotUpdateInputSchema,
} from '../src';
import * as f from '../src/testing/fixtures';

/** Which file of a result a shot gets, and when a shot is refused (docs/design/director-desk.md#the-result). */

const bytes = (n: number) => new Uint8Array(n).buffer as ArrayBuffer;
const mp4 = f.mp4Bytes;

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
      { name: `${s0.id}.camera.mp4`, mime: 'video/mp4', data: mp4(12) },
      { name: `${s0.id}.pose.mp4`, mime: 'video/mp4', data: mp4(13) },
      { name: `${s0.id}.still.png`, mime: 'image/png', data: f.pngBytes(1280, 720) },
      { name: `${s1.id}.motion.mp4`, mime: 'video/mp4', data: mp4(14) },
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
    // the update schema keeps the camera to the lens and the move: the shot's framing and movement stay as planned
    expect(ShotUpdateInputSchema.parse(patch).camera).toStrictEqual({ lensMm: 24, move: 'tracking_follow' });
  });

  it('refuses a shot listed twice (its first entry is taken) and a clip that is not an MP4', () => {
    const { s0, s1, project, clip, result } = setup();
    const reasons = (plans: ReturnType<typeof planDeskResult>) => plans.map((p) => (p.ok ? 'ok' : p.reason));
    const twice = { ...result, shots: [result.shots[0]!, result.shots[1]!, result.shots[0]!] };
    expect(reasons(planDeskResult({ result: twice, project, clip, mode: 'camera' }))).toEqual([
      'ok',
      'ok',
      DESK_REFUSALS.twice,
    ]);
    // a shot no longer in the clip is said so, listed twice or not
    expect(
      reasons(planDeskResult({ result: twice, project, clip: { ...clip, shots: [s1] }, mode: 'camera' })),
    ).toEqual([DESK_REFUSALS.shotGone, 'ok', DESK_REFUSALS.shotGone]);
    const notMp4 = {
      ...result,
      files: result.files.map((x) => (x.name === `${s0.id}.camera.mp4` ? { ...x, data: bytes(64) } : x)),
    };
    expect(reasons(planDeskResult({ result: notMp4, project, clip, mode: 'camera' }))).toEqual([
      DESK_REFUSALS.notMp4(`${s0.id}.camera.mp4`),
      'ok',
    ]);
    expect(DESK_REFUSALS.notMp4('a.mp4')).toBe('the file a.mp4 is not an MP4 clip');
  });

  it('drops a still without the PNG signature or of another size than the result', () => {
    const { s0, project, clip, result } = setup();
    const withStill = (data: ArrayBuffer) => ({
      ...result,
      files: result.files.map((x) => (x.name === `${s0.id}.still.png` ? { ...x, data } : x)),
    });
    const poster = (data: ArrayBuffer) =>
      (planDeskResult({ result: withStill(data), project, clip, mode: 'camera' })[0] as DeskShotAttach)
        .poster;
    expect(poster(f.pngBytes(1280, 720))?.name).toBe(`${s0.id}.still.png`);
    expect(poster(f.pngBytes(320, 180))).toBeNull();
    expect(poster(bytes(64))).toBeNull();
    expect(poster(mp4(64))).toBeNull();
    // the shot is attached all the same
    expect(planDeskResult({ result: withStill(bytes(3)), project, clip, mode: 'camera' })[0]!.ok).toBe(true);
  });

  it('reads the MP4 and PNG signatures', () => {
    expect(looksLikeMp4(mp4(12))).toBe(true);
    expect(looksLikeMp4(bytes(12))).toBe(false);
    expect(looksLikeMp4(mp4(12).slice(0, 7))).toBe(false);
    expect(pngSize(f.pngBytes(640, 360))).toEqual({ width: 640, height: 360 });
    expect(pngSize(f.pngBytes(640, 360).slice(0, 23))).toBeNull();
    expect(pngSize(bytes(33))).toBeNull();
  });

  it('attaches the mode a shot carries; of several, the one last attached, else the first in the protocol order', () => {
    const { project, clip, result } = setup();
    expect(DESK_MODE_FALLBACK).toEqual(['motion', 'pose', 'camera']);
    // shot 1 carries camera and pose (an export that asked for several), shot 2 motion only (a desk's Send)
    const motion = planDeskResult({ result, project, clip, mode: 'motion' }) as DeskShotAttach[];
    expect(motion.map((p) => p.mode)).toEqual(['pose', 'motion']);
    expect(motion[1]).toMatchObject({ fileName: 'desk-c1-s2-motion.mp4', poster: null, planAgrees: false });
    expect(motion[1]!.patch.camera).toEqual({ lensMm: 85, move: null });
    const camera = planDeskResult({ result, project, clip, mode: 'camera' }) as DeskShotAttach[];
    expect(camera.map((p) => p.mode)).toEqual(['camera', 'motion']);
    const pose = planDeskResult({ result, project, clip, mode: 'pose' }) as DeskShotAttach[];
    expect(pose.map((p) => p.mode)).toEqual(['pose', 'motion']);
    expect(pose[0]!.fileName).toBe('desk-c1-s1-pose.mp4');
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

  it('tells a length or format the desk changed from a shot or project changed since the brief', () => {
    const { s0, s1, project, clip, result } = setup();
    const reasons = (plans: ReturnType<typeof planDeskResult>) => plans.map((p) => (p.ok ? 'ok' : p.reason));
    // the brief the desk was opened with: the clip as it is now
    const brief = {
      id: clip.id,
      fps: 24,
      width: 1280,
      height: 720,
      shots: [
        { id: s0.id, durationSec: 3 },
        { id: s1.id, durationSec: 2.5 },
      ],
    } as Parameters<typeof planDeskResult>[0]['brief'];
    // the person made shot 2 half a second longer in the desk: rideo's shot is still the brief's
    const longer = {
      ...result,
      shots: [result.shots[0]!, { ...result.shots[1]!, frames: 72, durationSec: 3 }],
    };
    expect(reasons(planDeskResult({ result: longer, project, clip, mode: 'camera', brief }))).toEqual([
      'ok',
      "the clip has 72 frames and the shot 60 (2.5 s at 24 fps): set its length back in the desk, or change the shot's duration in the studio",
    ]);
    expect(DESK_REFUSALS.length(84, 72, 3, 24)).toBe(
      "the clip has 84 frames and the shot 72 (3 s at 24 fps): set its length back in the desk, or change the shot's duration in the studio",
    );
    expect(DESK_REFUSALS.length(10, 8, 1 / 3, 24)).toContain('(0.33 s at 24 fps)');
    // a clip of one frame is counted in the singular (docs/brand.md#voice)
    expect(DESK_REFUSALS.length(1, 24, 1, 24)).toMatch(
      /^the clip has 1 frame and the shot 24 \(1 s at 24 fps\): /,
    );
    expect(DESK_REFUSALS.update(1, 24, 1, 24)).toMatch(
      /^the clip has 1 frame and the shot 24 \(1 s at 24 fps\): /,
    );
    expect(DESK_REFUSALS.update(2, 24, 1, 24)).toMatch(/^the clip has 2 frames and the shot 24 /);
    // the shot's duration changed in rideo since the brief: render it again
    const retimed = { ...clip, shots: [s0, { ...s1, durationSec: 3 }] };
    expect(reasons(planDeskResult({ result, project, clip: retimed, mode: 'camera', brief }))).toEqual([
      'ok',
      DESK_REFUSALS.changed,
    ]);
    // a shot the brief did not have, or no brief at all: changed
    const unknown = { ...brief!, shots: [brief!.shots[0]!] };
    expect(
      reasons(planDeskResult({ result: longer, project, clip, mode: 'camera', brief: unknown })),
    ).toEqual(['ok', DESK_REFUSALS.changed]);
    expect(reasons(planDeskResult({ result: longer, project, clip, mode: 'camera' }))).toEqual([
      'ok',
      DESK_REFUSALS.changed,
    ]);
    // the project's frame rate changed since the brief: changed, whatever the shots
    const faster = f.project({ settings: ProjectSettingsSchema.parse({ fps: 30 }) });
    expect(reasons(planDeskResult({ result, project: faster, clip, mode: 'camera', brief }))).toEqual([
      DESK_REFUSALS.changed,
      DESK_REFUSALS.changed,
    ]);
    // the project is still the brief's, the desk sent another size: said with the numbers
    const smaller = { ...result, width: 640, height: 360 };
    expect(reasons(planDeskResult({ result: smaller, project, clip, mode: 'camera', brief }))).toEqual([
      'the clip is 640×360 at 24 fps, the scene 1280×720 at 24 fps',
      'the clip is 640×360 at 24 fps, the scene 1280×720 at 24 fps',
    ]);
    // a brief of another clip says nothing about this one
    expect(
      reasons(
        planDeskResult({ result: longer, project, clip, mode: 'camera', brief: { ...brief!, id: 'clp_x' } }),
      ),
    ).toEqual(['ok', DESK_REFUSALS.changed]);
  });

  it('says to press Update shots for a shot the brief retimed since the desk staged it, and to set back a length changed in the desk', () => {
    const { s0, s1, project, clip, result } = setup();
    const reasons = (plans: ReturnType<typeof planDeskResult>) => plans.map((p) => (p.ok ? 'ok' : p.reason));
    // rideo's shot 1 was made 3 s before the panel opened, so the brief carries 3 s; the desk restored an older
    // staging of 2.5 s and the person sent it without Update shots
    const brief = {
      id: clip.id,
      fps: 24,
      width: 1280,
      height: 720,
      shots: [
        { id: s0.id, durationSec: 3 },
        { id: s1.id, durationSec: 2.5 },
      ],
    } as Parameters<typeof planDeskResult>[0]['brief'];
    const older = {
      ...result,
      shots: [{ ...result.shots[0]!, frames: 60, durationSec: 2.5 }, result.shots[1]!],
    };
    const update =
      "the clip has 60 frames and the shot 72 (3 s at 24 fps): the brief changed the shot's length since the desk staged it; press Update shots in the desk, then send again";
    expect(DESK_REFUSALS.update(60, 72, 3, 24)).toBe(update);
    // the desk's opened said so (changes.retimed)
    expect(
      reasons(planDeskResult({ result: older, project, clip, mode: 'camera', brief, retimed: [s0.id] })),
    ).toEqual([update, 'ok']);
    // the desk's own issue says so: it points to Update shots
    const issue = (message: string) => [{ code: 'brief_length', severity: 'error' as const, message }];
    const byBrief = {
      ...older,
      shots: [
        {
          ...older.shots[0]!,
          issues: issue(
            "The brief changed this shot's length since it was staged: it is 60 frames (2.5 s) in the desk and 72 frames (3 s) in the brief, at 24 fps: Rideo refuses a clip of another length. Press Update shots (the brief's changes, above the scene), then send again.",
          ),
        },
        older.shots[1]!,
      ],
    };
    expect(reasons(planDeskResult({ result: byBrief, project, clip, mode: 'camera', brief }))).toEqual([
      update,
      'ok',
    ]);
    // a length the person changed in the desk: its brief_length issue says to set it back, and so does rideo
    const byDesk = {
      ...older,
      shots: [
        {
          ...older.shots[0]!,
          issues: issue(
            "The shot is 60 frames (2.5 s) in the desk and 72 frames (3 s) in the brief, at 24 fps: Rideo refuses a clip of another length. Set its length back, or change the shot's duration in Rideo.",
          ),
        },
        older.shots[1]!,
      ],
    };
    expect(reasons(planDeskResult({ result: byDesk, project, clip, mode: 'camera', brief }))).toEqual([
      DESK_REFUSALS.length(60, 72, 3, 24),
      'ok',
    ]);
    expect(
      reasons(planDeskResult({ result: older, project, clip, mode: 'camera', brief, retimed: [] })),
    ).toEqual([DESK_REFUSALS.length(60, 72, 3, 24), 'ok']);
    // changed in rideo since the brief: render it again, whatever the desk retimed
    const changed = { ...clip, shots: [{ ...s0, durationSec: 4 }, s1] };
    expect(
      reasons(
        planDeskResult({ result: older, project, clip: changed, mode: 'camera', brief, retimed: [s0.id] }),
      ),
    ).toEqual([DESK_REFUSALS.changed, 'ok']);
  });

  it("decides by the shot's own brief_length issue over a stale changes.retimed: retimed at open, Update shots pressed, then the length changed in the desk", () => {
    const { s0, s1, project, clip, result } = setup();
    const reasons = (plans: ReturnType<typeof planDeskResult>) => plans.map((p) => (p.ok ? 'ok' : p.reason));
    const brief = {
      id: clip.id,
      fps: 24,
      width: 1280,
      height: 720,
      shots: [
        { id: s0.id, durationSec: 3 },
        { id: s1.id, durationSec: 2.5 },
      ],
    } as Parameters<typeof planDeskResult>[0]['brief'];
    const sent = (frames: number, message: string) => ({
      ...result,
      shots: [
        {
          ...result.shots[0]!,
          frames,
          durationSec: frames / 24,
          issues: [{ code: 'brief_length', severity: 'error' as const, message }],
        },
        result.shots[1]!,
      ],
    });
    // the desk opened with shot 1 retimed by the brief (opened.changes.retimed), the person pressed Update shots (the
    // desk's live changes no longer list it), then made it 84 frames in the desk: the desk's issue at Send says to set
    // the length back, and so does rideo, whatever the opened list says
    const changedInTheDesk = sent(
      84,
      "The shot is 84 frames (3.5 s) in the desk and 72 frames (3 s) in the brief, at 24 fps: Rideo refuses a clip of another length. Set its length back, or change the shot's duration in Rideo.",
    );
    expect(
      reasons(
        planDeskResult({ result: changedInTheDesk, project, clip, mode: 'camera', brief, retimed: [s0.id] }),
      ),
    ).toEqual([DESK_REFUSALS.length(84, 72, 3, 24), 'ok']);
    // sent before Update shots: the desk's issue points to it, opened's list or not
    const notUpdated = sent(
      60,
      "The brief changed this shot's length since it was staged: it is 60 frames (2.5 s) in the desk and 72 frames (3 s) in the brief, at 24 fps: Rideo refuses a clip of another length. Press Update shots (the brief's changes, above the scene), then send again.",
    );
    for (const retimed of [[s0.id], []])
      expect(
        reasons(planDeskResult({ result: notUpdated, project, clip, mode: 'camera', brief, retimed })),
      ).toEqual([DESK_REFUSALS.update(60, 72, 3, 24), 'ok']);
    // a shot without the issue (a desk that gives none): opened's list decides
    const silent = { ...notUpdated, shots: [{ ...notUpdated.shots[0]!, issues: [] }, result.shots[1]!] };
    expect(
      reasons(planDeskResult({ result: silent, project, clip, mode: 'camera', brief, retimed: [s0.id] })),
    ).toEqual([DESK_REFUSALS.update(60, 72, 3, 24), 'ok']);
    expect(
      reasons(planDeskResult({ result: silent, project, clip, mode: 'camera', brief, retimed: [] })),
    ).toEqual([DESK_REFUSALS.length(60, 72, 3, 24), 'ok']);
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

  it('names the mode attached, and each mode when shots got different ones', () => {
    const shot = (n: number, mode?: 'motion' | 'pose' | 'camera') => ({
      shotId: `sht_${n}`,
      shot: n,
      ok: !!mode,
      ...(mode ? { mode } : { error: DESK_REFUSALS.changed }),
    });
    expect(
      deskResultSummary([shot(1, 'camera'), shot(2, 'camera'), shot(3, 'camera'), shot(4, 'camera')]),
    ).toEqual({ ok: true, message: 'Attached 4 camera references.' });
    expect(deskResultSummary([shot(1, 'pose')]).message).toBe('Attached 1 pose reference.');
    expect(
      deskResultSummary([shot(1, 'camera'), shot(2, 'camera'), shot(3, 'camera'), shot(4)]).message,
    ).toBe(`Attached 3 of 4 camera references. S4: ${DESK_REFUSALS.changed}.`);
    expect(deskResultSummary([shot(1), shot(2)]).message).toBe(
      `Attached 0 of 2 references. S1: ${DESK_REFUSALS.changed}. S2: ${DESK_REFUSALS.changed}.`,
    );
    const mixed = [shot(1, 'motion'), shot(2, 'camera'), shot(3, 'camera'), shot(4, 'pose'), shot(5)];
    expect(deskResultSummary(mixed).message).toBe(
      `Attached 4 of 5 references: 2 camera, 1 motion, 1 pose. S5: ${DESK_REFUSALS.changed}.`,
    );
    // the mode remembered for the project: the most attached, the protocol's order on a tie
    expect(deskAttachedModes(mixed)).toEqual([
      { mode: 'camera', count: 2 },
      { mode: 'motion', count: 1 },
      { mode: 'pose', count: 1 },
    ]);
    expect(deskAttachedModes([shot(1, 'pose'), shot(2, 'motion')])[0]!.mode).toBe('motion');
    expect(deskAttachedModes([shot(1)])).toEqual([]);
  });
});
