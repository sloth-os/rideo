import {
  apiBaseProblem,
  type EndpointStatus,
  endpointOfSetting,
  type ResolvedEndpoints,
  resolveEndpoints,
  SETTING_ENDPOINTS,
  SETTING_FIELDS,
  SETTING_GROUPS,
  type SettingEndpointId,
  type SettingField,
  type SettingGroupId,
  type SettingsView,
  settingVisible,
} from '@rideo/shared';

/**
 * The Settings page's pure logic (docs/design/settings.md#the-settings-page): effective values with unsaved changes,
 * which changes count, search, what needs attention per section, and the checks made while typing.
 */

/** A change in the form: a string sets, null clears back to the default. */
export type Draft = Record<string, string | null>;

const GROUP_IDS = new Set<string>(SETTING_GROUPS.map((g) => g.id));

/** The section a URL hash opens: `#ai`, or the older `#settings-ai`. */
export function groupFromHash(hash: string): SettingGroupId | null {
  const id = decodeURIComponent(hash.replace(/^#/, '')).replace(/^settings-/, '');
  return GROUP_IDS.has(id) ? (id as SettingGroupId) : null;
}

/** The value a field shows: the draft, else the stored or environment value ('' when unset or a secret). */
export function shown(view: SettingsView, draft: Draft, env: string): string {
  if (env in draft) return draft[env] ?? '';
  return view.fields[env]?.value ?? '';
}

/** Every setting's effective value with the draft applied (secrets: a marker when one is set or typed). */
export function effectiveValues(view: SettingsView, draft: Draft): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of SETTING_FIELDS) {
    if (f.kind === 'secret') {
      const typed = draft[f.env];
      const set = f.env in draft ? typed !== null && typed !== '' : !!view.fields[f.env]?.set;
      out[f.env] = set ? 'set' : null;
      continue;
    }
    out[f.env] = shown(view, draft, f.env) || null;
  }
  return out;
}

/** The endpoints as the draft would make them (what the cards say they call, and whose key they use). */
export function draftEndpoints(values: Record<string, string | null>): ResolvedEndpoints {
  const v: Record<string, string> = {};
  for (const [k, x] of Object.entries(values)) if (x) v[k] = x;
  return resolveEndpoints(v, { gateway: true });
}

/**
 * The draft after a change. Back to what is stored is no change; secrets are never shown, so for them only typing
 * nothing is no change (null removes a stored one).
 */
export function applyChange(view: SettingsView, draft: Draft, env: string, value: string | null): Draft {
  const field = SETTING_FIELDS.find((f) => f.env === env);
  const stored = view.fields[env];
  const next = { ...draft };
  const same =
    field?.kind === 'secret'
      ? value === '' || (value === null && !stored?.set)
      : (value ?? '') === (stored?.value ?? '');
  if (same && !(value === null && stored?.source === 'settings' && field?.kind !== 'secret'))
    delete next[env];
  else next[env] = value;
  return next;
}

/** The label a field reads as out of its card (search results): "Text model · API key". */
export function fullLabel(field: SettingField): string {
  const ep = endpointOfSetting(field.env);
  return ep ? `${ep.label} · ${field.label}` : field.label;
}

/** Whether a field matches a search: its label, card, variable, help, options or section. */
export function matches(field: SettingField, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const group = SETTING_GROUPS.find((g) => g.id === field.group)?.label ?? '';
  const hay = [
    fullLabel(field),
    field.env,
    field.help ?? '',
    group,
    ...(field.options ?? []),
    ...Object.values(field.optionLabels ?? {}),
  ]
    .join('\n')
    .toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

/** The fields of a section that show with these values. */
export function visibleFields(group: SettingGroupId, values: Record<string, string | null>): SettingField[] {
  return SETTING_FIELDS.filter((f) => f.group === group && settingVisible(f, values));
}

/** An endpoint status that needs a person: a missing proxy, a conflict, a failed registration. */
export function needsAttention(status: EndpointStatus | undefined): boolean {
  return !!status?.on && ['missing', 'conflict', 'failed'].includes(status.proxy);
}

/** Per section: unsaved changes, and whether something in it needs attention. */
export function sectionStates(
  view: SettingsView,
  draft: Draft,
  errors: Record<string, string>,
): Record<SettingGroupId, { changes: number; attention: boolean }> {
  const out = {} as Record<SettingGroupId, { changes: number; attention: boolean }>;
  for (const g of SETTING_GROUPS) {
    const fields = SETTING_FIELDS.filter((f) => f.group === g.id);
    const endpoints = SETTING_ENDPOINTS.filter((e) => e.group === g.id);
    out[g.id] = {
      changes: fields.filter((f) => f.env in draft).length,
      attention:
        fields.some((f) => errors[f.env]) ||
        endpoints.some((e) => needsAttention(view.endpoints[e.id])) ||
        (g.id === 'gateway' && view.proxySync.status === 'failed'),
    };
  }
  return out;
}

/** The AI endpoints in one line for the status row. */
export function aiSummary(view: SettingsView): { value: string; tone: 'success' | 'warning' | 'neutral' } {
  if (!view.gateway) return { value: 'Off until mm-gateway is connected', tone: 'neutral' };
  const on = SETTING_ENDPOINTS.map((e) => view.endpoints[e.id]).filter((s) => s?.on);
  const attention = on.filter(needsAttention).length;
  if (attention)
    return { value: `${attention} need${attention === 1 ? 's' : ''} attention`, tone: 'warning' };
  return { value: `${on.length} endpoint${on.length === 1 ? '' : 's'} ready`, tone: 'success' };
}

const HTTP_URL = /^https?:\/\/[^\s/]+/i;
/** The URL settings the server checks (EnvSchema), checked as they are typed too. */
const CHECKED_URLS = new Set([
  'MM_GATEWAY_URL',
  'RIDEO_WEBDAV_URL',
  'RIDEO_OIDC_ISSUER',
  'RIDEO_C2PA_TSA_URL',
]);

/** What is wrong with a value as it is typed (the server's validation stays the authority). */
export function checkValue(field: SettingField, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (field.kind === 'number' && !Number.isFinite(Number(v))) return 'a number';
  if (endpointOfSetting(field.env)?.url === field.env) return apiBaseProblem(v);
  if (CHECKED_URLS.has(field.env) && !HTTP_URL.test(v)) return 'an http:// or https:// URL';
  return null;
}

/** The first section with a refused field (opened after a refused save). */
export function firstGroupWithError(errors: Record<string, string>): SettingGroupId | null {
  for (const g of SETTING_GROUPS)
    if (SETTING_FIELDS.some((f) => f.group === g.id && errors[f.env])) return g.id;
  return null;
}

/** The endpoint's fields in the draft (a card with unsaved changes asks to save before testing). */
export function endpointDirty(id: SettingEndpointId, draft: Draft): boolean {
  const e = SETTING_ENDPOINTS.find((x) => x.id === id)!;
  return [e.provider, e.url, e.key, e.model].some((env) => !!env && env in draft);
}
