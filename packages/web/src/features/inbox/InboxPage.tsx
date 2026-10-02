import { actorLabel, type Inbox, isTerminalJob, type Job } from '@rideo/shared';
import { Bell, BellOff, Bot, Check, Download, Eye, Palette, ShieldCheck, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { jobLabel } from '../../components/JobProgress';
import { Badge, Button, Card, cx, EmptyState, Progress, SectionHeader } from '../../components/ui';
import { api } from '../../lib/api';
import { disablePush, enablePush, type PushState, pushState } from '../../pwa/push';
import { usePwa } from '../../pwa/register';
import { useNotifications } from '../../store/notifications';
import { reportError, useUi } from '../../store/ui';
import { AppHeader } from '../workspace/AppHeader';

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

/** The app on this device: install it, and notifications (docs/design/pwa.md). */
function ThisDevice() {
  const { installable, standalone, ios, offline, install } = usePwa();
  const [push, setPush] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    pushState().then(setPush, () => setPush('unsupported'));
  }, []);
  const toggle = async () => {
    setBusy(true);
    try {
      const next = push === 'on' ? await disablePush() : await enablePush();
      setPush(next);
      if (next === 'on') useUi.getState().toast('Notifications are on for this device', 'success');
      if (next === 'denied')
        useUi.getState().toast('Notifications are blocked: allow them in the browser settings');
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-2 p-3" data-testid="this-device">
      {offline ? (
        <p className="flex items-center gap-2 text-[13px] text-warning" data-testid="offline">
          <WifiOff className="size-4" /> Offline: what you see may be out of date.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {push && push !== 'unsupported' ? (
          <Button
            icon={push === 'on' ? <BellOff className="size-4" /> : <Bell className="size-4" />}
            loading={busy}
            disabled={push === 'denied'}
            onClick={toggle}
            data-testid="push-toggle"
            data-state={push}
          >
            {push === 'on'
              ? 'Turn off notifications here'
              : push === 'denied'
                ? 'Notifications blocked'
                : 'Notifications on this device'}
          </Button>
        ) : null}
        {!standalone && installable && install ? (
          <Button
            icon={<Download className="size-4" />}
            onClick={() => void install()}
            data-testid="install-app"
          >
            Install the app
          </Button>
        ) : null}
        {!standalone && ios && !installable ? (
          <span className="text-[12px] text-muted">To install: Share → Add to Home Screen.</span>
        ) : null}
        {standalone ? <Badge tone="success">Installed</Badge> : null}
      </div>
    </Card>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="flex items-center gap-2 text-[13px] font-medium tracking-wide text-muted uppercase">
        {title}
        {count ? <Badge tone="accent">{count}</Badge> : null}
      </h2>
      {children}
    </section>
  );
}

/**
 * The Inbox (docs/design/pwa.md#the-inbox): across projects, gates to approve, reviews to decide, jobs running or
 * failed, and agents' work of the day. Phone first.
 */
export function InboxPage() {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const notifications = useNotifications((s) => s.items.length);
  const load = useCallback((fresh = false) => api.inbox(fresh).then(setInbox, reportError), []);
  // Fresh while open: every 15 s when visible, on focus, and when a notification arrives
  useEffect(() => {
    void load(true);
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 15_000);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);
  useEffect(() => {
    if (notifications) void load(true);
  }, [notifications]);
  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setActing(key);
    try {
      await fn();
      useUi.getState().toast(done, 'success');
      await load(true);
    } catch (err) {
      reportError(err);
    } finally {
      setActing(null);
    }
  };
  return (
    <div className="min-h-full">
      <AppHeader />
      <main className="mx-auto max-w-2xl space-y-5 p-3 pb-10 sm:p-6" data-testid="view-inbox">
        <SectionHeader title="Inbox" subtitle="What waits for you, and what agents are doing." />
        <ThisDevice />
        {!inbox ? (
          <p className="text-[13px] text-muted">Loading…</p>
        ) : (
          <>
            <Section title="Waiting for you" count={inbox.waiting}>
              {inbox.waiting === 0 ? (
                <EmptyState title="Nothing waits for you">Approvals and reviews show up here.</EmptyState>
              ) : null}
              <ul className="space-y-2">
                {inbox.approvals.map((a) => (
                  <li key={`gate:${a.project.id}`}>
                    <Card className="flex flex-wrap items-center gap-2 p-3" data-testid="inbox-approval">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] font-medium">{a.project.title}</p>
                        <p className="text-[12px] text-muted">Ready: {a.gate.title}</p>
                      </div>
                      <Button
                        variant="primary"
                        icon={<Check className="size-4" />}
                        loading={acting === `gate:${a.project.id}`}
                        onClick={() =>
                          act(
                            `gate:${a.project.id}`,
                            () => api.approve(a.project.id, a.gate.id),
                            `${a.gate.title}: done`,
                          )
                        }
                        data-testid="inbox-approve"
                      >
                        {a.gate.title}
                      </Button>
                    </Card>
                  </li>
                ))}
                {inbox.reviews.map((r) => (
                  <li key={`review:${r.review.id}`}>
                    <Card className="flex flex-wrap items-center gap-2 p-3" data-testid="inbox-review">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] font-medium">{r.review.title}</p>
                        <p className="text-[12px] text-muted">
                          {r.project.title} · asked by {r.review.createdBy} · {ago(r.review.createdAt)}
                        </p>
                      </div>
                      <Link
                        to={`/p/${r.project.id}/overview?review=${r.review.id}`}
                        className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-border px-3 py-1.5 text-[13px] hover:border-accent"
                        data-testid="inbox-open-review"
                      >
                        <Eye className="size-4" /> Review
                      </Link>
                    </Card>
                  </li>
                ))}
              </ul>
            </Section>
            <Section title="Jobs" count={inbox.jobs.filter((j) => !isTerminalJob(j.job)).length}>
              {inbox.jobs.length === 0 ? <p className="text-[13px] text-muted">No jobs running.</p> : null}
              <ul className="space-y-2">
                {inbox.jobs.map(({ project, job, canCancel }) => {
                  const share = job.progress.total > 0 ? job.progress.done / job.progress.total : 0;
                  const failed = job.status === 'failed';
                  return (
                    <li key={job.id}>
                      <Card className="space-y-2 p-3" data-testid="inbox-job" data-status={job.status}>
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[14px] font-medium">
                              {jobLabel({ kind: job.kind } as Job)}
                            </p>
                            <p className="truncate text-[12px] text-muted">
                              {project.title} · {actorLabel(job.actor)} · {ago(job.createdAt)}
                            </p>
                          </div>
                          {job.actor.kind === 'agent' || job.actor.onBehalfOf?.kind === 'agent' ? (
                            <Badge tone="info">
                              <Bot className="mr-1 inline size-3" />
                              agent
                            </Badge>
                          ) : null}
                          <Badge tone={failed ? 'danger' : job.status === 'running' ? 'accent' : 'neutral'}>
                            {job.status}
                          </Badge>
                          {canCancel ? (
                            <Button
                              size="sm"
                              loading={acting === job.id}
                              onClick={() =>
                                act(job.id, () => api.cancelJob(project.id, job.id), 'Job cancelled')
                              }
                              data-testid="inbox-cancel"
                            >
                              Cancel
                            </Button>
                          ) : null}
                        </div>
                        {failed ? (
                          <p className="text-[12px] text-danger">{job.error}</p>
                        ) : (
                          <Progress
                            value={share}
                            label={job.progress.message ?? `${Math.round(share * 100)}%`}
                          />
                        )}
                      </Card>
                    </li>
                  );
                })}
              </ul>
            </Section>
            <Section title="Agents today" count={inbox.agents.length}>
              {inbox.agents.length === 0 ? (
                <p className="text-[13px] text-muted">No agent work in the last 24 hours.</p>
              ) : null}
              <ul className="divide-y divide-border rounded-[var(--radius-card)] border border-border bg-surface">
                {inbox.agents.map(({ project, commit }) => (
                  <li key={`${project.id}:${commit.id}`} className="p-3" data-testid="inbox-agent">
                    <Link to={`/p/${project.id}/history`} className="block hover:text-accent">
                      <p className="flex items-center gap-1.5 text-[13px]">
                        <Bot className="size-3.5 shrink-0 text-info" />
                        <span className="font-medium">{commit.agent}</span>
                        <span className="min-w-0 truncate text-muted">{commit.message}</span>
                      </p>
                      <p className="text-[12px] text-muted">
                        {project.title} · {ago(commit.at)}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          </>
        )}
        <nav className="flex flex-wrap gap-3 text-[13px] text-muted sm:hidden" aria-label="More">
          <Link to="/brand" className={cx('inline-flex items-center gap-1.5 hover:text-text')}>
            <Palette className="size-4" /> Brand kits
          </Link>
          <Link to="/verify" className="inline-flex items-center gap-1.5 hover:text-text">
            <ShieldCheck className="size-4" /> Verify a watermark
          </Link>
        </nav>
      </main>
    </div>
  );
}
