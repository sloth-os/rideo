import { isTerminalJob, type View } from '@rideo/shared';
import {
  Clapperboard,
  Download,
  FolderOpen,
  GitBranch,
  LayoutDashboard,
  type LucideIcon,
  MoreHorizontal,
  NotebookPen,
  ScanSearch,
  Scissors,
  Users,
} from 'lucide-react';
import { type ComponentType, lazy, Suspense, useEffect, useState } from 'react';
import { NavLink, useParams } from 'react-router';
import { ActivityFeed } from '../../components/ActivityFeed';
import { JobRow } from '../../components/JobProgress';
import { Badge, cx, Spinner } from '../../components/ui';
import { editorWorker } from '../../engine';
import { liveClient } from '../../lib/live-bridge';
import { useProject } from '../../store/project';
import { AnalysisView } from '../analysis/AnalysisView';
import { CastView } from '../cast/CastView';
import { ClipsView } from '../clips/ClipsView';
import { ExportsView } from '../exports/ExportsView';
import { HistoryView } from '../history/HistoryView';
import { ResourcesView } from '../resources/ResourcesView';
import { StoryView } from '../story/StoryView';
import { AppHeader } from './AppHeader';
import { Overview } from './Overview';

interface NavItem {
  view: View;
  label: string;
  icon: LucideIcon;
}

const STORY_NAV: NavItem[] = [
  { view: 'overview', label: 'Overview', icon: LayoutDashboard },
  { view: 'story', label: 'Story', icon: NotebookPen },
  { view: 'cast', label: 'Cast', icon: Users },
  { view: 'resources', label: 'Resources', icon: FolderOpen },
  { view: 'clips', label: 'Clips', icon: Clapperboard },
  { view: 'editor', label: 'Editor', icon: Scissors },
  { view: 'history', label: 'History', icon: GitBranch },
  { view: 'exports', label: 'Exports', icon: Download },
];

const EDIT_NAV: NavItem[] = [
  { view: 'overview', label: 'Overview', icon: LayoutDashboard },
  { view: 'resources', label: 'Footage', icon: FolderOpen },
  { view: 'analysis', label: 'Analysis', icon: ScanSearch },
  { view: 'editor', label: 'Editor', icon: Scissors },
  { view: 'history', label: 'History', icon: GitBranch },
  { view: 'exports', label: 'Exports', icon: Download },
];

// The editor pulls in mediabunny (WebCodecs); load it only when the editor is opened.
const EditorView = lazy(() => import('../editor/EditorView').then((m) => ({ default: m.EditorView })));

const VIEWS: Record<View, ComponentType> = {
  overview: Overview,
  story: StoryView,
  cast: CastView,
  resources: ResourcesView,
  clips: ClipsView,
  editor: EditorView,
  analysis: AnalysisView,
  history: HistoryView,
  exports: ExportsView,
};

function ContextPanel({ projectId }: { projectId: string }) {
  const jobs = useProject((s) => s.jobs);
  const active = Object.values(jobs)
    .filter((j) => !isTerminalJob(j) && !j.parentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recent = Object.values(jobs)
    .filter((j) => isTerminalJob(j) && !j.parentId)
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
    .slice(0, 3);
  return (
    <aside
      className="hidden w-80 shrink-0 overflow-y-auto border-l border-border p-4 xl:block"
      aria-label="Activity"
    >
      <h3 className="mb-2 text-[11px] font-medium tracking-wide text-muted uppercase">Jobs</h3>
      <div className="space-y-2" data-testid="jobs-panel">
        {active.length === 0 && recent.length === 0 ? (
          <p className="text-[13px] text-muted">No jobs.</p>
        ) : null}
        {[...active, ...recent].map((j) => (
          <JobRow key={j.id} job={j} projectId={projectId} compact />
        ))}
      </div>
      <h3 className="mt-6 mb-2 text-[11px] font-medium tracking-wide text-muted uppercase">Activity</h3>
      <ActivityFeed />
    </aside>
  );
}

export function Workspace() {
  const { projectId = '', view: rawView } = useParams();
  const { load, docs, loading, error, head } = useProject();
  const [more, setMore] = useState(false);
  useEffect(() => {
    let cancelled = false;
    load(projectId)
      .then((s) => {
        if (!cancelled) liveClient()?.subscribe(projectId, s.seq);
      })
      .catch(() => undefined);
    // This tab runs the project's editor jobs while it is open (docs/design/editor.md#editor-jobs).
    editorWorker.setProject(projectId);
    return () => {
      cancelled = true;
      editorWorker.setProject(null);
      liveClient()?.unsubscribe(projectId);
    };
  }, [projectId, load]);
  if (error && !docs) {
    return (
      <div className="min-h-full">
        <AppHeader />
        <p className="p-6 text-danger">{error}</p>
      </div>
    );
  }
  if (!docs || loading || docs.project.id !== projectId) {
    return (
      <div className="min-h-full">
        <AppHeader />
        <div className="flex justify-center p-10">
          <Spinner className="size-6" />
        </div>
      </div>
    );
  }
  const nav = docs.project.kind === 'story' ? STORY_NAV : EDIT_NAV;
  const view = (nav.some((n) => n.view === rawView) ? rawView : 'overview') as View;
  const Current = VIEWS[view];
  const primaryMobile = nav.slice(0, 4);
  const overflow = nav.slice(4);
  return (
    <div className="flex h-full flex-col">
      <AppHeader>
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate font-semibold" data-testid="project-title">
            {docs.project.title}
          </h1>
          <Badge tone="accent" className="hidden sm:inline-flex">
            {docs.project.workflow.stage}
          </Badge>
          {head && head.branch !== 'main' ? (
            <Badge tone="info">
              <GitBranch className="size-3" />
              {head.branch}
            </Badge>
          ) : null}
        </div>
      </AppHeader>
      <div className="flex min-h-0 flex-1">
        <nav
          className="hidden w-14 shrink-0 flex-col gap-1 border-r border-border p-2 md:flex lg:w-52"
          aria-label="Project"
        >
          {nav.map((n) => (
            <NavLink
              key={n.view}
              to={`/p/${projectId}/${n.view}`}
              data-testid={`nav-${n.view}`}
              className={({ isActive }) =>
                cx(
                  'flex items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-2 text-[13px] transition-colors',
                  isActive || (n.view === 'overview' && view === 'overview')
                    ? 'bg-accent/15 text-accent'
                    : 'text-muted hover:bg-surface-2 hover:text-text',
                )
              }
              title={n.label}
            >
              <n.icon className="size-5 shrink-0 lg:size-4" />
              <span className="hidden lg:inline">{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <main
          className="min-w-0 flex-1 overflow-y-auto px-3 pt-4 pb-24 sm:px-6 md:pb-8"
          data-testid={`view-${view}`}
        >
          <Suspense fallback={<Spinner className="size-6" />}>
            <Current />
          </Suspense>
        </main>
        <ContextPanel projectId={projectId} />
      </div>
      <nav
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-bg/95 backdrop-blur md:hidden"
        aria-label="Project mobile"
      >
        {primaryMobile.map((n) => (
          <NavLink
            key={n.view}
            to={`/p/${projectId}/${n.view}`}
            data-testid={`mnav-${n.view}`}
            className={({ isActive }) =>
              cx(
                'flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px]',
                isActive || (n.view === 'overview' && view === 'overview') ? 'text-accent' : 'text-muted',
              )
            }
          >
            <n.icon className="size-5" />
            {n.label}
          </NavLink>
        ))}
        <button
          type="button"
          onClick={() => setMore((m) => !m)}
          className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] text-muted"
          aria-expanded={more}
          data-testid="mnav-more"
        >
          <MoreHorizontal className="size-5" />
          More
        </button>
      </nav>
      {more ? (
        <div
          className="fixed inset-x-0 bottom-14 z-30 border-t border-border bg-surface p-2 md:hidden"
          role="menu"
        >
          {overflow.map((n) => (
            <NavLink
              key={n.view}
              to={`/p/${projectId}/${n.view}`}
              onClick={() => setMore(false)}
              className="flex items-center gap-3 rounded px-3 py-2.5 text-sm"
              role="menuitem"
              data-testid={`mnav-${n.view}`}
            >
              <n.icon className="size-4 text-muted" />
              {n.label}
            </NavLink>
          ))}
        </div>
      ) : null}
    </div>
  );
}
