import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type Actor,
  type Annotation,
  type Author,
  authorOf,
  type CommentTarget,
  type CommentThread,
  CommentThreadSchema,
  docPath,
  docsFromEntries,
  type Notification,
  newId,
  type ProjectDocs,
  parseMentions,
  parseReviewToken,
  type Review,
  type ReviewDecision,
  ReviewSchema,
  type ReviewTarget,
  reviewItems,
  reviewOutcome,
  reviewToken,
  sameTarget,
  stageOfGate,
  threadsFor,
} from '@rideo/shared';
import { currentPrincipal } from '../auth/context';
import { randomToken } from '../auth/oidc';
import { AppError, invalid, notFound } from '../errors';
import { Service } from './base';
import type { Deps } from './deps';
import type { WorkflowService } from './workflow';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A guest of a share link: who they say they are, scoped to the link. */
const guestAuthor = (reviewId: string, name: string): Author => ({
  kind: 'guest',
  id: `${reviewId}:${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)}`,
  name: name.trim(),
});

/**
 * Review and approvals (docs/design/review.md): comment threads, reviews with share links and decisions that can
 * approve a workflow gate, guests scoped to a review, notifications. REST, MCP and the guest page share it.
 */
export class ReviewService extends Service {
  constructor(
    deps: Deps,
    private readonly workflow: WorkflowService,
  ) {
    super(deps);
  }

  // Comments

  async comments(
    projectId: string,
    filter: { status?: 'open' | 'resolved'; target?: CommentTarget } = {},
  ): Promise<CommentThread[]> {
    const docs = await this.deps.projects.docs(projectId);
    const all = filter.target ? threadsFor(docs.comments, filter.target) : Object.values(docs.comments);
    return all
      .filter((c) => !filter.status || c.status === filter.status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private people(docs: ProjectDocs) {
    return this.deps.accounts.describeAccess(docs.project.access).members;
  }

  private assertTarget(docs: ProjectDocs, target: CommentTarget): void {
    if (target.kind === 'export') {
      if (!docs.exports[target.exportId]?.media) throw notFound(`export ${target.exportId}`);
      return;
    }
    const take = docs.clips[target.clipId]?.shots
      .find((s) => s.id === target.shotId)
      ?.takes.find((t) => t.id === target.takeId);
    if (!take?.video) throw notFound(`take ${target.takeId}`);
  }

  private linkTo(projectId: string, c: Pick<CommentThread, 'target' | 'id'>): string {
    return c.target.kind === 'export'
      ? `/p/${projectId}/exports?comment=${c.id}`
      : `/p/${projectId}/clips?take=${c.target.takeId}&comment=${c.id}`;
  }

  async createComment(
    actor: Actor,
    projectId: string,
    input: { target: CommentTarget; at?: number | null; annotation?: Annotation | null; body: string },
    opts: { author?: Author; reviewId?: string } = {},
  ): Promise<CommentThread> {
    const author = opts.author ?? authorOf(actor);
    const { result: thread } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const docs = docsFromEntries(tx.entries());
        this.assertTarget(docs, input.target);
        const thread = CommentThreadSchema.parse({
          id: newId('comment'),
          target: input.target,
          at: input.at ?? null,
          annotation: input.annotation ?? null,
          author,
          body: input.body.trim(),
          mentions: parseMentions(input.body, this.people(docs)),
          reviewId: opts.reviewId ?? null,
          createdAt: new Date().toISOString(),
        });
        tx.set(docPath.comment(thread.id), thread);
        return thread;
      },
      { message: `${author.name} commented${input.at != null ? ` at ${input.at.toFixed(1)} s` : ''}` },
    );
    this.deps.metrics.review.inc({ event: 'comment' });
    const docs = await this.deps.projects.docs(projectId);
    const review = thread.reviewId ? docs.reviews[thread.reviewId] : undefined;
    await this.notify(
      projectId,
      thread.mentions,
      {
        kind: 'mention',
        title: `${author.name} mentioned you`,
        body: thread.body,
        link: this.linkTo(projectId, thread),
      },
      author,
    );
    if (review)
      await this.notify(
        projectId,
        this.userIdsOf([review.createdBy]),
        {
          kind: 'comment',
          title: `${author.name} commented on “${review.title}”`,
          body: thread.body,
          link: this.linkTo(projectId, thread),
        },
        author,
      );
    return thread;
  }

  async reply(
    actor: Actor,
    projectId: string,
    commentId: string,
    body: string,
    opts: { author?: Author; reviewId?: string } = {},
  ): Promise<CommentThread> {
    const author = opts.author ?? authorOf(actor);
    const { result: thread } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const docs = docsFromEntries(tx.entries());
        const cur = docs.comments[commentId];
        if (!cur || (opts.reviewId && !this.inReview(docs, opts.reviewId, cur)))
          throw notFound(`comment ${commentId}`);
        const next = CommentThreadSchema.parse({
          ...cur,
          replies: [
            ...cur.replies,
            {
              id: newId('reply'),
              author,
              body: body.trim(),
              mentions: parseMentions(body, this.people(docs)),
              createdAt: new Date().toISOString(),
            },
          ],
        });
        tx.set(docPath.comment(commentId), next);
        return next;
      },
      { message: `${author.name} replied` },
    );
    this.deps.metrics.review.inc({ event: 'reply' });
    const last = thread.replies.at(-1)!;
    await this.notify(
      projectId,
      // People in the thread hear of the reply; the ones it mentions get the mention instead.
      this.userIdsOf([thread.author, ...thread.replies.map((r) => r.author)]).filter(
        (id) => !last.mentions.includes(id),
      ),
      {
        kind: 'reply',
        title: `${author.name} replied`,
        body: last.body,
        link: this.linkTo(projectId, thread),
      },
      author,
    );
    await this.notify(
      projectId,
      last.mentions,
      {
        kind: 'mention',
        title: `${author.name} mentioned you`,
        body: last.body,
        link: this.linkTo(projectId, thread),
      },
      author,
    );
    return thread;
  }

  /** Resolves or reopens a thread: its author may, reviewers their own threads only, editors any. */
  async setStatus(
    actor: Actor,
    projectId: string,
    commentId: string,
    status: 'open' | 'resolved',
  ): Promise<CommentThread> {
    const principal = currentPrincipal();
    const role = principal ? await this.deps.accounts.roleIn(principal, projectId) : 'director';
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const cur = tx.get<CommentThread>(docPath.comment(commentId));
        if (!cur) throw notFound(`comment ${commentId}`);
        if (role === 'reviewer' && cur.author.id !== actor.id)
          throw new AppError('forbidden', 'Reviewers resolve their own threads; editors resolve any');
        const next = CommentThreadSchema.parse({
          ...cur,
          status,
          resolvedBy: status === 'resolved' ? authorOf(actor) : null,
          resolvedAt: status === 'resolved' ? new Date().toISOString() : null,
        });
        tx.set(docPath.comment(commentId), next);
        return next;
      },
      { message: `${status === 'resolved' ? 'Resolve' : 'Reopen'} a comment` },
    );
    return result;
  }

  // Reviews

  async reviews(projectId: string): Promise<Review[]> {
    const docs = await this.deps.projects.docs(projectId);
    return Object.values(docs.reviews).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** A review, with a share link when asked: the URL (and its secret) is returned once. */
  async createReview(
    actor: Actor,
    projectId: string,
    input: {
      title: string;
      target: ReviewTarget;
      gate?: string | null;
      required?: number;
      link?: { expiresInDays?: number } | null;
    },
  ): Promise<{ review: Review; url: string | null }> {
    const secret = input.link ? randomToken(32) : null;
    const { result: review } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const docs = docsFromEntries(tx.entries());
        if (input.target.kind === 'export' && !docs.exports[input.target.exportId]?.media)
          throw notFound(`export ${input.target.exportId}`);
        if (input.target.kind === 'clip' && !docs.clips[input.target.clipId])
          throw notFound(`clip ${input.target.clipId}`);
        if (input.gate && !stageOfGate(docs.project.kind, input.gate))
          throw invalid(`unknown gate ${input.gate} for ${docs.project.kind} projects`);
        const review = ReviewSchema.parse({
          id: newId('review'),
          title: input.title.trim(),
          target: input.target,
          gate: input.gate ?? null,
          required: input.required ?? 1,
          link: secret
            ? {
                hash: sha256(secret),
                expiresAt: input.link?.expiresInDays
                  ? new Date(Date.now() + input.link.expiresInDays * 86_400_000).toISOString()
                  : null,
              }
            : null,
          createdBy: authorOf(actor),
          createdAt: new Date().toISOString(),
        });
        tx.set(docPath.review(review.id), review);
        return review;
      },
      { message: `Ask for a review: “${input.title.trim()}”${input.gate ? ` (${input.gate})` : ''}` },
    );
    return {
      review,
      url: secret
        ? `${this.deps.config.publicUrl}/review/${reviewToken(projectId, review.id, secret)}`
        : null,
    };
  }

  async revokeLink(actor: Actor, projectId: string, reviewId: string): Promise<Review> {
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const cur = tx.get<Review>(docPath.review(reviewId));
        if (!cur?.link) throw notFound(`review link ${reviewId}`);
        const next = {
          ...cur,
          link: { ...cur.link, revokedAt: cur.link.revokedAt ?? new Date().toISOString() },
        };
        tx.set(docPath.review(reviewId), next);
        return next;
      },
      { message: 'Revoke a review link' },
    );
    return result;
  }

  /** A decision on a review; an approved review for a gate approves the gate (as the review's director). */
  async decide(
    actor: Actor,
    projectId: string,
    reviewId: string,
    input: { decision: ReviewDecision['decision']; note?: string },
    opts: { author?: Author } = {},
  ): Promise<Review> {
    const author = opts.author ?? authorOf(actor);
    const { result: review } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const cur = tx.get<Review>(docPath.review(reviewId));
        if (!cur) throw notFound(`review ${reviewId}`);
        if (cur.status === 'closed') throw invalid('this review is closed');
        const decisions = [
          ...cur.decisions,
          { author, decision: input.decision, note: input.note?.trim() ?? '', at: new Date().toISOString() },
        ];
        const next = ReviewSchema.parse({
          ...cur,
          decisions,
          status: reviewOutcome(decisions, cur.required),
        });
        tx.set(docPath.review(reviewId), next);
        return next;
      },
      {
        message: `${author.name} ${input.decision === 'approve' ? 'approved' : 'asked for changes in'} a review`,
      },
    );
    this.deps.metrics.review.inc({ event: input.decision });
    const link = `/p/${projectId}/overview?review=${reviewId}`;
    await this.notify(
      projectId,
      this.userIdsOf([review.createdBy]),
      {
        kind: 'decision',
        title: `${author.name} ${input.decision === 'approve' ? 'approved' : 'asked for changes'}: “${review.title}”`,
        body: input.note ?? '',
        link,
      },
      author,
    );
    if (review.status === 'approved' && review.gate && !review.gateApprovedAt)
      return this.applyGate(projectId, review);
    return review;
  }

  /** The gate of an approved review, approved in the name of the review's director when its requirements hold. */
  private async applyGate(projectId: string, review: Review): Promise<Review> {
    // The review's director approves; an agent's review stays an agent's approval (settings.approvals.allowAgents).
    const director: Actor = {
      kind:
        review.createdBy.kind === 'user' || review.createdBy.kind === 'agent'
          ? review.createdBy.kind
          : 'system',
      id: review.createdBy.id,
      name: `${review.createdBy.name} via review “${review.title}”`,
    };
    const link = `/p/${projectId}/overview?review=${review.id}`;
    try {
      await this.workflow.approve(director, projectId, review.gate!);
    } catch (err) {
      await this.notify(projectId, this.userIdsOf([review.createdBy]), {
        kind: 'gate',
        title: `“${review.title}” is approved, but ${review.gate} cannot be yet`,
        body: (err as Error).message.slice(0, 900),
        link,
      });
      return review;
    }
    const { result } = await this.mutate(
      director,
      projectId,
      (tx) => {
        const cur = tx.require<Review>(docPath.review(review.id), `review ${review.id}`);
        const next = { ...cur, gateApprovedAt: new Date().toISOString() };
        tx.set(docPath.review(review.id), next);
        return next;
      },
      { message: `Review “${review.title}” approved ${review.gate}` },
    );
    await this.deps.accounts.record(currentPrincipal(), 'project.approval', {
      projectId,
      detail: { gate: review.gate, reviewId: review.id, via: 'review' },
    });
    this.deps.log.info(
      { projectId, reviewId: review.id, gate: review.gate },
      'gate approved through a review',
    );
    await this.notify(projectId, this.userIdsOf([review.createdBy]), {
      kind: 'gate',
      title: `${review.gate} approved through “${review.title}”`,
      body: '',
      link,
    });
    return result;
  }

  // Guests of share links (docs/design/review.md#reviews-and-share-links)

  /** The review a token opens, or 404 (unknown, wrong secret, revoked or expired). */
  async guestAccess(token: string): Promise<{ projectId: string; review: Review; docs: ProjectDocs }> {
    const t = parseReviewToken(token);
    const gone = () => new AppError('not_found', 'This review link does not exist or has expired');
    if (!t) throw gone();
    const docs = await this.deps.projects.docs(t.projectId).catch(() => null);
    const review = docs?.reviews[t.reviewId];
    if (!docs || !review?.link) throw gone();
    const a = Buffer.from(sha256(t.secret));
    const b = Buffer.from(review.link.hash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw gone();
    if (review.link.revokedAt || (review.link.expiresAt && Date.parse(review.link.expiresAt) < Date.now()))
      throw gone();
    return { projectId: t.projectId, review, docs };
  }

  /** What a guest sees: the review, its media and the comments on them. */
  async guestView(token: string) {
    const { projectId, review, docs } = await this.guestAccess(token);
    this.deps.metrics.review.inc({ event: 'link_open' });
    const items = reviewItems(review, docs);
    const { link: _l, ...open } = review;
    return {
      projectId,
      project: { title: docs.project.title },
      review: open,
      items,
      comments: items.flatMap((i) => threadsFor(docs.comments, i.target)),
    };
  }

  /** Whether a media path belongs to what the review shows (guests read nothing else). */
  async guestMedia(token: string, path: string): Promise<{ projectId: string } | null> {
    const { projectId, review, docs } = await this.guestAccess(token);
    const allowed = reviewItems(review, docs).flatMap((i) =>
      [i.media.path, i.media.poster?.path].filter(Boolean),
    );
    return allowed.includes(path) ? { projectId } : null;
  }

  private inReview(docs: ProjectDocs, reviewId: string, c: Pick<CommentThread, 'target'>): boolean {
    const review = docs.reviews[reviewId];
    return !!review && reviewItems(review, docs).some((i) => sameTarget(i.target, c.target));
  }

  async guestComment(
    token: string,
    name: string,
    input: { target: CommentTarget; at?: number | null; annotation?: Annotation | null; body: string },
  ) {
    const { projectId, review, docs } = await this.guestAccess(token);
    if (!reviewItems(review, docs).some((i) => sameTarget(i.target, input.target)))
      throw new AppError('forbidden', 'Guests comment on what the review shows');
    const author = guestAuthor(review.id, name);
    return this.createComment({ kind: 'system', id: 'review-link', name: author.name }, projectId, input, {
      author,
      reviewId: review.id,
    });
  }

  async guestReply(token: string, name: string, commentId: string, body: string) {
    const { projectId, review } = await this.guestAccess(token);
    const author = guestAuthor(review.id, name);
    return this.reply({ kind: 'system', id: 'review-link', name: author.name }, projectId, commentId, body, {
      author,
      reviewId: review.id,
    });
  }

  async guestDecide(
    token: string,
    name: string,
    input: { decision: ReviewDecision['decision']; note?: string },
  ) {
    const { projectId, review } = await this.guestAccess(token);
    const author = guestAuthor(review.id, name);
    const next = await this.decide(
      { kind: 'system', id: 'review-link', name: author.name },
      projectId,
      review.id,
      input,
      {
        author,
      },
    );
    const { link: _l, ...open } = next;
    return open;
  }

  // Notifications

  /** User ids among authors (members and the configured user). */
  private userIdsOf(authors: readonly Author[]): string[] {
    return authors.filter((a) => a.kind === 'user').map((a) => a.id);
  }

  private async notify(
    projectId: string,
    userIds: readonly string[],
    n: Pick<Notification, 'kind' | 'title' | 'body' | 'link'>,
    except?: Author,
  ): Promise<void> {
    await this.deps.notifications.notify(userIds, { ...n, projectId }, { except: except?.id });
  }
}
