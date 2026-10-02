import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  type AudioItem,
  exportCut,
  framedPicture,
  fromOtio,
  type InterchangeContext,
  interchangeFileName,
  lanes,
  layoutPrimary,
  type MediaRef,
  normalizeMediaBase,
  type Source,
  type TextItem,
  type Timeline,
  TimelineSchema,
  timecode,
  toEdl,
  toFcpxml,
  toOtio,
  toXmeml,
  type VideoItem,
} from '../src';
import * as f from '../src/testing/fixtures';

const media = (name: string, over: Partial<MediaRef> = {}): MediaRef =>
  f.media({ path: `media/takes/${name}.mp4`, durationSec: 8, hasAudio: true, ...over });
const takeSource = (m: MediaRef): Source => ({
  type: 'take',
  clipId: 'clp_000000000001',
  shotId: 'sht_000000000001',
  takeId: 'tak_000000000001',
  media: m,
});

/** A cut with a take, a sped-up resource with a crossfade, a muted clip with a wipe, music and a title. */
function cut(): Timeline {
  const a = media('lighthouse-a1b2c3d4e5f6');
  const b = media('letters-b2c3d4e5f6a1');
  const c = media('stairs-c3d4e5f6a1b2', { hasAudio: false });
  const music = f.media({ path: 'media/music/score-d4e5f6a1b2c3.mp3', mime: 'audio/mpeg', durationSec: 30 });
  const picture: VideoItem[] = [
    {
      id: 'itm_00000000000a',
      kind: 'video',
      source: takeSource(a),
      start: 0,
      in: 0,
      out: 4,
      speed: 1,
      volume: 0.5,
      fadeIn: 0.5,
    },
    {
      id: 'itm_00000000000b',
      kind: 'video',
      source: { type: 'media', media: b, resourceId: 'res_000000000001' },
      start: 0,
      in: 1,
      out: 5,
      speed: 2,
      volume: 1,
      transitionIn: { type: 'crossfade', duration: 0.5 },
      label: 'Letters <from> the "future" & more',
    },
    {
      id: 'itm_00000000000c',
      kind: 'video',
      source: { type: 'media', media: c },
      start: 0,
      in: 0,
      out: 2,
      speed: 1,
      volume: 1,
      muted: true,
      transitionIn: { type: 'wipe', duration: 0.25 },
      effects: { saturation: 0.5 },
    },
  ];
  const audio: AudioItem[] = [
    {
      id: 'itm_00000000000m',
      kind: 'audio',
      source: { type: 'media', media: music },
      start: 0.5,
      in: 0,
      out: 3,
      volume: 0.8,
    },
    {
      id: 'itm_00000000000n',
      kind: 'audio',
      source: { type: 'media', media: music },
      start: 2,
      in: 10,
      out: 12,
      volume: 1,
      fadeOut: 1,
    },
  ];
  const title: TextItem = {
    id: 'itm_00000000000t',
    kind: 'text',
    start: 0,
    duration: 2,
    text: 'The <Keeper> & "friends"',
    style: { preset: 'title', color: '#FF6B3D' },
  };
  const t = TimelineSchema.parse({
    version: 1,
    fps: 24,
    width: 1920,
    height: 1080,
    tracks: [
      { id: 'trk_primaryvideo01', kind: 'video', name: 'Video', items: picture },
      { id: 'trk_musicbed000001', kind: 'audio', name: 'Music', items: audio },
      { id: 'trk_titles00000001', kind: 'text', name: 'Titles', items: [title] },
    ],
  });
  layoutPrimary(t.tracks[0]!);
  return t;
}

const ctx: InterchangeContext = {
  title: 'The Keeper',
  mediaUrl: (m) => `file:///Volumes/dav/rideo/projects/prj_000000000001/${m.path}`,
  notes: (item) =>
    item.source.type === 'take'
      ? [
          { at: 1.5, author: 'Cleo', body: 'The lamp flickers' },
          { at: 7, author: 'Ben', body: 'outside the shown range' },
        ]
      : [],
};

/** Numbers rounded so float noise does not count. */
const settle = (v: unknown): unknown =>
  typeof v === 'number'
    ? Math.round(v * 1e6) / 1e6
    : Array.isArray(v)
      ? v.map(settle)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, settle(x)]))
        : v;

describe('interchange basics (docs/design/interchange.md)', () => {
  it('formats timecode, media locations and file names', () => {
    expect(timecode(0, 24)).toBe('00:00:00:00');
    expect(timecode(3600 * 24 + 25, 24)).toBe('01:00:01:01');
    expect(timecode(59 * 60 * 30 + 29, 30)).toBe('00:59:00:29');
    expect(normalizeMediaBase('https://studio.test/dav/rideo/')).toBe('https://studio.test/dav/rideo');
    expect(normalizeMediaBase('/Volumes/My Share/rideo')).toBe('file:///Volumes/My%20Share/rideo');
    expect(normalizeMediaBase('Z:\\rideo\\')).toBe('file:///Z:/rideo');
    expect(interchangeFileName('The Keeper: Act 1', 'fcpxml')).toBe('the-keeper-act-1.fcpxml');
    expect(
      lanes([
        { start: 0, end: 5 },
        { start: 2, end: 3 },
        { start: 5, end: 6 },
      ]).map((l) => l.length),
    ).toEqual([2, 1]);
  });

  it('cuts at the incoming clip of a transition, the outgoing one keeping its handle', () => {
    const t = cut();
    const items = t.tracks[0]!.items as VideoItem[];
    expect(items.map((i) => i.start)).toEqual([0, 3.5, 5.25]);
    const framed = framedPicture(t);
    expect(framed.map((c) => [c.start, c.end, c.in, c.out, c.transition?.frames ?? null])).toEqual([
      [0, 84, 0, 84, null], // 0–3.5 s shown, the last 0.5 s of its 4 s is the crossfade's handle
      [84, 126, 24, 108, 12], // 2× speed: 1.75 s of record shows 3.5 s of media
      [126, 174, 0, 48, 6],
    ]);
  });
});

describe('OpenTimelineIO', () => {
  it('writes tracks, clips with their WebDAV originals, transitions, speed, notes and titles', () => {
    const otio = toOtio(cut(), ctx) as any;
    expect(otio).toMatchObject({
      OTIO_SCHEMA: 'Timeline.1',
      name: 'The Keeper',
      global_start_time: { rate: 24, value: 86400 },
    });
    const tracks = otio.tracks.children;
    expect(tracks.map((t: any) => [t.name, t.kind])).toEqual([
      ['Video', 'Video'],
      ['Production sound', 'Audio'],
      ['Music', 'Audio'],
      ['Music 2', 'Audio'],
    ]);
    const [a, cross, b, wipe, c] = tracks[0].children;
    expect(a.media_reference.target_url).toBe(
      'file:///Volumes/dav/rideo/projects/prj_000000000001/media/takes/lighthouse-a1b2c3d4e5f6.mp4',
    );
    expect(a.source_range).toMatchObject({ start_time: { value: 0 }, duration: { value: 84 } });
    expect(a.markers.map((m: any) => [m.name, m.comment, m.marked_range.start_time.value])).toEqual([
      ['Cleo', 'The lamp flickers', 36],
    ]);
    expect(cross).toMatchObject({
      OTIO_SCHEMA: 'Transition.1',
      transition_type: 'SMPTE_Dissolve',
      in_offset: { value: 0 },
      out_offset: { value: 12 },
    });
    expect(b.effects).toEqual([expect.objectContaining({ OTIO_SCHEMA: 'LinearTimeWarp.1', time_scalar: 2 })]);
    expect(b.source_range).toMatchObject({ start_time: { value: 24 }, duration: { value: 42 } });
    expect(wipe).toMatchObject({ transition_type: 'Custom_Transition', name: 'wipe' });
    expect(c.metadata.rideo.muted).toBe(true);
    // the muted clip's sound is a gap; the crossfade into the muted clip is not on the sound track
    expect(tracks[1].children.map((x: any) => x.OTIO_SCHEMA)).toEqual([
      'Clip.1',
      'Transition.1',
      'Clip.1',
      'Gap.1',
    ]);
    expect(tracks[3].children.map((x: any) => [x.OTIO_SCHEMA, x.source_range.duration.value])).toEqual([
      ['Gap.1', 48],
      ['Clip.1', 48],
    ]);
    expect(otio.tracks.markers).toMatchObject([
      { name: 'The <Keeper> & "friends"', marked_range: { duration: { value: 48 } }, color: 'PURPLE' },
    ]);
  });

  it('reads its own export back into the same cut', () => {
    const t = cut();
    const back = fromOtio(JSON.parse(exportCut('otio', t, ctx)), {
      base: t,
      resolve: (clip) =>
        ((clip.rideo?.item as { source?: Source } | undefined)?.source ?? null) as Source | null,
    });
    expect(back.unresolved).toEqual([]);
    expect(back.skipped).toEqual([]);
    expect(back.clips).toBe(5);
    expect(settle(back.timeline)).toEqual(settle(t));
  });

  it('reads a foreign timeline: handles, gaps, other tracks, unknown media and speed limits', () => {
    const t = cut();
    const known = media('lighthouse-a1b2c3d4e5f6');
    const rt = (value: number) => ({ OTIO_SCHEMA: 'RationalTime.1', rate: 25, value });
    const tr = (start: number, dur: number) => ({
      OTIO_SCHEMA: 'TimeRange.1',
      start_time: rt(start),
      duration: rt(dur),
    });
    const clip2 = (name: string, url: string, start: number, dur: number, effects: unknown[] = []) => ({
      OTIO_SCHEMA: 'Clip.2',
      name,
      source_range: tr(start, dur),
      media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: 'ExternalReference.1', target_url: url } },
      active_media_reference_key: 'DEFAULT_MEDIA',
      effects,
    });
    const doc = {
      OTIO_SCHEMA: 'Timeline.1',
      name: 'Resolve cut',
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        children: [
          {
            OTIO_SCHEMA: 'Track.1',
            kind: 'Video',
            name: 'V1',
            children: [
              clip2(
                'Opening',
                'file:///Volumes/dav/rideo/projects/prj_000000000001/media/takes/lighthouse-a1b2c3d4e5f6.mp4',
                25,
                50,
              ),
              { OTIO_SCHEMA: 'Gap.1', source_range: tr(0, 10) },
              clip2('Lost', 'file:///elsewhere/unknown.mov', 0, 25),
              clip2('Again', 'file:///x/lighthouse-a1b2c3d4e5f6.mp4', 50, 50, [
                { OTIO_SCHEMA: 'LinearTimeWarp.1', time_scalar: 8 },
              ]),
              {
                OTIO_SCHEMA: 'Transition.1',
                transition_type: 'SMPTE_Dissolve',
                in_offset: rt(5),
                out_offset: rt(5),
              },
              clip2('Close', 'file:///y/lighthouse-a1b2c3d4e5f6.mp4', 100, 25),
            ],
          },
          { OTIO_SCHEMA: 'Track.1', kind: 'Video', name: 'V2', children: [] },
          {
            OTIO_SCHEMA: 'Track.1',
            kind: 'Audio',
            name: 'music',
            children: [
              { OTIO_SCHEMA: 'Gap.1', source_range: tr(0, 25) },
              clip2('Bed', 'file:///z/lighthouse-a1b2c3d4e5f6.mp4', 0, 50),
            ],
          },
          { OTIO_SCHEMA: 'Track.1', kind: 'Audio', name: 'Room tone', children: [] },
        ],
      },
    };
    const resolve = (c: { url: string | null }) =>
      c.url?.endsWith('lighthouse-a1b2c3d4e5f6.mp4') ? ({ type: 'media', media: known } as Source) : null;
    let n = 0;
    const r = fromOtio(doc, {
      base: t,
      resolve,
      newId: (k) => `${k === 'item' ? 'itm' : 'trk'}_${String(++n).padStart(12, '0')}`,
    });
    expect(r.name).toBe('Resolve cut');
    expect(r.unresolved).toEqual([{ name: 'Lost', url: 'file:///elsewhere/unknown.mov' }]);
    expect(r.skipped).toEqual([
      'video track “V2” (Rideo cuts have one picture track)',
      'speed 8× on “Again” (Rideo plays 0.25–4×)',
      '“Again” runs past the end of its media',
      'transition into “Close” shortened: “Again” has no more media',
      "1 gap(s) in the picture track (closed: Rideo's picture track has no gaps)",
    ]);
    const picture = r.timeline.tracks[0]!.items as VideoItem[];
    expect(picture.map((i) => [i.label, i.in, i.out, i.speed, i.transitionIn?.duration ?? null])).toEqual([
      ['Opening', 1, 3, 1, null],
      // 4× from 2 s for 2 s would run past its 8 s: clamped, so the dissolve keeps only the incoming handle
      ['Again', 2, 8, 4, null],
      ['Close', 3.8, 5, 1, 0.2],
    ]);
    const music = r.timeline.tracks.find((x) => x.name === 'Music')!.items as AudioItem[];
    expect(music.map((i) => [i.start, i.in, i.out])).toEqual([[1, 0, 2]]);
    expect(r.timeline.tracks.map((x) => x.name)).toEqual(['Video', 'Music', 'Titles', 'Room tone']);
    // no Rideo text markers: the titles stay
    expect(r.timeline.tracks[2]!.items).toHaveLength(1);
    expect(() => fromOtio({ OTIO_SCHEMA: 'Clip.1' }, { base: t, resolve })).toThrow(ZodError);
  });
});

describe('FCPXML, XML and EDL', () => {
  it('writes FCPXML 1.10 with assets on WebDAV, the spine, connected sound, titles and markers', () => {
    const xml = toFcpxml(cut(), ctx);
    expect(
      xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10">'),
    ).toBe(true);
    expect(xml).toContain(
      '<format id="r1" name="FFVideoFormat1080p24" frameDuration="1/24s" width="1920" height="1080"',
    );
    expect(xml).toContain(
      '<media-rep kind="original-media" src="file:///Volumes/dav/rideo/projects/prj_000000000001/media/takes/lighthouse-a1b2c3d4e5f6.mp4"/>',
    );
    expect(xml).toContain('<sequence format="r1" duration="174/24s" tcStart="86400/24s" tcFormat="NDF"');
    expect(xml).toMatch(
      /<asset-clip ref="r2" offset="86400\/24s" name="lighthouse-a1b2c3d4e5f6.mp4" start="0s" duration="84\/24s"/,
    );
    expect(xml).toContain('<adjust-volume amount="-6.0dB"/>');
    expect(xml).toContain('<transition name="Cross Dissolve" offset="86484/24s" duration="12/24s">');
    expect(xml).toContain('<transition name="Wipe" offset="86526/24s" duration="6/24s">');
    expect(xml).toContain('<timept time="24/24s" value="24/24s" interp="linear"/>');
    expect(xml).toContain('<timept time="66/24s" value="108/24s" interp="linear"/>');
    expect(xml).toContain('name="Letters &lt;from&gt; the &quot;future&quot; &amp; more"');
    expect(xml).toContain('<marker start="36/24s" duration="1/24s" value="Cleo: The lamp flickers"/>');
    expect(xml).toContain('<text-style ref="ts1">The &lt;Keeper&gt; &amp; &quot;friends&quot;</text-style>');
    expect(xml).toContain('fontColor="1.000 0.420 0.239 1"');
    // music connected to the clips that hold its start, in their local time, on lanes below
    expect(xml).toMatch(
      /<asset-clip ref="r5" lane="-1" offset="12\/24s" name="score-d4e5f6a1b2c3.mp3" start="0s" duration="72\/24s" audioRole="music">/,
    );
    expect(xml).toMatch(
      /<asset-clip ref="r5" lane="-2" offset="48\/24s" name="score-d4e5f6a1b2c3.mp3" start="240\/24s" duration="48\/24s" audioRole="music"\/>/,
    );
  });

  it('writes Final Cut Pro 7 XML with linked sound, transitions, speed and files defined once', () => {
    const xml = toXmeml(cut(), ctx);
    expect(
      xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5">'),
    ).toBe(true);
    expect(xml).toContain('<string>01:00:00:00</string>');
    expect(xml.match(/<pathurl>/g)).toHaveLength(4);
    expect(xml.match(/<file id="file-1"\/>/g)?.length).toBeGreaterThanOrEqual(1);
    expect(xml).toContain('<alignment>start</alignment>');
    expect(xml).toContain('<effectid>Cross Dissolve</effectid>');
    expect(xml).toContain('<effectid>Edge Wipe</effectid>');
    expect(xml).toContain('<value>200</value>');
    expect(xml).toMatch(/<start>84<\/start>\s+<end>126<\/end>\s+<in>24<\/in>\s+<out>108<\/out>/);
    expect(xml).toContain('<linkclipref>clipitem-a1</linkclipref>');
    expect(xml).toMatch(
      /<marker>\s+<name>Cleo<\/name>\s+<comment>The lamp flickers<\/comment>\s+<in>36<\/in>/,
    );
    expect(xml).toContain('<comment>title: The &lt;Keeper&gt; &amp; &quot;friends&quot;</comment>');
  });

  it('writes a CMX 3600 EDL of the picture with dissolves, wipes, speed and relink comments', () => {
    const edl = toEdl(cut(), ctx);
    expect(edl.split('\n').slice(0, 12)).toEqual([
      'TITLE: The Keeper',
      'FCM: NON-DROP FRAME',
      '',
      '001  AX       B     C        00:00:00:00 00:00:03:12 01:00:00:00 01:00:03:12',
      '* FROM CLIP NAME: lighthouse-a1b2c3d4e5f6.mp4',
      '* SOURCE FILE: lighthouse-a1b2c3d4e5f6.mp4',
      '* SOURCE URL: file:///Volumes/dav/rideo/projects/prj_000000000001/media/takes/lighthouse-a1b2c3d4e5f6.mp4',
      '* COMMENT: 00:00:01:12 Cleo: The lamp flickers',
      '* TITLE: 01:00:00:00 The <Keeper> & "friends"',
      '',
      '002  AX       B     C        00:00:03:12 00:00:03:12 01:00:03:12 01:00:03:12',
      '002  AX       B     D    012 00:00:01:00 00:00:04:12 01:00:03:12 01:00:05:06',
    ]);
    expect(edl).toContain('M2   AX       048.0                00:00:01:00');
    expect(edl).toContain('003  AX       V     W001 006 00:00:00:00 00:00:02:00 01:00:05:06 01:00:07:06');
    expect(edl).toContain('* TO CLIP NAME: stairs-c3d4e5f6a1b2.mp4');
  });
});
