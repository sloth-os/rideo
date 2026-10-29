import type { BlockingIssue, SceneBlocking } from '../schemas/blocking';
import type { Clip } from '../schemas/clip';
import type { ProjectDocs } from '../schemas/documents';
import { blockingShotOf } from '../storyboard';
import {
  type BlockingContext,
  blockingCast,
  blockingIssues,
  blockingLine,
  blockingState,
  emptyBlocking,
  heightFromIdentity,
  normalizeBlocking,
  shotLayout,
} from './index';

/** A clip's blocking as the desk shows it (docs/design/director-desk.md#surfaces). */
export interface BlockingView {
  /** What is stored on the clip (null until the scene is blocked). */
  blocking: SceneBlocking | null;
  state: 'missing' | 'incomplete' | 'ready';
  /** The stored blocking completed (every shot a camera, every character a mark), or a new one: what the desk edits. */
  draft: SceneBlocking;
  issues: BlockingIssue[];
  /** Each shot's blocking line, by shot id. */
  lines: Record<string, string | null>;
}

/** What the desk needs of a clip: its shots, its cast in order, their heights and the frame's shape. */
export function blockingContextFor(
  docs: Pick<ProjectDocs, 'characters' | 'project'>,
  clip: Pick<Clip, 'shots'>,
): BlockingContext {
  const shots = clip.shots.map(blockingShotOf);
  const characterIds = blockingCast(shots).filter((id) => docs.characters[id]);
  const { width, height } = docs.project.settings.resolution;
  return {
    shots,
    characterIds,
    heights: Object.fromEntries(
      characterIds.map((id) => [id, heightFromIdentity(docs.characters[id]?.identity.height)]),
    ),
    aspect: width / Math.max(1, height),
  };
}

/** The desk's view of a blocking: its state, the completed draft, its issues and lines. */
export function blockingView(
  docs: Pick<ProjectDocs, 'characters' | 'project'>,
  clip: Pick<Clip, 'shots' | 'blocking'>,
  draft?: SceneBlocking,
): BlockingView {
  const ctx = blockingContextFor(docs, clip);
  const d = draft ?? (clip.blocking ? normalizeBlocking(clip.blocking, ctx).blocking : emptyBlocking(ctx));
  const names = Object.fromEntries(Object.values(docs.characters).map((c) => [c.id, c.name]));
  return {
    blocking: clip.blocking,
    state: blockingState(clip.blocking, ctx.shots),
    draft: d,
    issues: blockingIssues(d, ctx.shots, names, ctx.aspect),
    lines: Object.fromEntries(
      ctx.shots.map((s) => [s.id, blockingLine(shotLayout(d, s, names, ctx.aspect))]),
    ),
  };
}
