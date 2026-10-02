import type { Actor, MediaRef } from '../schemas/common';
import type { ProjectDocs } from '../schemas/documents';
import type { Author, CommentTarget, CommentThread, Review, ReviewDecision } from '../schemas/review';

/** Review helpers (docs/design/review.md): authors, mentions, outcomes, what a review shows, share-link tokens. */

export function authorOf(actor: Actor): Author {
  const name = actor.name ?? actor.id;
  return {
    kind: actor.kind,
    id: actor.id,
    name: actor.onBehalfOf ? `${name} (for ${actor.onBehalfOf.name ?? actor.onBehalfOf.id})` : name,
  };
}

/**
 * The members named in a text: `@` followed by a member's full name, their first name when no other member shares
 * it, or their email (case-insensitive).
 */
export function parseMentions(
  body: string,
  people: readonly { userId: string; name: string; email: string }[],
): string[] {
  const text = body.toLowerCase();
  const firstNames = new Map<string, number>();
  for (const p of people) {
    const first = p.name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (first) firstNames.set(first, (firstNames.get(first) ?? 0) + 1);
  }
  const named = (handle: string) => {
    if (!handle) return false;
    const re = new RegExp(`(^|[^\\w@])@${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i');
    return re.test(text);
  };
  const out: string[] = [];
  for (const p of people) {
    const first = p.name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (
      named(p.name.trim().toLowerCase()) ||
      (p.email && named(p.email.toLowerCase())) ||
      (first && firstNames.get(first) === 1 && named(first))
    )
      out.push(p.userId);
  }
  return [...new Set(out)];
}

/** A review's state from its decisions: each person's latest decision counts; one request for changes holds it. */
export function reviewOutcome(decisions: readonly ReviewDecision[], required: number): Review['status'] {
  const latest = new Map<string, ReviewDecision>();
  for (const d of decisions) latest.set(`${d.author.kind}:${d.author.id}`, d);
  const values = [...latest.values()];
  if (values.some((d) => d.decision === 'changes')) return 'changes_requested';
  return values.filter((d) => d.decision === 'approve').length >= required ? 'approved' : 'open';
}

export interface ReviewItem {
  key: string;
  label: string;
  target: CommentTarget;
  media: MediaRef;
}

/** What a review shows: the export's video, or the selected takes of the clip's shots in order. */
export function reviewItems(
  review: Pick<Review, 'target'>,
  docs: Pick<ProjectDocs, 'clips' | 'exports'>,
): ReviewItem[] {
  if (review.target.kind === 'export') {
    const exp = docs.exports[review.target.exportId];
    return exp?.media
      ? [{ key: exp.id, label: 'Export', target: { kind: 'export', exportId: exp.id }, media: exp.media }]
      : [];
  }
  const clip = docs.clips[review.target.clipId];
  if (!clip) return [];
  return [...clip.shots]
    .sort((a, b) => a.index - b.index)
    .flatMap((shot) => {
      const take = shot.takes.find((t) => t.id === shot.selectedTakeId);
      return take?.video
        ? [
            {
              key: take.id,
              label: `C${clip.index + 1}·S${shot.index + 1}`,
              target: { kind: 'take' as const, clipId: clip.id, shotId: shot.id, takeId: take.id },
              media: take.video,
            },
          ]
        : [];
    });
}

export function sameTarget(a: CommentTarget, b: CommentTarget): boolean {
  if (a.kind === 'export' && b.kind === 'export') return a.exportId === b.exportId;
  if (a.kind === 'take' && b.kind === 'take') return a.takeId === b.takeId;
  return false;
}

/** The threads on a target, oldest first. */
export function threadsFor(comments: Record<string, CommentThread>, target: CommentTarget): CommentThread[] {
  return Object.values(comments)
    .filter((c) => sameTarget(c.target, target))
    .sort((a, b) => (a.at ?? -1) - (b.at ?? -1) || a.createdAt.localeCompare(b.createdAt));
}

/** A share-link token: `<projectId>.<reviewId>.<secret>`. */
export function reviewToken(projectId: string, reviewId: string, secret: string): string {
  return `${projectId}.${reviewId}.${secret}`;
}

export function parseReviewToken(
  token: string,
): { projectId: string; reviewId: string; secret: string } | null {
  const m = /^(prj_[0-9a-z]{10,32})\.(rev_[0-9a-z]{10,32})\.([A-Za-z0-9_-]{20,100})$/.exec(token);
  return m ? { projectId: m[1]!, reviewId: m[2]!, secret: m[3]! } : null;
}
