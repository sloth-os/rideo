import type { MediaRef } from '../schemas/common';
import type { Timeline } from '../schemas/timeline';
import { trackRole } from '../timeline/ops';
import {
  clipLabel,
  type FramedClip,
  framedAudio,
  framedPicture,
  hasSound,
  type InterchangeContext,
  lanes,
  mediaFileName,
  RECORD_START_SEC,
  textItems,
  toFrames,
  type XmlNode,
  x,
  xmlDocument,
} from './common';

/** FCPXML 1.10 (docs/design/interchange.md#mapping): the spine, connected sound and titles, markers. */

const CROSS_DISSOLVE_UID = 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265';
const BASIC_TITLE_UID = '.../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti';
const TRANSITION_NAME = { crossfade: 'Cross Dissolve', wipe: 'Wipe', dip_to_black: 'Dip to Black' } as const;

export function toFcpxml(t: Timeline, ctx: InterchangeContext): string {
  const fps = t.fps;
  /** Frames as FCPXML rational time. */
  const tm = (frames: number) => (frames === 0 ? '0s' : `${frames}/${fps}s`);
  const origin = RECORD_START_SEC * fps;
  const picture = framedPicture(t);
  // One lane per track, more where its items overlap: lanes −1, −2, … below the picture.
  const audioTracks = t.tracks
    .filter((tr) => tr.kind === 'audio')
    .flatMap((tr) => lanes(framedAudio(t, tr)).map((clips) => ({ role: trackRole(tr) ?? 'effects', clips })));

  // Resources: the format, one asset per media file, the effects used
  const assets = new Map<string, { id: string; media: MediaRef }>();
  let next = 2;
  const assetOf = (media: MediaRef) => {
    let a = assets.get(media.path);
    if (!a) {
      a = { id: `r${next++}`, media };
      assets.set(media.path, a);
    }
    return a.id;
  };
  for (const c of picture) assetOf(c.item.source.media);
  for (const track of audioTracks) for (const c of track.clips) assetOf(c.item.source.media);
  const dissolveId = picture.some((c) => c.transition) ? `r${next++}` : null;
  const titles = textItems(t);
  const titleId = titles.length ? `r${next++}` : null;

  const total = Math.max(
    picture.at(-1)?.end ?? 0,
    ...audioTracks.flatMap((tr) => tr.clips).map((c) => c.end),
    ...titles.map((i) => toFrames(i.start + i.duration, fps)),
  );

  // Connected items hang from the spine clip that holds their start, in its local (source) time.
  type Anchor = { start: number; end: number; local: (record: number) => number; children: XmlNode[] };
  const anchors: Anchor[] = picture.map((c) => ({
    start: c.start,
    end: c.end,
    local: (record) => c.in + Math.round((record - c.start) * c.speed),
    children: [],
  }));
  // Past the picture's end, a gap at the end of the spine holds them.
  const after: { gap: Anchor | null } = { gap: null };
  const anchorAt = (record: number): Anchor => {
    const a = anchors.find((x) => record >= x.start && record < x.end);
    if (a) return a;
    if (!after.gap) {
      const start = picture.at(-1)?.end ?? 0;
      after.gap = {
        start,
        end: Math.max(total, start + 1),
        local: (r) => origin + (r - start),
        children: [],
      };
    }
    return after.gap;
  };
  audioTracks.forEach((track, k) => {
    for (const c of track.clips) {
      const a = anchorAt(c.start);
      const volume = c.item.volume;
      a.children.push(
        x(
          'asset-clip',
          {
            ref: assetOf(c.item.source.media),
            lane: -(k + 1),
            offset: tm(a.local(c.start)),
            name: clipLabel(c.item),
            start: tm(c.in),
            duration: tm(c.end - c.start),
            audioRole: track.role,
          },
          volume !== 1 ? x('adjust-volume', { amount: dB(volume) }) : null,
        ),
      );
    }
  });
  titles.forEach((item, k) => {
    const start = toFrames(item.start, fps);
    const a = anchorAt(start);
    const id = `ts${k + 1}`;
    a.children.push(
      x(
        'title',
        {
          ref: titleId,
          lane: 1,
          offset: tm(a.local(start)),
          name: item.text.slice(0, 80),
          start: tm(origin),
          duration: tm(Math.max(1, toFrames(item.duration, fps))),
        },
        x('text', null, x('text-style', { ref: id }, item.text)),
        x(
          'text-style-def',
          { id },
          x('text-style', {
            font: 'Helvetica',
            fontSize: item.style.size ?? (item.style.preset === 'title' ? 72 : 48),
            fontColor: rgba(item.style.color ?? '#FFFFFF'),
            alignment: item.style.align ?? 'center',
          }),
        ),
      ),
    );
  });

  const spine: XmlNode[] = [];
  picture.forEach((c, i) => {
    if (c.transition) {
      spine.push(
        x(
          'transition',
          {
            name: TRANSITION_NAME[c.transition.type],
            offset: tm(origin + c.start),
            duration: tm(c.transition.frames),
          },
          x('filter-video', { ref: dissolveId, name: 'Cross Dissolve' }),
        ),
      );
    }
    spine.push(assetClip(c, anchors[i]!.children));
  });
  if (after.gap)
    spine.push(
      x(
        'gap',
        {
          name: 'Gap',
          offset: tm(origin + after.gap.start),
          start: tm(origin),
          duration: tm(after.gap.end - after.gap.start),
        },
        after.gap.children,
      ),
    );

  function assetClip(c: FramedClip, children: XmlNode[]): XmlNode {
    const item = c.item;
    const dur = c.end - c.start;
    const notes = (item.kind === 'video' ? (ctx.notes?.(item) ?? []) : [])
      .map((n) => ({ ...n, f: toFrames(n.at, fps) }))
      .filter((n) => n.f >= c.in && n.f <= c.out);
    const volume = item.kind === 'video' && !hasSound(item) ? 0 : item.volume;
    return x(
      'asset-clip',
      {
        ref: assetOf(item.source.media),
        offset: tm(origin + c.start),
        name: clipLabel(item),
        start: tm(c.in),
        duration: tm(dur),
        format: 'r1',
        tcFormat: 'NDF',
      },
      c.speed !== 1
        ? x(
            'timeMap',
            null,
            x('timept', { time: tm(c.in), value: tm(c.in), interp: 'linear' }),
            x('timept', {
              time: tm(c.in + dur),
              value: tm(c.in + Math.round(dur * c.speed)),
              interp: 'linear',
            }),
          )
        : null,
      volume !== 1 ? x('adjust-volume', { amount: dB(volume) }) : null,
      children,
      notes.map((n) =>
        x('marker', { start: tm(n.f), duration: tm(1), value: `${n.author}: ${n.body}`.slice(0, 500) }),
      ),
    );
  }

  const resources: XmlNode[] = [
    x('format', {
      id: 'r1',
      name: `FFVideoFormat${t.height}p${fps}`,
      frameDuration: `1/${fps}s`,
      width: t.width,
      height: t.height,
      colorSpace: '1-1-1 (Rec. 709)',
    }),
    ...[...assets.values()].map(({ id, media }) =>
      x(
        'asset',
        {
          id,
          name: mediaFileName(media),
          uid: media.hash.toUpperCase(),
          start: '0s',
          duration: tm(toFrames(media.durationSec ?? 3600, fps)),
          hasVideo: media.mime.startsWith('video/') ? 1 : 0,
          format: media.mime.startsWith('video/') ? 'r1' : undefined,
          hasAudio: media.hasAudio === false ? 0 : 1,
          audioSources: media.hasAudio === false ? undefined : 1,
          audioChannels: media.hasAudio === false ? undefined : 2,
          audioRate: media.hasAudio === false ? undefined : 48000,
        },
        x('media-rep', { kind: 'original-media', src: ctx.mediaUrl(media) }),
      ),
    ),
    dissolveId ? x('effect', { id: dissolveId, name: 'Cross Dissolve', uid: CROSS_DISSOLVE_UID }) : null,
    titleId ? x('effect', { id: titleId, name: 'Basic Title', uid: BASIC_TITLE_UID }) : null,
  ].filter((r): r is XmlNode => !!r);

  const root = x(
    'fcpxml',
    { version: '1.10' },
    x('resources', null, resources),
    x(
      'library',
      null,
      x(
        'event',
        { name: 'Rideo' },
        x(
          'project',
          { name: ctx.title },
          x(
            'sequence',
            {
              format: 'r1',
              duration: tm(total),
              tcStart: tm(origin),
              tcFormat: 'NDF',
              audioLayout: 'stereo',
              audioRate: '48k',
            },
            x('spine', null, spine),
          ),
        ),
      ),
    ),
  );
  return xmlDocument('fcpxml', root);
}

/** Gain as FCPXML decibels (silence is −96 dB). */
function dB(gain: number): string {
  if (gain <= 0) return '-96dB';
  return `${(Math.round(20 * Math.log10(gain) * 10) / 10).toFixed(1)}dB`;
}

/** `#RRGGBB` as FCPXML `r g b a` (0–1). */
function rgba(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3)).join(' ') + ' 1';
}
