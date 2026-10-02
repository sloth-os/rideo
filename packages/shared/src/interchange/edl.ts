import type { Timeline, VideoItem } from '../schemas/timeline';
import {
  clipLabel,
  framedPicture,
  hasSound,
  type InterchangeContext,
  mediaFileName,
  RECORD_START_SEC,
  textItems,
  timecode,
  toFrames,
} from './common';

/**
 * CMX 3600 (docs/design/interchange.md#mapping): the picture track (with its own sound as `B` events), dissolves and
 * wipes, `M2` speed lines, the clip names and files to relink, review notes and titles as comments.
 */

const REEL = 'AX';

function event(
  n: number,
  track: 'V' | 'B',
  transition: string,
  dur: number | null,
  srcIn: string,
  srcOut: string,
  recIn: string,
  recOut: string,
): string {
  return `${String(n).padStart(3, '0')}  ${REEL.padEnd(8)} ${track.padEnd(5)} ${transition.padEnd(4)} ${dur === null ? '   ' : String(dur).padStart(3, '0')} ${srcIn} ${srcOut} ${recIn} ${recOut}`;
}

export function toEdl(t: Timeline, ctx: InterchangeContext): string {
  const fps = t.fps;
  const tc = (f: number) => timecode(f, fps);
  const rec = (f: number) => tc(RECORD_START_SEC * fps + f);
  const titles = textItems(t).map((i) => ({ item: i, f: toFrames(i.start, fps) }));
  const lines = [`TITLE: ${ctx.title.replace(/[\r\n]+/g, ' ').slice(0, 70)}`, 'FCM: NON-DROP FRAME', ''];
  const picture = framedPicture(t);
  picture.forEach((c, i) => {
    const item = c.item as VideoItem;
    const n = i + 1;
    const track = hasSound(item) ? 'B' : 'V';
    if (c.transition) {
      // A dissolve or wipe: the outgoing clip, held for no time at the cut, then the incoming one.
      const prev = picture[i - 1]!;
      lines.push(
        event(
          n,
          hasSound(prev.item as VideoItem) ? 'B' : 'V',
          'C',
          null,
          tc(prev.out),
          tc(prev.out),
          rec(c.start),
          rec(c.start),
        ),
      );
      lines.push(
        event(
          n,
          track,
          c.transition.type === 'wipe' ? 'W001' : 'D',
          c.transition.frames,
          tc(c.in),
          tc(c.out),
          rec(c.start),
          rec(c.end),
        ),
      );
    } else {
      lines.push(event(n, track, 'C', null, tc(c.in), tc(c.out), rec(c.start), rec(c.end)));
    }
    if (c.speed !== 1)
      lines.push(
        `M2   ${REEL.padEnd(8)} ${(fps * c.speed).toFixed(1).padStart(5, '0')}                ${tc(c.in)}`,
      );
    if (c.transition)
      lines.push(
        `* FROM CLIP NAME: ${clipLabel(picture[i - 1]!.item)}`,
        `* TO CLIP NAME: ${clipLabel(item)}`,
      );
    else lines.push(`* FROM CLIP NAME: ${clipLabel(item)}`);
    lines.push(
      `* SOURCE FILE: ${mediaFileName(item.source.media)}`,
      `* SOURCE URL: ${ctx.mediaUrl(item.source.media)}`,
    );
    for (const note of ctx.notes?.(item) ?? []) {
      const f = toFrames(note.at, fps);
      if (f >= c.in && f <= c.out)
        lines.push(`* COMMENT: ${tc(f)} ${note.author}: ${note.body.replace(/[\r\n]+/g, ' ')}`.slice(0, 250));
    }
    for (const { item: title, f } of titles)
      if (f >= c.start && (f < c.end || i === picture.length - 1))
        lines.push(`* TITLE: ${rec(f)} ${title.text.replace(/[\r\n]+/g, ' ')}`.slice(0, 250));
    lines.push('');
  });
  return `${lines.join('\n').trimEnd()}\n`;
}
