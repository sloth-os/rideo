import { describe, expect, it } from 'vitest';
import {
  type Author,
  authorOf,
  CommentThreadSchema,
  ExportSchema,
  parseMentions,
  parseReviewToken,
  type ReviewDecision,
  ReviewSchema,
  ROUTE_PERMISSIONS,
  reviewItems,
  reviewOutcome,
  reviewToken,
  routePermission,
  ShapeSchema,
  sameTarget,
  threadsFor,
} from '../src';
import * as f from '../src/testing/fixtures';

const people = [
  { userId: 'usr_00000000mira', name: 'Mira Okafor', email: 'mira@studio.test' },
  { userId: 'usr_000000000ben', name: 'Ben Ito', email: 'ben@studio.test' },
  { userId: 'usr_00000000ben2', name: 'Ben Hale', email: 'hale@studio.test' },
  { userId: 'usr_00000000cleo', name: 'Cleo', email: 'cleo@studio.test' },
];
const a = (id: string, kind: Author['kind'] = 'user'): Author => ({ kind, id, name: id });
const d = (author: Author, decision: ReviewDecision['decision']): ReviewDecision => ({
  author,
  decision,
  note: '',
  at: '2026-10-01T00:00:00.000Z',
});

describe('review helpers (docs/design/review.md)', () => {
  it('finds mentions by full name, unique first name or email, not by ambiguous names or in words', () => {
    expect(parseMentions('@Mira Okafor and @cleo, look', people)).toEqual([
      'usr_00000000mira',
      'usr_00000000cleo',
    ]);
    expect(parseMentions('@mira: the lamp', people)).toEqual(['usr_00000000mira']);
    // two Bens: the first name alone names nobody; the full name or email does
    expect(parseMentions('@Ben the lamp', people)).toEqual([]);
    expect(parseMentions('@Ben Hale and @ben@studio.test', people)).toEqual([
      'usr_000000000ben',
      'usr_00000000ben2',
    ]);
    // not inside emails or longer words
    expect(parseMentions('mail cleo@mira.test or @cleopatra', people)).toEqual([]);
    expect(parseMentions('no mentions', people)).toEqual([]);
  });

  it('decides a review from each person’s latest decision', () => {
    const ana = a('rev_000000000001:ana', 'guest');
    const ben = a('usr_000000000ben');
    expect(reviewOutcome([], 1)).toBe('open');
    expect(reviewOutcome([d(ana, 'approve')], 1)).toBe('approved');
    expect(reviewOutcome([d(ana, 'approve')], 2)).toBe('open');
    expect(reviewOutcome([d(ana, 'approve'), d(ana, 'approve')], 2)).toBe('open');
    expect(reviewOutcome([d(ana, 'approve'), d(ben, 'approve')], 2)).toBe('approved');
    expect(reviewOutcome([d(ana, 'approve'), d(ben, 'changes')], 1)).toBe('changes_requested');
    expect(reviewOutcome([d(ben, 'changes'), d(ben, 'approve')], 1)).toBe('approved');
    // a guest and a member with the same id stay different people
    expect(reviewOutcome([d(a('x', 'guest'), 'approve'), d(a('x', 'user'), 'approve')], 2)).toBe('approved');
  });

  it('shows an export’s video, or the selected takes of a clip in shot order', () => {
    const t1 = f.take();
    const t2 = f.take();
    const unselected = f.take();
    const clip = f.clip({
      index: 2,
      shots: [
        f.shot({ index: 1, takes: [t2], selectedTakeId: t2.id }),
        f.shot({ index: 0, takes: [unselected, t1], selectedTakeId: t1.id }),
        f.shot({ index: 2, takes: [f.take({ video: null })] }),
      ],
    });
    const exp = ExportSchema.parse({
      id: 'exp_000000000001',
      createdAt: '2026-10-01T00:00:00.000Z',
      method: 'browser',
      status: 'succeeded',
      media: f.media(),
    });
    const docs = f.docs({ clips: { [clip.id]: clip }, exports: { [exp.id]: exp } });
    const items = reviewItems({ target: { kind: 'clip', clipId: clip.id } }, docs);
    expect(items.map((i) => [i.label, i.key])).toEqual([
      ['C3·S1', t1.id],
      ['C3·S2', t2.id],
    ]);
    expect(items[0]!.target).toEqual({
      kind: 'take',
      clipId: clip.id,
      shotId: clip.shots[1]!.id,
      takeId: t1.id,
    });
    expect(reviewItems({ target: { kind: 'export', exportId: exp.id } }, docs)).toMatchObject([
      { label: 'Export', target: { kind: 'export', exportId: exp.id }, media: exp.media },
    ]);
    expect(reviewItems({ target: { kind: 'export', exportId: 'exp_000000000404' } }, docs)).toEqual([]);
  });

  it('keeps threads per target, ordered by time', () => {
    const target = {
      kind: 'take' as const,
      clipId: 'cli_000000000001',
      shotId: 'sho_000000000001',
      takeId: 'tak_000000000001',
    };
    const thread = (
      id: string,
      at: number | null,
      createdAt: string,
      t: typeof target | { kind: 'export'; exportId: string } = target,
    ) =>
      CommentThreadSchema.parse({ id, target: t, at, author: a('usr_00000000cleo'), body: 'x', createdAt });
    const comments = {
      cmt_000000000003: thread('cmt_000000000003', 3, '2026-10-01T00:00:01.000Z'),
      cmt_000000000001: thread('cmt_000000000001', 1, '2026-10-01T00:00:02.000Z'),
      cmt_000000000002: thread('cmt_000000000002', null, '2026-10-01T00:00:03.000Z'),
      cmt_000000000004: thread('cmt_000000000004', 0, '2026-10-01T00:00:00.000Z', {
        kind: 'export',
        exportId: 'exp_000000000001',
      }),
    };
    expect(threadsFor(comments, target).map((c) => c.id)).toEqual([
      'cmt_000000000002',
      'cmt_000000000001',
      'cmt_000000000003',
    ]);
    expect(sameTarget(target, { ...target, clipId: 'cli_000000000009' })).toBe(true);
    expect(sameTarget(target, { kind: 'export', exportId: 'exp_000000000001' })).toBe(false);
  });

  it('round-trips share-link tokens and rejects anything else', () => {
    const token = reviewToken('prj_0000000000ab', 'rev_0000000000cd', 'Zm9vYmFyYmF6cXV4cXV1eDEyMzQ1Ng');
    expect(parseReviewToken(token)).toEqual({
      projectId: 'prj_0000000000ab',
      reviewId: 'rev_0000000000cd',
      secret: 'Zm9vYmFyYmF6cXV4cXV1eDEyMzQ1Ng',
    });
    expect(parseReviewToken('prj_0000000000ab.rev_0000000000cd.short')).toBeNull();
    expect(
      parseReviewToken('../prj_0000000000ab.rev_0000000000cd.Zm9vYmFyYmF6cXV4cXV1eDEyMzQ1Ng'),
    ).toBeNull();
    expect(parseReviewToken('cmt_0000000000ab.rev_0000000000cd.Zm9vYmFyYmF6cXV4cXV1eDEyMzQ1Ng')).toBeNull();
  });

  it('names agents with the person they act for, and validates drawings and reviews', () => {
    expect(
      authorOf({
        kind: 'agent',
        id: 'claude-code',
        name: 'Claude Code',
        onBehalfOf: { kind: 'user', id: 'u', name: 'Ben' },
      }),
    ).toEqual({
      kind: 'agent',
      id: 'claude-code',
      name: 'Claude Code (for Ben)',
    });
    expect(
      ShapeSchema.safeParse({ kind: 'box', from: [0, 0], to: [1.2, 0.5], color: '#FF6B3D' }).success,
    ).toBe(false);
    expect(ShapeSchema.safeParse({ kind: 'stroke', points: [[0, 0]], color: '#FF6B3D' }).success).toBe(false);
    expect(ShapeSchema.safeParse({ kind: 'arrow', from: [0, 0], to: [1, 1], color: 'red' }).success).toBe(
      false,
    );
    const review = ReviewSchema.parse({
      id: 'rev_000000000001',
      title: 'Pilot',
      target: { kind: 'clip', clipId: 'cli_000000000001' },
      createdBy: a('usr_00000000mira'),
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    expect(review).toMatchObject({
      gate: null,
      link: null,
      decisions: [],
      required: 1,
      status: 'open',
      gateApprovedAt: null,
    });
  });

  it('maps review routes to permissions: comments and decisions for reviewers, reviews and links for directors', () => {
    expect(ROUTE_PERMISSIONS.length).toBeGreaterThan(0);
    expect(routePermission('GET', '/comments')).toBe('project.read');
    expect(routePermission('POST', '/comments')).toBe('project.comment');
    expect(routePermission('POST', '/comments/cmt_000000000001/replies')).toBe('project.comment');
    expect(routePermission('PATCH', '/comments/cmt_000000000001')).toBe('project.comment');
    expect(routePermission('POST', '/reviews/rev_000000000001/decisions')).toBe('project.comment');
    expect(routePermission('POST', '/reviews')).toBe('project.approve');
    expect(routePermission('DELETE', '/reviews/rev_000000000001/link')).toBe('project.approve');
  });
});
