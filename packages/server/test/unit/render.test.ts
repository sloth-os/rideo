import { applyOps, emptyTimeline, newId, primaryTrack } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { describe, expect, it } from 'vitest';
import { atempoChain, buildRenderPlan, escapeFilterValue } from '../../src/media/render';

describe('render planner', () => {
  const a = f.media({ durationSec: 5 });
  const b = f.media({ durationSec: 6, hasAudio: false });
  const music = f.media({ durationSec: 30, mime: 'audio/mpeg' });
  let t = emptyTimeline({ fps: 24, width: 321, height: 181 });
  const video = primaryTrack(t).id;
  const audio = t.tracks.find((x) => x.kind === 'audio')!.id;
  const id2 = newId('item');
  t = applyOps(t, [
    {
      op: 'insert',
      trackId: video,
      item: { kind: 'video', source: { type: 'media', media: a }, in: 1, out: 5, speed: 2 },
    },
    {
      op: 'insert',
      trackId: video,
      item: { id: id2, kind: 'video', source: { type: 'media', media: b }, in: 0, out: 6 },
    },
    { op: 'set_transition', itemId: id2, transition: { type: 'dip_to_black', duration: 1 } },
    { op: 'set_effects', itemId: id2, effects: { saturation: 1.2 } },
    {
      op: 'insert',
      trackId: audio,
      item: { kind: 'audio', source: { type: 'media', media: music }, start: 0, in: 0, out: 7, fadeIn: 1 },
    },
    {
      op: 'add_text',
      item: { kind: 'text', start: 1, duration: 2, text: "It's 5:00", style: { preset: 'title' } },
    },
  ]);
  const inputs = new Map([
    [a.hash, '/m/a.mp4'],
    [b.hash, '/m/b.mp4'],
    [music.hash, '/m/music.mp3'],
  ]);

  it('builds one normalized video chain with transitions, effects, text and even dimensions', () => {
    const plan = buildRenderPlan({
      timeline: t,
      inputs,
      quality: 'standard',
      textDir: '/tmp/x',
      fontFile: '/fonts/Sans.ttf',
    });
    const graph = plan.videoArgs[plan.videoArgs.indexOf('-filter_complex') + 1]!;
    expect(plan.width).toBe(320);
    expect(plan.height).toBe(180);
    expect(plan.durationSec).toBe(7);
    expect(plan.totalFrames).toBe(168);
    expect(graph).toContain('[0:v]trim=start=1:end=5,setpts=(PTS-STARTPTS)/2');
    expect(graph).toContain('xfade=transition=fadeblack:duration=1:offset=1');
    expect(graph).toContain('eq=brightness=0:contrast=1:saturation=1.2');
    expect(graph).toContain("textfile='/tmp/x/text-0.txt'");
    expect(graph).toContain("enable='between(t\\,1\\,3)'");
    expect(plan.textFiles).toEqual([{ path: '/tmp/x/text-0.txt', content: "It's 5:00" }]);
    expect(plan.videoArgs.slice(-5)).toEqual(['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
  });

  it('mixes embedded and track audio, skipping silent media', () => {
    const plan = buildRenderPlan({ timeline: t, inputs, quality: 'draft', textDir: '/tmp/x' });
    const args = plan.audioArgs('/tmp/out.m4a');
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(args.filter((x) => x === '-i')).toHaveLength(2);
    expect(graph).toContain('atempo=2');
    expect(graph).toContain('amix=inputs=2:normalize=0');
    expect(graph).toContain('afade=t=in:st=0:d=1');
    expect(args.at(-1)).toBe('/tmp/out.m4a');
  });

  it('caps draft renders at 720p and escapes filter values', () => {
    const big = { ...t, width: 1920, height: 1080 };
    const plan = buildRenderPlan({ timeline: big, inputs, quality: 'draft', textDir: '/tmp' });
    expect([plan.width, plan.height]).toEqual([1280, 720]);
    expect(escapeFilterValue("a:b'c,d;e\\f")).toBe("a\\:b\\'c\\,d\\;e\\\\f");
    expect(atempoChain(0.25)).toBe('atempo=0.5,atempo=0.5,');
    expect(atempoChain(3)).toBe('atempo=3,');
    expect(atempoChain(1)).toBe('');
  });
});
