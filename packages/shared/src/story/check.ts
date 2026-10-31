import type { LlmScene, ScreenplayCheckInput, ScreenplayEdit, VideoModelFacts } from '../schemas/llm';
import { SCENE_CONTINUITY_MAX } from '../schemas/screenplay';

/**
 * The screenplay read for the video model before it is saved (docs/design/first-pass.md#the-screenplay-read-for-the-video-model):
 * the texts `screenplay.check` may rewrite, and how long each may be.
 */
export const SCREENPLAY_CHECK_FIELDS = {
  outline: { summary: 4000 },
  scene: { summary: 4000, action: 20000, continuity: SCENE_CONTINUITY_MAX },
} as const;

/** A draft the check reads: a written screenplay (with its outline) or the scenes an extension wrote. */
export interface CheckableDraft {
  outline?: { title: string; summary: string }[];
  scenes: Pick<
    LlmScene,
    'beatIndex' | 'heading' | 'characters' | 'props' | 'continuity' | 'summary' | 'action' | 'dialogue'
  >[];
}

/** What `screenplay.check` reads of a draft. */
export function screenplayCheckInput(
  draft: CheckableDraft,
  opts: {
    brief: string;
    castOnly: boolean;
    video: VideoModelFacts;
    props: { name: string; description: string }[];
  },
): ScreenplayCheckInput {
  return {
    brief: opts.brief,
    castOnly: opts.castOnly,
    video: opts.video,
    ...(draft.outline
      ? { outline: draft.outline.map((b, index) => ({ index, title: b.title, summary: b.summary })) }
      : {}),
    scenes: draft.scenes.map((s, index) => ({
      index,
      ...(s.beatIndex !== undefined ? { beatIndex: s.beatIndex } : {}),
      heading: s.heading,
      characters: s.characters,
      props: s.props,
      continuity: s.continuity,
      summary: s.summary,
      action: s.action,
      dialogue: s.dialogue.map((d) => ({ character: d.character, line: d.line })),
    })),
    props: opts.props.map((p) => ({ name: p.name, description: p.description })),
  };
}

/**
 * The draft with the check's edits in place. An edit of a beat or a scene the draft does not have, of a field the
 * target has not, with no text, or longer than its field allows is dropped; so is one that changes nothing.
 */
export function applyScreenplayEdits<D extends CheckableDraft>(
  draft: D,
  edits: readonly ScreenplayEdit[],
): { draft: D; applied: ScreenplayEdit[] } {
  const outline = draft.outline?.map((b) => ({ ...b }));
  const scenes = draft.scenes.map((s) => ({ ...s }));
  const applied: ScreenplayEdit[] = [];
  for (const e of edits) {
    const text = e.text.trim();
    if (!text) continue;
    if (e.target === 'outline') {
      const beat = outline?.[e.index];
      if (!beat || e.field !== 'summary' || text.length > SCREENPLAY_CHECK_FIELDS.outline.summary) continue;
      if (beat.summary === text) continue;
      beat.summary = text;
    } else {
      const scene = scenes[e.index];
      if (!scene || text.length > SCREENPLAY_CHECK_FIELDS.scene[e.field]) continue;
      if (scene[e.field] === text) continue;
      scene[e.field] = text;
    }
    applied.push({ ...e, text });
  }
  return { draft: { ...draft, ...(outline ? { outline } : {}), scenes }, applied };
}
