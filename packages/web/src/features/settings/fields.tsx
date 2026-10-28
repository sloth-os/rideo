import {
  BRAND_TOKENS,
  parseThemeJson,
  type SettingField,
  type SettingsView,
  type Theme,
} from '@rideo/shared';
import { Eye, EyeOff, KeyRound, Lock, RotateCcw, Undo2 } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import { Badge, Button, cx, Input, Select, Textarea } from '../../components/ui';
import { checkValue, type Draft, shown } from './model';

/** Help text with `code` shown as code. */
export function HelpText({ text, id, className }: { text: string; id?: string; className?: string }) {
  return (
    <span id={id} className={className}>
      {text.split('`').map((part, i) =>
        i % 2 ? (
          <code key={i} className="rounded bg-surface-2 px-1 py-px font-mono text-[11px] text-text">
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </span>
  );
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

/** A secret: never shown. A stored one reads *Set* with Replace and Remove; typing shows or hides. */
function SecretControl({
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
  const [editing, setEditing] = useState(false);
  const [reveal, setReveal] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const removing = field.env in draft && draft[field.env] === null;
  const typed = draft[field.env] ?? '';
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  // A save ends a replacement; a refresh of the same settings (the page polls while keys register) does not
  useEffect(() => setEditing(false), [view.updatedAt]);
  if (state?.locked)
    return (
      <div className="flex h-9 items-center gap-2 text-[13px] text-muted" data-testid="setting-secret-set">
        <KeyRound className="size-3.5" /> •••••••• set by the environment
      </div>
    );
  if (removing)
    return (
      <div className="flex min-h-9 flex-wrap items-center gap-2 text-[13px]">
        <Badge tone="warning" testid="setting-secret-removing">
          Removed when you save
        </Badge>
        <Button
          size="sm"
          variant="ghost"
          icon={<Undo2 className="size-3.5" />}
          onClick={() => onChange(field.env, '')}
          data-testid="setting-secret-undo"
        >
          Undo
        </Button>
      </div>
    );
  if (state?.set && !editing && !typed)
    return (
      <div className="flex min-h-9 flex-wrap items-center gap-2">
        <span className="flex items-center gap-2 text-[13px] text-muted" data-testid="setting-secret-set">
          <KeyRound className="size-3.5" /> ••••••••
          <Badge tone="success">Set</Badge>
        </span>
        <Button size="sm" onClick={() => setEditing(true)} data-testid="setting-secret-replace">
          Replace
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onChange(field.env, null)}
          data-testid="setting-secret-remove"
        >
          Remove
        </Button>
      </div>
    );
  return (
    <div className="flex items-center gap-1.5">
      <Input
        ref={input}
        name={field.env}
        id={`setting-${field.env}`}
        type={reveal ? 'text' : 'password'}
        autoComplete="new-password"
        spellCheck={false}
        value={typed}
        placeholder={state?.set ? 'The new value' : 'Not set'}
        aria-describedby={field.help ? `setting-${field.env}-help` : undefined}
        onChange={(e) => onChange(field.env, e.target.value)}
        className="min-w-0 flex-1 font-mono"
      />
      <button
        type="button"
        className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted hover:bg-surface-2 hover:text-text"
        onClick={() => setReveal((r) => !r)}
        aria-label={reveal ? 'Hide the value' : 'Show the value'}
        aria-pressed={reveal}
        data-testid="setting-secret-toggle"
      >
        {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
      {state?.set ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setEditing(false);
            onChange(field.env, '');
          }}
        >
          Cancel
        </Button>
      ) : null}
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
  const label = (o: string) => field.optionLabels?.[o] ?? o;
  switch (field.kind) {
    case 'select':
      return (
        <Select {...common} value={value} onChange={(e) => onChange(field.env, e.target.value || null)}>
          {field.options?.includes('') ? null : (
            <option value="">{`Default (${label(field.placeholder ?? '') || 'none'})`}</option>
          )}
          {field.options?.map((o) => (
            <option key={o} value={o}>
              {o === '' ? (field.optionLabels?.[''] ?? `Default (${field.placeholder ?? 'none'})`) : label(o)}
            </option>
          ))}
        </Select>
      );
    case 'secret':
      return <SecretControl field={field} view={view} draft={draft} onChange={onChange} />;
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
          type="text"
          inputMode={field.kind === 'number' ? 'decimal' : field.kind === 'url' ? 'url' : undefined}
          autoCapitalize="off"
          spellCheck={field.kind === 'text' ? undefined : false}
          value={value}
          placeholder={field.placeholder}
          onChange={(e) => onChange(field.env, e.target.value)}
        />
      );
  }
}

/** One setting: its label and variable, the control, its state, help, a check while typing and the server's error. */
export function FieldRow({
  field,
  view,
  draft,
  error,
  onChange,
  layout = 'row',
  label,
  extra,
}: {
  field: SettingField;
  view: SettingsView;
  draft: Draft;
  error?: string;
  onChange: (env: string, value: string | null) => void;
  /** `stacked`: the label above the control (cards, search results on phones). */
  layout?: 'row' | 'stacked';
  label?: string;
  extra?: ReactNode;
}) {
  const state = view.fields[field.env];
  if (!state) return null;
  const dirty = field.env in draft;
  const check = field.kind === 'secret' ? null : checkValue(field, shown(view, draft, field.env));
  return (
    <div
      className={cx(
        'grid grid-cols-1 content-start gap-1.5',
        layout === 'row' ? 'py-3 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:gap-4' : 'py-2',
      )}
      data-testid={`setting-${field.env}`}
      data-source={state.source}
      data-locked={state.locked ? 'true' : 'false'}
      data-dirty={dirty ? 'true' : 'false'}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <label htmlFor={`setting-${field.env}`} className="text-[13px] font-medium">
          {label ?? field.label}
        </label>
        <code className="max-w-full truncate text-[11px] text-muted" title={field.env}>
          {field.env}
        </code>
      </div>
      <div className="min-w-0 space-y-1">
        <Control field={field} view={view} draft={draft} onChange={onChange} />
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
          {state.locked ? (
            <Badge tone="info" testid="setting-locked">
              <Lock className="size-3" /> set by the environment
            </Badge>
          ) : state.source === 'settings' && !dirty && field.kind !== 'secret' ? (
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
          {field.help ? <HelpText text={field.help} id={`setting-${field.env}-help`} /> : null}
          {extra}
        </div>
        {check && !error ? (
          <p className="text-[12px] text-warning" data-testid="setting-check">
            Should be {check}
          </p>
        ) : null}
        {error ? (
          <p className="text-[12px] text-danger" role="alert" data-testid="setting-error">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
