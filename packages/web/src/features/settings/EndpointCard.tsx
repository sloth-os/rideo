import {
  type EndpointStatus,
  type ResolvedEndpoints,
  type SettingEndpoint,
  type SettingEndpointId,
  type SettingsTestResult,
  type SettingsView,
  settingEndpoint,
  settingField,
  settingVisible,
  withPrefix,
} from '@rideo/shared';
import {
  AudioWaveform,
  Captions,
  MessageSquareText,
  Mic,
  PlugZap,
  ScanEye,
  Search,
  UserCheck,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Badge, Button, Card, cx, type Tone } from '../../components/ui';
import { api } from '../../lib/api';
import { reportError } from '../../store/ui';
import { FieldRow, HelpText } from './fields';
import { type Draft, endpointDirty } from './model';

const ICONS: Record<SettingEndpointId, ReactNode> = {
  llm: <MessageSquareText className="size-4" />,
  vision: <ScanEye className="size-4" />,
  stt: <Captions className="size-4" />,
  embeddings: <Search className="size-4" />,
  tts: <Mic className="size-4" />,
  sfx: <AudioWaveform className="size-4" />,
  voiceJudge: <UserCheck className="size-4" />,
};

const STATUS: Record<EndpointStatus['proxy'], { label: string; tone: Tone }> = {
  off: { label: 'Off', tone: 'neutral' },
  registered: { label: 'Key registered in mm-gateway', tone: 'success' },
  gateway: { label: 'Uses mm-gateway’s account', tone: 'success' },
  missing: { label: 'No proxy in mm-gateway', tone: 'warning' },
  unknown: { label: 'Through mm-gateway', tone: 'neutral' },
  pending: { label: 'Registering…', tone: 'info' },
  conflict: { label: 'Conflict in mm-gateway', tone: 'danger' },
  failed: { label: 'Key not registered', tone: 'danger' },
};

/** What a call looks like with the draft: the URL, and the proxy it goes through. */
function callsLine(endpoint: SettingEndpoint, resolved: ResolvedEndpoints): string | null {
  const ep = resolved[endpoint.id];
  if (!ep) return null;
  const path = (endpoint.paths[ep.provider] ?? '')
    .replace('{model}', ep.model || 'model')
    .replace('{voice}', '…');
  return `${ep.base.origin}/${withPrefix(path, ep.base.prefix)}`;
}

/**
 * One AI endpoint (docs/design/settings.md#the-settings-page): provider, model, API base URL and API key together,
 * what the studio will call, how it is reached and a test of the saved settings.
 */
export function EndpointCard({
  endpoint,
  view,
  draft,
  values,
  resolved,
  errors,
  onChange,
}: {
  endpoint: SettingEndpoint;
  view: SettingsView;
  draft: Draft;
  values: Record<string, string | null>;
  resolved: ResolvedEndpoints;
  errors: Record<string, string>;
  onChange: (env: string, value: string | null) => void;
}) {
  const status = view.endpoints[endpoint.id];
  const dirty = endpointDirty(endpoint.id, draft);
  const [result, setResult] = useState<SettingsTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  // A new view (saved settings) makes the last test stale
  useEffect(() => setResult(null), [view]);
  const field = (env: string | undefined) => {
    const f = env ? settingField(env) : undefined;
    return f && settingVisible(f, values) ? f : undefined;
  };
  const [provider, model, url, key] = [endpoint.provider, endpoint.model, endpoint.url, endpoint.key].map(
    field,
  );
  // With a provider: provider and model, then the base URL and the key. Without: the base URL turns it on.
  const layout = endpoint.provider ? [[provider, model], [url], [key]] : [[url], [model, key]];
  const calls = callsLine(endpoint, resolved);
  const ep = resolved[endpoint.id];
  const shared = ep?.keyFrom ? settingEndpoint(ep.keyFrom).label.toLowerCase() : null;
  const badge = dirty
    ? { label: 'Unsaved: save to apply', tone: 'warning' as Tone }
    : STATUS[status?.proxy ?? 'off'];
  const testable = !!status?.on && !dirty;
  const row = (f: NonNullable<ReturnType<typeof field>>) => (
    <FieldRow
      key={f.env}
      field={f}
      view={view}
      draft={draft}
      error={errors[f.env]}
      onChange={onChange}
      layout="stacked"
      extra={
        f.env === endpoint.key && shared && !(f.env in draft) && !view.fields[f.env]?.set ? (
          <span className="text-info" data-testid={`settings-endpoint-${endpoint.id}-shared`}>
            Uses the {shared}’s key
          </span>
        ) : undefined
      }
    />
  );
  return (
    <Card
      className="px-4 py-3"
      data-testid={`settings-endpoint-${endpoint.id}`}
      data-status={status?.proxy ?? 'off'}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
          {ICONS[endpoint.id]}
        </span>
        <h3 className="mr-auto min-w-0 font-semibold">{endpoint.label}</h3>
        <span
          data-testid={`settings-endpoint-${endpoint.id}-status`}
          data-status={dirty ? 'unsaved' : status?.proxy}
        >
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </span>
        <Button
          size="sm"
          icon={<PlugZap className="size-3.5" />}
          loading={busy}
          disabled={!testable}
          title={
            dirty
              ? 'Save first: tests use the saved settings'
              : status?.on
                ? undefined
                : (status?.detail ?? 'Turned off')
          }
          onClick={async () => {
            setBusy(true);
            setResult(null);
            try {
              setResult(await api.testSettings(endpoint.id));
            } catch (err) {
              reportError(err);
            } finally {
              setBusy(false);
            }
          }}
          data-testid={`settings-endpoint-${endpoint.id}-test`}
        >
          Test
        </Button>
      </div>
      <p className="mt-1 text-[12px] text-muted">
        <HelpText text={endpoint.help} />
      </p>
      {layout.map((line) => {
        const shownFields = line.filter((f) => !!f).map((f) => f!);
        if (!shownFields.length) return null;
        return (
          <div
            key={shownFields.map((f) => f.env).join()}
            className={cx('grid grid-cols-1 gap-x-4', line.length > 1 && 'md:grid-cols-2')}
          >
            {shownFields.map(row)}
          </div>
        );
      })}
      {calls ? (
        <p
          className="mt-1 break-all text-[12px] text-muted"
          data-testid={`settings-endpoint-${endpoint.id}-calls`}
        >
          Calls <code className="font-mono text-text">{calls}</code> through mm-gateway’s proxy{' '}
          <code className="font-mono text-text">{ep?.base.domain}</code>
        </p>
      ) : null}
      {!dirty && status?.detail && status.proxy !== 'off' ? (
        <p
          className={cx('mt-1 text-[12px]', status.proxy === 'missing' ? 'text-warning' : 'text-danger')}
          data-testid={`settings-endpoint-${endpoint.id}-detail`}
        >
          {status.detail}
        </p>
      ) : null}
      {result ? (
        <p
          className={cx('mt-1 text-[12px]', result.ok ? 'text-success' : 'text-danger')}
          role="status"
          data-testid={`settings-endpoint-${endpoint.id}-result`}
          data-ok={result.ok ? 'true' : 'false'}
        >
          {result.detail}
        </p>
      ) : null}
    </Card>
  );
}
