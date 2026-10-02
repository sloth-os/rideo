import {
  type CommentTarget,
  type CommentThread,
  type MediaRef,
  type ProjectDocs,
  sameTarget,
  threadsFor,
} from '@rideo/shared';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Dialog } from '../../components/ui';
import { api, mediaUrl } from '../../lib/api';
import { useAuth, useProjectRole } from '../../lib/auth';
import { useProject } from '../../store/project';
import { ReviewPlayer } from './ReviewPlayer';

/** The media a comment target points at, and a label for it. */
export function targetMedia(
  docs: ProjectDocs,
  target: CommentTarget,
): { label: string; media: MediaRef } | null {
  if (target.kind === 'export') {
    const e = docs.exports[target.exportId];
    return e?.media ? { label: `Export · ${e.quality}`, media: e.media } : null;
  }
  const clip = docs.clips[target.clipId];
  const shot = clip?.shots.find((s) => s.id === target.shotId);
  const k = shot?.takes.findIndex((t) => t.id === target.takeId) ?? -1;
  const take = k >= 0 ? shot?.takes[k] : undefined;
  return clip && shot && take?.video
    ? { label: `C${clip.index + 1}·S${shot.index + 1} · take ${k + 1}`, media: take.video }
    : null;
}

/** Open threads on a target. */
export function openThreads(comments: Record<string, CommentThread>, target: CommentTarget): number {
  return Object.values(comments).filter((c) => c.status === 'open' && sameTarget(c.target, target)).length;
}

const ReviewCtx = createContext<{ open: (target: CommentTarget, focusId?: string) => void } | null>(null);

/** Opens the review player for a take or an export of the project in view. */
export function useReviewDialog() {
  return useContext(ReviewCtx);
}

/**
 * The studio's review player in a dialog (docs/design/review.md#surfaces); `?comment=<id>` (a notification's link)
 * opens it on that thread.
 */
export function ReviewHost({ children }: { children: ReactNode }) {
  const docs = useProject((s) => s.docs);
  const me = useAuth((s) => s.me);
  const { can } = useProjectRole(docs?.project);
  const [state, setState] = useState<{ target: CommentTarget; focus?: string } | null>(null);
  const [params, setParams] = useSearchParams();
  const linked = params.get('comment');
  const linkedThread = linked ? docs?.comments[linked] : undefined;
  useEffect(() => {
    if (!linked || !linkedThread) return;
    setState({ target: linkedThread.target, focus: linked });
    const next = new URLSearchParams(params);
    next.delete('comment');
    next.delete('take');
    setParams(next, { replace: true });
  }, [linked, linkedThread, params, setParams]);

  const item = state && docs ? targetMedia(docs, state.target) : null;
  const projectId = docs?.project.id ?? '';
  return (
    <ReviewCtx.Provider value={{ open: (target, focus) => setState({ target, focus }) }}>
      {children}
      <Dialog open={!!state && !!item} onClose={() => setState(null)} title={item?.label ?? 'Review'} wide>
        {state && item && docs ? (
          <ReviewPlayer
            src={mediaUrl(projectId, item.media.path)}
            poster={item.media.poster ? mediaUrl(projectId, item.media.poster.path) : undefined}
            threads={threadsFor(docs.comments, state.target)}
            canComment={can('project.comment')}
            canResolve={(t) => can('project.edit') || (!!me?.user && t.author.id === me.user.id)}
            onComment={(input) => api.createComment(projectId, { ...input, target: state.target })}
            onReply={(id, body) => api.replyComment(projectId, id, body)}
            onResolve={(id, status) => api.setCommentStatus(projectId, id, status)}
            focusId={state.focus}
          />
        ) : null}
      </Dialog>
    </ReviewCtx.Provider>
  );
}
