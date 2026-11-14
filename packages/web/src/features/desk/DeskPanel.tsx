import { type Clip, DESK_MODES, type DeskMode, deskBrief } from '@rideo/shared';
import { Box, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Badge, Button, Select } from '../../components/ui';
import { api } from '../../lib/api';
import { useConfig } from '../../lib/config';
import { useProject } from '../../store/project';
import { useUi } from '../../store/ui';
import { uploadReference } from '../clips/reference-upload';
import { DeskBridge, type DeskStatus } from './bridge';
import { applyDeskResult, pngToJpeg } from './results';

/** Where the desk's headers are explained (the timeout message links to it). */
export const DESK_HEADERS_DOC =
  'https://github.com/sloth-os/rideo/blob/main/docs/design/director-desk.md#topology-and-headers';

const MODE_KEY = 'rideo.deskMode';
const MODE_LABELS: Record<DeskMode, string> = { camera: 'Camera', motion: 'Motion', pose: 'Poses' };
/** The reference modes rideo offers the desk, in the order of the Follow menu. */
const MODES: DeskMode[] = ['camera', 'motion', 'pose'];

/** The person's Follow mode, remembered in this browser (Camera by default). */
function useDeskMode(): [DeskMode, (mode: DeskMode) => void] {
  const [mode, setMode] = useState<DeskMode>(() => {
    try {
      const saved = localStorage.getItem(MODE_KEY);
      return (DESK_MODES as readonly string[]).includes(saved ?? '') ? (saved as DeskMode) : 'camera';
    } catch {
      return 'camera';
    }
  });
  const choose = (next: DeskMode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // storage unavailable: the choice lasts for this page
    }
  };
  return [mode, choose];
}

/**
 * The 3D-Editor's director's desk on a scene (docs/design/director-desk.md#the-desk): a full-screen panel inside the
 * studio's root (it keeps the theme), with the scene's title, the person's Follow mode and Close, a status line and
 * the desk's iframe filling the rest. The page behind it is inert while it is open; on phones the panel keeps inside
 * the safe-area insets. Keys pressed in the desk go to the desk: the panel closes with its button, never with Escape.
 */
export function DeskPanel({ clip, onClose }: { clip: Clip; onClose: () => void }) {
  const config = useConfig();
  const projectId = useProject((s) => s.projectId);
  const url = config?.features.desk?.url ?? null;
  const [mode, setMode] = useDeskMode();
  const modeId = useId();
  const modeRef = useRef(mode);
  modeRef.current = mode;
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
      options: () => ({
        hostName: opening.current.hostName.slice(0, 40),
        modes: MODES,
        defaultMode: modeRef.current,
        readOnly: opening.current.readOnly,
      }),
      load: () => api.deskState(projectId, clip.id),
      store: async (state) => (await api.saveDeskState(projectId, clip.id, state)).deskState.media.hash,
      applyResult: (result) => {
        const docs = useProject.getState().docs;
        return applyDeskResult(
          result,
          { project: docs!.project, clip: docs?.clips[clip.id] ?? null, mode: modeRef.current },
          {
            upload: (file, opts) => uploadReference(projectId, file, { ...opts, keep: false }),
            patchShot: (shotId, body) => api.updateShot(projectId, clip.id, shotId, body),
            poster: pngToJpeg,
          },
        );
      },
      onStatus: setStatus,
      onToast: (message, level) => useUi.getState().toast(message, level),
      onClosed: () => onCloseRef.current(),
      log: (message, data) => console.debug(`[desk] ${message}`, data ?? ''),
    });
    bridge.current = desk;
    desk.start();
    return () => {
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
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <label htmlFor={modeId}>Follow</label>
          <Select
            id={modeId}
            value={mode}
            onChange={(e) => setMode(e.target.value as DeskMode)}
            className="h-8 w-auto text-[13px]"
            data-testid="desk-mode"
          >
            {MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m]}
              </option>
            ))}
          </Select>
        </div>
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
            {status.failure} (
            <a href={DESK_HEADERS_DOC} target="_blank" rel="noreferrer" className="text-accent underline">
              the headers
            </a>
            ).
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
      {status && url ? (
        <iframe
          ref={frame}
          src={url}
          title="3D director's desk"
          allow="fullscreen; clipboard-write"
          className="min-h-0 w-full flex-1 border-0 bg-bg"
          onLoad={() => bridge.current?.frameLoaded()}
          data-testid="desk-frame"
        />
      ) : null}
    </div>
  );
  return (
    <>
      <span ref={anchor} hidden />
      {root ? createPortal(body, root) : null}
    </>
  );
}
