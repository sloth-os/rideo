import type { MediaRef } from '../schemas/common';
import type { AudioItem, VideoItem } from '../schemas/timeline';
import { itemDuration, itemEnd } from '../timeline/ops';

/** Effects from action lines (docs/design/post-audio.md#effects-from-action-lines). */
export const SFX_MAX_PER_SHOT = 3;
export const SFX_SPOT_VOLUME = 0.8;
export const SFX_AMBIENCE_VOLUME = 0.35;
/** The longest sound one request makes. */
export const SFX_MAX_SEC = 22;

export interface PlannedEffect {
  /** Seconds into the shot (spot effects). */
  at: number;
  durationSec: number;
  kind: 'spot' | 'ambience';
  description: string;
}

/** The length to generate for an effect of a shot of the cut. */
export function effectLength(item: VideoItem, e: PlannedEffect): number {
  const len = e.kind === 'ambience' ? itemDuration(item) : Math.min(e.durationSec, itemDuration(item));
  return Math.round(Math.max(0.5, Math.min(SFX_MAX_SEC, len)) * 10) / 10;
}

/**
 * Where an effect sits on the Effects track: a spot at its moment in the shot (moved earlier when it would run past
 * the shot), an ambience under the whole shot, repeated when the sound is shorter than the shot.
 */
export function effectItems(
  item: VideoItem,
  e: PlannedEffect,
  sound: { media: MediaRef; resourceId: string },
  newId: () => string,
): AudioItem[] {
  const start = item.start;
  const end = itemEnd(item);
  const len = Math.max(0.1, sound.media.durationSec ?? effectLength(item, e));
  const label = `SFX: ${e.description}`.slice(0, 200);
  const source = { type: 'media' as const, media: sound.media, resourceId: sound.resourceId };
  if (e.kind === 'ambience') {
    const out: AudioItem[] = [];
    for (let cursor = start; cursor < end - 0.05; cursor += len) {
      const piece = Math.min(len, end - cursor);
      out.push({
        id: newId(),
        kind: 'audio',
        source,
        start: round3(cursor),
        in: 0,
        out: round3(piece),
        volume: SFX_AMBIENCE_VOLUME,
        fadeIn: round3(Math.min(0.5, piece / 3)),
        fadeOut: round3(Math.min(0.5, piece / 3)),
        label,
      });
    }
    return out;
  }
  const piece = Math.min(len, end - start);
  // `at` is in the take's time; the item may start later in the take and play faster.
  const at = Math.min(Math.max(0, (e.at - item.in) / item.speed), Math.max(0, end - start - piece));
  return [
    {
      id: newId(),
      kind: 'audio',
      source,
      start: round3(start + at),
      in: 0,
      out: round3(piece),
      volume: SFX_SPOT_VOLUME,
      fadeOut: round3(Math.min(0.15, piece / 4)),
      label,
    },
  ];
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
