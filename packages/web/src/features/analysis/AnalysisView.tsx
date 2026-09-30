import { type Analysis, type EditSuggestion, formatDuration, isTerminalJob } from '@rideo/shared';
import { Bot, Check, ListChecks, ScanSearch, Sparkles, Wand2, X } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Entity } from '../../components/Entity';
import { JobRow } from '../../components/JobProgress';
import { MediaImage } from '../../components/Media';
import { Badge, Button, Card, cx, EmptyState, SectionHeader, Select } from '../../components/ui';
import { api } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError, useUi } from '../../store/ui';

function describeParams(s: EditSuggestion): string {
  const p = s.params;
  const r = (a: number, b: number) => `${a.toFixed(1)}–${b.toFixed(1)}s`;
  switch (p.kind) {
    case 'cut':
      return r(p.start, p.end);
    case 'tighten_silence':
      return `${r(p.start, p.end)} → keep ${p.keepSec}s`;
    case 'highlight':
      return `${p.segments.length} segment(s)`;
    case 'transition':
      return `${p.type} at ${p.at.toFixed(1)}s (${p.duration}s)`;
    case 'title':
      return `“${p.text}” at ${p.start.toFixed(1)}s`;
    case 'caption':
      return `${r(p.start, p.end)} “${p.text}”`;
    case 'speed':
      return `${r(p.start, p.end)} × ${p.factor}`;
    case 'music':
      return p.prompt ?? p.resourceId ?? 'music bed';
    case 'fade':
      return `in ${p.in ?? 0}s · out ${p.out ?? 0}s`;
    case 'color':
      return [
        p.brightness !== undefined && `brightness ${p.brightness}`,
        p.contrast !== undefined && `contrast ${p.contrast}`,
        p.saturation !== undefined && `saturation ${p.saturation}`,
      ]
        .filter(Boolean)
        .join(' · ');
  }
}

function SignalLane({ a }: { a: Analysis }) {
  const d = a.probe?.durationSec ?? 1;
  const pct = (t: number) => `${(t / d) * 100}%`;
  return (
    <div className="space-y-1" role="group" aria-label="Signal analysis">
      {[
        ['Scenes', a.scenes, 'bg-accent/40'],
        ['Silence', a.silences, 'bg-warning/60'],
        ['Black', a.blackSegments, 'bg-danger/60'],
      ].map(([label, ranges, color]) => (
        <div key={label as string} className="flex items-center gap-2">
          <span className="w-14 shrink-0 text-[11px] text-muted">{label as string}</span>
          <div className="relative h-4 flex-1 rounded bg-surface-2">
            {(ranges as { start: number; end: number }[]).map((r, i) => (
              <div
                key={i}
                className={cx('absolute inset-y-0.5 rounded-sm border-r border-bg', color as string)}
                style={{ left: pct(r.start), width: pct(Math.max(0.05, r.end - r.start)) }}
                title={`${r.start.toFixed(1)}–${r.end.toFixed(1)}s`}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function AnalysisView() {
  const { docs, projectId, jobs, workflow } = useProject();
  const navigate = useNavigate();
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  if (!docs || !projectId) return null;
  const videos = Object.values(docs.resources).filter((r) => r.kind === 'video' && r.status === 'ready');
  const analyses = Object.values(docs.analyses).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const current = analyses[0];
  const running = Object.values(jobs).find(
    (j) => (j.kind === 'analysis.signals' || j.kind === 'analysis.suggest') && !isTerminalJob(j),
  );
  const decide = (decisions: { id: string; status: EditSuggestion['status'] }[]) =>
    current && api.reviewSuggestions(projectId, current.id, decisions).catch(reportError);
  const run = async () => {
    const rid = source || videos.find((v) => v.role === 'source')?.id || videos[0]?.id;
    if (!rid) return;
    setBusy(true);
    try {
      await api.analyze(projectId, rid);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  const autoEdit = async () => {
    if (!current) return;
    setBusy(true);
    try {
      await api.autoEdit(projectId, current.id);
      useUi.getState().toast('Auto edit applied', 'success');
      navigate(`/p/${projectId}/editor`);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  const accepted = current?.suggestions.filter((s) => s.status === 'accepted').length ?? 0;
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <SectionHeader
        title="Analysis"
        subtitle="Scenes, silences, black frames, loudness and a visual summary — then edit suggestions you can accept or reject."
        actions={
          <>
            {videos.length > 1 ? (
              <Select
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="w-auto"
                aria-label="Source video"
              >
                <option value="">Newest source</option>
                {videos.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            ) : null}
            <Button
              icon={<ScanSearch className="size-4" />}
              loading={busy && !current}
              disabled={!videos.length || !!running}
              onClick={run}
              data-testid="run-analysis"
            >
              {current ? 'Analyze again' : 'Analyze footage'}
            </Button>
            <Button
              variant="primary"
              icon={<Wand2 className="size-4" />}
              disabled={current?.status !== 'completed' || accepted === 0}
              loading={busy && !!current}
              onClick={autoEdit}
              data-testid="auto-edit"
            >
              Auto edit ({accepted})
            </Button>
          </>
        }
      />
      {running ? <JobRow job={running} projectId={projectId} /> : null}
      {!current ? (
        <EmptyState
          icon={<ScanSearch className="size-8" />}
          title={videos.length ? 'Not analyzed yet' : 'Upload footage first'}
        >
          {workflow?.stage === 'ingest'
            ? 'Upload a video in Footage, then continue here.'
            : 'Run the analysis to get edit suggestions.'}
        </EmptyState>
      ) : (
        <>
          <Card className="space-y-3 p-4" data-testid="analysis-summary">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                tone={
                  current.status === 'completed'
                    ? 'success'
                    : current.status === 'failed'
                      ? 'danger'
                      : 'warning'
                }
              >
                {current.status}
              </Badge>
              {current.probe ? (
                <span className="text-[12px] text-muted">
                  {formatDuration(current.probe.durationSec)} · {current.probe.width}×{current.probe.height} ·{' '}
                  {current.probe.fps.toFixed(0)} fps
                  {current.loudness ? ` · ${current.loudness.integratedLufs.toFixed(1)} LUFS` : ''}
                </span>
              ) : null}
            </div>
            {current.summary ? <p className="text-[13px]">{current.summary}</p> : null}
            {current.error ? <p className="text-[13px] text-danger">{current.error}</p> : null}
            {current.probe ? <SignalLane a={current} /> : null}
            {current.scenes.some((s) => s.thumbnail) ? (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {current.scenes
                  .filter((s) => s.thumbnail)
                  .map((s) => (
                    <figure key={s.start} className="w-32 shrink-0">
                      <MediaImage
                        projectId={projectId}
                        media={s.thumbnail}
                        alt={`scene at ${s.start}s`}
                        className="aspect-video w-full rounded"
                      />
                      <figcaption className="tabular mt-0.5 text-[10px] text-muted">
                        {s.start.toFixed(1)}–{s.end.toFixed(1)}s
                      </figcaption>
                    </figure>
                  ))}
              </div>
            ) : null}
            {current.transcript.length ? (
              <details className="text-[13px]">
                <summary className="cursor-pointer text-muted">
                  Transcript ({current.transcript.length} segments)
                </summary>
                <ul className="mt-2 space-y-1">
                  {current.transcript.map((t) => (
                    <li key={t.start}>
                      <span className="tabular text-muted">{t.start.toFixed(1)}s</span> {t.text}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </Card>
          {current.suggestions.length ? (
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="flex-1 font-medium">Suggestions</h3>
              <Button
                size="sm"
                icon={<ListChecks className="size-3.5" />}
                onClick={() => decide(current.suggestions.map((s) => ({ id: s.id, status: 'accepted' })))}
                data-testid="accept-all"
              >
                Accept all
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => decide(current.suggestions.map((s) => ({ id: s.id, status: 'rejected' })))}
              >
                Reject all
              </Button>
            </div>
          ) : null}
          <ul className="space-y-2" data-testid="suggestions">
            {current.suggestions.map((s) => (
              <Entity
                key={s.id}
                kind="suggestion"
                id={s.id}
                as="li"
                className={cx(
                  'flex flex-wrap items-start gap-3 rounded-[var(--radius-card)] border bg-surface p-3',
                  s.status === 'accepted'
                    ? 'border-success/50'
                    : s.status === 'rejected'
                      ? 'border-border opacity-60'
                      : 'border-border',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={s.source === 'ai' ? 'info' : 'neutral'}>
                      {s.source === 'ai' ? <Bot className="size-3" /> : <Sparkles className="size-3" />}
                      {s.source}
                    </Badge>
                    <Badge tone="accent">{s.params.kind.replace('_', ' ')}</Badge>
                    <span className="tabular text-[11px] text-muted">{Math.round(s.confidence * 100)}%</span>
                  </div>
                  <div className="mt-1 text-[13px] font-medium">{s.description}</div>
                  <div className="text-[12px] text-muted">
                    {describeParams(s)}
                    {s.rationale ? ` — ${s.rationale}` : ''}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant={s.status === 'accepted' ? 'primary' : 'secondary'}
                    onClick={() =>
                      decide([{ id: s.id, status: s.status === 'accepted' ? 'pending' : 'accepted' }])
                    }
                    aria-label="Accept"
                    data-testid="accept-suggestion"
                  >
                    <Check className="size-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant={s.status === 'rejected' ? 'danger' : 'ghost'}
                    onClick={() =>
                      decide([{ id: s.id, status: s.status === 'rejected' ? 'pending' : 'rejected' }])
                    }
                    aria-label="Reject"
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              </Entity>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
