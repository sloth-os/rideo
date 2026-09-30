import { formatDuration, type ProjectSummary } from '@rideo/shared';
import { Clapperboard, Film, Plus, ScanSearch, Scissors, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  Progress,
  Select,
  Spinner,
  Textarea,
} from '../../components/ui';
import { api, mediaUrl } from '../../lib/api';
import { reportError } from '../../store/ui';
import { AppHeader } from '../workspace/AppHeader';

const DURATION_PRESETS = [
  { label: '40 min', sec: 2400 },
  { label: '45 min', sec: 2700 },
  { label: '50 min', sec: 3000 },
  { label: '60 min', sec: 3600 },
  { label: '10 min', sec: 600 },
  { label: '1 min (test)', sec: 60 },
];

function CreateProjectDialog({ kind, onClose }: { kind: 'story' | 'edit' | null; onClose: () => void }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [target, setTarget] = useState(2700);
  const [pilot, setPilot] = useState(30);
  const [aspect, setAspect] = useState('16:9');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!kind) return;
    setBusy(true);
    try {
      const p = await api.createProject({
        kind,
        title: title.trim() || (kind === 'story' ? 'Untitled film' : 'Untitled edit'),
        ...(kind === 'story' && prompt.trim() ? { brief: { prompt } } : {}),
        settings: {
          aspectRatio: aspect,
          ...(kind === 'story' ? { targetDurationSec: target, pilotDurationSec: pilot } : {}),
        },
      });
      onClose();
      navigate(`/p/${p.id}/${kind === 'story' ? 'story' : 'resources'}`);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={kind !== null}
      onClose={onClose}
      title={kind === 'story' ? 'New film from an idea' : 'New edit from footage'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit} data-testid="create-project-submit">
            Create project
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Title">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={kind === 'story' ? 'The Keeper' : 'Summer trip'}
            name="title"
          />
        </Field>
        {kind === 'story' ? (
          <>
            <Field label="Idea" hint="A sentence or two. You can attach reference images and videos next.">
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="A lighthouse keeper starts receiving letters from the future…"
                name="prompt"
              />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Film length">
                <Select value={target} onChange={(e) => setTarget(Number(e.target.value))} name="target">
                  {DURATION_PRESETS.map((d) => (
                    <option key={d.sec} value={d.sec}>
                      {d.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Pilot clip">
                <Select value={pilot} onChange={(e) => setPilot(Number(e.target.value))} name="pilot">
                  {[10, 20, 30, 60, 90, 120, 180].map((s) => (
                    <option key={s} value={s}>
                      {formatDuration(s)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Aspect">
                <Select value={aspect} onChange={(e) => setAspect(e.target.value)} name="aspect">
                  {['16:9', '9:16', '1:1', '4:3', '21:9'].map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </Select>
              </Field>
            </div>
          </>
        ) : (
          <Field label="Aspect">
            <Select value={aspect} onChange={(e) => setAspect(e.target.value)} name="aspect">
              {['16:9', '9:16', '1:1', '4:3', '21:9'].map((a) => (
                <option key={a}>{a}</option>
              ))}
            </Select>
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function ProjectCard({ p, onDelete }: { p: ProjectSummary; onDelete: () => void }) {
  const target = p.targetDurationSec ?? 0;
  return (
    <Card className="group overflow-hidden transition-colors hover:border-muted" data-testid="project-card">
      <Link to={`/p/${p.id}`} className="block">
        <div className="relative aspect-video bg-surface-2">
          {p.posterPath ? (
            <img
              src={mediaUrl(p.id, p.posterPath)}
              alt=""
              className="size-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex size-full items-center justify-center text-muted">
              {p.kind === 'story' ? <Clapperboard className="size-8" /> : <Scissors className="size-8" />}
            </div>
          )}
          <Badge tone="accent" className="absolute top-2 left-2 bg-surface/90">
            {p.stage}
          </Badge>
        </div>
        <div className="p-3">
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 flex-1 truncate font-medium">{p.title}</h3>
            <Badge>{p.kind === 'story' ? 'film' : 'edit'}</Badge>
          </div>
          {p.kind === 'story' && target > 0 ? (
            <div className="mt-2 space-y-1">
              <Progress
                value={(p.approvedDurationSec ?? 0) / target}
                tone="success"
                label="approved length"
              />
              <div className="tabular text-[11px] text-muted">
                {formatDuration(p.approvedDurationSec ?? 0)} approved ·{' '}
                {formatDuration(p.plannedDurationSec ?? 0)} planned · {formatDuration(target)} target
              </div>
            </div>
          ) : null}
        </div>
      </Link>
      <div className="flex justify-end border-t border-border px-2 py-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
        <Button
          size="sm"
          variant="ghost"
          icon={<Trash2 className="size-3.5" />}
          onClick={onDelete}
          aria-label={`Delete ${p.title}`}
        >
          Delete
        </Button>
      </div>
    </Card>
  );
}

export function Dashboard() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [creating, setCreating] = useState<'story' | 'edit' | null>(null);
  const load = useCallback(() => {
    api.projects().then(setProjects).catch(reportError);
  }, []);
  useEffect(load, [load]);
  return (
    <div className="min-h-full">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-3 py-6 sm:px-6">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setCreating('story')}
            className="rounded-[var(--radius-card)] border border-border bg-surface p-4 text-left transition-colors hover:border-accent"
            data-testid="new-story"
          >
            <Film className="mb-2 size-6 text-accent" />
            <div className="font-semibold">Idea → movie</div>
            <p className="mt-1 text-[13px] text-muted">
              Screenplay, locked cast, a pilot clip, then the whole film (40–60 min) with guaranteed character
              consistency.
            </p>
          </button>
          <button
            type="button"
            onClick={() => setCreating('edit')}
            className="rounded-[var(--radius-card)] border border-border bg-surface p-4 text-left transition-colors hover:border-accent"
            data-testid="new-edit"
          >
            <ScanSearch className="mb-2 size-6 text-accent" />
            <div className="font-semibold">Footage → edit</div>
            <p className="mt-1 text-[13px] text-muted">
              Upload a video; the AI analyzes it, suggests an edit and cuts it for you.
            </p>
          </button>
        </div>
        <div className="mt-8 mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Projects</h2>
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating('story')}>
            New
          </Button>
        </div>
        {projects === null ? (
          <Spinner />
        ) : projects.length === 0 ? (
          <EmptyState icon={<Clapperboard className="size-8" />} title="No projects yet">
            Start from an idea or from footage. Agents connected over MCP can create projects too.
          </EmptyState>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="project-list">
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                p={p}
                onDelete={() => {
                  if (confirm(`Move “${p.title}” to the trash?`))
                    api.deleteProject(p.id).then(load).catch(reportError);
                }}
              />
            ))}
          </div>
        )}
      </main>
      <CreateProjectDialog kind={creating} onClose={() => setCreating(null)} />
    </div>
  );
}
