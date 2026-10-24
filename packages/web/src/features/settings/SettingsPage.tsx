import {
  SETTING_ENDPOINTS,
  SETTING_FIELDS,
  SETTING_GROUPS,
  type SettingGroupId,
  type SettingsTestResult,
  type SettingsView,
  settingVisible,
} from '@rideo/shared';
import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Film,
  Gauge,
  HardDrive,
  MessageSquareText,
  Palette,
  PlugZap,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
  Volume2,
  X,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Badge, Button, Card, cx, Dialog, EmptyState, Input, Spinner } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useConfigStore } from '../../lib/config';
import { reportError, useUi } from '../../store/ui';
import { AppHeader } from '../workspace/AppHeader';
import { EndpointCard } from './EndpointCard';
import { FieldRow, HelpText } from './fields';
import {
  aiSummary,
  applyChange,
  type Draft,
  draftEndpoints,
  effectiveValues,
  firstGroupWithError,
  fullLabel,
  groupFromHash,
  matches,
  sectionStates,
  visibleFields,
} from './model';

const STORAGE_LABEL: Record<SettingsView['storage'], string> = {
  browser: 'This browser',
  webdav: 'WebDAV server',
  embedded: 'Built-in WebDAV server',
};

const GROUP_ICONS: Record<SettingGroupId, ReactNode> = {
  storage: <HardDrive className="size-4" />,
  gateway: <Server className="size-4" />,
  models: <Film className="size-4" />,
  ai: <MessageSquareText className="size-4" />,
  audio: <Volume2 className="size-4" />,
  consistency: <CheckCircle2 className="size-4" />,
  accounts: <Users className="size-4" />,
  provenance: <ShieldCheck className="size-4" />,
  jobs: <Gauge className="size-4" />,
  appearance: <Palette className="size-4" />,
};

/** Settings an endpoint card shows (not repeated in its section's list). */
const ENDPOINT_SETTINGS = new Set(
  SETTING_ENDPOINTS.flatMap((e) => [e.provider, e.url, e.key, e.model]).filter((env): env is string => !!env),
);

function TestButton({ target, values }: { target: 'webdav' | 'gateway'; values: Draft }) {
  const [result, setResult] = useState<SettingsTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        icon={<PlugZap className="size-3.5" />}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setResult(await api.testSettings(target, values));
          } catch (err) {
            reportError(err);
          } finally {
            setBusy(false);
          }
        }}
        data-testid={`settings-test-${target}`}
      >
        Test connection
      </Button>
      {result ? (
        <span
          className={cx('text-[12px]', result.ok ? 'text-success' : 'text-danger')}
          data-testid="settings-test-result"
          data-ok={result.ok ? 'true' : 'false'}
        >
          {result.detail}
        </span>
      ) : null}
    </div>
  );
}

function StatusTile({
  icon,
  label,
  value,
  tone,
  testid,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone: 'success' | 'warning' | 'neutral';
  testid: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-w-0 items-center gap-3 rounded-[var(--radius-card)] border border-border bg-surface p-3 text-left transition-colors duration-100 hover:border-muted focus-visible:outline-2 focus-visible:outline-accent"
      data-testid={testid}
      data-tone={tone}
    >
      <span
        className={cx(
          'flex size-9 shrink-0 items-center justify-center rounded-full',
          tone === 'success'
            ? 'bg-success/15 text-success'
            : tone === 'warning'
              ? 'bg-warning/15 text-warning'
              : 'bg-surface-2 text-muted',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[11px] font-medium tracking-wide text-muted uppercase">{label}</span>
        <span className="block truncate text-[14px] font-medium" data-testid={`${testid}-value`}>
          {value}
        </span>
      </span>
    </button>
  );
}

/** How registering the API keys in mm-gateway went (the mm-gateway section). */
function ProxySyncLine({ view }: { view: SettingsView }) {
  const s = view.proxySync;
  if (s.status === 'idle') return null;
  const at = s.at ? new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <p
      className={cx(
        'mb-3 rounded-[var(--radius-control)] border px-3 py-2 text-[12px]',
        s.status === 'failed'
          ? 'border-danger/40 bg-danger/10 text-danger'
          : 'border-border bg-surface text-muted',
      )}
      data-testid="settings-proxy-sync"
      data-status={s.status}
    >
      {s.status === 'pending'
        ? 'Registering the API keys in mm-gateway…'
        : s.status === 'ok'
          ? `API keys of Language, vision and speech and Voices and sound are in step with mm-gateway${at ? ` (checked at ${at})` : ''}.`
          : `API keys are not registered in mm-gateway: ${s.detail}`}
    </p>
  );
}

/** Studio settings for administrators (docs/design/settings.md#the-settings-page), rendered from the settings table. */
export function SettingsPage() {
  const me = useAuth((s) => s.me);
  const toast = useUi((s) => s.toast);
  const reloadConfig = useConfigStore((s) => s.reload);
  const location = useLocation();
  const navigate = useNavigate();
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<SettingGroupId>(() => groupFromHash(location.hash) ?? 'storage');
  const [advanced, setAdvanced] = useState<Partial<Record<SettingGroupId, boolean>>>({});
  const load = useCallback(() => {
    api
      .settings()
      .then(setView)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) setForbidden(true);
        else reportError(err);
      });
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const g = groupFromHash(location.hash);
    if (g) setActive(g);
  }, [location.hash]);
  // Keys being registered: look again until the gateway has answered
  useEffect(() => {
    if (view?.proxySync.status !== 'pending') return;
    const t = setTimeout(load, 2000);
    return () => clearTimeout(t);
  }, [view, load]);
  const values = useMemo(() => (view ? effectiveValues(view, draft) : {}), [view, draft]);
  const resolved = useMemo(() => draftEndpoints(values), [values]);
  const sections = useMemo(() => (view ? sectionStates(view, draft, errors) : null), [view, draft, errors]);
  const open = (g: SettingGroupId) => {
    setQuery('');
    setActive(g);
    navigate({ hash: g }, { replace: true });
    document.getElementById('settings-content')?.scrollIntoView?.({ block: 'nearest' });
  };
  // On a phone the open section's tab stays in view in its row (once the row is there)
  const loaded = !!view;
  useEffect(() => {
    if (!loaded) return;
    document
      .querySelector(`[data-testid="settings-nav-${active}"]`)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [active, loaded]);
  const change = (env: string, value: string | null) => {
    if (!view) return;
    setErrors(({ [env]: _, ...rest }) => rest);
    setDraft((d) => applyChange(view, d, env, value));
  };
  const save = async () => {
    setConfirming(false);
    setSaving(true);
    try {
      const r = await api.updateSettings(draft);
      setView(r);
      setDraft({});
      setErrors({});
      const keys = r.changed.some((k) => ENDPOINT_SETTINGS.has(k) || k.startsWith('MM_GATEWAY_'));
      if (r.proxySync.status === 'failed' && keys)
        toast(
          `Settings applied, but the API keys are not registered in mm-gateway: ${r.proxySync.detail}`,
          'warning',
        );
      else if (r.proxySync.status === 'pending' && keys)
        toast('Settings applied. Registering the API keys in mm-gateway…', 'info');
      else
        toast(
          r.applied
            ? `Settings applied (${r.changed.join(', ')})${keys && SETTING_ENDPOINTS.some((e) => r.endpoints[e.id]?.proxy === 'registered') ? ' · API keys registered in mm-gateway' : ''}`
            : 'Nothing changed',
          'success',
        );
      await reloadConfig().catch(() => undefined);
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.problem.errors)) {
        const byField: Record<string, string> = {};
        for (const e of err.problem.errors as { path?: string; message?: string }[])
          if (e.path && e.message) byField[e.path] = e.message;
        setErrors(byField);
        const first = firstGroupWithError(byField);
        if (first && !SETTING_FIELDS.some((f) => f.group === active && byField[f.env])) open(first);
      }
      reportError(err);
    } finally {
      setSaving(false);
    }
  };
  const changes = Object.keys(draft).length;
  if (forbidden || (me && !me.admin))
    return (
      <div className="min-h-full">
        <AppHeader />
        <main className="mx-auto max-w-3xl px-3 py-10 sm:px-6" data-testid="settings-forbidden">
          <p className="text-muted">Only administrators change the studio settings.</p>
        </main>
      </div>
    );
  const group = SETTING_GROUPS.find((g) => g.id === active)!;
  const row = (f: (typeof SETTING_FIELDS)[number], label?: string) => (
    <FieldRow
      key={f.env}
      field={f}
      view={view!}
      draft={draft}
      error={errors[f.env]}
      onChange={change}
      label={label}
    />
  );
  const section = () => {
    if (!view) return null;
    const fields = visibleFields(group.id, values).filter((f) => !ENDPOINT_SETTINGS.has(f.env));
    const essential = fields.filter((f) => !f.advanced);
    const rare = fields.filter((f) => f.advanced);
    const forced = rare.some((f) => f.env in draft || errors[f.env] || view.fields[f.env]?.locked);
    const openRare = forced || !!advanced[group.id];
    const endpoints = SETTING_ENDPOINTS.filter((e) => e.group === group.id);
    return (
      <section
        id={`settings-${group.id}`}
        aria-labelledby={`settings-${group.id}-title`}
        data-testid={`settings-group-${group.id}`}
        className="space-y-3"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={`settings-${group.id}-title`} className="text-lg font-semibold tracking-tight">
              {group.label}
            </h2>
            <p className="max-w-2xl text-[13px] text-muted">
              <HelpText text={group.help} />
            </p>
          </div>
          {group.id === 'gateway' ? <TestButton target="gateway" values={draft} /> : null}
          {group.id === 'storage' && (values.RIDEO_STORAGE === 'webdav' || values.RIDEO_WEBDAV_URL) ? (
            <TestButton target="webdav" values={draft} />
          ) : null}
        </div>
        {group.id === 'gateway' ? <ProxySyncLine view={view} /> : null}
        {endpoints.map((e) => (
          <EndpointCard
            key={e.id}
            endpoint={e}
            view={view}
            draft={draft}
            values={values}
            resolved={resolved}
            errors={errors}
            onChange={change}
          />
        ))}
        {essential.length ? (
          <Card className="px-4 py-1">
            <div className="divide-y divide-border">{essential.map((f) => row(f))}</div>
          </Card>
        ) : null}
        {rare.length ? (
          <Card className="px-4 py-1" data-testid={`settings-advanced-${group.id}`}>
            <button
              type="button"
              className="flex w-full items-center gap-2 py-2.5 text-left text-[13px] font-medium text-muted hover:text-text"
              aria-expanded={openRare}
              disabled={forced}
              onClick={() => setAdvanced((a) => ({ ...a, [group.id]: !a[group.id] }))}
              data-testid={`settings-advanced-${group.id}-toggle`}
            >
              <ChevronDown className={cx('size-4 transition-transform', !openRare && '-rotate-90')} />
              Advanced
              <span className="text-[12px] font-normal">({rare.length})</span>
            </button>
            {openRare ? (
              <div className="divide-y divide-border border-t border-border">{rare.map((f) => row(f))}</div>
            ) : null}
          </Card>
        ) : null}
      </section>
    );
  };
  const results = () => {
    if (!view) return null;
    const found = SETTING_GROUPS.map((g) => ({
      g,
      fields: SETTING_FIELDS.filter(
        (f) => f.group === g.id && settingVisible(f, values) && matches(f, query),
      ),
    })).filter((x) => x.fields.length);
    if (!found.length)
      return (
        <EmptyState icon={<Search className="size-6" />} title={`No setting matches “${query.trim()}”`}>
          Try a word from its label, its variable name (MM_GATEWAY_URL) or its help.
        </EmptyState>
      );
    return (
      <div className="space-y-3" data-testid="settings-results">
        {found.map(({ g, fields }) => (
          <Card key={g.id} className="px-4 py-1" data-testid={`settings-results-${g.id}`}>
            <button
              type="button"
              className="flex items-center gap-2 py-2.5 text-[13px] font-semibold hover:text-accent"
              onClick={() => open(g.id)}
            >
              {GROUP_ICONS[g.id]} {g.label}
            </button>
            <div className="divide-y divide-border border-t border-border">
              {fields.map((f) => row(f, fullLabel(f)))}
            </div>
          </Card>
        ))}
      </div>
    );
  };
  const ai = view ? aiSummary(view) : null;
  return (
    <div className="min-h-full pb-28">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-3 py-6 sm:px-6" data-testid="settings-page">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
              <Settings2 className="size-5" /> Settings
            </h1>
            <p className="text-[13px] text-muted">
              Applied at once. Values set in the server’s environment win and are shown locked.
            </p>
          </div>
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
            <Input
              type="text"
              enterKeyHint="search"
              role="searchbox"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a setting…"
              aria-label="Find a setting"
              className="pr-9 pl-9"
              data-testid="settings-search"
            />
            {query ? (
              <button
                type="button"
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted hover:text-text"
                onClick={() => setQuery('')}
                aria-label="Clear the search"
              >
                <X className="size-4" />
              </button>
            ) : null}
          </div>
        </div>
        {!view || !sections || !ai ? (
          <Spinner />
        ) : (
          <>
            <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatusTile
                icon={<HardDrive className="size-4" />}
                label="Projects are stored in"
                value={STORAGE_LABEL[view.storage]}
                tone={view.storage === 'browser' ? 'warning' : 'success'}
                testid="settings-status-storage"
                onClick={() => open('storage')}
              />
              <StatusTile
                icon={view.gateway ? <CheckCircle2 className="size-4" /> : <CircleAlert className="size-4" />}
                label="mm-gateway"
                value={view.gateway ? 'Connected: AI features are on' : 'Not connected: AI is off'}
                tone={view.gateway ? 'success' : 'warning'}
                testid="settings-status-gateway"
                onClick={() => open('gateway')}
              />
              <StatusTile
                icon={<Sparkles className="size-4" />}
                label="Language, vision and speech"
                value={ai.value}
                tone={ai.tone}
                testid="settings-status-ai"
                onClick={() => open('ai')}
              />
            </div>
            {view.error ? (
              <Card
                className="mb-5 border-danger/40 bg-danger/10 p-3 text-[13px] text-danger"
                data-testid="settings-error"
              >
                The saved settings are not in effect: {view.error}
              </Card>
            ) : null}
            <div className="md:grid md:grid-cols-[13.5rem_minmax(0,1fr)] md:gap-6">
              <nav
                aria-label="Settings sections"
                data-testid="settings-nav"
                className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-20 -mx-3 mb-4 flex gap-1.5 overflow-x-auto border-b border-border bg-bg/95 px-3 py-2 backdrop-blur md:top-20 md:mx-0 md:mb-0 md:flex-col md:gap-0.5 md:self-start md:overflow-visible md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none"
              >
                {SETTING_GROUPS.map((g) => {
                  const s = sections[g.id];
                  const current = !query && active === g.id;
                  return (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => open(g.id)}
                      aria-current={current ? 'page' : undefined}
                      data-testid={`settings-nav-${g.id}`}
                      data-attention={s.attention ? 'true' : 'false'}
                      className={cx(
                        'flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] transition-colors duration-100 md:rounded-[var(--radius-control)] md:border-transparent md:py-2',
                        current
                          ? 'border-accent/50 bg-accent/10 text-text md:border-transparent md:bg-surface-2'
                          : 'border-border text-muted hover:text-text md:hover:bg-surface-2',
                      )}
                    >
                      <span className={cx(current ? 'text-accent' : 'text-muted')}>{GROUP_ICONS[g.id]}</span>
                      <span className="whitespace-nowrap">{g.label}</span>
                      {s.changes ? (
                        <span
                          className="rounded-full bg-warning/20 px-1.5 text-[11px] font-medium text-warning md:ml-auto"
                          data-testid={`settings-nav-${g.id}-changes`}
                          title={`${s.changes} unsaved`}
                        >
                          {s.changes}
                        </span>
                      ) : null}
                      {s.attention ? (
                        <span
                          className={cx(
                            'size-2 shrink-0 rounded-full bg-warning',
                            !s.changes && 'md:ml-auto',
                          )}
                          role="img"
                          aria-label="needs attention"
                        />
                      ) : null}
                    </button>
                  );
                })}
              </nav>
              <div id="settings-content" className="min-w-0 scroll-mt-20">
                {query.trim() ? results() : section()}
              </div>
            </div>
          </>
        )}
      </main>
      {changes ? (
        <div
          className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-bg/95 px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur sm:px-6"
          data-testid="settings-savebar"
        >
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-end gap-2">
            <span className="mr-auto text-[13px] text-muted">
              {changes} unsaved change{changes === 1 ? '' : 's'}
              {Object.keys(errors).length ? (
                <Badge tone="danger" className="ml-2">
                  {Object.keys(errors).length} refused
                </Badge>
              ) : null}
            </span>
            <Button
              variant="ghost"
              onClick={() => {
                setDraft({});
                setErrors({});
              }}
              data-testid="settings-discard"
            >
              Discard
            </Button>
            <Button
              variant="primary"
              loading={saving}
              onClick={() => (view?.runningJobs ? setConfirming(true) : void save())}
              data-testid="settings-save"
            >
              Save and apply
            </Button>
          </div>
        </div>
      ) : null}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Apply settings now?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()} data-testid="settings-confirm">
              Apply
            </Button>
          </>
        }
      >
        <p className="text-[13px]">
          {view?.runningJobs} job{view?.runningJobs === 1 ? ' is' : 's are'} running. Applying restarts the
          studio’s services: they stop now and resume on their own.
        </p>
      </Dialog>
    </div>
  );
}
