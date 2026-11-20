import { isTerminalJob, type View } from '@rideo/shared';
import {
  BarChart3,
  Clapperboard,
  Download,
  FolderOpen,
  GitBranch,
  LayoutDashboard,
  LayoutGrid,
  LibraryBig,
  type LucideIcon,
  MapPin,
  MoreHorizontal,
  NotebookPen,
  Palette,
  ScanSearch,
  Scissors,
  Search,
  Settings,
  Users,
} from 'lucide-react';
import { type ComponentType, lazy, Suspense, useEffect, useState } from 'react';
import { Link, NavLink, useParams } from 'react-router';
import { ActivityFeed } from '../../components/ActivityFeed';
import { AiNotice } from '../../components/AiNotice';
import { JobRow } from '../../components/JobProgress';
import { Badge, cx, Spinner } from '../../components/ui';
import { editorWorker } from '../../engine';
import { useAuth, useProjectRole } from '../../lib/auth';
import { useAi } from '../../lib/config';
import { liveClient } from '../../lib/live-bridge';
import { useStudioShell } from '../../lib/studio-context';
import { useProject } from '../../store/project';
import { AnalysisView } from '../analysis/AnalysisView';
import { CastView } from '../cast/CastView';
import { ClipsView } from '../clips/ClipsView';
import { ElementsView } from '../elements/ElementsView';
import { ExportsView } from '../exports/ExportsView';
import { HistoryView } from '../history/HistoryView';
import { InsightsView } from '../insights/InsightsView';
import { ResourcesView } from '../resources/ResourcesView';
import { ReviewHost } from '../review/ReviewHost';
import { SearchView } from '../search/SearchView';
import { StoryView } from '../story/StoryView';
import { StoryboardView } from '../storyboard/StoryboardView';
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
  { view: 'elements', label: 'Elements', icon: MapPin },
  { view: 'resources', label: 'Resources', icon: FolderOpen },
  { view: 'storyboard', label: 'Storyboard', icon: LayoutGrid },
  { view: 'clips', label: 'Clips', icon: Clapperboard },
  { view: 'editor', label: 'Editor', icon: Scissors },
  { view: 'search', label: 'Search', icon: Search },
  { view: 'history', label: 'History', icon: GitBranch },
  { view: 'exports', label: 'Exports', icon: Download },
  { view: 'insights', label: 'Insights', icon: BarChart3 },
];

const EDIT_NAV: NavItem[] = [
  { view: 'overview', label: 'Overview', icon: LayoutDashboard },
  { view: 'resources', label: 'Footage', icon: FolderOpen },
  { view: 'analysis', label: 'Analysis', icon: ScanSearch },
  { view: 'editor', label: 'Editor', icon: Scissors },
  { view: 'search', label: 'Search', icon: Search },
  { view: 'history', label: 'History', icon: GitBranch },
  { view: 'exports', label: 'Exports', icon: Download },
  { view: 'insights', label: 'Insights', icon: BarChart3 },
];

/**
 * The header's studio links that the More menu holds while it shows (below `md`), the header leaving them out there
 * (`AppHeader`'s `linksInMenu`, docs/brand.md#layout-and-responsiveness). Settings is for administrators, as in the header.
 */
const STUDIO_LINKS: { to: string; label: string; icon: LucideIcon; testid: string; admin?: boolean }[] = [
  { to: '/library', label: 'Library', icon: LibraryBig, testid: 'mnav-library' },
  { to: '/brand', label: 'Brand kits', icon: Palette, testid: 'mnav-brand-kits' },
  { to: '/settings', label: 'Settings', icon: Settings, testid: 'mnav-settings', admin: true },
];

// The editor pulls in mediabunny (WebCodecs); load it only when the editor is opened.
const EditorView = lazy(() => import('../editor/EditorView').then((m) => ({ default: m.EditorView })));

const VIEWS: Record<View, ComponentType> = {
  overview: Overview,
  story: StoryView,
  cast: CastView,
  elements: ElementsView,
  resources: ResourcesView,
  storyboard: StoryboardView,
  clips: ClipsView,
  editor: EditorView,
  analysis: AnalysisView,
  history: HistoryView,
  exports: ExportsView,
  search: SearchView,
  insights: InsightsView,
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
  const access = useProjectRole(docs?.project);
  const ai = useAi();
  const [more, setMore] = useState(false);
  const shell = useStudioShell();
  const admin = useAuth((s) => s.me?.admin);
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
      <AppHeader linksInMenu>
        {/*
          The title gives way to its badges with an ellipsis, never below the smaller of its own width and 3rem and
          never wider than its text; the stage badge (from `sm`) keeps its word; the branch badge gives way down to its
          icon, its name in its tooltip. The row clips only what the header's room cannot hold, so nothing runs under
          the header's controls (docs/brand.md#layout-and-responsiveness)
        */}
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <h1 className="font-semibold" data-testid="project-title" title={docs.project.title}>
            <span className="fit-title-text">{docs.project.title}</span>
            <span className="fit-title-sizer" data-text={docs.project.title} aria-hidden="true" />
          </h1>
          <Badge tone="accent" className="hidden shrink-0 sm:inline-flex" testid="project-stage">
            {docs.project.workflow.stage}
          </Badge>
          {head && head.branch !== 'main' ? (
            <Badge
              tone="info"
              className="min-w-[1.875rem] overflow-hidden"
              title={`Branch ${head.branch}`}
              testid="project-branch"
            >
              <GitBranch className="size-3 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{head.branch}</span>
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
          {ai === false && docs.project.kind === 'story' ? (
            <AiNotice className="mx-auto mb-3 max-w-5xl">
              AI is off: screenplays, cast references, clips, music and voices need mm-gateway. Editing,
              review and exports work.
            </AiNotice>
          ) : null}
          {access.role === 'reviewer' ? (
            <p
              className="mx-auto mb-3 max-w-5xl rounded-[var(--radius-control)] border border-border bg-surface-2 px-3 py-2 text-[13px] text-muted"
              data-testid="role-banner"
            >
              You review this project: you can read and comment; editing and approvals are for its editors and
              directors.
            </p>
          ) : null}
          <ReviewHost>
            <Suspense fallback={<Spinner className="size-6" />}>
              <Current />
            </Suspense>
          </ReviewHost>
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
          {/*
            While this menu shows (below `md`) the header's studio links are here, leaving the header's room to the
            project's title and its badges (docs/brand.md#layout-and-responsiveness); a host that hides the header has
            neither
          */}
          {shell.chrome.header ? (
            <>
              <div className="my-1 border-t border-border" role="separator" />
              {STUDIO_LINKS.filter((l) => !l.admin || admin).map((l) => (
                <Link
                  key={l.to}
                  to={l.to}
                  onClick={() => setMore(false)}
                  className="flex items-center gap-3 rounded px-3 py-2.5 text-sm"
                  role="menuitem"
                  data-testid={l.testid}
                >
                  <l.icon className="size-4 text-muted" />
                  {l.label}
                </Link>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
