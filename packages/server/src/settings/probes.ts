import {
  type EndpointStatus,
  type SettingEndpointId,
  type SettingsTestResult,
  settingEndpoint,
} from '@rideo/shared';
import { EmbeddingsClient } from '../ai/embeddings';
import { createAdapter, LlmError, SttClient } from '../ai/llm';
import type { Config } from '../config';
import type { ProxyClient } from '../gateway/proxy-client';
import type { GatewayProxies } from '../gateway/proxy-sync';

/**
 * Endpoint statuses and tests of the Settings page (docs/design/settings.md#endpoint-status-and-tests): how each AI
 * endpoint is reached, and the smallest real call to it through the gateway proxy.
 */

const OFF = (
  detail: string | null,
): Omit<EndpointStatus, 'on' | 'provider' | 'url' | 'domain' | 'model'> => ({
  key: 'none',
  keyFrom: null,
  proxy: 'off',
  detail,
});

export function endpointStatus(
  config: Config,
  proxies: GatewayProxies,
  id: SettingEndpointId,
): EndpointStatus {
  const ep = config.endpoints[id];
  if (!ep) return { on: false, provider: null, url: null, domain: null, model: null, ...OFF(null) };
  const base = { provider: ep.provider, url: ep.url, domain: ep.base.domain, model: ep.model };
  const key = ep.apiKey ? (ep.keyFrom ? 'shared' : 'own') : 'none';
  const keyFrom = ep.keyFrom ?? null;
  if (!config.gateway.configured)
    return { on: false, ...base, ...OFF('Connect mm-gateway first'), key, keyFrom };
  const sync = proxies.state;
  if (key !== 'none') {
    const settled = proxies.domainState(ep.base.domain);
    if (sync.status === 'pending' && !settled)
      return { on: true, ...base, key, keyFrom, proxy: 'pending', detail: null };
    if (settled?.state === 'registered')
      return { on: true, ...base, key, keyFrom, proxy: 'registered', detail: null };
    if (settled?.state === 'conflict')
      return { on: true, ...base, key, keyFrom, proxy: 'conflict', detail: settled.detail };
    if (sync.status === 'failed')
      return { on: true, ...base, key, keyFrom, proxy: 'failed', detail: sync.detail };
    return { on: true, ...base, key, keyFrom, proxy: 'pending', detail: null };
  }
  const has = proxies.gatewayHas(ep.base.domain);
  if (has === true) return { on: true, ...base, key, keyFrom, proxy: 'gateway', detail: null };
  if (has === false)
    return {
      on: true,
      ...base,
      key,
      keyFrom,
      proxy: 'missing',
      detail: `mm-gateway has no proxy for ${ep.base.domain}: set an API key here, or add the proxy in mm-gateway`,
    };
  return { on: true, ...base, key, keyFrom, proxy: 'unknown', detail: null };
}

/** Half a second of 16 kHz mono silence as WAV (a speech-to-text test clip). */
export function silentWav(seconds = 0.5, rate = 16_000): Buffer {
  const samples = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

/** A failed call through the proxy, said plainly: the gateway's own refusals apart from the provider's. */
export function describeProxyFailure(status: number | undefined, body: string, domain: string): string {
  type Problem = { type?: string; code?: string; detail?: string };
  let problem: Problem | null = null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === 'object') problem = parsed as Problem;
  } catch {
    // not JSON: the provider's own answer
  }
  if (problem?.type?.startsWith('urn:mm-gateway:problem:')) {
    switch (problem.code) {
      case 'unauthorized':
        return 'mm-gateway refused the studio’s gateway key';
      case 'forbidden':
        return `The studio’s gateway key may not use mm-gateway’s proxy for ${domain}`;
      case 'generation_service_not_found':
      case 'provider_not_found':
      case 'not_found':
        return `mm-gateway has no proxy for ${domain}: set an API key here, or add the proxy in mm-gateway`;
      case 'provider_not_configured':
        return `mm-gateway’s proxy for ${domain} has no account: set an API key here`;
      default:
        return `mm-gateway answered ${status}: ${problem.detail ?? problem.code}`;
    }
  }
  if (status === 401 || status === 403) return `The provider refused the key (${status})`;
  if (status === 404) return 'The provider answered 404: check the API base URL and the model';
  return `The provider answered ${status ?? 'nothing'}${body ? `: ${body.slice(0, 200)}` : ''}`;
}

const seconds = (ms: number) =>
  ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;

/** The smallest real call to an endpoint through the gateway proxy, with the saved settings. */
export async function probeEndpoint(
  config: Config,
  proxy: ProxyClient,
  id: SettingEndpointId,
): Promise<SettingsTestResult> {
  const label = settingEndpoint(id).label;
  const ep = config.endpoints[id];
  if (!config.gateway.configured) return { ok: false, detail: 'Connect mm-gateway first' };
  if (!ep) return { ok: false, detail: `${label} is off` };
  const api = { domain: ep.base.domain, prefix: ep.base.prefix };
  const started = Date.now();
  const done = (detail: string): SettingsTestResult => ({
    ok: true,
    detail,
    latencyMs: Date.now() - started,
  });
  try {
    switch (id) {
      case 'llm':
      case 'vision':
      case 'voiceJudge': {
        const adapter = createAdapter(proxy, {
          ...api,
          provider: ep.provider as 'openai' | 'gemini' | 'anthropic',
          model: ep.model,
        });
        const res = await adapter.complete({
          system: 'rideo-task: settings.test\nReply with the single word OK.',
          parts: [{ type: 'text', text: 'Reply with OK.' }],
          json: false,
          temperature: 0,
          maxTokens: 16,
          signal: AbortSignal.timeout(60_000),
        });
        const said = res.text.trim().replace(/\s+/g, ' ').slice(0, 40);
        return done(`${ep.model} answered in ${seconds(Date.now() - started)}${said ? `: “${said}”` : ''}`);
      }
      case 'stt': {
        await new SttClient(proxy, api, ep.model).transcribe(
          silentWav(),
          'rideo-test.wav',
          AbortSignal.timeout(60_000),
        );
        return done(`${ep.model} transcribed a test clip in ${seconds(Date.now() - started)}`);
      }
      case 'embeddings': {
        const [vector] = await new EmbeddingsClient(proxy, api, ep.model).embed(
          ['rideo'],
          AbortSignal.timeout(60_000),
        );
        return done(
          `${ep.model} answered with ${vector?.length ?? 0} dimensions in ${seconds(Date.now() - started)}`,
        );
      }
      case 'tts':
      case 'sfx': {
        const res = await proxy.fetch(api, 'v1/models', { timeoutMs: 30_000 });
        const body = await res.text();
        if (!res.ok) return { ok: false, detail: describeProxyFailure(res.status, body, ep.base.domain) };
        let ids: string[] = [];
        try {
          const parsed = JSON.parse(body) as { data?: { id?: string }[] } | { model_id?: string }[];
          ids = (
            Array.isArray(parsed) ? parsed.map((m) => m.model_id) : (parsed.data ?? []).map((m) => m.id)
          ).filter((m): m is string => !!m);
        } catch {
          // a list we cannot read still proves the key works
        }
        return done(
          ids.length && !ids.includes(ep.model)
            ? `Connected in ${seconds(Date.now() - started)}, but the API does not list ${ep.model}`
            : `Connected in ${seconds(Date.now() - started)}: ${ep.model} is available`,
        );
      }
    }
  } catch (err) {
    if (err instanceof LlmError)
      return { ok: false, detail: describeProxyFailure(err.status, err.body ?? '', ep.base.domain) };
    return { ok: false, detail: `${label}: ${(err as Error).message}` };
  }
}
