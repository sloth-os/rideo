# Review and approvals

People review a film where it is made: timecoded comments and drawings on takes and exports, from members of the
project and from outside reviewers who open a share link without an account. A review can stand for a workflow
gate, so the client's approval of the pilot is the pilot's approval. Mentions notify people; agents read, answer
and resolve notes over MCP.

## Comments

A comment thread is a versioned document, `comments/<id>.json` (synced, diffable, restorable like everything else):

```ts
type CommentThread = {
  id: string;
  target:
    | { kind: 'take'; clipId: string; shotId: string; takeId: string }
    | { kind: 'export'; exportId: string };
  /** Seconds into the take or the export; null for the whole of it. */
  at: number | null;
  /** A drawing on the frame at `at`: strokes, arrows and boxes in 0–1 frame coordinates. */
  annotation: { shapes: Shape[] } | null;
  author: Author;              // a member, an agent, or a guest of a share link: {kind, id, name}
  body: string;                // up to 4000 characters; @mentions name members
  mentions: string[];          // user ids
  replies: { id; author: Author; body; mentions; createdAt }[];
  status: 'open' | 'resolved';
  resolvedBy: Author | null; resolvedAt: string | null;
  reviewId: string | null;     // posted through a review (link)
  createdAt: string;
};
type Shape = { kind: 'stroke'; points: [x, y][]; color } | { kind: 'arrow' | 'box'; from: [x, y]; to: [x, y]; color };
```

Reviewers (`project.comment`) comment, reply and resolve their own threads; editors resolve any thread. Mentions are
`@` followed by a member's name or email; they resolve to members of the project when the comment is saved.

## Reviews and share links

A review asks for a decision on something, from members and from people with a link, as `reviews/<id>.json`:

```ts
type Review = {
  id: string;
  title: string;
  target: { kind: 'export'; exportId: string } | { kind: 'clip'; clipId: string };
  /** The workflow gate this review decides (e.g. pilot_approved), or null. */
  gate: string | null;
  link: { hash: string; expiresAt: string | null; revokedAt: string | null } | null;
  decisions: { author: Author; decision: 'approve' | 'changes'; note: string; at: string }[];
  /** How many approvals close it (default 1); a request for changes reopens the work. */
  required: number;
  status: 'open' | 'approved' | 'changes_requested' | 'closed';
  createdBy: Author; createdAt: string;
  gateApprovedAt: string | null;   // when the review approved its gate
};
```

Directors (`project.approve`) create reviews. A **share link** is `/review/<projectId>.<reviewId>.<secret>` (a
256-bit secret; only its SHA-256 is stored, compared in constant time, and the URL is returned once): whoever has it
sees only the review's target (the export's video, or the clip's selected takes in shot order), the comments on it,
and may comment, draw, reply and decide under a name they type, until the link expires or is revoked. Guests are
`{kind: "guest", id: "<reviewId>:<slug(name)>", name}`; their media comes through `GET /api/review/:token/media/*`,
which serves only the review's videos and posters. Nothing else of the project is reachable with a link, and an
unknown, wrong, revoked or expired link is a plain 404. Commits of guests are by `review-link` under the guest's name.

A person's **decision** counts once: their latest. Any request for changes holds the review at `changes_requested`;
otherwise it is `approved` when `required` people approved.

**Gates.** A review for a gate approves the gate when it reaches its approvals (`required`), if the gate's
requirements hold and the project is at that gate, in the name of the review's director (the commit and the approval
read `<director> via review “<title>”`; an agent's review stays an agent's approval, so
`settings.approvals.allowAgents` applies), and is audited as `project.approval` with `via: "review"`. A request for
changes marks the review `changes_requested` and notifies the director. Gates that cannot be approved yet stay as
they are and the director is told why (a `gate` notification with the unmet requirements); the next approval tries
again.

## Notifications

People are notified when they are mentioned, when someone replies to their thread, when a review they created gets
a decision or a comment, and when a review's gate is approved. Notifications are kept per person
(`<dataDir>/notifications/<userId>.json`, the last 500), pushed to their open tabs over the live WebSocket
(`{type: "notification", notification}`), and listed with `GET /api/notifications` (`POST
/api/notifications/read` marks them read). Without accounts the configured user gets them. They also reach the
person's devices through Web Push, and long work that ends adds `job` notifications ([installable app](pwa.md)).

## Surfaces

| Surface | REST | MCP |
|---|---|---|
| comments | `GET /api/projects/:id/comments?target&status`, `POST …/comments`, `POST …/comments/:cid/replies`, `PATCH …/comments/:cid` `{status}` | `comments_list`, `comment_create`, `comment_reply`, `comment_resolve` |
| reviews | `GET /api/projects/:id/reviews`, `POST …/reviews` `{title, target, gate?, required?, link?: {expiresInDays?}}` → the review and, once, its link | `review_create`, `reviews_list` |
| decisions | `POST …/reviews/:rid/decisions` `{decision, note}` | `review_decide` |
| links | `DELETE …/reviews/:rid/link` (revoke) | – |
| guests | `GET /api/review/:token` (the review without its link, the items and their comments), `GET …/media/*`, `POST /api/review/:token/comments`, `…/comments/:cid/replies`, `…/decisions` (each with `name`) | – |
| notifications | `GET /api/notifications`, `POST /api/notifications/read` | `notifications_list` |

The studio shows comment counts on take tiles and export cards, a **review player** (the video, comment markers on
its timeline, the drawing tools, the threads with replies and resolve) for takes and exports, a **Reviews** card in
the overview (create a review with a link, copy it, see decisions, revoke), and a bell in the header with the
notifications. The guest page `/review/<token>` is the same player for outsiders, on phones too.

Mentions resolve to the project's members; a person mentioned in a reply gets the mention, the others in the
thread get the reply. Notification links open the place: `/p/<id>/clips?take=<takeId>&comment=<id>`,
`/p/<id>/exports?comment=<id>` (the review player on that thread) and `/p/<id>/overview?review=<id>`.

Logs carry `projectId` and the review id; `rideo_review_total{event}` counts comments, replies, decisions
(`approve`, `changes`) and link opens (`link_open`).

## Testing

`packages/shared/test/review.test.ts` (mentions, outcomes, what a review shows, tokens, route permissions),
`packages/server/test/unit/notifications.test.ts`, `packages/server/test/integration/review.test.ts` (roles,
mentions and notifications, a share link's scope, decisions that approve the pilot gate, MCP) and
`e2e/review.spec.ts` (desktop and phone: drawing a note, replying and resolving, a review with a link, the guest
page, the bell, the gate).
