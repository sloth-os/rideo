import { type CommentThread, CommentThreadSchema } from '@rideo/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatAt, ReviewPlayer } from '../src/features/review/ReviewPlayer';
import { useNotifications } from '../src/store/notifications';

afterEach(cleanup);

const take = {
  kind: 'take' as const,
  clipId: 'clp_000000000001',
  shotId: 'sht_000000000001',
  takeId: 'tak_000000000001',
};
const thread = (over: Partial<CommentThread> = {}): CommentThread =>
  CommentThreadSchema.parse({
    id: 'cmt_000000000001',
    target: take,
    at: 1.5,
    author: { kind: 'guest', id: 'rev_000000000001:ana', name: 'Ana' },
    body: 'Bigger logo here',
    createdAt: '2026-10-01T10:00:00.000Z',
    ...over,
  });

describe('review player (docs/design/review.md#surfaces)', () => {
  it('formats comment times', () => {
    expect(formatAt(0)).toBe('0:00.0');
    expect(formatAt(1.25)).toBe('0:01.3');
    expect(formatAt(83.04)).toBe('1:23.0');
  });

  it('lists threads with authors, times and replies, filters open ones and resolves when allowed', async () => {
    const onResolve = vi.fn(async () => undefined);
    const threads = [
      thread(),
      thread({
        id: 'cmt_000000000002',
        at: null,
        author: { kind: 'user', id: 'usr_000000000001', name: 'Ben' },
        body: 'Overall: warmer',
        status: 'resolved',
        replies: [
          {
            id: 'rpl_000000000001',
            author: { kind: 'agent', id: 'claude-code', name: 'Claude Code (for Ben)' },
            body: 'Relit',
            mentions: [],
            createdAt: '2026-10-01T10:01:00.000Z',
          },
        ],
      }),
    ];
    render(
      <ReviewPlayer
        src="/v.mp4"
        threads={threads}
        canComment
        canResolve={(t) => t.author.kind === 'user'}
        onComment={vi.fn()}
        onReply={vi.fn()}
        onResolve={onResolve}
      />,
    );
    const items = screen.getAllByTestId('comment-thread');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByTestId('comment-time').textContent).toBe('0:01.5');
    expect(within(items[0]!).getByText('guest')).toBeTruthy();
    expect(within(items[0]!).queryByTestId('comment-resolve')).toBeNull();
    expect(within(items[1]!).getByTestId('comment-reply').textContent).toContain('Claude Code (for Ben)');
    expect(screen.getByTestId('comments-open').textContent).toBe('1 open');
    fireEvent.click(within(items[1]!).getByTestId('comment-resolve'));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith('cmt_000000000002', 'open'));
    fireEvent.click(screen.getByTestId('comments-filter-open'));
    expect(screen.getAllByTestId('comment-thread')).toHaveLength(1);
  });

  it('posts a comment at the playhead, or for the whole video, and hides the composer without the right', async () => {
    const onComment = vi.fn(async () => undefined);
    const { rerender } = render(
      <ReviewPlayer src="/v.mp4" threads={[]} canComment onComment={onComment} onReply={vi.fn()} />,
    );
    expect(screen.getByTestId('comments-empty')).toBeTruthy();
    const post = screen.getByTestId('comment-post') as HTMLButtonElement;
    expect(post.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('comment-body'), { target: { value: '  Keep this shot  ' } });
    fireEvent.click(post);
    await waitFor(() =>
      expect(onComment).toHaveBeenLastCalledWith({ at: 0, annotation: null, body: 'Keep this shot' }),
    );
    fireEvent.click(screen.getByTestId('comment-at-toggle'));
    fireEvent.change(screen.getByTestId('comment-body'), { target: { value: 'Overall fine' } });
    fireEvent.click(screen.getByTestId('comment-post'));
    await waitFor(() =>
      expect(onComment).toHaveBeenLastCalledWith({ at: null, annotation: null, body: 'Overall fine' }),
    );
    rerender(
      <ReviewPlayer src="/v.mp4" threads={[]} canComment={false} onComment={onComment} onReply={vi.fn()} />,
    );
    expect(screen.queryByTestId('comment-composer')).toBeNull();
  });
});

describe('notifications store', () => {
  beforeEach(() => useNotifications.setState({ items: [], unread: 0, loaded: true }));
  afterEach(() => vi.unstubAllGlobals());

  it('adds pushed notifications once and marks them read', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ unread: 0 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const n = {
      id: 'ntf_000000000001',
      at: '2026-10-01T10:00:00.000Z',
      kind: 'reply' as const,
      projectId: null,
      title: 'Ben replied',
      body: '',
      link: '/',
      read: false,
    };
    useNotifications.getState().push(n);
    useNotifications.getState().push(n);
    expect(useNotifications.getState()).toMatchObject({ unread: 1, items: [n] });
    await useNotifications.getState().markRead([n.id]);
    expect(useNotifications.getState().unread).toBe(0);
    expect(useNotifications.getState().items[0]!.read).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/notifications/read',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
