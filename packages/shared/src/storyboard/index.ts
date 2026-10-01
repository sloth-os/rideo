import { isStale, takeState } from '../consistency';
import { compileShotPrompt, orderedShotCharacters, orderedShotElements, type ShotContext } from '../prompt';
import type { Clip, Shot } from '../schemas/clip';
import { type ProjectDocs, sortedClips } from '../schemas/documents';
import type { Scene } from '../schemas/screenplay';
import { fnv1a32 } from '../util/hash';

/**
 * The storyboard (docs/design/storyboard.md): which scenes are storyboarded, the state of each shot's frame, and
 * the shot list. Shared by the server, the studio and agents.
 */

export type BoardState = 'missing' | 'failed' | 'stale' | 'outdated' | 'unapproved' | 'approved';

type BoardDocs = Pick<ProjectDocs, 'characters' | 'elements' | 'screenplay' | 'project'>;

export function shotContextOf(shot: Shot, docs: BoardDocs): ShotContext {
  return {
    shot,
    characters: orderedShotCharacters(shot, docs.characters),
    elements: orderedShotElements(shot, docs.elements),
    screenplay: docs.screenplay,
    settings: docs.project.settings,
  };
}

/** Hash of what a frame is generated from: the keyframe prompt and the negative prompt. */
export function boardPromptHash(ctx: ShotContext): string {
  return fnv1a32(`${compileShotPrompt(ctx, 'keyframe')}\n${ctx.shot.negativePrompt ?? ''}`).toString(16);
}

export function boardState(shot: Shot, docs: BoardDocs): BoardState {
  const b = shot.board;
  if (!b) return 'missing';
  if (b.consistency.status === 'failed') return 'failed';
  if (isStale(b, shot, docs.characters, docs.elements)) return 'stale';
  if (b.promptHash !== boardPromptHash(shotContextOf(shot, docs))) return 'outdated';
  return b.approved ? 'approved' : 'unapproved';
}

/** Frames that can be approved: current and not failed. */
export function boardApprovable(state: BoardState): boolean {
  return state === 'unapproved' || state === 'approved';
}

/** Frames `storyboard.generate` (re)generates. */
export function boardNeedsGeneration(state: BoardState): boolean {
  return state === 'missing' || state === 'failed' || state === 'stale' || state === 'outdated';
}

/** The storyboarded scenes: the first `settings.storyboard.scenes` written scenes. */
export function storyboardScenes(docs: Pick<ProjectDocs, 'screenplay' | 'project'>): Scene[] {
  const n = docs.project.settings.storyboard?.scenes ?? 3;
  return (docs.screenplay?.scenes ?? [])
    .slice()
    .sort((a, b) => a.index - b.index)
    .slice(0, n);
}

/** The clips of the storyboarded scenes, in order (scenes without a clip have none). */
export function storyboardClips(docs: Pick<ProjectDocs, 'screenplay' | 'project' | 'clips'>): Clip[] {
  const ids = new Set(storyboardScenes(docs).map((s) => s.id));
  return sortedClips(docs).filter((c) => c.sceneId && ids.has(c.sceneId));
}

export interface StoryboardProgress {
  scenes: number;
  planned: number;
  shots: number;
  approved: number;
  states: Record<BoardState, number>;
  /** `c1-s2 (stale)` for every frame that is not approved. */
  pending: string[];
}

export function storyboardProgress(docs: ProjectDocs): StoryboardProgress {
  const scenes = storyboardScenes(docs);
  const clips = storyboardClips(docs);
  const states: Record<BoardState, number> = {
    missing: 0,
    failed: 0,
    stale: 0,
    outdated: 0,
    unapproved: 0,
    approved: 0,
  };
  const pending: string[] = [];
  let shots = 0;
  for (const clip of clips) {
    for (const shot of [...clip.shots].sort((a, b) => a.index - b.index)) {
      shots++;
      const state = boardState(shot, docs);
      states[state]++;
      if (state !== 'approved') pending.push(`c${clip.index + 1}-s${shot.index + 1} (${state})`);
    }
  }
  return {
    scenes: scenes.length,
    planned: new Set(clips.map((c) => c.sceneId)).size,
    shots,
    approved: states.approved,
    states,
    pending,
  };
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const SHOT_LIST_COLUMNS = [
  'scene',
  'clip',
  'shot',
  'duration_sec',
  'framing',
  'movement',
  'continuity',
  'characters',
  'location',
  'props',
  'description',
  'action',
  'dialogue',
  'board',
  'take',
] as const;

/** One row per planned shot (docs/design/storyboard.md#shot-list). */
export function shotListRows(docs: ProjectDocs): Record<(typeof SHOT_LIST_COLUMNS)[number], string>[] {
  const scenes = new Map((docs.screenplay?.scenes ?? []).map((s) => [s.id, s]));
  const rows: Record<(typeof SHOT_LIST_COLUMNS)[number], string>[] = [];
  for (const clip of sortedClips(docs)) {
    const scene = clip.sceneId ? scenes.get(clip.sceneId) : undefined;
    for (const shot of [...clip.shots].sort((a, b) => a.index - b.index)) {
      const names = (ids: string[]) => ids.map((id) => docs.characters[id]?.name ?? id).join('; ');
      const elements = shot.elementIds.map((id) => docs.elements[id]).filter((e) => !!e);
      const take = shot.takes.find((t) => t.id === shot.selectedTakeId);
      rows.push({
        scene: scene ? `${scene.index + 1}. ${scene.heading}` : '',
        clip: String(clip.index + 1),
        shot: String(shot.index + 1),
        duration_sec: shot.durationSec.toFixed(1),
        framing: shot.camera.framing,
        movement: shot.camera.movement,
        continuity: shot.continuity,
        characters: names(shot.characterIds),
        location: elements
          .filter((e) => e!.kind === 'location')
          .map((e) => e!.name)
          .join('; '),
        props: elements
          .filter((e) => e!.kind !== 'location')
          .map((e) => e!.name)
          .join('; '),
        description: shot.description,
        action: shot.action,
        dialogue: shot.dialogue
          .map(
            (d) => `${d.characterId ? (docs.characters[d.characterId]?.name ?? '') : 'Narrator'}: ${d.line}`,
          )
          .join(' / '),
        board: boardState(shot, docs),
        take: take ? takeState(take, shot, docs.characters, docs.elements) : 'none',
      });
    }
  }
  return rows;
}

/** RFC 4180 CSV with a UTF-8 BOM (spreadsheet apps read the accents). */
export function shotListCsv(docs: ProjectDocs): string {
  const lines = [SHOT_LIST_COLUMNS.join(',')];
  for (const row of shotListRows(docs)) lines.push(SHOT_LIST_COLUMNS.map((c) => csvCell(row[c])).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}
