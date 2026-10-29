import { blockingLine, blockingMoves, figureLegend, shotLayout } from '../blocking';
import { isStale, takeState } from '../consistency';
import {
  compileShotPrompt,
  orderedShotCharacters,
  orderedShotElements,
  promptVersionOf,
  type ShotContext,
} from '../prompt';
import type { Clip, Shot } from '../schemas/clip';
import { type ProjectDocs, sortedClips } from '../schemas/documents';
import type { Scene } from '../schemas/screenplay';
import { fnv1a32 } from '../util/hash';

/**
 * The storyboard (docs/design/storyboard.md): which scenes are storyboarded, the state of each shot's frame, and
 * the shot list. Shared by the server, the studio and agents.
 */

export type BoardState = 'missing' | 'failed' | 'stale' | 'outdated' | 'unapproved' | 'approved';

type BoardDocs = Pick<ProjectDocs, 'characters' | 'elements' | 'screenplay' | 'project'> &
  Partial<Pick<ProjectDocs, 'clips'>>;

/**
 * What a shot's prompts are compiled from. With prompt version 2 that includes its scene and the end state of the shot
 * before it (docs/design/continuity.md#prompts-version-2); `clip` saves looking the shot's clip up.
 */
export function shotContextOf(shot: Shot, docs: BoardDocs, clip?: Clip): ShotContext {
  const ctx: ShotContext = {
    shot,
    characters: orderedShotCharacters(shot, docs.characters),
    elements: orderedShotElements(shot, docs.elements),
    screenplay: docs.screenplay,
    settings: docs.project.settings,
  };
  if (promptVersionOf(docs.project.settings) < 2) return ctx;
  const owner = clip ?? Object.values(docs.clips ?? {}).find((c) => c.shots.some((s) => s.id === shot.id));
  const scene = owner?.sceneId ? docs.screenplay?.scenes.find((x) => x.id === owner.sceneId) : undefined;
  const previous = owner?.shots.find((s) => s.index === shot.index - 1);
  // The clip's cast who are not in this shot: the scene reference frame shows them all
  const here = new Set(shot.characterIds);
  const offscreen = [...new Set((owner?.shots ?? []).flatMap((s) => s.characterIds))]
    .filter((id) => !here.has(id))
    .map((id) => docs.characters[id]?.name)
    .filter((n): n is string => !!n);
  return {
    ...ctx,
    offscreen,
    scene: scene
      ? {
          heading: scene.heading,
          location: scene.location,
          timeOfDay: scene.timeOfDay,
          continuity: scene.continuity ?? '',
        }
      : null,
    previousEndState: previous?.endState || null,
    blocking: owner ? blockingContextOf(owner, shot, docs) : null,
  };
}

/**
 * A blocked shot's blocking line, moves and figure colours (docs/design/director-desk.md), when the project blocks its
 * scenes and the shot has a camera on the desk; null otherwise.
 */
export function blockingContextOf(
  clip: Pick<Clip, 'blocking'>,
  shot: Shot,
  docs: Pick<BoardDocs, 'characters' | 'project'>,
): ShotContext['blocking'] {
  const settings = docs.project.settings;
  const b = clip.blocking;
  if (!b || settings.blocking?.enabled !== true || !b.shots[shot.id]) return null;
  const names = Object.fromEntries(Object.values(docs.characters).map((c) => [c.id, c.name]));
  const aspect = settings.resolution.width / Math.max(1, settings.resolution.height);
  const input = blockingShotOf(shot);
  const layout = shotLayout(b, input, names, aspect);
  // What the camera view is drawn from: the set, the shot's characters, the props and the shot's own marks and camera
  const signature = fnv1a32(
    JSON.stringify([
      b.set,
      b.actors.filter((a) => shot.characterIds.includes(a.characterId)),
      b.props,
      b.shots[shot.id],
    ]),
  ).toString(16);
  return {
    line: blockingLine(layout),
    moves: blockingMoves(layout),
    legend: figureLegend(b, input, names),
    signature,
  };
}

/** What the desk needs of a planned shot. */
export function blockingShotOf(shot: Shot) {
  return {
    id: shot.id,
    index: shot.index,
    characterIds: shot.characterIds,
    elementIds: shot.elementIds,
    camera: { framing: shot.camera.framing, lensMm: shot.camera.lensMm ?? null },
    continuity: shot.continuity,
  };
}

/**
 * Hash of what a frame is generated from: the keyframe prompt and the negative prompt. What the shot's neighbours lend
 * it is left out: the scene reference image (whether one was at hand depends on the order of generation), the
 * previous shot's end state and who is out of frame (moving or editing a frame on the board must not make the frames
 * around it outdated).
 */
export function boardPromptHash(ctx: ShotContext): string {
  // A blocked shot's frame is drawn from its camera view too: moving its mannequins or its camera outdates it
  const blocking = ctx.blocking?.signature ? `\n${ctx.blocking.signature}` : '';
  return fnv1a32(
    `${compileShotPrompt({ ...ctx, sceneReference: false, blockingImage: false, previousEndState: null, offscreen: [], referenceLabels: [] }, 'keyframe')}\n${ctx.shot.negativePrompt ?? ''}${blocking}`,
  ).toString(16);
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
