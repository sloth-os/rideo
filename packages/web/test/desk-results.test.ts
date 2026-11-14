import { type DeskResultMessage, ProjectSettingsSchema } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { describe, expect, it } from 'vitest';
import { applyDeskResult, type DeskResultDeps } from '../src/features/desk/results';

/** A desk's result applied in the studio (docs/design/director-desk.md#the-result). */
const bytes = (n: number) => new Uint8Array(n).buffer as ArrayBuffer;

function setup(status: 'planned' | 'approved' = 'planned') {
  const s0 = f.shot({ index: 0, durationSec: 3 });
  const s1 = f.shot({ index: 1, durationSec: 2.5 });
  const clip = f.clip({ index: 1, status, shots: [s0, s1] });
  const project = f.project({
    settings: ProjectSettingsSchema.parse({ fps: 24, resolution: { width: 1280, height: 720 } }),
  });
  const result: DeskResultMessage = {
    type: 'result',
    id: 'desk-3',
    sceneId: clip.id,
    fps: 24,
    width: 1280,
    height: 720,
    shots: [
      {
        shotId: s0.id,
        frames: 72,
        durationSec: 3,
        references: { camera: 's0.camera.mp4', motion: 's0.motion.mp4' },
        still: 's0.still.png',
        camera: { lensMm: 35, move: 'push_in' },
        line: '',
        moves: null,
        planAgrees: true,
        issues: [],
      },
      {
        shotId: s1.id,
        frames: 60,
        durationSec: 2.5,
        references: { camera: 's1.camera.mp4' },
        still: null,
        camera: { lensMm: 85, move: null },
        line: '',
        moves: null,
        planAgrees: false,
        issues: [],
      },
    ],
    files: [
      { name: 's0.camera.mp4', mime: 'video/mp4', data: bytes(11) },
      { name: 's0.motion.mp4', mime: 'video/mp4', data: bytes(12) },
      { name: 's0.still.png', mime: 'image/png', data: bytes(5) },
      { name: 's1.camera.mp4', mime: 'video/mp4', data: bytes(13) },
    ],
  };
  const uploads: { name: string; type: string; size: number; probe: unknown; poster: Blob | null }[] = [];
  const patches: [string, Record<string, unknown>][] = [];
  const posters: number[] = [];
  const deps: DeskResultDeps = {
    upload: async (file, opts) => {
      uploads.push({
        name: file.name,
        type: file.type,
        size: file.size,
        probe: opts.probe,
        poster: opts.poster,
      });
      return { id: `res_000000000000000${uploads.length}` };
    },
    patchShot: async (shotId, body) => {
      patches.push([shotId, body]);
    },
    poster: async (png) => {
      posters.push(png.byteLength);
      return new Blob(['jpeg'], { type: 'image/jpeg' });
    },
  };
  return { s0, s1, clip, project, result, uploads, patches, posters, deps };
}

describe('applyDeskResult', () => {
  it('uploads each clip in the Follow mode with its probe and JPEG poster, then sets the shot', async () => {
    const { s0, s1, clip, project, result, uploads, patches, posters, deps } = setup();
    const ack = await applyDeskResult(result, { project, clip, mode: 'motion' }, deps);
    expect(uploads.map((u) => [u.name, u.type, u.size])).toEqual([
      ['desk-c2-s1-motion.mp4', 'video/mp4', 12],
      // no motion clip for the second shot: the first of camera, motion, pose it has
      ['desk-c2-s2-camera.mp4', 'video/mp4', 13],
    ]);
    expect(uploads[0]!.probe).toMatchObject({
      hasVideo: true,
      hasAudio: false,
      videoCodec: 'h264',
      fps: 24,
      durationSec: 3,
    });
    expect(uploads[0]!.poster?.type).toBe('image/jpeg');
    expect(uploads[1]!.poster).toBeNull();
    expect(posters).toEqual([5]);
    expect(patches).toEqual([
      [
        s0.id,
        {
          motionReference: { resourceId: 'res_0000000000000001', mode: 'motion' },
          camera: { lensMm: 35, move: 'push_in' },
        },
      ],
      [
        s1.id,
        {
          motionReference: { resourceId: 'res_0000000000000002', mode: 'camera' },
          camera: { lensMm: 85, move: null },
        },
      ],
    ]);
    expect(ack).toEqual({
      ok: true,
      message: 'Attached 2 references. S2: the camera does not show the planned layout.',
      shots: [
        { shotId: s0.id, ok: true },
        { shotId: s1.id, ok: true },
      ],
    });
    // the transferred bytes are let go
    expect(result.files).toEqual([]);
  });

  it('refuses every shot of an approved clip without uploading anything', async () => {
    const { clip, project, result, uploads, patches, deps } = setup('approved');
    const ack = await applyDeskResult(result, { project, clip, mode: 'camera' }, deps);
    expect(uploads).toEqual([]);
    expect(patches).toEqual([]);
    expect(ack.ok).toBe(false);
    expect(ack.shots.map((s) => s.error)).toEqual([
      'clip 2 is approved: unapprove it to change its shots',
      'clip 2 is approved: unapprove it to change its shots',
    ]);
    expect(ack.message).toBe(
      'Attached 0 of 2 references. S1: clip 2 is approved: unapprove it to change its shots. S2: clip 2 is approved: unapprove it to change its shots.',
    );
  });

  it('goes on with the other shots when one fails', async () => {
    const { s1, clip, project, result, patches, deps } = setup();
    let calls = 0;
    const failing: DeskResultDeps = {
      ...deps,
      upload: async (file, opts) => {
        if (++calls === 1) throw new Error('the upload was refused');
        return deps.upload(file, opts);
      },
    };
    const ack = await applyDeskResult(result, { project, clip, mode: 'camera' }, failing);
    expect(patches.map(([id]) => id)).toEqual([s1.id]);
    expect(ack.ok).toBe(false);
    expect(ack.shots[0]).toMatchObject({ ok: false, error: 'the upload was refused' });
    expect(ack.message).toMatch(/^Attached 1 of 2 references\. S1: the upload was refused\./);
  });
});
