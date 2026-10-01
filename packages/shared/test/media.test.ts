import { describe, expect, it } from 'vitest';
import {
  analysisCommand,
  applyOps,
  atempoChain,
  chunkGraph,
  emptyTimeline,
  localProxyCommand,
  type MediaRef,
  newId,
  parseAnalysisLog,
  parseProbe,
  planChunks,
  primaryTrack,
  renderInputs,
  renderSize,
  soundtrackGraph,
  type Timeline,
  thumbnailPicks,
  totalFrames,
} from '../src';
import * as f from '../src/testing/fixtures';

describe('parseProbe (ffmpeg -i banner)', () => {
  it('reads FFmpeg 4.4 and the 5.1 wasm core alike', () => {
    const native = [
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'footage.mp4':",
      '  Duration: 00:00:09.00, start: 0.000000, bitrate: 309 kb/s',
      '  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 320x180 [SAR 1:1 DAR 16:9], 251 kb/s, 24 fps, 24 tbr, 12288 tbn, 48 tbc (default)',
      '  Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 50 kb/s (default)',
      'At least one output file must be specified',
    ];
    const wasm = [
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/in/footage.mp4':",
      '  Duration: 00:00:09.00, start: 0.000000, bitrate: 309 kb/s',
      '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 320x180 [SAR 1:1 DAR 16:9], 251 kb/s, 24 fps, 24 tbr, 12288 tbn (default)',
      '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 50 kb/s (default)',
    ];
    const expected = {
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationSec: 9,
      hasVideo: true,
      hasAudio: true,
      width: 320,
      height: 180,
      fps: 24,
      videoCodec: 'h264',
      audioCodec: 'aac',
      sampleRate: 44100,
      channels: 1,
    };
    expect(parseProbe(native)).toEqual(expected);
    expect(parseProbe(wasm.join('\n'))).toEqual(expected);
  });

  it('ignores cover art, handles stills, rotation, WebM and non-media', () => {
    expect(
      parseProbe([
        "Input #0, mp3, from 'cover.mp3':",
        '  Duration: 00:00:03.03, start: 0.025056, bitrate: 69 kb/s',
        '  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 64 kb/s',
        '  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 500x500 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn, 90k tbc (attached pic)',
      ]),
    ).toMatchObject({
      formatName: 'mp3',
      durationSec: 3.03,
      hasVideo: false,
      hasAudio: true,
      audioCodec: 'mp3',
      channels: 2,
    });
    const still = parseProbe([
      "Input #0, png_pipe, from 'still.png':",
      '  Duration: N/A, bitrate: N/A',
      '  Stream #0:0: Video: png, rgb24(pc), 640x360 [SAR 1:1 DAR 16:9], 25 fps, 25 tbr, 25 tbn, 25 tbc',
    ]);
    expect(still).toEqual({
      formatName: 'png_pipe',
      durationSec: 0,
      hasVideo: true,
      hasAudio: false,
      width: 640,
      height: 360,
      videoCodec: 'png',
    });
    expect(
      parseProbe([
        "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'phone.mov':",
        '  Duration: 00:01:02.50, start: 0.000000, bitrate: 9000 kb/s',
        '  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, bt709), 1920x1080, 8000 kb/s, 29.97 fps, 29.97 tbr, 600 tbn (default)',
        '    Side data:',
        '      displaymatrix: rotation of -90.00 degrees',
        '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, 5.1(side), fltp, 256 kb/s (default)',
      ]),
    ).toMatchObject({
      durationSec: 62.5,
      width: 1080,
      height: 1920,
      fps: 29.97,
      rotation: -90,
      videoCodec: 'hevc',
      channels: 6,
    });
    expect(
      parseProbe([
        "Input #0, matroska,webm, from 'p.webm':",
        '  Duration: 00:00:09.01, start: 0.000000, bitrate: 692 kb/s',
        '  Stream #0:0: Video: vp8, yuv420p(tv, progressive), 640x360, SAR 1:1 DAR 16:9, 24 fps, 24 tbr, 1k tbn (default)',
        '  Stream #0:1: Audio: opus, 48000 Hz, mono, fltp (default)',
      ]),
    ).toMatchObject({ width: 640, height: 360, videoCodec: 'vp8', audioCodec: 'opus', fps: 24 });
    expect(parseProbe(['DejaVuSans.ttf: Invalid data found when processing input'])).toBeNull();
  });
});

describe('analysis', () => {
  it('builds one pass for the streams that exist', () => {
    expect(analysisCommand('/in/a.mp4', { hasVideo: true, hasAudio: true }).join(' ')).toBe(
      "-hide_banner -nostats -i /in/a.mp4 -vf scale=320:-2,blackdetect=d=0.3:pix_th=0.10,select='gt(scene\\,0.3)',showinfo -af silencedetect=noise=-35dB:d=0.6,ebur128=framelog=verbose -f null -",
    );
    expect(analysisCommand('a.wav', { hasVideo: false, hasAudio: true })).toContain('-vn');
  });

  it('parses scenes, black, silences and the last loudness summary', () => {
    const log = [
      '[Parsed_ebur128_1 @ 0x1] Summary:',
      '  Integrated loudness:',
      '    I:         -70.0 LUFS',
      '[Parsed_showinfo_3 @ 0xb2] n:   0 pts:  49152 pts_time:4       pos:   147292 fmt:yuv420p sar:1/1 s:320x180 i:P iskey:0 type:P',
      '[silencedetect @ 0xb2] silence_start: 3.99996',
      '[blackdetect @ 0xb2] black_start:4 black_end:5 black_duration:1',
      '[Parsed_showinfo_3 @ 0xb2] n:   1 pts:  61440 pts_time:5       pos:   152065 fmt:yuv420p sar:1/1 s:320x180 i:P iskey:1 type:I',
      '[silencedetect @ 0xb2] silence_end: 6.50006 | silence_duration: 2.5001',
      '[Parsed_ebur128_1 @ 0xb2] Summary:',
      '  Integrated loudness:',
      '    I:         -21.9 LUFS',
    ];
    expect(parseAnalysisLog(log, 9)).toEqual({
      scenes: [
        { start: 0, end: 4 },
        { start: 4, end: 5 },
        { start: 5, end: 9 },
      ],
      silences: [{ start: 4, end: 6.5 }],
      blackSegments: [{ start: 4, end: 5 }],
      loudness: { integratedLufs: -21.9 },
    });
  });

  it('merges tiny scenes, closes an open silence and drops digital silence loudness', () => {
    const s = parseAnalysisLog(
      [
        '[Parsed_showinfo_3 @ 1] n:0 pts_time:2.0',
        '[Parsed_showinfo_3 @ 1] n:1 pts_time:2.3',
        'silence_start: 7',
        'Summary:',
        '    I:         -70.0 LUFS',
      ],
      10,
    );
    expect(s.scenes).toEqual([
      { start: 0, end: 2.3 },
      { start: 2.3, end: 10 },
    ]);
    expect(s.silences).toEqual([{ start: 7, end: 10 }]);
    expect(s.loudness).toBeNull();
    expect(parseAnalysisLog([], 5).scenes).toEqual([{ start: 0, end: 5 }]);
  });

  it('spreads at most N thumbnails over the scenes', () => {
    const scenes = Array.from({ length: 30 }, (_, i) => ({ start: i, end: i + 1 }));
    const picks = thumbnailPicks(scenes, 12);
    expect(picks).toHaveLength(12);
    expect(picks[0]).toEqual({ sceneIndex: 0, at: 0.5 });
    expect(new Set(picks.map((p) => p.sceneIndex)).size).toBe(12);
    expect(thumbnailPicks(scenes.slice(0, 3), 12).map((p) => p.sceneIndex)).toEqual([0, 1, 2]);
  });

  it('makes playable local proxies with and without audio', () => {
    expect(localProxyCommand('in.mp4', 'p.webm', { hasAudio: true })).toEqual(
      expect.arrayContaining(['libvpx', 'libopus', '-g', '12']),
    );
    expect(localProxyCommand('in.mp4', 'p.webm', { hasAudio: false })).toContain('-an');
  });
});

describe('render plan', () => {
  const a = f.media({ durationSec: 20 });
  const b = f.media({ durationSec: 30, hasAudio: false });
  const music = f.media({ durationSec: 120, mime: 'audio/mpeg' });
  const inputPath = (m: MediaRef) => `/in/${m.hash.slice(0, 8)}`;
  const textPath = (i: number) => `/text/${i}.txt`;

  function film(): { t: Timeline; ids: string[] } {
    const base = emptyTimeline({ fps: 24, width: 1920, height: 1080 });
    const video = primaryTrack(base).id;
    const audio = base.tracks.find((x) => x.kind === 'audio')!.id;
    const ids = [newId('item'), newId('item'), newId('item')];
    const t = applyOps(base, [
      {
        op: 'insert',
        trackId: video,
        item: { id: ids[0], kind: 'video', source: { type: 'media', media: a }, in: 0, out: 20, fadeIn: 1 },
      },
      {
        op: 'insert',
        trackId: video,
        item: { id: ids[1], kind: 'video', source: { type: 'media', media: b }, in: 0, out: 30 },
      },
      {
        op: 'insert',
        trackId: video,
        item: { id: ids[2], kind: 'video', source: { type: 'media', media: a }, in: 5, out: 15, speed: 2 },
      },
      { op: 'set_transition', itemId: ids[2]!, transition: { type: 'crossfade', duration: 1 } },
      {
        op: 'insert',
        trackId: audio,
        item: { kind: 'audio', source: { type: 'media', media: music }, start: 0, in: 0, out: 60, fadeIn: 2 },
      },
      {
        op: 'add_text',
        item: { kind: 'text', start: 18, duration: 4, text: "It's 5:00", style: { preset: 'title' } },
      },
    ]);
    return { t, ids };
  }

  it('cuts frame-aligned chunks at hard cuts and never inside transitions or fades', () => {
    const { t } = film();
    // video: 20 + 30 + 5 − 1 (crossfade) = 54 s; the music bed makes the film 60 s (black after 54 s)
    expect(totalFrames(t)).toBe(60 * 24);
    const chunks = planChunks(t, { targetSec: 15 });
    expect(chunks.reduce((s, c) => s + c.frames, 0)).toBe(60 * 24);
    expect(chunks[0]).toMatchObject({ start: 0, end: 20 }); // the hard cut at 20 s is near 15 s
    for (const c of chunks) {
      expect(Number.isInteger(c.start * 24 + 1e-9 - ((c.start * 24 + 1e-9) % 1))).toBe(true);
      expect(c.start < 49 || c.start >= 50).toBe(true); // crossfade 49–50 s stays whole
      expect(c.start > 0 && c.start < 1).toBe(false); // fade-in 0–1 s stays whole
    }
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.start).toBe(chunks[i - 1]!.end);
    expect(planChunks(t, { targetSec: 600 })).toHaveLength(1);
  });

  it('splits long items inside the item when there is no cut nearby', () => {
    const base = emptyTimeline({ fps: 25, width: 320, height: 180 });
    const t = applyOps(base, [
      {
        op: 'insert',
        trackId: primaryTrack(base).id,
        item: {
          kind: 'video',
          source: { type: 'media', media: f.media({ durationSec: 100 }) },
          in: 0,
          out: 100,
        },
      },
    ]);
    const chunks = planChunks(t, { targetSec: 30 });
    expect(chunks.map((c) => c.frames)).toEqual([750, 750, 1000]);
  });

  it('builds a chunk graph with seeked inputs, transitions inside the chunk, fades and clipped text', () => {
    const { t } = film();
    const chunks = planChunks(t, { targetSec: 15 });
    const withXfade = chunks.find((c) => c.start <= 49 && c.end >= 50)!;
    const g = chunkGraph(t, withXfade, {
      quality: 'standard',
      inputPath,
      textPath,
      fontFile: '/fonts/DejaVuSans.ttf',
    });
    const graph = g.args[g.args.indexOf('-filter_complex') + 1]!;
    expect(g.size).toEqual({ width: 1920, height: 1080 });
    expect(g.frames).toBe(withXfade.frames);
    expect(graph).toContain('xfade=transition=fade:duration=1');
    expect(graph).toContain('settb=AVTB');
    expect(graph.endsWith(`setpts=N/(24*TB),trim=end_frame=${withXfade.frames},format=yuv420p[vout]`)).toBe(
      true,
    );
    // after the last clip ends (54 s) the chunk is padded with black up to the music's end
    const last = chunkGraph(t, chunks.at(-1)!, { quality: 'standard', inputPath, textPath });
    expect(last.args[last.args.indexOf('-filter_complex') + 1]).toContain('tpad=stop_mode=add:stop=');
    // the second clip is entered mid-way: seeked input, no fade-in
    const first = chunkGraph(t, chunks[0]!, { quality: 'draft', inputPath, textPath });
    const g0 = first.args[first.args.indexOf('-filter_complex') + 1]!;
    expect(first.size).toEqual({ width: 1280, height: 720 });
    expect(g0).toContain('fade=t=in:st=0:d=1');
    expect(g0).toContain("enable='between(t\\,18\\,20)'");
    expect(first.textFiles).toEqual([{ path: '/text/0.txt', content: "It's 5:00" }]);
    const second = chunkGraph(t, chunks[1]!, { quality: 'draft', inputPath, textPath });
    expect(second.args.slice(0, 2)).toEqual(['-ss', '0']);
    expect(second.args[second.args.indexOf('-filter_complex') + 1]).toContain("enable='between(t\\,0\\,2)'");
  });

  it('plans one continuous soundtrack from item audio and audio tracks', () => {
    const { t } = film();
    const s = soundtrackGraph(t, { inputPath });
    const graph = s.args[s.args.indexOf('-filter_complex') + 1]!;
    expect(s.durationSec).toBe(60);
    // one bus per stem (the clips' sound is dialogue, the bed is music), then the buses summed
    expect(graph).toContain(
      '[a0][a1]amix=inputs=2:normalize=0:dropout_transition=0,apad,atrim=0:60[bus_dialogue]',
    );
    expect(graph).toContain('[a2]apad,atrim=0:60[bus_music]');
    expect(graph).toContain('[bus_dialogue][bus_music]amix=inputs=2:normalize=0:dropout_transition=0[aout]');
    expect(graph).toContain('atempo=2');
    expect(s.stems).toBeNull();
    expect(renderInputs(t)).toHaveLength(3);
    expect(atempoChain(0.25)).toBe('atempo=0.5,atempo=0.5,');
    const silent = soundtrackGraph(emptyTimeline({ fps: 24, width: 320, height: 180 }), { inputPath });
    expect(silent.args.join(' ')).toContain('anullsrc=r=48000:cl=stereo');
    expect(renderSize(t, 'high')).toEqual({ width: 1920, height: 1080 });
  });
});
