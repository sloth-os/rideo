import { type Character, isRealPersonCharacter } from '../schemas/character';
import type { ProjectDocs } from '../schemas/documents';
import { DEFAULT_DISCLOSURE, type DisclosurePosition } from '../schemas/project';
import type { DisclosureStamp } from '../schemas/provenance';
import type { TextItem, Timeline, Track, VideoItem } from '../schemas/timeline';
import { timelineDuration } from '../timeline/query';

/**
 * The visible disclosure label (docs/design/provenance.md#disclosure-label): `always` shows it, `auto` shows it
 * when the film contains a real-person character, and `off` cannot hide it from a deepfake.
 */
export function realPersonCharacters(
  docs: ProjectDocs,
  timeline: Timeline | null = docs.timeline,
): Character[] {
  const ids = new Set<string>();
  for (const track of timeline?.tracks ?? []) {
    for (const item of track.items) {
      if (item.kind !== 'video' || item.source.type !== 'take') continue;
      const source = (item as VideoItem).source as { clipId: string; shotId: string };
      const shot = docs.clips[source.clipId]?.shots.find((s) => s.id === source.shotId);
      for (const id of shot?.characterIds ?? []) ids.add(id);
    }
  }
  return [...ids]
    .map((id) => docs.characters[id])
    .filter((c): c is Character => !!c && isRealPersonCharacter(c));
}

export function disclosureFor(docs: ProjectDocs, timeline: Timeline | null = docs.timeline): DisclosureStamp {
  const settings = docs.project.settings.disclosure ?? DEFAULT_DISCLOSURE;
  const realPerson = realPersonCharacters(docs, timeline).length > 0;
  const reason: DisclosureStamp['reason'] = realPerson
    ? 'real_person'
    : settings.label === 'always'
      ? 'policy'
      : null;
  return { label: reason !== null, text: settings.text, position: settings.position, reason };
}

export const DISCLOSURE_TRACK_ID = 'trk_disclosure';
/** Text items are at most 3600 s long; longer films get consecutive label items. */
const MAX_ITEM_SEC = 3600;

function labelStyle(position: DisclosurePosition): TextItem['style'] {
  const [vertical, horizontal] = position.split('_') as ['top' | 'bottom', 'left' | 'right'];
  return { preset: 'label', position: vertical, align: horizontal };
}

/** The render timeline with the label drawn over the whole film (a text track, so both engines draw it). */
export function withDisclosure(
  t: Timeline,
  label: { text: string; position: DisclosurePosition } | null,
): Timeline {
  if (!label) return t;
  const total = timelineDuration(t);
  if (total <= 0) return t;
  const items: TextItem[] = [];
  for (let start = 0, i = 0; start < total - 1e-6; start += MAX_ITEM_SEC, i++) {
    items.push({
      id: `itm_disclosure${String(i).padStart(2, '0')}`,
      kind: 'text',
      start,
      duration: Math.min(MAX_ITEM_SEC, total - start),
      text: label.text,
      style: labelStyle(label.position),
    });
  }
  const track: Track = { id: DISCLOSURE_TRACK_ID, kind: 'text', name: 'Disclosure', items };
  return { ...t, tracks: [...t.tracks.filter((x) => x.id !== DISCLOSURE_TRACK_ID), track] };
}
