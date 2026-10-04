import {
  BRAND_TOKENS,
  parseThemeJson,
  SETTING_FIELDS,
  SETTING_GROUPS,
  type SettingField,
  type SettingsTestResult,
  type SettingsView,
  settingVisible,
  type Theme,
} from '@rideo/shared';
import { CheckCircle2, CircleAlert, HardDrive, Lock, PlugZap, RotateCcw, Settings2 } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, cx, Dialog, Input, Select, Spinner, Textarea } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useConfigStore } from '../../lib/config';
import { reportError, useUi } from '../../store/ui';
import { AppHeader } from '../workspace/AppHeader';

/** A change in the form: a string sets, null clears back to the default. */
type Draft = Record<string, string | null>;

const STORAGE_LABEL: Record<SettingsView['storage'], string> = {
  browser: 'This browser',
  webdav: 'WebDAV server',
  embedded: 'Built-in WebDAV server',
};

/** The value a field shows: the draft, else the stored or environment value ('' when unset or a secret). */
function shown(view: SettingsView, draft: Draft, env: string): string {
  if (env in draft) return draft[env] ?? '';
  return view.fields[env]?.value ?? '';
}

function ThemeEditor({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (v: string | null) => void;
}) {
  const [json, setJson] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setJson(value), [value]);
  let theme: Theme = {};
  try {
    theme = parseThemeJson(value) ?? {};
  } catch {
    // shown in the JSON field below
  }
  const set = (next: Theme) => {
    const clean = JSON.parse(JSON.stringify(next)) as Theme;
    onChange(Object.keys(clean).length ? JSON.stringify(clean) : null);
  };
  const accent = (mode: 'dark' | 'light') =>
    theme[mode]?.accent ?? theme.colors?.accent ?? BRAND_TOKENS[mode].accent;
  return (
    <div className="space-y-3" data-testid="theme-editor">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label htmlFor="theme-mode" className="block text-[12px] text-muted">
          Default mode
          <Select
            id="theme-mode"
            value={theme.mode ?? ''}
            disabled={disabled}
            onChange={(e) => set({ ...theme, mode: (e.target.value || undefined) as Theme['mode'] })}
            name="theme-mode"
            className="mt-1"
          >
            <option value="">Follow the device</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </Select>
        </label>
        {(['dark', 'light'] as const).map((mode) => (
          <label key={mode} className="block text-[12px] text-muted">
            Accent ({mode})
            <span className="mt-1 flex items-center gap-2">
              <input
                type="color"
                value={/^#[0-9a-f]{6}$/i.test(accent(mode)) ? accent(mode) : BRAND_TOKENS[mode].accent}
                disabled={disabled}
                onChange={(e) => set({ ...theme, [mode]: { ...theme[mode], accent: e.target.value } })}
                className="h-9 w-12 cursor-pointer rounded-[var(--radius-control)] border border-border bg-surface-2"
                aria-label={`Accent color in ${mode} mode`}
                name={`theme-accent-${mode}`}
              />
              <code className="truncate text-[12px] text-text">{accent(mode)}</code>
            </span>
          </label>
        ))}
      </div>
      <label htmlFor="setting-RIDEO_THEME" className="block text-[12px] text-muted">
        Theme (JSON): colors, fonts, radius and brand (docs/design/embedding.md#themes)
        <Textarea
          id="setting-RIDEO_THEME"
          value={json}
          disabled={disabled}
          onChange={(e) => {
            setJson(e.target.value);
            try {
              parseThemeJson(e.target.value);
              setError(null);
              onChange(e.target.value.trim() ? e.target.value : null);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
          name="RIDEO_THEME"
          spellCheck={false}
          className="mt-1 font-mono text-[12px]"
          placeholder='{"mode":"dark","colors":{"accent":"#7c3aed"}}'
        />
        {error ? <span className="mt-1 block text-danger">{error.slice(0, 300)}</span> : null}
      </label>
    </div>
  );
}

function Control({
  field,
  view,
  draft,
  onChange,
}: {
  field: SettingField;
  view: SettingsView;
  draft: Draft;
  onChange: (env: string, value: string | null) => void;
}) {
  const state = view.fields[field.env];
  const locked = !!state?.locked;
  const value = shown(view, draft, field.env);
  const common = {
    name: field.env,
    id: `setting-${field.env}`,
    disabled: locked,
    'aria-describedby': field.help ? `setting-${field.env}-help` : undefined,
  };
  switch (field.kind) {
    case 'select':
      return (
        <Select {...common} value={value} onChange={(e) => onChange(field.env, e.target.value || null)}>
          {field.options?.includes('') ? null : (
            <option value="">{`Default (${field.placeholder ?? 'none'})`}</option>
          )}
          {field.options?.map((o) => (
            <option key={o} value={o}>
              {o === '' ? `Default (${field.placeholder ?? 'none'})` : o}
            </option>
          ))}
        </Select>
      );
    case 'secret':
      return (
        <Input
          {...common}
          type="password"
          autoComplete="new-password"
          value={draft[field.env] ?? ''}
          placeholder={state?.set && !(field.env in draft) ? '•••••••• (set; type to replace)' : 'Not set'}
          onChange={(e) => onChange(field.env, e.target.value)}
        />
      );
    case 'pem':
      return (
        <Textarea
          {...common}
          value={value}
          spellCheck={false}
          className="font-mono text-[12px]"
          placeholder={field.placeholder ?? '-----BEGIN CERTIFICATE-----'}
          onChange={(e) => onChange(field.env, e.target.value)}
        />
      );
    case 'theme':
      return <ThemeEditor value={value} disabled={locked} onChange={(v) => onChange(field.env, v)} />;
    default:
      return (
        <Input
          {...common}
          type={field.kind === 'number' ? 'text' : field.kind === 'url' ? 'url' : 'text'}
          inputMode={field.kind === 'number' ? 'decimal' : undefined}
          value={value}
          placeholder={field.placeholder}
          onChange={(e) => onChange(field.env, e.target.value)}
        />
      );
  }
}

function FieldRow({
  field,
  view,
  draft,
  error,
  onChange,
}: {
  field: SettingField;
  view: SettingsView;
  draft: Draft;
  error?: string;
  onChange: (env: string, value: string | null) => void;
}) {
  const state = view.fields[field.env];
  if (!state) return null;
  const dirty = field.env in draft;
  return (
    <div
      className="grid grid-cols-1 gap-1.5 py-3 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] md:gap-4"
      data-testid={`setting-${field.env}`}
      data-source={state.source}
      data-locked={state.locked ? 'true' : 'false'}
    >
      <div className="min-w-0">
        <label htmlFor={`setting-${field.env}`} className="block text-[13px] font-medium">
          {field.label}
        </label>
        <code className="block truncate text-[11px] text-muted" title={field.env}>
          {field.env}
        </code>
      </div>
      <div className="min-w-0 space-y-1">
        <Control field={field} view={view} draft={draft} onChange={onChange} />
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
          {state.locked ? (
            <Badge tone="info" testid="setting-locked">
              <Lock className="size-3" /> set by the environment
            </Badge>
          ) : state.source === 'settings' && !dirty ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 hover:text-text"
              onClick={() => onChange(field.env, null)}
              data-testid="setting-reset"
            >
              <RotateCcw className="size-3" /> Use the default
            </button>
          ) : null}
          {dirty ? <Badge tone="warning">unsaved</Badge> : null}
          {field.help ? <span id={`setting-${field.env}-help`}>{field.help}</span> : null}
        </div>
        {error ? (
          <p className="text-[12px] text-danger" role="alert" data-testid="setting-error">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

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

function StatusCard({
  icon,
  label,
  value,
  tone,
  testid,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone: 'success' | 'warning' | 'neutral';
  testid: string;
}) {
  return (
    <Card className="flex items-center gap-3 p-3" data-testid={testid}>
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
    </Card>
  );
}

/** Studio settings for administrators (docs/design/settings.md), rendered from the shared settings table. */
export function SettingsPage() {
  const me = useAuth((s) => s.me);
  const toast = useUi((s) => s.toast);
  const reloadConfig = useConfigStore((s) => s.reload);
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [forbidden, setForbidden] = useState(false);
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
  const effective = useMemo(() => {
    const out: Record<string, string | null> = {};
    if (!view) return out;
    for (const f of SETTING_FIELDS) out[f.env] = shown(view, draft, f.env) || null;
    return out;
  }, [view, draft]);
  const change = (env: string, value: string | null) => {
    setErrors(({ [env]: _, ...rest }) => rest);
    setDraft((d) => {
      const field = SETTING_FIELDS.find((f) => f.env === env);
      const stored = view?.fields[env];
      const next = { ...d };
      // Back to what is stored: nothing to save. Secrets are never shown, so only typing nothing is no change.
      const same = field?.kind === 'secret' ? value === '' : (value ?? '') === (stored?.value ?? '');
      if (same && !(value === null && stored?.source === 'settings')) delete next[env];
      else next[env] = value;
      return next;
    });
  };
  const save = async () => {
    setConfirming(false);
    setSaving(true);
    try {
      const r = await api.updateSettings(draft);
      setView(r);
      setDraft({});
      setErrors({});
      toast(r.applied ? `Settings applied (${r.changed.join(', ')})` : 'Nothing changed', 'success');
      await reloadConfig().catch(() => undefined);
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.problem.errors)) {
        const byField: Record<string, string> = {};
        for (const e of err.problem.errors as { path?: string; message?: string }[])
          if (e.path && e.message) byField[e.path] = e.message;
        setErrors(byField);
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
  return (
    <div className="min-h-full pb-24">
      <AppHeader />
      <main className="mx-auto max-w-5xl px-3 py-6 sm:px-6" data-testid="settings-page">
        <h1 className="mb-1 flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Settings2 className="size-5" /> Settings
        </h1>
        <p className="mb-5 text-[13px] text-muted">
          Applied at once. Values set in the server’s environment win and are shown locked.
        </p>
        {!view ? (
          <Spinner />
        ) : (
          <>
            <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <StatusCard
                icon={<HardDrive className="size-4" />}
                label="Projects are stored in"
                value={STORAGE_LABEL[view.storage]}
                tone={view.storage === 'browser' ? 'warning' : 'success'}
                testid="settings-status-storage"
              />
              <StatusCard
                icon={view.gateway ? <CheckCircle2 className="size-4" /> : <CircleAlert className="size-4" />}
                label="mm-gateway"
                value={
                  view.gateway
                    ? 'Connected: AI features are on'
                    : 'Not connected: the editor works, AI is off'
                }
                tone={view.gateway ? 'success' : 'warning'}
                testid="settings-status-gateway"
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
            <nav className="mb-4 flex gap-1 overflow-x-auto pb-1 text-[13px]" aria-label="Settings sections">
              {SETTING_GROUPS.map((g) => (
                <a
                  key={g.id}
                  href={`#settings-${g.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(`settings-${g.id}`)?.scrollIntoView({ behavior: 'smooth' });
                  }}
                  className="shrink-0 rounded-full border border-border px-3 py-1 text-muted hover:border-muted hover:text-text"
                >
                  {g.label}
                </a>
              ))}
            </nav>
            <div className="space-y-5">
              {SETTING_GROUPS.map((g) => {
                const fields = SETTING_FIELDS.filter((f) => f.group === g.id && settingVisible(f, effective));
                return (
                  <Card
                    key={g.id}
                    className="scroll-mt-20 px-4 py-2"
                    id={`settings-${g.id}`}
                    data-testid={`settings-group-${g.id}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-3">
                      <div className="min-w-0">
                        <h2 className="font-semibold">{g.label}</h2>
                        <p className="text-[12px] text-muted">{g.help}</p>
                      </div>
                      {g.id === 'gateway' ? <TestButton target="gateway" values={draft} /> : null}
                      {g.id === 'storage' &&
                      (effective.RIDEO_STORAGE === 'webdav' || effective.RIDEO_WEBDAV_URL) ? (
                        <TestButton target="webdav" values={draft} />
                      ) : null}
                    </div>
                    <div className="divide-y divide-border">
                      {fields.map((f) => (
                        <FieldRow
                          key={f.env}
                          field={f}
                          view={view}
                          draft={draft}
                          error={errors[f.env]}
                          onChange={change}
                        />
                      ))}
                    </div>
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </main>
      {changes ? (
        <div
          className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-bg/95 px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur sm:px-6"
          data-testid="settings-savebar"
        >
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-end gap-2">
            <span className="mr-auto text-[13px] text-muted">
              {changes} unsaved change{changes === 1 ? '' : 's'}
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
