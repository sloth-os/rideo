import { captionWords } from '../captions';
import { voicedLines } from '../dialogue';
import { type Character, voiceOf } from '../schemas/character';
import type { Clip, Shot, Take } from '../schemas/clip';
import type { Dub, Localization, TranslatedLine } from '../schemas/localization';
import type { AudioItem, TextItem, TextStyle, Timeline, VideoItem } from '../schemas/timeline';
import { DIALOGUE_TRACK_ID, itemEnd, primaryTrack } from '../timeline/ops';
import { deepClone } from '../util/canonical-json';

/** Languages offered in the studio (any BCP 47 code works through the API). */
export const LANGUAGES: Record<string, string> = {
  ar: 'Arabic',
  de: 'German',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  hi: 'Hindi',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  nl: 'Dutch',
  pl: 'Polish',
  pt: 'Portuguese',
  'pt-BR': 'Portuguese (Brazil)',
  ru: 'Russian',
  sv: 'Swedish',
  tr: 'Turkish',
  uk: 'Ukrainian',
  zh: 'Chinese',
};
export const languageName = (code: string) => LANGUAGES[code] ?? code;

/** Framings whose lips are re-rendered to the dub (docs/design/localization.md#dubbing). */
export const LIP_SYNC_FRAMINGS = ['close_up', 'extreme_close_up', 'medium_close'] as const;

export const lineKey = (shotId: string, index: number) => `${shotId}:${index}`;

export interface CutTake {
  /** Position on the primary track. */
  position: number;
  item: VideoItem;
  clip: Clip;
  shot: Shot;
  take: Take;
}

/** The takes of the cut in order (primary items whose take still exists). */
export function cutTakes(t: Timeline, clips: Record<string, Clip>): CutTake[] {
  const out: CutTake[] = [];
  (primaryTrack(t).items as VideoItem[]).forEach((item, position) => {
    if (item.source.type !== 'take') return;
    const src = item.source;
    const clip = clips[src.clipId];
    const shot = clip?.shots.find((s) => s.id === src.shotId);
    const take = shot?.takes.find((x) => x.id === src.takeId);
    if (clip && shot && take) out.push({ position, item, clip, shot, take });
  });
  return out;
}

export interface CutLine {
  shotId: string;
  index: number;
  characterId: string | null;
  text: string;
}

/** Every spoken line of the shots in the cut, once per shot. */
export function cutLines(t: Timeline, clips: Record<string, Clip>): CutLine[] {
  const seen = new Set<string>();
  const out: CutLine[] = [];
  for (const { shot } of cutTakes(t, clips)) {
    if (seen.has(shot.id)) continue;
    seen.add(shot.id);
    shot.dialogue.forEach((d, index) => {
      const text = d.line.trim();
      if (text) out.push({ shotId: shot.id, index, characterId: d.characterId, text });
    });
  }
  return out;
}

/** The translation of a line when it was made from the line as it is now. */
export function currentTranslation(
  loc: Pick<Localization, 'lines'> | undefined,
  shotId: string,
  index: number,
  source: string,
): TranslatedLine | null {
  const l = loc?.lines.find((x) => x.shotId === shotId && x.index === index);
  return l && l.source === source ? l : null;
}

/** The translated lines a dub of the shot must speak (null when a line has no current translation). */
function wantedDubLines(loc: Localization, shot: Shot, characters: Record<string, Character>) {
  const out: { index: number; characterId: string; text: string }[] = [];
  for (const l of voicedLines(shot, characters)) {
    const tr = currentTranslation(loc, shot.id, l.index, l.text);
    if (!tr) return null;
    out.push({ index: l.index, characterId: l.characterId, text: tr.text });
  }
  return out;
}

/** A dub speaks the current translations with the speakers' current voices (V6). */
export function dubIsCurrent(
  dub: Dub | undefined,
  loc: Localization,
  shot: Shot,
  characters: Record<string, Character>,
): boolean {
  if (!dub) return false;
  const want = wantedDubLines(loc, shot, characters);
  if (!want || want.length !== dub.lines.length) return false;
  if (!want.every((w, k) => dub.lines[k]!.index === w.index && dub.lines[k]!.text === w.text)) return false;
  return Object.entries(dub.voiceLocks).every(([id, v]) => {
    const c = characters[id];
    return !!c && voiceOf(c).lock.version === v;
  });
}

/** A close-up whose shot speaks gets its lips re-rendered. */
export function needsLipSync(
  shot: Pick<Shot, 'camera' | 'dialogue'>,
  characters: Record<string, Character>,
): boolean {
  return (
    (LIP_SYNC_FRAMINGS as readonly string[]).includes(shot.camera.framing) &&
    voicedLines(shot, characters).length > 0
  );
}

export interface LocalizationState {
  lines: { total: number; current: number; missing: string[]; stale: string[] };
  /** Speaking takes of the cut and their dubs. */
  dubs: { needed: number; current: number; missing: string[]; stale: string[]; lipSynced: number };
}

/** How far a language is (docs/design/localization.md): translations and dubs of the cut. */
export function localizationState(
  loc: Localization | undefined,
  t: Timeline,
  clips: Record<string, Clip>,
  characters: Record<string, Character>,
): LocalizationState {
  const lines = cutLines(t, clips);
  const missing: string[] = [];
  const stale: string[] = [];
  for (const l of lines) {
    const any = loc?.lines.find((x) => x.shotId === l.shotId && x.index === l.index);
    if (!any) missing.push(lineKey(l.shotId, l.index));
    else if (any.source !== l.text) stale.push(lineKey(l.shotId, l.index));
  }
  const dubs = { needed: 0, current: 0, missing: [] as string[], stale: [] as string[], lipSynced: 0 };
  const seen = new Set<string>();
  for (const { shot, take } of cutTakes(t, clips)) {
    if (seen.has(take.id) || !voicedLines(shot, characters).length) continue;
    seen.add(take.id);
    dubs.needed++;
    const dub = loc?.dubs[take.id];
    if (!dub) dubs.missing.push(take.id);
    else if (!loc || !dubIsCurrent(dub, loc, shot, characters)) dubs.stale.push(take.id);
    else {
      dubs.current++;
      if (dub.video) dubs.lipSynced++;
    }
  }
  return {
    lines: { total: lines.length, current: lines.length - missing.length - stale.length, missing, stale },
    dubs,
  };
}

const EPS = 1e-6;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Text items and Dialogue items belong to the primary item whose span they start in. */
function ownerOf(items: readonly VideoItem[], time: number): number {
  let owner = -1;
  for (let k = 0; k < items.length; k++) if (items[k]!.start <= time + EPS) owner = k;
  return owner;
}

/** The cut without captions in the picture (sidecar subtitles). */
export function withoutCaptions(t: Timeline): Timeline {
  const out = deepClone(t);
  for (const track of out.tracks)
    if (track.kind === 'text')
      track.items = track.items.filter((i) => !(i.kind === 'text' && i.style.preset === 'caption'));
  return out;
}

/**
 * A language variant of the cut (docs/design/localization.md#language-variants): every take's captions in the
 * language, and when dubbed its dub on the Dialogue track (the take's own sound muted) and its lip-synced video.
 */
export function localizeTimeline(
  t: Timeline,
  input: {
    loc: Localization;
    clips: Record<string, Clip>;
    characters: Record<string, Character>;
    dubbed: boolean;
    newId: () => string;
  },
): Timeline {
  const out = deepClone(t);
  const items = primaryTrack(out).items as VideoItem[];
  const textTrack = out.tracks.find((tr) => tr.kind === 'text');
  const style: TextStyle = {
    ...((textTrack?.items as TextItem[] | undefined)?.find((i) => i.style.preset === 'caption')?.style ?? {
      preset: 'caption',
      position: 'bottom',
    }),
  };
  let dialogueTrack = out.tracks.find((tr) => tr.id === DIALOGUE_TRACK_ID);
  const name = (id: string | null) => (id ? (input.characters[id]?.name ?? '') : '');
  const captions: TextItem[] = [];
  const dialogue: AudioItem[] = [];
  const replaced = new Set<number>();
  for (const { position, item, shot, take } of cutTakes(out, input.clips)) {
    replaced.add(position);
    const dub = input.dubbed ? input.loc.dubs[take.id] : undefined;
    const end = itemEnd(item);
    const toTimeline = (sec: number) => item.start + (sec - item.in) / item.speed;
    let lines: {
      characterId: string | null;
      text: string;
      start?: number;
      end?: number;
      words?: Dub['lines'][number]['words'];
    }[];
    if (dub) {
      if (dub.video) {
        item.source = { ...item.source, media: dub.video };
        if (dub.video.durationSec !== undefined && item.out > dub.video.durationSec)
          item.out = Math.max(item.in + 0.1, dub.video.durationSec);
      }
      // The dub plays on the Dialogue track, as TTS dialogue does.
      item.volume = 0;
      delete item.speech;
      const mixLen = dub.dialogue.durationSec ?? item.out;
      if (item.in < mixLen - 0.05)
        dialogue.push({
          id: input.newId(),
          kind: 'audio',
          source: { type: 'media', media: dub.dialogue },
          start: item.start,
          in: item.in,
          out: r3(Math.min(mixLen, item.out)),
          volume: 1,
          speech: dub.lines.filter((l) => l.end > l.start).map((l) => [l.start, l.end] as [number, number]),
        });
      lines = dub.lines;
    } else {
      const timed = new Map((take.audio?.lines ?? []).map((l) => [l.index, l]));
      lines = shot.dialogue.flatMap((d, index) => {
        const tr = currentTranslation(input.loc, shot.id, index, d.line.trim());
        if (!d.line.trim()) return [];
        const at = timed.get(index);
        return [
          { characterId: d.characterId, text: tr?.text ?? d.line.trim(), start: at?.start, end: at?.end },
        ];
      });
    }
    const untimed = lines.filter((l) => l.start === undefined || l.end === undefined);
    lines.forEach((l) => {
      const caption = (name(l.characterId) ? `${name(l.characterId)}: ${l.text}` : l.text).slice(0, 500);
      const offset = name(l.characterId) ? name(l.characterId).length + 2 : 0;
      let start: number;
      let duration: number;
      let words: TextItem['words'] = [];
      if (l.start !== undefined && l.end !== undefined) {
        const a = Math.max(l.start, item.in);
        const b = Math.min(l.end, item.out);
        if (b <= a) return;
        start = toTimeline(a);
        const spoken = (b - a) / item.speed;
        duration = Math.min(Math.max(0.8, spoken), Math.max(0.1, end - start));
        words = captionWords(caption, offset, {
          start: 0,
          end: Math.min(spoken, duration),
          words: l.words?.map((w) => ({
            ...w,
            start: (w.start - a) / item.speed,
            end: (w.end - a) / item.speed,
          })),
        });
      } else {
        const k = untimed.indexOf(l);
        const each = (end - item.start) / untimed.length;
        start = item.start + k * each;
        duration = Math.max(0.5, each - 0.1);
        words = captionWords(caption, offset, { start: 0, end: duration });
      }
      captions.push({
        id: input.newId(),
        kind: 'text',
        start: r3(start),
        duration: r3(duration),
        text: caption,
        style: { ...style },
        ...(words.length ? { words } : {}),
      });
    });
  }
  // Drop the original captions and dialogue of the replaced takes; keep everything else.
  if (textTrack)
    textTrack.items = [
      ...textTrack.items.filter(
        (i) => !(i.kind === 'text' && i.style.preset === 'caption' && replaced.has(ownerOf(items, i.start))),
      ),
      ...captions,
    ].sort((a, b) => a.start - b.start);
  if (dialogueTrack) {
    dialogueTrack.items = dialogueTrack.items.filter(
      (i) => !(input.dubbed && replaced.has(ownerOf(items, i.start))),
    );
  }
  if (dialogue.length) {
    if (!dialogueTrack) {
      dialogueTrack = { id: DIALOGUE_TRACK_ID, kind: 'audio', name: 'Dialogue', items: [] };
      const at = out.tracks.findIndex((tr) => tr.kind === 'text');
      out.tracks.splice(at < 0 ? out.tracks.length : at, 0, dialogueTrack);
    }
    dialogueTrack.items = [...dialogueTrack.items, ...dialogue].sort((a, b) => a.start - b.start);
  }
  return out;
}
