import { actorLabel } from '@rideo/shared';
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
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
      onStatus: (s) => useUi.getState().setLive(s),
    });
    client = c;
    c.connect();
    return () => {
      c.close();
      client = null;
    };
  }, []);

  useEffect(() => {
    const projectId = /^\/p\/(prj_[0-9a-z]+)/.exec(location.pathname)?.[1] ?? null;
    const sel = useProject.getState().highlight;
    client?.setPresence({
      projectId,
      route: location.pathname + location.search,
      selection: sel ? { kind: sel.kind, id: sel.id } : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
  }, [location]);
  return null;
}
