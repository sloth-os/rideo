import { type Character, voiceOf, voiceReady } from '../schemas/character';
import type { Shot } from '../schemas/clip';
import type { DialogueMode, ProjectSettings } from '../schemas/project';
import type { Screenplay } from '../schemas/screenplay';
import { fnv1a32 } from '../util/hash';

/**
 * Dialogue rules shared by the server, the studio and agents (docs/design/dialogue.md): which lines are voiced,
 * who speaks, where the lines sit in a shot, and whether the voices are ready.
 */

/** A screenplay line that a locked voice speaks (lines without a known character stay captions). */
export interface VoicedLine {
  index: number;
  characterId: string;
  text: string;
}

export function dialogueMode(settings: Pick<ProjectSettings, 'dialogue'>): DialogueMode {
  return settings.dialogue?.mode ?? 'off';
}

export function voicedLines(
  shot: Pick<Shot, 'dialogue'>,
  characters: Record<string, Character>,
): VoicedLine[] {
  const out: VoicedLine[] = [];
  shot.dialogue.forEach((d, index) => {
    const text = d.line.trim();
    if (d.characterId && characters[d.characterId] && text)
      out.push({ index, characterId: d.characterId, text });
  });
  return out;
}

/** Speakers of the shot in order of their first line. */
export function shotSpeakers(shot: Pick<Shot, 'dialogue'>, characters: Record<string, Character>): string[] {
  return [...new Set(voicedLines(shot, characters).map((l) => l.characterId))];
}

/** Rule V3: a fixed seed per line, so a regenerated shot speaks the same way. */
export function lineSeed(shotId: string, line: Pick<VoicedLine, 'index' | 'text'>): number {
  return fnv1a32(`line:${shotId}:${line.index}:${line.text}`) % 4294967295;
}

export const DIALOGUE_LAYOUT = { leadSec: 0.4, gapSec: 0.3, tailSec: 0.5 } as const;

/** Lines one after another from `leadSec`, `gapSec` apart; the shot must last `totalSec` to hold them. */
export function layoutDialogue(durations: number[]): { offsets: number[]; totalSec: number } {
  const offsets: number[] = [];
  let t = DIALOGUE_LAYOUT.leadSec;
  durations.forEach((d, i) => {
    offsets.push(Math.round(t * 1000) / 1000);
    t += Math.max(0, d) + (i < durations.length - 1 ? DIALOGUE_LAYOUT.gapSec : 0);
  });
  return { offsets, totalSec: Math.round((t + DIALOGUE_LAYOUT.tailSec) * 1000) / 1000 };
}

/** Characters with a line in a written scene or a planned shot: they need a locked voice (cast gate). */
export function speakingCharacters(docs: {
  screenplay: Pick<Screenplay, 'scenes'> | null;
  characters: Record<string, Character>;
  clips?: Record<string, { shots: Pick<Shot, 'dialogue'>[] }>;
}): Character[] {
  const ids = new Set<string>();
  for (const s of docs.screenplay?.scenes ?? [])
    for (const d of s.dialogue) if (d.characterId && d.line.trim()) ids.add(d.characterId);
  for (const clip of Object.values(docs.clips ?? {}))
    for (const shot of clip.shots)
      for (const d of shot.dialogue) if (d.characterId && d.line.trim()) ids.add(d.characterId);
  return [...ids]
    .map((id) => docs.characters[id])
    .filter((c): c is Character => !!c)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Speakers of the shots without a ready voice (rule V1); empty when dialogue is off. */
export function voicesNotReady(
  shots: Pick<Shot, 'dialogue'>[],
  characters: Record<string, Character>,
  mode: DialogueMode,
): Character[] {
  if (mode === 'off') return [];
  const ids = new Set(shots.flatMap((s) => shotSpeakers(s, characters)));
  return [...ids].map((id) => characters[id]!).filter((c) => !voiceReady(c, mode));
}

/** The text a designed voice speaks in its previews: the character's own lines, padded to the provider minimum. */
export function voiceSampleText(c: Pick<Character, 'name'>, lines: string[]): string {
  let text = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
  const filler = [
    `My name is ${c.name}.`,
    'I have waited a long time to tell this story, and tonight I will tell it the way it happened.',
    'Listen closely; every word matters.',
  ];
  for (const f of filler) if (text.length < 100) text = text ? `${text} ${f}` : f;
  return text.slice(0, 1000);
}

/** A short status of a character's voice for lists and agents. */
export function voiceStatus(c: Pick<Character, 'voice'>): 'none' | 'candidates' | 'chosen' | 'locked' {
  const v = voiceOf(c);
  if (v.lock.locked) return 'locked';
  if (v.voiceId || v.sample) return 'chosen';
  return v.candidates.length ? 'candidates' : 'none';
}
