import { type Clip, DESK_MODES, type DeskMode, deskBrief } from '@rideo/shared';
import { Box, RotateCw, Undo2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Badge, Button, Dialog } from '../../components/ui';
import { ApiError, api, etagValue } from '../../lib/api';
import { useConfig } from '../../lib/config';
import { useProject } from '../../store/project';
import { useUi } from '../../store/ui';
import { uploadReference } from '../clips/reference-upload';
import { DeskBridge, DeskStateConflict, type DeskStatus, deskStatesSent } from './bridge';
import { applyDeskResult, pngToJpeg } from './results';

/** Where the desk's headers are explained (the timeout message links to it). */
export const DESK_HEADERS_DOC =
  'https://github.com/sloth-os/rideo/blob/main/docs/design/director-desk.md#topology-and-headers';

/**
 * The desk's iframe sandbox (docs/design/director-desk.md#topology-and-headers): scripts and its own storage, its
 * downloads, forms, dialogs, popups and pointer lock, never navigating the studio's tab (no `allow-top-navigation*`).
 */
export const DESK_SANDBOX =
  'allow-scripts allow-same-origin allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-pointer-lock';
/** What the desk may use of the page's features: full screen, the clipboard, and the screen kept awake while it renders. */
export const DESK_ALLOW = 'fullscreen; clipboard-write; screen-wake-lock';

/** Where this browser remembers the mode last attached in a project. */
const modeKey = (projectId: string) => `rideo.deskMode.${projectId}`;

/**
 * The mode last attached in a project (docs/design/director-desk.md#the-desk), which the desk opens on
 * (`defaultMode`); Camera when none. The desk's own Follow menu decides what it renders.
 */
export function rememberedDeskMode(projectId: string): DeskMode {
  try {
    const saved = localStorage.getItem(modeKey(projectId));
    return (DESK_MODES as readonly string[]).includes(saved ?? '') ? (saved as DeskMode) : 'camera';
  } catch {
    return 'camera';
  }
}

/** Remembers the mode a result attached, for the project's next desk. */
export function rememberDeskMode(projectId: string, mode: DeskMode): void {
  try {
    localStorage.setItem(modeKey(projectId), mode);
  } catch {
    // storage unavailable: the desk opens on Camera next time
  }
}

/** What each confirmation says: what replacing the kept state, or starting over, does and what is lost. */
const CONFIRM = {
  unreadable:
    'What the desk holds now (staged from the brief or from this browser’s copy of the scene) replaces the stored desk state, which this desk could not read, and later changes are stored as usual. The project’s history keeps the state it replaces.',
  conflict:
    'What the desk holds now replaces the desk state another session stored for this clip, and later changes are stored as usual. The project’s history keeps the state it replaces.',
  cleared:
    'Another session cleared the stored desk state of this clip: what the desk holds now is stored for it, and later changes are stored as usual. The project’s history keeps the state that was cleared.',
  startOver:
    'The stored desk state of this scene is cleared and the desk opens again: from this browser’s own copy of the scene if it has one, else from the brief. What was staged only in the stored desk state is lost, and other browsers’ copies of the scene are replaced by what is stored next: start over in the browser that has the newest work.',
} as const;

/**
 * The 3D-Editor's director's desk on a scene (docs/design/director-desk.md#the-desk): a full-screen panel inside the
 * studio's root (it keeps the theme), with the scene's title and Close, a status line and the desk's iframe filling
 * the rest. The desk's own Follow menu decides which reference its Send renders; the panel opens it on the mode last
 * attached in the project. The page behind it is inert while it is open; on phones the panel keeps inside the
 * safe-area insets. Keys pressed in the desk go to the desk: the panel closes with its button, never with Escape.
 */
export function DeskPanel({ clip, onClose }: { clip: Clip; onClose: () => void }) {
  const config = useConfig();
  const projectId = useProject((s) => s.projectId);
  const url = config?.features.desk?.url ?? null;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const readOnly = clip.status === 'approved';
  // read when the desk opens: approved clips open read-only
  const opening = useRef({ readOnly, hostName: config?.brand.name || 'Rideo' });
  opening.current = { readOnly, hostName: config?.brand.name || 'Rideo' };
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<DeskBridge | null>(null);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [status, setStatus] = useState<DeskStatus | null>(null);
  const [visible, setVisible] = useState(false);
  /** The confirmation open: Replace the stored desk state, or Start over. */
  const [confirm, setConfirm] = useState<'replace' | 'startOver' | null>(null);

  // The panel goes to the studio's root element, so the rest of the root can be made inert
  useLayoutEffect(() => {
    setRoot(anchor.current?.closest<HTMLElement>('.rideo-root') ?? document.body);
  }, []);

  useEffect(() => {
    if (!root || !panel.current) return;
    const others = [...root.children].filter(
      (el): el is HTMLElement =>
        el !== panel.current && el instanceof HTMLElement && !el.hasAttribute('data-keep-active'),
    );
    const changed = others.filter((el) => !el.hasAttribute('inert'));
    for (const el of changed) el.setAttribute('inert', '');
    const raf = requestAnimationFrame(() => setVisible(true));
    panel.current.querySelector<HTMLElement>('[data-testid="desk-close"]')?.focus();
    return () => {
      cancelAnimationFrame(raf);
      for (const el of changed) el.removeAttribute('inert');
    };
  }, [root]);

  useEffect(() => {
    if (!url || !projectId) return;
    const desk = new DeskBridge({
      url,
      host: window,
      frame: () => frame.current?.contentWindow ?? null,
      brief: () => {
        const docs = useProject.getState().docs;
        const brief = docs ? deskBrief(docs, clip.id) : null;
        if (!brief) throw new Error('The scene has no shots to stage: plan it first');
        return brief;
      },
      // the desk offers all three modes and opens on the one last attached in the project
      options: () => ({
        hostName: opening.current.hostName.slice(0, 40),
        modes: [...DESK_MODES],
        defaultMode: rememberedDeskMode(projectId),
        readOnly: opening.current.readOnly,
      }),
      load: () => api.deskState(projectId, clip.id),
      store: async (state, precondition, signal) => {
        try {
          return (await api.saveDeskState(projectId, clip.id, state, precondition, signal)).deskState.media
            .hash;
        } catch (err) {
          // another session stored a newer state, or cleared it: the bridge keeps it
          // (docs/design/director-desk.md#when-rideo-stores-it)
          if (err instanceof ApiError && err.code === 'desk_state_conflict')
            throw new DeskStateConflict(etagValue(err.headers?.get('etag')), err.message);
          throw err;
        }
      },
      clear: () => api.clearDeskState(projectId, clip.id),
      applyResult: async (result, opened) => {
        const docs = useProject.getState().docs;
        const ack = await applyDeskResult(
          result,
          {
            project: docs!.project,
            clip: docs?.clips[clip.id] ?? null,
            mode: rememberedDeskMode(projectId),
            brief: opened.brief,
            retimed: opened.retimed,
          },
          {
            upload: (file, opts) => uploadReference(projectId, file, { ...opts, keep: false }),
            patchShot: (shotId, body) => api.updateShot(projectId, clip.id, shotId, body),
            poster: pngToJpeg,
          },
        );
        // the desk opens on the mode attached next time (docs/design/director-desk.md#the-result)
        if (ack.mode) rememberDeskMode(projectId, ack.mode);
        return ack;
      },
      onStatus: setStatus,
      onToast: (message, level) => useUi.getState().toast(message, level),
      onClosed: () => onCloseRef.current(),
      log: (message, data) => console.debug(`[desk] ${message}`, data ?? ''),
      // the states this tab sent for the clip outlive the panel: the next one knows them
      sent: deskStatesSent(`${projectId}/${clip.id}`),
    });
    bridge.current = desk;
    desk.start();
    return () => {
      // leaving without Close (another view, the back gesture, the clip leaving the list): the newest state not stored
      // yet is stored on the way out, best effort
      desk.flush();
      desk.dispose();
      bridge.current = null;
    };
  }, [url, projectId, clip.id]);

  const closing = status?.phase === 'closing' || status?.phase === 'closed';
  const close = () => {
    if (bridge.current) void bridge.current.close();
    else onCloseRef.current();
  };
  const title = clip.title.trim() || `Scene ${clip.index + 1}`;
  const body = (
    <div
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-label={`Director's desk: ${title}`}
      data-testid="desk-panel"
      className={`fixed inset-0 z-50 flex flex-col bg-bg text-text transition-opacity duration-200 ease-out motion-reduce:transition-none ${visible ? 'opacity-100' : 'opacity-0'}`}
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingRight: 'env(safe-area-inset-right)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
      }}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-3 py-2 sm:px-4">
        <Box className="size-4 shrink-0 text-muted" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold" data-testid="desk-title">
          {title}
        </h2>
        {readOnly ? (
          <Badge
            tone="success"
            testid="desk-read-only"
            title="The clip is approved: its shots keep their references"
          >
            Approved · read-only
          </Badge>
        ) : null}
        <Button
          size="sm"
          icon={<X className="size-4" />}
          onClick={close}
          loading={closing}
          data-testid="desk-close"
        >
          Close
        </Button>
      </header>
      <p
        className="border-b border-border bg-surface px-3 py-1.5 text-[12px] text-muted sm:px-4"
        role="status"
        aria-live="polite"
        data-testid="desk-status"
      >
        {status?.failure ? (
          <span data-testid="desk-failure">
            {status.remedy === 'headers' ? (
              <>
                {status.failure} (
                <a href={DESK_HEADERS_DOC} target="_blank" rel="noreferrer" className="text-accent underline">
                  the headers
                </a>
                ).
              </>
            ) : (
              status.failure
            )}
            {status.remedy === 'retry' ? (
              <span className="ml-2 inline-flex flex-wrap gap-2 align-middle">
                <Button
                  size="sm"
                  icon={<RotateCw className="size-4" />}
                  onClick={() => bridge.current?.retry()}
                  data-testid="desk-retry"
                >
                  Retry
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Undo2 className="size-4" />}
                  onClick={() => setConfirm('startOver')}
                  data-testid="desk-start-over"
                >
                  Start over
                </Button>
              </span>
            ) : null}
          </span>
        ) : (
          (status?.line ?? 'Connecting to the desk…')
        )}
        {status?.exportUnavailable ? (
          <span className="block text-warning" data-testid="desk-export-unavailable">
            {status.exportUnavailable}
          </span>
        ) : null}
      </p>
      {status?.kept ? (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-warning/10 px-3 py-1.5 text-[12px] sm:px-4"
          role="status"
          data-testid="desk-kept"
          data-reason={status.kept.reason}
        >
          <span className="min-w-0 flex-1 text-warning" data-testid="desk-kept-notice">
            {status.kept.notice}
          </span>
          <Button size="sm" onClick={() => setConfirm('replace')} data-testid="desk-replace">
            Replace the stored desk state
          </Button>
        </div>
      ) : null}
      {status && url ? (
        <iframe
          // a panel that gets another clip loads the desk again and connects afresh
          key={clip.id}
          ref={frame}
          src={url}
          title="3D director's desk"
          sandbox={DESK_SANDBOX}
          allow={DESK_ALLOW}
          className="min-h-0 w-full flex-1 border-0 bg-bg"
          onLoad={() => bridge.current?.frameLoaded()}
          data-testid="desk-frame"
        />
      ) : null}
      <Dialog
        open={confirm === 'replace' && !!status?.kept}
        onClose={() => setConfirm(null)}
        title="Replace the stored desk state?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirm(null);
                bridge.current?.replace();
              }}
              data-testid="desk-replace-confirm"
            >
              Replace
            </Button>
          </>
        }
      >
        <p className="text-[13px]" data-testid="desk-replace-what">
          {CONFIRM[status?.kept?.reason ?? 'conflict']}
        </p>
      </Dialog>
      <Dialog
        open={confirm === 'startOver' && status?.remedy === 'retry'}
        onClose={() => setConfirm(null)}
        title="Start over?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirm(null);
                bridge.current?.startOver();
              }}
              data-testid="desk-start-over-confirm"
            >
              Start over
            </Button>
          </>
        }
      >
        <p className="text-[13px]" data-testid="desk-start-over-what">
          {CONFIRM.startOver}
        </p>
      </Dialog>
    </div>
  );
  return (
    <>
      <span ref={anchor} hidden />
      {root ? createPortal(body, root) : null}
    </>
  );
}
