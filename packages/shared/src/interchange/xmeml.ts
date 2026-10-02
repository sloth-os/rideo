import type { MediaRef } from '../schemas/common';
import type { AudioItem, Timeline, VideoItem } from '../schemas/timeline';
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
  timecode,
  toFrames,
  type XmlNode,
  x,
  xmlDocument,
} from './common';

/**
 * Final Cut Pro 7 XML, `xmeml` version 5 (docs/design/interchange.md#mapping): what Premiere Pro and DaVinci Resolve
 * import as "XML". The picture on video track 1 with its sound linked on audio track 1, then the sound tracks.
 */

const TRANSITIONS = {
  crossfade: { name: 'Cross Dissolve', category: 'Dissolve' },
  wipe: { name: 'Edge Wipe', category: 'Wipe' },
  dip_to_black: { name: 'Dip to Color Dissolve', category: 'Dissolve' },
} as const;

export function toXmeml(t: Timeline, ctx: InterchangeContext): string {
  const fps = t.fps;
  const rate = () => x('rate', null, x('timebase', null, fps), x('ntsc', null, 'FALSE'));
  const picture = framedPicture(t);
  const sound = t.tracks.filter((tr) => tr.kind === 'audio').flatMap((tr) => lanes(framedAudio(t, tr)));
  const total = Math.max(picture.at(-1)?.end ?? 0, ...sound.flat().map((c) => c.end));

  const files = new Map<string, string>();
  const file = (media: MediaRef): XmlNode => {
    const known = files.get(media.path);
    if (known) return x('file', { id: known });
    const id = `file-${files.size + 1}`;
    files.set(media.path, id);
    const video = media.mime.startsWith('video/');
    return x(
      'file',
      { id },
      x('name', null, mediaFileName(media)),
      x('pathurl', null, ctx.mediaUrl(media)),
      rate(),
      x('duration', null, toFrames(media.durationSec ?? 0, fps)),
      x(
        'timecode',
        null,
        rate(),
        x('string', null, timecode(0, fps)),
        x('frame', null, 0),
        x('displayformat', null, 'NDF'),
      ),
      x(
        'media',
        null,
        video
          ? x(
              'video',
              null,
              x(
                'samplecharacteristics',
                null,
                rate(),
                x('width', null, media.width ?? t.width),
                x('height', null, media.height ?? t.height),
              ),
            )
          : null,
        media.hasAudio === false
          ? null
          : x(
              'audio',
              null,
              x('samplecharacteristics', null, x('depth', null, 16), x('samplerate', null, 48000)),
              x('channelcount', null, 2),
            ),
      ),
    );
  };

  let clipCount = 0;
  const ids = new Map<FramedClip, string>();
  const idOf = (c: FramedClip) => {
    let id = ids.get(c);
    if (!id) {
      id = `clipitem-${++clipCount}`;
      ids.set(c, id);
    }
    return id;
  };
  const audioLinked = new Map<FramedClip, string>();
  const levels = (gain: number) =>
    x(
      'filter',
      null,
      x(
        'effect',
        null,
        x('name', null, 'Audio Levels'),
        x('effectid', null, 'audiolevels'),
        x('effectcategory', null, 'audiolevels'),
        x('effecttype', null, 'audiolevels'),
        x('mediatype', null, 'audio'),
        x(
          'parameter',
          null,
          x('parameterid', null, 'level'),
          x('name', null, 'Level'),
          x('valuemin', null, 0),
          x('valuemax', null, 3.98109),
          x('value', null, Math.round(gain * 1e4) / 1e4),
        ),
      ),
    );
  const remap = (speed: number) =>
    x(
      'filter',
      null,
      x(
        'effect',
        null,
        x('name', null, 'Time Remap'),
        x('effectid', null, 'timeremap'),
        x('effectcategory', null, 'motion'),
        x('effecttype', null, 'motion'),
        x('mediatype', null, 'video'),
        x(
          'parameter',
          null,
          x('parameterid', null, 'speed'),
          x('name', null, 'speed'),
          x('valuemin', null, -100000),
          x('valuemax', null, 100000),
          x('value', null, Math.round(speed * 10000) / 100),
        ),
        x(
          'parameter',
          null,
          x('parameterid', null, 'reverse'),
          x('name', null, 'reverse'),
          x('value', null, 'FALSE'),
        ),
        x(
          'parameter',
          null,
          x('parameterid', null, 'frameblending'),
          x('name', null, 'frameblending'),
          x('value', null, 'FALSE'),
        ),
      ),
    );
  const link = (clipId: string, mediatype: 'video' | 'audio', trackindex: number, clipindex: number) =>
    x(
      'link',
      null,
      x('linkclipref', null, clipId),
      x('mediatype', null, mediatype),
      x('trackindex', null, trackindex),
      x('clipindex', null, clipindex),
    );

  const clipitem = (
    c: FramedClip,
    kind: 'video' | 'audio',
    opts: { links?: XmlNode[]; markers?: XmlNode[]; gain?: number; trackIndex?: number } = {},
  ) =>
    x(
      'clipitem',
      { id: kind === 'video' ? idOf(c) : (audioLinked.get(c) ?? idOf(c)) },
      x('name', null, clipLabel(c.item)),
      x('enabled', null, 'TRUE'),
      x('duration', null, toFrames(c.item.source.media.durationSec ?? 0, fps) || c.out),
      rate(),
      x('start', null, c.start),
      x('end', null, c.end),
      x('in', null, c.in),
      x('out', null, c.out),
      file(c.item.source.media),
      kind === 'audio'
        ? x('sourcetrack', null, x('mediatype', null, 'audio'), x('trackindex', null, opts.trackIndex ?? 1))
        : null,
      kind === 'video' && c.speed !== 1 ? remap(c.speed) : null,
      kind === 'audio' && opts.gain !== undefined && opts.gain !== 1 ? levels(opts.gain) : null,
      opts.links ?? [],
      opts.markers ?? [],
    );

  // Picture, with the transitions between its clips
  const pictureNodes: XmlNode[] = [];
  const soundOfPicture: XmlNode[] = [];
  picture.forEach((c, i) => {
    const item = c.item as VideoItem;
    if (c.transition) {
      const tr = TRANSITIONS[c.transition.type];
      pictureNodes.push(
        x(
          'transitionitem',
          null,
          x('start', null, c.start),
          x('end', null, c.start + c.transition.frames),
          x('alignment', null, 'start'),
          rate(),
          x(
            'effect',
            null,
            x('name', null, tr.name),
            x('effectid', null, tr.name),
            x('effectcategory', null, tr.category),
            x('effecttype', null, 'transition'),
            x('mediatype', null, 'video'),
          ),
        ),
      );
    }
    const linked = hasSound(item);
    const audioId = linked ? `clipitem-a${i + 1}` : null;
    if (audioId) audioLinked.set(c, audioId);
    const links = audioId
      ? [link(idOf(c), 'video', 1, i + 1), link(audioId, 'audio', 1, soundOfPicture.length + 1)]
      : [];
    const notes = (ctx.notes?.(item) ?? [])
      .map((n) => ({ ...n, f: toFrames(n.at, fps) }))
      .filter((n) => n.f >= c.in && n.f <= c.out)
      .map((n) =>
        x(
          'marker',
          null,
          x('name', null, n.author),
          x('comment', null, n.body),
          x('in', null, n.f),
          x('out', null, -1),
        ),
      );
    pictureNodes.push(clipitem(c, 'video', { links, markers: notes }));
    if (audioId) soundOfPicture.push(clipitem(c, 'audio', { links, gain: item.volume, trackIndex: 1 }));
  });

  const audioTracks: XmlNode[] = [];
  if (soundOfPicture.length) audioTracks.push(x('track', null, soundOfPicture));
  for (const lane of sound)
    audioTracks.push(
      x(
        'track',
        null,
        lane.map((c) => clipitem(c, 'audio', { gain: (c.item as AudioItem).volume, trackIndex: 1 })),
      ),
    );

  const markers = textItems(t).map((item) =>
    x(
      'marker',
      null,
      x('name', null, item.text.slice(0, 80)),
      x('comment', null, `${item.style.preset}: ${item.text}`),
      x('in', null, toFrames(item.start, fps)),
      x('out', null, toFrames(item.start + item.duration, fps)),
    ),
  );

  const root = x(
    'xmeml',
    { version: 5 },
    x(
      'sequence',
      { id: 'sequence-1' },
      x('name', null, ctx.title),
      x('duration', null, total),
      rate(),
      x(
        'timecode',
        null,
        rate(),
        x('string', null, timecode(RECORD_START_SEC * fps, fps)),
        x('frame', null, RECORD_START_SEC * fps),
        x('displayformat', null, 'NDF'),
      ),
      x(
        'media',
        null,
        x(
          'video',
          null,
          x(
            'format',
            null,
            x(
              'samplecharacteristics',
              null,
              rate(),
              x('width', null, t.width),
              x('height', null, t.height),
              x('pixelaspectratio', null, 'square'),
              x('fielddominance', null, 'none'),
            ),
          ),
          x('track', null, pictureNodes),
        ),
        x(
          'audio',
          null,
          x('numOutputChannels', null, 2),
          x(
            'format',
            null,
            x('samplecharacteristics', null, x('depth', null, 16), x('samplerate', null, 48000)),
          ),
          audioTracks,
        ),
      ),
      markers,
    ),
  );
  return xmlDocument('xmeml', root);
}
