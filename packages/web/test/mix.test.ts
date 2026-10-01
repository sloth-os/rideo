import {
  applyOps,
  DEFAULT_TRACK_IDS,
  DIALOGUE_TRACK_ID,
  duckEnvelope,
  duckGainAt,
  emptyTimeline,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { describe, expect, it } from 'vitest';
import { automateDuck } from '../src/features/editor/engine/audio';

/** The preview's ducking (docs/design/post-audio.md#ducking) automates the music bus like the render ducks it. */
describe('preview ducking', () => {
  const base = emptyTimeline({ fps: 24, width: 320, height: 180 });
  const t = applyOps(base, [
    {
      op: 'insert',
      trackId: DEFAULT_TRACK_IDS.audio,
      item: {
        kind: 'audio',
        source: { type: 'media', media: f.media({ durationSec: 20 }) },
        start: 0,
        in: 0,
        out: 12,
      },
    },
    { op: 'add_track', track: { id: DIALOGUE_TRACK_ID, kind: 'audio', name: 'Dialogue' } },
    {
      op: 'insert',
      trackId: DIALOGUE_TRACK_ID,
      item: {
        kind: 'audio',
        source: { type: 'media', media: f.media({ durationSec: 20 }) },
        start: 2,
        in: 0,
        out: 6,
        speech: [[1, 3]],
      },
    },
    { op: 'set_mix', ducking: { enabled: true, depthDb: -12 } },
  ]);

  it('schedules the shared breakpoints, offset to the playback start', () => {
    const env = duckEnvelope(t)!;
    const calls: [string, number, number][] = [];
    const param = {
      setValueAtTime: (v: number, at: number) => {
        calls.push(['set', v, at]);
        return param as unknown as AudioParam;
      },
      linearRampToValueAtTime: (v: number, at: number) => {
        calls.push(['ramp', v, at]);
        return param as unknown as AudioParam;
      },
    };
    // playing from 1 s, started at context time 100
    automateDuck(param, env, 1, 100);
    expect(calls.map(([k, , at]) => [k, Math.round((at - 100) * 1000) / 1000])).toEqual([
      ['set', 0],
      ['ramp', 1.75],
      ['ramp', 2],
      ['ramp', 4],
      ['ramp', 4.6],
    ]);
    for (const [, v, at] of calls) expect(v).toBeCloseTo(duckGainAt(env, at - 100 + 1), 9);
    // from inside the duck: start on the floor
    calls.length = 0;
    automateDuck(param, env, 4, 0);
    expect(calls[0]).toEqual(['set', expect.closeTo(env.floor, 9), 0]);
  });
});
