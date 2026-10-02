import {
  formatDuration,
  isStillMedia,
  isTerminalJob,
  type SearchKind,
  type SearchResponse,
  type SearchResult,
  type SearchStatus,
} from '@rideo/shared';
import { Search as SearchIcon, Sparkles } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { JobRow } from '../../components/JobProgress';
import { Badge, Button, Card, cx, EmptyState, Input, SectionHeader } from '../../components/ui';
import { api, mediaUrl } from '../../lib/api';
import { useProjectRole } from '../../lib/auth';
import { useProject } from '../../store/project';
import { reportError } from '../../store/ui';

const KINDS: { kind: SearchKind; label: string }[] = [
  { kind: 'take', label: 'Takes' },
  { kind: 'resource', label: 'Footage and stills' },
  { kind: 'reference', label: 'References' },
];

/** A result's frame: a still, or the video at the frame's time, playing while hovered (or after a tap). */
export function ResultFrame({
  projectId,
  result,
}: {
  projectId: string;
  result: Pick<SearchResult, 'media' | 'at'>;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const src = mediaUrl(projectId, result.media.path);
  if (isStillMedia(result.media))
    return <img src={src} alt="" loading="lazy" className="aspect-video w-full bg-surface-2 object-cover" />;
  const play = () => void ref.current?.play().catch(() => undefined);
  const stop = () => {
    const v = ref.current;
    if (!v) return;
    v.pause();
    v.currentTime = result.at;
  };
  return (
    <video
      ref={ref}
      src={`${src}#t=${result.at}`}
      muted
      playsInline
      preload="metadata"
      className="aspect-video w-full bg-surface-2 object-cover"
      onMouseEnter={play}
      onMouseLeave={stop}
      onClick={() => (ref.current?.paused ? play() : stop())}
      data-testid="result-video"
    />
  );
}

/**
 * Semantic media search (docs/design/search.md#searching): takes, footage, stills and references found by what they
 * show, and the state of the project's index.
 */
export function SearchView() {
  const { docs, projectId, jobs, head } = useProject();
  const focus = useProject((s) => s.focus);
  const { can } = useProjectRole(docs?.project);
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [kinds, setKinds] = useState<SearchKind[]>([]);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [status, setStatus] = useState<SearchStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const job = Object.values(jobs).find((j) => j.kind === 'search.index' && !isTerminalJob(j)) ?? null;
  const jobKey = job ? `${job.id}:${job.status}` : '';
  // The index's state follows commits (new takes, uploads) and the index job
  const commit = head?.commit;
  useEffect(() => {
    if (!projectId) return;
    api.searchStatus(projectId).then(setStatus, reportError);
  }, [projectId, commit, jobKey]);
  const run = async (query = q, k = kinds) => {
    if (!projectId || !query.trim()) return;
    setBusy(true);
    try {
      setRes(await api.search(projectId, query.trim(), { kinds: k, limit: 48 }));
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  // New frames in the index show in the results of the current query
  const indexed = status?.indexed;
  useEffect(() => {
    if (res && indexed !== undefined && indexed !== res.indexed) void run(res.query);
  }, [indexed]);
  if (!docs || !projectId) return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run();
  };
  const toggle = (k: SearchKind) => {
    const next = kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k];
    setKinds(next);
    if (res) void run(res.query, next);
  };
  const index = async () => {
    try {
      await api.searchIndex(projectId);
    } catch (err) {
      reportError(err);
    }
  };
  const show = (r: SearchResult) => {
    const s = r.source;
    if (s.kind === 'take') {
      navigate(`/p/${projectId}/clips`);
      focus('take', s.takeId);
    } else if (s.kind === 'resource') {
      navigate(`/p/${projectId}/resources`);
      focus('resource', s.resourceId);
    } else if (s.characterId) {
      navigate(`/p/${projectId}/cast`);
      focus('character', s.characterId);
    } else if (s.elementId) {
      navigate(`/p/${projectId}/elements`);
      focus('element', s.elementId);
    }
  };
  const nothing = status && status.indexed === 0;
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <SectionHeader
        title="Search"
        subtitle="Find takes, footage, stills and references by what they show."
      />
      <Card className="space-y-3 p-4" data-testid="search-index-card">
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <Sparkles className="size-4 text-muted" />
          {status ? (
            <span data-testid="search-status">
              {status.indexed} frame{status.indexed === 1 ? '' : 's'} indexed in {status.files} file
              {status.files === 1 ? '' : 's'}
              {status.pending ? ` · ${status.pending} waiting` : ''}
              {status.failed ? ` · ${status.failed} could not be described` : ''}
            </span>
          ) : (
            <span className="text-muted">Loading the index…</span>
          )}
          {status ? (
            <Badge tone={status.mode === 'semantic' ? 'accent' : 'neutral'} testid="search-mode">
              {status.mode === 'semantic' ? 'by meaning' : 'by words'}
            </Badge>
          ) : null}
          {can('project.edit') ? (
            <Button
              className="ml-auto"
              icon={<Sparkles className="size-4" />}
              disabled={!!job || !status?.pending}
              onClick={index}
              data-testid="search-index"
            >
              Index for search
            </Button>
          ) : null}
        </div>
        {job ? <JobRow job={job} projectId={projectId} compact /> : null}
      </Card>
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row" role="search">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Close-ups of Mira at night, the harbour at dawn…"
          aria-label="Search the project's media"
          maxLength={500}
          className="sm:flex-1"
          data-testid="search-input"
        />
        <Button
          type="submit"
          variant="primary"
          icon={<SearchIcon className="size-4" />}
          loading={busy}
          disabled={!q.trim()}
          data-testid="search-submit"
        >
          Search
        </Button>
      </form>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Kinds">
        {KINDS.map(({ kind, label }) => (
          <button
            key={kind}
            type="button"
            aria-pressed={kinds.includes(kind)}
            onClick={() => toggle(kind)}
            className={cx(
              'rounded-full border px-2.5 py-1 text-[12px]',
              kinds.includes(kind) ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted',
            )}
            data-testid={`search-kind-${kind}`}
          >
            {label}
          </button>
        ))}
      </div>
      {res ? (
        res.results.length ? (
          <>
            <p className="text-[12px] text-muted" data-testid="search-summary">
              {res.results.length} result{res.results.length === 1 ? '' : 's'}, matched{' '}
              {res.mode === 'semantic' ? 'by meaning' : 'by words'}
              {res.pending ? ` · ${res.pending} frames are not indexed yet` : ''}
            </p>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="search-results">
              {res.results.map((r) => (
                <li
                  key={`${r.media.hash}@${r.at}:${JSON.stringify(r.source)}`}
                  className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface"
                  data-testid="search-result"
                  data-source={r.source.kind}
                >
                  <ResultFrame projectId={projectId} result={r} />
                  <div className="space-y-1.5 p-3">
                    <div className="flex items-start gap-2">
                      <p className="min-w-0 flex-1 truncate text-[13px] font-medium" title={r.label}>
                        {r.label}
                      </p>
                      <Badge>
                        {r.source.kind === 'resource'
                          ? isStillMedia(r.media)
                            ? 'still'
                            : 'footage'
                          : r.source.kind}
                      </Badge>
                    </div>
                    <p className="text-[13px] text-muted" data-testid="result-caption">
                      {r.caption}
                    </p>
                    <div className="flex items-center gap-2 text-[12px] text-muted">
                      {isStillMedia(r.media) ? null : <span className="tabular">{formatDuration(r.at)}</span>}
                      <span className="tabular">{Math.round(r.score * 100)}%</span>
                      <Button size="sm" className="ml-auto" onClick={() => show(r)} data-testid="result-show">
                        Show
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <EmptyState title="No matches">
            <span data-testid="search-empty">
              {res.indexed
                ? 'Try other words, or fewer filters.'
                : `Nothing is indexed yet${res.pending ? `: ${res.pending} frames wait` : ''}.`}
            </span>
          </EmptyState>
        )
      ) : nothing ? (
        <EmptyState title="Nothing is indexed yet">
          Index the project's takes, footage, stills and references to search them by what they show.
        </EmptyState>
      ) : null}
    </div>
  );
}
