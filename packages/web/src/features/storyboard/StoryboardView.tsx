import {
  type BoardState,
  boardApprovable,
  boardState,
  type Clip,
  formatDuration,
  isTerminalJob,
  type Shot,
  storyboardProgress,
  storyboardScenes,
  timelineDuration,
} from '@rideo/shared';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clapperboard,
  Download,
  FileSpreadsheet,
  Film,
  LayoutGrid,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Entity } from '../../components/Entity';
import { JobRow } from '../../components/JobProgress';
import { MediaImage } from '../../components/Media';
import {
  Badge,
  Button,
  buttonClass,
  Card,
  EmptyState,
  Field,
  SectionHeader,
  Select,
  Spinner,
} from '../../components/ui';
import { api, shotListUrl } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError, useUi } from '../../store/ui';

// The player pulls in mediabunny (WebCodecs); load it only when an animatic exists.
const AnimaticPlayer = lazy(() => import('./AnimaticPlayer').then((m) => ({ default: m.AnimaticPlayer })));

const STATE_TONE: Record<BoardState, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  approved: 'success',
  unapproved: 'info',
  outdated: 'warning',
  stale: 'warning',
  failed: 'danger',
  missing: 'neutral',
};

const STATE_LABEL: Record<BoardState, string> = {
  approved: 'approved',
  unapproved: 'to review',
  outdated: 'shot edited',
  stale: 'lock changed',
  failed: 'failed',
  missing: 'no frame',
};

function BoardCard({ clip, shot, shots }: { clip: Clip; shot: Shot; shots: Shot[] }) {
  const { projectId, docs, jobs } = useProject();
  if (!projectId || !docs) return null;
  const state = boardState(shot, docs);
  const job = Object.values(jobs).find(
    (j) => !isTerminalJob(j) && j.kind === 'shot.board' && j.params.shotId === shot.id,
  );
  const names = Object.fromEntries(Object.values(docs.characters).map((c) => [c.id, c.name]));
  const position = shots.findIndex((s) => s.id === shot.id);
  const move = (delta: number) => {
    const ids = shots.map((s) => s.id);
    const [moved] = ids.splice(position, 1);
    ids.splice(position + delta, 0, moved!);
    api.reorderShots(projectId, clip.id, ids).catch(reportError);
  };
  return (
    <Entity
      kind="shot"
      id={shot.id}
      as="article"
      className="flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface"
    >
      <div className="relative">
        <MediaImage
          projectId={projectId}
          media={shot.board?.keyframe}
          alt={`Storyboard frame ${clip.index + 1}.${shot.index + 1}`}
          className="aspect-video w-full"
        />
        {job ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <Spinner className="size-6 text-white" />
          </div>
        ) : null}
        <span className="absolute top-1.5 left-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[11px] font-medium text-white">
          C{clip.index + 1}·S{shot.index + 1}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2.5">
        <div className="flex flex-wrap items-center gap-1">
          <Badge tone={STATE_TONE[state]} testid="board-state">
            {STATE_LABEL[state]}
          </Badge>
          <span className="text-[11px] text-muted">
            {shot.durationSec.toFixed(1)} s · {shot.camera.framing.replace(/_/g, ' ')}
          </span>
        </div>
        <p className="line-clamp-2 text-[12px]">{shot.description}</p>
        {shot.dialogue.length ? (
          <ul className="space-y-0.5 text-[11px] text-muted">
            {shot.dialogue.map((d, i) => (
              <li key={i} className="line-clamp-2">
                <span className="font-medium text-text">
                  {d.characterId ? (names[d.characterId] ?? '') : 'Narrator'}
                </span>
                : {d.line}
              </li>
            ))}
          </ul>
        ) : null}
        {job ? <JobRow job={job} projectId={projectId} compact /> : null}
        <div className="mt-auto flex flex-wrap items-center gap-1 pt-1">
          {state === 'approved' ? (
            <Button
              size="sm"
              className="h-7"
              icon={<X className="size-3.5" />}
              onClick={() => api.approveBoard(projectId, clip.id, shot.id, false).catch(reportError)}
              data-testid="unapprove-board"
            >
              Unapprove
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              className="h-7"
              icon={<Check className="size-3.5" />}
              disabled={!boardApprovable(state)}
              onClick={() => api.approveBoard(projectId, clip.id, shot.id, true).catch(reportError)}
              data-testid="approve-board"
            >
              Approve
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            icon={<RefreshCw className="size-3.5" />}
            disabled={!!job}
            onClick={() => api.generateBoard(projectId, clip.id, shot.id).catch(reportError)}
            data-testid="regenerate-board"
          >
            {shot.board ? 'Redraw' : 'Draw'}
          </Button>
          <span className="ml-auto flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              disabled={position === 0}
              onClick={() => move(-1)}
              aria-label="Move earlier"
              data-testid="move-earlier"
            >
              <ArrowLeft className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              disabled={position === shots.length - 1}
              onClick={() => move(1)}
              aria-label="Move later"
              data-testid="move-later"
            >
              <ArrowRight className="size-3.5" />
            </Button>
          </span>
        </div>
      </div>
    </Entity>
  );
}

function AnimaticPanel() {
  const { projectId, docs } = useProject();
  const [music, setMusic] = useState('');
  const [busy, setBusy] = useState(false);
  if (!projectId || !docs) return null;
  const audio = Object.values(docs.resources).filter((r) => r.kind === 'audio' && r.status === 'ready');
  const animatic = docs.animatic;
  const frames = animatic?.tracks.find((t) => t.kind === 'video')?.items.length ?? 0;
  return (
    <Card className="space-y-3 p-4" data-testid="animatic-panel">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-1.5 text-[15px] font-semibold">
            <Film className="size-4" /> Animatic
          </h3>
          <p className="text-[12px] text-muted">
            {animatic
              ? `${frames} frames · ${formatDuration(timelineDuration(animatic))} with dialogue and captions`
              : 'The frames with their dialogue, temp music and captions, played and exported in this browser.'}
          </p>
        </div>
        <Field label="Temp music" className="w-full sm:w-56">
          <Select value={music} onChange={(e) => setMusic(e.target.value)} data-testid="animatic-music">
            <option value="">None</option>
            {audio.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          icon={<Clapperboard className="size-4" />}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.buildAnimatic(projectId, music ? { musicResourceId: music } : {});
            } catch (err) {
              reportError(err);
            } finally {
              setBusy(false);
            }
          }}
          data-testid="build-animatic"
        >
          {animatic ? 'Rebuild' : 'Build animatic'}
        </Button>
        {animatic ? (
          <Button
            icon={<Download className="size-4" />}
            onClick={() =>
              api
                .createExport(projectId, { quality: 'draft', engine: 'auto', source: 'animatic' })
                .then(() =>
                  useUi.getState().toast('Animatic export queued: it renders in this tab', 'success'),
                )
                .catch(reportError)
            }
            data-testid="export-animatic"
          >
            Export MP4
          </Button>
        ) : null}
      </div>
      {animatic && frames ? (
        <Suspense
          fallback={
            <div className="flex aspect-video items-center justify-center rounded bg-black">
              <Spinner className="size-6 text-white" />
            </div>
          }
        >
          <AnimaticPlayer projectId={projectId} timeline={animatic} />
        </Suspense>
      ) : null}
    </Card>
  );
}

/**
 * The storyboard stage (docs/design/storyboard.md): the frames of the first scenes as a grid to review, reorder,
 * redraw and approve, the animatic, and the shot list downloads.
 */
export function StoryboardView() {
  const { docs, projectId, workflow, jobs } = useProject();
  const navigate = useNavigate();
  if (!docs || !projectId) return null;
  const enabled = docs.project.settings.storyboard.enabled;
  const scenes = storyboardScenes(docs);
  const progress = storyboardProgress(docs);
  const gate = workflow?.stages.find((s) => s.id === 'storyboard')?.gate;
  const running = Object.values(jobs).find((j) => !isTerminalJob(j) && j.kind === 'storyboard.generate');
  const clipsByScene = new Map(Object.values(docs.clips).map((c) => [c.sceneId, c]));
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <SectionHeader
        title="Storyboard"
        subtitle={
          enabled
            ? `The first ${scenes.length} scene(s): approve a frame per shot before any video is generated. Approved frames start the video pass.`
            : 'The storyboard is off for this project (Overview → Settings).'
        }
        actions={
          <>
            <a
              href={shotListUrl(projectId, 'csv')}
              download
              className={buttonClass('ghost')}
              title="Shot list (CSV)"
              data-testid="shotlist-csv"
            >
              <FileSpreadsheet className="size-4" /> CSV
            </a>
            <a
              href={shotListUrl(projectId, 'pdf')}
              download
              className={buttonClass('ghost')}
              title="Shot list with frames (PDF)"
              data-testid="shotlist-pdf"
            >
              <Download className="size-4" /> PDF
            </a>
            <Button
              icon={<Sparkles className="size-4" />}
              disabled={!!running || !docs.screenplay?.scenes.length}
              onClick={() => api.generateStoryboard(projectId).catch(reportError)}
              data-testid="generate-storyboard"
            >
              {progress.shots ? 'Draw missing frames' : 'Generate storyboard'}
            </Button>
            <Button
              icon={<Check className="size-4" />}
              disabled={!progress.states.unapproved}
              onClick={() =>
                api
                  .approveAllBoards(projectId)
                  .then((r) => useUi.getState().toast(`${r.approved} frame(s) approved`, 'success'))
                  .catch(reportError)
              }
              data-testid="approve-all-boards"
            >
              Approve all
            </Button>
            {workflow?.stage === 'storyboard' && gate ? (
              <Button
                variant="primary"
                icon={<LayoutGrid className="size-4" />}
                disabled={!gate.satisfied}
                onClick={() =>
                  api
                    .approve(projectId, 'storyboard_approved')
                    .then(() => {
                      useUi.getState().toast('Storyboard approved', 'success');
                      navigate(`/p/${projectId}/clips`);
                    })
                    .catch(reportError)
                }
                data-testid="approve-storyboard"
              >
                Approve storyboard
              </Button>
            ) : null}
          </>
        }
      />
      {running ? <JobRow job={running} projectId={projectId} /> : null}
      {enabled ? (
        <p className="text-[13px] text-muted" data-testid="storyboard-progress">
          {progress.approved} of {progress.shots} frames approved
          {progress.states.failed ? ` · ${progress.states.failed} failed` : ''}
          {progress.states.stale + progress.states.outdated
            ? ` · ${progress.states.stale + progress.states.outdated} to redraw`
            : ''}
        </p>
      ) : null}
      {!docs.screenplay?.scenes.length ? (
        <EmptyState title="No scenes yet">
          Generate or <Link to={`/p/${projectId}/story`}>import the screenplay</Link> first.
        </EmptyState>
      ) : (
        scenes.map((scene) => {
          const clip = clipsByScene.get(scene.id);
          const shots = clip ? [...clip.shots].sort((a, b) => a.index - b.index) : [];
          return (
            <section key={scene.id} className="space-y-2" data-testid="storyboard-scene">
              <h3 className="text-[13px] font-semibold">
                {scene.index + 1}. {scene.heading}
                <span className="ml-2 font-normal text-muted">{formatDuration(scene.estDurationSec)}</span>
              </h3>
              {clip ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {shots.map((shot) => (
                    <BoardCard key={shot.id} clip={clip} shot={shot} shots={shots} />
                  ))}
                </div>
              ) : (
                <p className="text-[12px] text-muted">Not planned yet: generate the storyboard.</p>
              )}
            </section>
          );
        })
      )}
      <AnimaticPanel />
    </div>
  );
}
