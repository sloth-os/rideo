import { type Insights, isTerminalJob } from '@rideo/shared';
import { BarChart3, Clock, Coins, ShieldCheck, Sparkles } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Badge, Card, EmptyState, SectionHeader, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError } from '../../store/ui';

/**
 * A project's run at a glance (docs/design/observability.md#insights): cost, time, quality and the improvements of the
 * newest feedback. Fetched when the view opens and again whenever a job ends.
 */
function money(n: number): string {
  return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

function seconds(n: number | null): string {
  if (n === null) return '–';
  if (n < 90) return `${n.toFixed(n < 10 ? 1 : 0)} s`;
  if (n < 5400) return `${(n / 60).toFixed(1)} min`;
  return `${(n / 3600).toFixed(1)} h`;
}

function percent(a: number, b: number): string {
  return b ? `${Math.round((a / b) * 100)}%` : '–';
}

function Stat({ label, value, testid }: { label: string; value: ReactNode; testid?: string }) {
  return (
    <div className="min-w-0 rounded-[var(--radius-control)] bg-surface-2 px-3 py-2" data-testid={testid}>
      <div className="truncate text-[11px] text-muted">{label}</div>
      <div className="truncate font-mono text-[15px] tabular-nums">{value}</div>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
  testid,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  testid: string;
}) {
  return (
    <Card className="min-w-0 space-y-3 p-3 sm:p-4" data-testid={testid}>
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        {icon} {title}
      </h3>
      {children}
    </Card>
  );
}

/** A table that wraps instead of scrolling sideways on phones: each row is a line of cells. */
function Rows({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="space-y-1 text-[12px]">
      <div className="hidden grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))] gap-2 text-muted sm:grid">
        {head.map((h) => (
          <span key={h} className="truncate">
            {h}
          </span>
        ))}
      </div>
      {rows.map((r, i) => (
        <div
          key={i}
          className="grid grid-cols-2 gap-x-2 gap-y-0.5 border-t border-border pt-1 sm:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))] sm:border-0 sm:pt-0"
        >
          {r.map((cell, k) => (
            <span
              key={k}
              className={
                k === 0 ? 'col-span-2 truncate font-medium sm:col-span-1' : 'truncate font-mono tabular-nums'
              }
            >
              <span className="text-muted sm:hidden">{k === 0 ? '' : `${head[k]}: `}</span>
              {cell}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

export function InsightsView() {
  const { projectId, docs, jobs } = useProject();
  const [data, setData] = useState<Insights | null>(null);
  const [failed, setFailed] = useState(false);
  // Refetch when a job ends: the ledger and the job times change then.
  const settled = useMemo(() => Object.values(jobs).filter(isTerminalJob).length, [jobs]);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api
      .insights(projectId)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setFailed(false);
        }
      })
      .catch((err) => {
        if (!cancelled) setFailed(true);
        reportError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, settled]);
  if (!docs || !projectId) return null;
  if (!data)
    return failed ? (
      <EmptyState icon={<BarChart3 className="size-8" />} title="Insights are not available" />
    ) : (
      <div className="flex justify-center p-8">
        <Spinner />
      </div>
    );
  const t = data.usage.totals;
  const newest = Object.values(docs.exports)
    .filter((e) => e.status === 'succeeded' && e.durationSec)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const minutes = newest?.durationSec ? newest.durationSec / 60 : 0;
  const models = Object.entries(t.byModel).sort(
    (a, b) => b[1].costUsd - a[1].costUsd || b[1].calls - a[1].calls,
  );
  const kinds = Object.entries(data.usage.byKind).sort(
    (a, b) => b[1].costUsd - a[1].costUsd || b[1].runSeconds - a[1].runSeconds,
  );
  return (
    <div className="mx-auto max-w-5xl space-y-4" data-testid="insights">
      <SectionHeader
        title="Insights"
        subtitle="What this project's run cost, how long it took and how good it came out, and what to improve next time."
      />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Section title="Cost" icon={<Coins className="size-4 text-accent" />} testid="insights-cost">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat
              label="Estimated"
              value={t.costUsd ? money(t.costUsd) : 'not priced'}
              testid="insights-cost-total"
            />
            <Stat
              label="Per finished minute"
              value={t.costUsd && minutes ? money(t.costUsd / minutes) : '–'}
            />
            <Stat
              label="Thrown away"
              value={
                t.discardedCostUsd ? money(t.discardedCostUsd) : `${Math.round(t.discardedVideoSeconds)} s`
              }
            />
            <Stat label="Video generated" value={`${Math.round(t.videoSeconds)} s`} />
            <Stat label="Images" value={t.images} />
            <Stat label="Model calls" value={t.llmCalls} />
          </div>
          {t.unpriced ? (
            <p className="text-[12px] text-warning">
              {t.unpriced} usage items have no price: set RIDEO_PRICES in Settings → Limits.
            </p>
          ) : null}
          <Rows
            head={['Model', 'Calls', 'Units', 'Time', 'Cost']}
            rows={models.map(([id, m]) => [
              <span key="m" title={m.modality}>
                {id}
              </span>,
              m.calls,
              Math.round(m.units),
              seconds(m.seconds),
              m.unpriced ? 'unpriced' : money(m.costUsd),
            ])}
          />
        </Section>
        <Section title="Time" icon={<Clock className="size-4 text-info" />} testid="insights-time">
          <Rows
            head={['Job', 'Runs', 'Failed', 'Median', 'Slowest tenth']}
            rows={data.jobs.slice(0, 14).map((j) => [
              <span
                key="k"
                title={Object.entries(j.errors)
                  .map(([c, n]) => `${c} × ${n}`)
                  .join(', ')}
              >
                {j.kind}
              </span>,
              j.count,
              j.failed ? (
                <span key="f" className="text-danger">
                  {j.failed}
                </span>
              ) : (
                0
              ),
              seconds(j.p50Sec),
              seconds(j.p90Sec),
            ])}
          />
          <Rows
            head={['Kind', 'Jobs', 'Waited', 'Ran', 'Cost']}
            rows={kinds
              .slice(0, 8)
              .map(([kind, k]) => [
                kind,
                k.jobs,
                seconds(k.waitSeconds),
                seconds(k.runSeconds),
                money(k.costUsd),
              ])}
          />
        </Section>
        <Section
          title="Quality"
          icon={<ShieldCheck className="size-4 text-success" />}
          testid="insights-quality"
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="Takes" value={data.takes.total} />
            <Stat
              label="Passed on the first try"
              value={percent(data.takes.firstTry, data.takes.total)}
              testid="insights-first-try"
            />
            <Stat label="Attempts per take" value={data.takes.meanAttempts ?? '–'} />
            <Stat label="Unverified" value={data.takes.unverified} />
            <Stat label="Overridden" value={data.takes.overridden} />
            <Stat label="Failed quality checks" value={data.takes.qualityFailed} />
          </div>
          {data.characters.some((c) => c.failures) ? (
            <div className="flex flex-wrap gap-1.5">
              {data.characters.map((c) => (
                <Badge
                  key={c.characterId}
                  tone={c.failures / Math.max(1, c.checks) > 0.3 ? 'warning' : 'neutral'}
                >
                  {c.name}: {c.failures}/{c.checks} failed
                </Badge>
              ))}
            </div>
          ) : null}
          {data.feedback.length ? (
            <div className="space-y-1">
              <div className="text-[12px] text-muted">Feedback on exports</div>
              <div className="flex flex-wrap gap-1.5" data-testid="insights-feedback">
                {data.feedback.map((f) => (
                  <Badge
                    key={f.exportId}
                    tone={(f.overall ?? 0) >= 7.5 ? 'success' : (f.overall ?? 0) >= 5 ? 'warning' : 'danger'}
                  >
                    {new Date(f.createdAt).toLocaleDateString()} ·{' '}
                    {f.overall !== null ? `${f.overall.toFixed(1)}/10` : 'measured'}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}
        </Section>
        <Section
          title="Improvements"
          icon={<Sparkles className="size-4 text-warning" />}
          testid="insights-improvements"
        >
          {data.retrospective.length ? (
            <ul className="space-y-1.5">
              {data.retrospective.map((r) => (
                <li key={`${r.area}-${r.title}`} className="text-[13px]">
                  <Badge tone="info" className="mr-1.5">
                    {r.area}
                  </Badge>
                  <span className="font-medium break-words">{r.title}</span>
                  {r.detail ? (
                    <span className="block text-[12px] text-muted break-words">{r.detail}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">The feedback on the next export lists what to improve.</p>
          )}
        </Section>
      </div>
    </div>
  );
}
