import { actorLabel } from '@rideo/shared';
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { detectEngineCaps, editorWorker, useEngine } from '../engine';
import { enginePresence } from '../engine/state';
import { useNotifications } from '../store/notifications';
import { useProject } from '../store/project';
import { useUi } from '../store/ui';
import { LiveClient } from './live';
import { handleUiCommand } from './ui-commands';

let client: LiveClient | null = null;

export function liveClient(): LiveClient | null {
  return client;
}

/** Owns the tab's live connection: events → store, resync, agent UI commands, presence. */
export function LiveBridge() {
  const navigate = useNavigate();
  const location = useLocation();
  const nav = useRef({ navigate, path: location.pathname + location.search });
  nav.current = { navigate, path: location.pathname + location.search };

  useEffect(() => {
    const c = new LiveClient({
      onEvent: (projectId, seq, event) => {
        const store = useProject.getState();
        if (store.projectId !== projectId) return;
        if (store.applyEvent(seq, event)) void store.refresh();
        if (event.kind === 'activity' && event.actor.kind === 'agent' && event.action.startsWith('tool:')) {
          useUi.getState().toast(event.summary.replace(/^.*? → /, ''), 'info', event.actor);
        }
        // A queued editor job of this project: this tab may claim it (docs/design/editor.md#editor-jobs).
        if (event.kind === 'job' && event.job.lane === 'client' && event.job.status === 'queued')
          void editorWorker.poke();
        if (event.kind === 'job' && event.job.status === 'failed' && !event.job.parentId) {
          useUi.getState().toast(`${event.job.kind} failed: ${event.job.error?.message ?? ''}`, 'error');
        }
        if (event.kind === 'sync-issue')
          useUi.getState().toast(`WebDAV edit of ${event.path} rejected: ${event.error}`, 'warning');
        if (event.kind === 'commit' && event.commit.author.kind === 'webdav') {
          useUi
            .getState()
            .toast(
              `${actorLabel(event.commit.author)}: ${event.commit.message}`,
              'info',
              event.commit.author,
            );
        }
      },
      onResync: (projectId) => {
        const store = useProject.getState();
        if (store.projectId === projectId)
          void store.load(projectId).then((s) => c.resetSeq(projectId, s.seq));
      },
      onUi: (cmd) => handleUiCommand(cmd, (to) => nav.current.navigate(to), nav.current.path),
      onNotification: (n) => {
        useNotifications.getState().push(n);
        useUi.getState().toast(n.title, 'info');
      },
      onStatus: (s) => {
        useUi.getState().setLive(s);
        if (s === 'live') void editorWorker.poke();
      },
    });
    client = c;
    editorWorker.setSession(() => c.sessionId);
    c.connect();
    detectEngineCaps();
    // Leaving mid-render would drop the job back into the queue: ask first.
    const guard = (e: BeforeUnloadEvent) => {
      if (editorWorker.busy) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => {
      window.removeEventListener('beforeunload', guard);
      c.close();
      client = null;
    };
  }, []);

  const engine = useEngine();
  const busyJobId = engine.busy?.jobId ?? null;
  useEffect(() => {
    const projectId = /^\/p\/(prj_[0-9a-z]+)/.exec(location.pathname)?.[1] ?? null;
    const sel = useProject.getState().highlight;
    client?.setPresence({
      projectId,
      route: location.pathname + location.search,
      selection: sel ? { kind: sel.kind, id: sel.id } : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      engine: enginePresence(useEngine.getState()),
    });
  }, [location, engine.ffmpeg, engine.webcodecs, busyJobId]);
  return null;
}
