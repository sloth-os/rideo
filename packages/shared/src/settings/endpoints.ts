import { z } from 'zod';

/**
 * The AI endpoints reached through the mm-gateway proxy and the provider APIs they speak
 * (docs/design/settings.md#provider-endpoints-and-api-keys): declared once, as data. The Settings page draws one card
 * per endpoint from this table; the server derives the endpoints, their API keys and the gateway proxies the studio
 * registers from it.
 */

export interface ProviderApi {
  label: string;
  /** The API's domain when no base URL is given. */
  domain: string;
  /** The API version segment the adapters' paths start with. */
  version: string;
  /** The header the API reads its key from, and what precedes the key in it. */
  header: string;
  scheme: string;
}

export const PROVIDER_APIS = {
  openai: {
    label: 'OpenAI or compatible',
    domain: 'api.openai.com',
    version: 'v1',
    header: 'authorization',
    scheme: 'Bearer ',
  },
  gemini: {
    label: 'Google Gemini',
    domain: 'generativelanguage.googleapis.com',
    version: 'v1beta',
    header: 'x-goog-api-key',
    scheme: '',
  },
  anthropic: {
    label: 'Anthropic',
    domain: 'api.anthropic.com',
    version: 'v1',
    header: 'x-api-key',
    scheme: '',
  },
  elevenlabs: {
    label: 'ElevenLabs',
    domain: 'api.elevenlabs.io',
    version: 'v1',
    header: 'xi-api-key',
    scheme: '',
  },
} as const satisfies Record<string, ProviderApi>;
export type ProviderApiId = keyof typeof PROVIDER_APIS;

/** The header carrying a key for a provider's API (an account of a gateway proxy). */
export function credentialHeaders(provider: ProviderApiId, key: string): Record<string, string> {
  const api = PROVIDER_APIS[provider];
  return { [api.header]: `${api.scheme}${key}` };
}

export const SETTING_ENDPOINT_IDS = [
  'llm',
  'vision',
  'omni',
  'stt',
  'embeddings',
  'tts',
  'sfx',
  'voiceJudge',
  // Fallbacks for an endpoint that is paused or overloaded (docs/design/ai-gateway.md#outages)
  'llmFallback',
  'visionFallback',
  'omniFallback',
] as const;
export type SettingEndpointId = (typeof SETTING_ENDPOINT_IDS)[number];
export const SettingEndpointIdSchema = z.enum(SETTING_ENDPOINT_IDS);

export interface SettingEndpoint {
  id: SettingEndpointId;
  group: 'ai' | 'audio';
  label: string;
  /** How other cards name it (“the text fallback’s key”); the label in lower case when unset. */
  short?: string;
  /** What the studio uses it for. */
  help: string;
  /** The provider select; endpoints without one speak `fixedProvider`'s API. */
  provider?: string;
  fixedProvider?: ProviderApiId;
  /** The provider when the select is empty: OpenAI's API, or the parent endpoint's (`inherits`). */
  providerFrom?: 'openai' | 'parent';
  /** The API base URL (or just its domain), its key and the model. */
  url: string;
  key: string;
  model: string;
  /** Provider, base URL and model left empty come from this endpoint (when the provider matches). */
  inherits?: SettingEndpointId;
  /** Off while the base URL is empty (optional endpoints). */
  needsUrl?: boolean;
  /** Off while the model is empty: no provider has a default, and the parent's model may not take its input. */
  needsModel?: boolean;
  /** What a call looks like, per provider (the card shows it). */
  paths: Partial<Record<ProviderApiId, string>>;
  /** The model when none is set, per provider. */
  models: Partial<Record<ProviderApiId, string>>;
}

const CHAT_PATHS = {
  openai: 'v1/chat/completions',
  gemini: 'v1beta/models/{model}:generateContent',
  anthropic: 'v1/messages',
} as const;

export const SETTING_ENDPOINTS: readonly SettingEndpoint[] = [
  {
    id: 'llm',
    group: 'ai',
    label: 'Text model',
    help: 'Writes screenplays, plans shots and scores, translates dialogue.',
    provider: 'RIDEO_LLM_PROVIDER',
    providerFrom: 'openai',
    url: 'RIDEO_LLM_PROXY_DOMAIN',
    key: 'RIDEO_LLM_API_KEY',
    model: 'RIDEO_LLM_MODEL',
    paths: CHAT_PATHS,
    models: { openai: 'gpt-4.1-mini', gemini: 'gpt-4.1-mini', anthropic: 'gpt-4.1-mini' },
  },
  {
    id: 'vision',
    group: 'ai',
    label: 'Vision',
    help: 'Reads attachments and footage, judges every take’s consistency, captions frames for search.',
    provider: 'RIDEO_VISION_PROVIDER',
    providerFrom: 'parent',
    url: 'RIDEO_VISION_PROXY_DOMAIN',
    key: 'RIDEO_VISION_API_KEY',
    model: 'RIDEO_VISION_MODEL',
    inherits: 'llm',
    paths: CHAT_PATHS,
    models: {},
  },
  {
    id: 'omni',
    group: 'ai',
    label: 'Audio-visual model',
    help: 'Watches video with its sound: checks that every take speaks its lines, and listens to the finished film for feedback.',
    provider: 'RIDEO_OMNI_PROVIDER',
    // Audio input: Anthropic models do not take it (no path)
    providerFrom: 'parent',
    url: 'RIDEO_OMNI_PROXY_DOMAIN',
    key: 'RIDEO_OMNI_API_KEY',
    model: 'RIDEO_OMNI_MODEL',
    inherits: 'vision',
    needsModel: true,
    paths: { openai: CHAT_PATHS.openai, gemini: CHAT_PATHS.gemini },
    models: {},
  },
  {
    id: 'stt',
    group: 'ai',
    label: 'Speech-to-text',
    help: 'Transcripts of footage, with the word timings transcript editing uses.',
    fixedProvider: 'openai',
    url: 'RIDEO_STT_PROXY_DOMAIN',
    key: 'RIDEO_STT_API_KEY',
    model: 'RIDEO_STT_MODEL',
    needsUrl: true,
    paths: { openai: 'v1/audio/transcriptions' },
    models: { openai: 'whisper-1' },
  },
  {
    id: 'embeddings',
    group: 'ai',
    label: 'Embeddings',
    help: 'Media search by meaning: captions of frames compared as embeddings.',
    fixedProvider: 'openai',
    url: 'RIDEO_EMBEDDINGS_PROXY_DOMAIN',
    key: 'RIDEO_EMBEDDINGS_API_KEY',
    model: 'RIDEO_EMBEDDINGS_MODEL',
    needsUrl: true,
    paths: { openai: 'v1/embeddings' },
    models: { openai: 'text-embedding-3-small' },
  },
  {
    id: 'tts',
    group: 'audio',
    label: 'Dialogue voices',
    help: 'Designed and cloned character voices speaking the dialogue.',
    provider: 'RIDEO_TTS_PROVIDER',
    url: 'RIDEO_TTS_PROXY_DOMAIN',
    key: 'RIDEO_TTS_API_KEY',
    model: 'RIDEO_TTS_MODEL',
    paths: { elevenlabs: 'v1/text-to-speech/{voice}', openai: 'v1/audio/speech' },
    models: { elevenlabs: 'eleven_multilingual_v2', openai: 'gpt-4o-mini-tts' },
  },
  {
    id: 'sfx',
    group: 'audio',
    label: 'Sound effects',
    help: 'Effects generated from the action lines.',
    provider: 'RIDEO_SFX_PROVIDER',
    url: 'RIDEO_SFX_PROXY_DOMAIN',
    key: 'RIDEO_SFX_API_KEY',
    model: 'RIDEO_SFX_MODEL',
    paths: { elevenlabs: 'v1/sound-generation' },
    models: { elevenlabs: 'eleven_text_to_sound_v2' },
  },
  {
    id: 'voiceJudge',
    group: 'audio',
    label: 'Speaker check',
    help: 'An audio-capable model that checks who speaks in takes with native dialogue.',
    provider: 'RIDEO_VOICE_JUDGE_PROVIDER',
    providerFrom: 'parent',
    url: 'RIDEO_VOICE_JUDGE_PROXY_DOMAIN',
    key: 'RIDEO_VOICE_JUDGE_API_KEY',
    model: 'RIDEO_VOICE_JUDGE_MODEL',
    inherits: 'vision',
    paths: { openai: CHAT_PATHS.openai, gemini: CHAT_PATHS.gemini },
    models: { openai: 'gpt-4o-audio-preview', gemini: 'gemini-2.5-flash' },
  },
  {
    id: 'llmFallback',
    group: 'ai',
    label: 'Text model, fallback',
    short: 'text fallback',
    help: 'Takes the text model’s calls while it is paused or overloaded (another provider).',
    provider: 'RIDEO_LLM_FALLBACK_PROVIDER',
    providerFrom: 'openai',
    url: 'RIDEO_LLM_FALLBACK_PROXY_DOMAIN',
    key: 'RIDEO_LLM_FALLBACK_API_KEY',
    model: 'RIDEO_LLM_FALLBACK_MODEL',
    needsUrl: true,
    needsModel: true,
    paths: CHAT_PATHS,
    models: {},
  },
  {
    id: 'visionFallback',
    group: 'ai',
    label: 'Vision, fallback',
    short: 'vision fallback',
    help: 'Takes the judge’s and the other vision calls while vision is paused or overloaded.',
    provider: 'RIDEO_VISION_FALLBACK_PROVIDER',
    providerFrom: 'parent',
    url: 'RIDEO_VISION_FALLBACK_PROXY_DOMAIN',
    key: 'RIDEO_VISION_FALLBACK_API_KEY',
    model: 'RIDEO_VISION_FALLBACK_MODEL',
    inherits: 'llmFallback',
    paths: CHAT_PATHS,
    models: {},
  },
  {
    id: 'omniFallback',
    group: 'ai',
    label: 'Audio-visual model, fallback',
    short: 'audio-visual fallback',
    help: 'Takes the sound checks and the listening while the audio-visual model is paused or overloaded.',
    provider: 'RIDEO_OMNI_FALLBACK_PROVIDER',
    providerFrom: 'parent',
    url: 'RIDEO_OMNI_FALLBACK_PROXY_DOMAIN',
    key: 'RIDEO_OMNI_FALLBACK_API_KEY',
    model: 'RIDEO_OMNI_FALLBACK_MODEL',
    inherits: 'visionFallback',
    needsModel: true,
    paths: { openai: CHAT_PATHS.openai, gemini: CHAT_PATHS.gemini },
    models: {},
  },
];

export function settingEndpoint(id: SettingEndpointId): SettingEndpoint {
  return SETTING_ENDPOINTS.find((e) => e.id === id)!;
}

/** The endpoint a setting belongs to (its card on the Settings page). */
export function endpointOfSetting(env: string): SettingEndpoint | undefined {
  return SETTING_ENDPOINTS.find((e) => [e.provider, e.url, e.key, e.model].includes(env));
}

/** Where an API is: the gateway proxy's domain, the origin it is registered at, and the path standing for the version. */
export interface ApiBase {
  domain: string;
  origin: string;
  /** Replaces the version segment of the adapters' paths (`v1`, `api/v3`); null keeps the provider's. */
  prefix: string | null;
}

const BARE_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;

/**
 * An API base URL as the provider documents it (`https://api.openai.com/v1`) or just its domain (`api.openai.com`)
 * (docs/design/settings.md#api-base-url); null when it is neither.
 */
export function parseApiBase(raw: string): ApiBase | null {
  const value = raw.trim();
  if (!value) return null;
  if (BARE_HOST.test(value)) {
    const host = value.toLowerCase();
    return { domain: host.replace(/:\d+$/, ''), origin: `https://${host}`, prefix: null };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash || !url.hostname) return null;
  // The URL parser has resolved dot segments already
  const path = url.pathname.replace(/^\/+|\/+$/g, '');
  return { domain: url.hostname.toLowerCase(), origin: url.origin, prefix: path || null };
}

/** Why a base URL is refused, for the field (null when it parses or is empty). */
export function apiBaseProblem(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  return parseApiBase(raw)
    ? null
    : 'an API base URL like https://api.openai.com/v1 (no credentials, query or fragment), or just its domain';
}

/** An adapter's path through a base URL: the base URL's path replaces the version segment. */
export function withPrefix(path: string, prefix: string | null | undefined): string {
  const clean = path.replace(/^\/+/, '');
  if (!prefix) return clean;
  const rest = clean.includes('/') ? clean.slice(clean.indexOf('/') + 1) : '';
  return rest ? `${prefix}/${rest}` : prefix;
}

/** One endpoint as the studio uses it. */
export interface ResolvedEndpoint {
  id: SettingEndpointId;
  provider: ProviderApiId;
  base: ApiBase;
  /** The base URL calls go to: the origin and the version path. */
  url: string;
  model: string;
  apiKey?: string;
  /** The endpoint whose key it shares (same origin), when it has none of its own. */
  keyFrom?: SettingEndpointId;
}

export type ResolvedEndpoints = Record<SettingEndpointId, ResolvedEndpoint | null>;

type Values = Readonly<Record<string, string | undefined>>;
const isProvider = (v: string | undefined): v is ProviderApiId => !!v && v in PROVIDER_APIS;

/**
 * Every endpoint from the settings' effective values (the environment over the settings file; empty is unset): null
 * when it is off. Provider, base URL and model fall back along `inherits` when the provider matches, keys are shared
 * by endpoints with the same origin. Without a gateway every endpoint but the text and vision models is off.
 */
export function resolveEndpoints(values: Values, opts: { gateway: boolean }): ResolvedEndpoints {
  const v = (env: string | undefined) => (env && values[env]?.trim() ? values[env]!.trim() : undefined);
  const out = {} as ResolvedEndpoints;
  for (const e of SETTING_ENDPOINTS) {
    const parent = e.inherits ? out[e.inherits] : null;
    const chosen = v(e.provider);
    let provider: ProviderApiId | undefined;
    if (e.fixedProvider) provider = e.fixedProvider;
    else if (chosen === 'off') provider = undefined;
    else if (isProvider(chosen)) provider = chosen;
    else if (e.providerFrom === 'openai') provider = 'openai';
    // The speaker check and the audio-visual models need audio input, which Anthropic models do not take (no path)
    else if (e.providerFrom === 'parent') provider = parent?.provider;
    if (!provider || !e.paths[provider] || (e.needsModel && !v(e.model))) {
      out[e.id] = null;
      continue;
    }
    const sameAsParent = !!parent && parent.provider === provider;
    const rawUrl = v(e.url);
    if (e.needsUrl && !rawUrl) {
      out[e.id] = null;
      continue;
    }
    const base =
      (rawUrl ? parseApiBase(rawUrl) : null) ??
      (sameAsParent ? parent.base : parseApiBase(PROVIDER_APIS[provider].domain)!);
    const model = v(e.model) ?? e.models[provider] ?? parent?.model ?? '';
    // No model, no endpoint: a fallback with no model of its own and none to inherit is off
    if (!model) {
      out[e.id] = null;
      continue;
    }
    out[e.id] = {
      id: e.id,
      provider,
      base,
      url: `${base.origin}/${base.prefix ?? PROVIDER_APIS[provider].version}`,
      model,
      apiKey: v(e.key),
    };
  }
  // Keys shared by origin: an endpoint without one uses the first endpoint's on the same origin that has one.
  const own = SETTING_ENDPOINT_IDS.map((id) => out[id]).filter((ep) => !!ep?.apiKey);
  for (const id of SETTING_ENDPOINT_IDS) {
    const ep = out[id];
    if (!ep || ep.apiKey) continue;
    const donor = own.find((d) => d!.base.origin === ep.base.origin);
    if (donor) out[id] = { ...ep, apiKey: donor.apiKey, keyFrom: donor.id };
  }
  if (!opts.gateway)
    for (const id of SETTING_ENDPOINT_IDS) if (id !== 'llm' && id !== 'vision') out[id] = null;
  return out;
}

/** A gateway proxy the studio registers for its API keys (docs/design/settings.md#registration-in-mm-gateway). */
export interface DesiredProxy {
  domain: string;
  origin: string;
  accounts: { id: string; headers: Record<string, string>; endpoints: SettingEndpointId[] }[];
}

/**
 * The proxies the API keys need: one per domain, one account per distinct key carrying the credential header of every
 * provider using it there. `accountId` names an account after a key (the studio's instance and the key's
 * fingerprint). Two origins on one domain cannot share a proxy: the later endpoint is reported.
 */
export function desiredProxies(
  endpoints: ResolvedEndpoints,
  accountId: (key: string) => string,
): { proxies: Map<string, DesiredProxy>; conflicts: { id: SettingEndpointId; message: string }[] } {
  const proxies = new Map<string, DesiredProxy>();
  const conflicts: { id: SettingEndpointId; message: string }[] = [];
  for (const id of SETTING_ENDPOINT_IDS) {
    const ep = endpoints[id];
    if (!ep?.apiKey) continue;
    let proxy = proxies.get(ep.base.domain);
    if (proxy && proxy.origin !== ep.base.origin) {
      const holder = proxy.accounts[0]?.endpoints[0];
      conflicts.push({
        id,
        message: `mm-gateway proxies one API per domain: ${ep.base.domain} is ${proxy.origin} for the ${settingEndpoint(holder ?? id).label.toLowerCase()}`,
      });
      continue;
    }
    if (!proxy) {
      proxy = { domain: ep.base.domain, origin: ep.base.origin, accounts: [] };
      proxies.set(ep.base.domain, proxy);
    }
    const aid = accountId(ep.apiKey);
    let account = proxy.accounts.find((a) => a.id === aid);
    if (!account) {
      account = { id: aid, headers: {}, endpoints: [] };
      proxy.accounts.push(account);
    }
    Object.assign(account.headers, credentialHeaders(ep.provider, ep.apiKey));
    account.endpoints.push(id);
  }
  return { proxies, conflicts };
}

/** How an endpoint is reached (docs/design/settings.md#endpoint-status-and-tests). */
export const EndpointProxyStateSchema = z.enum([
  'off',
  'registered',
  'gateway',
  'missing',
  'unknown',
  'pending',
  'conflict',
  'failed',
]);
export type EndpointProxyState = z.infer<typeof EndpointProxyStateSchema>;

export const EndpointStatusSchema = z.object({
  on: z.boolean(),
  provider: z.string().nullable(),
  /** The base URL calls go to. */
  url: z.string().nullable(),
  /** The gateway proxy (`/proxy/{domain}/…`). */
  domain: z.string().nullable(),
  model: z.string().nullable(),
  key: z.enum(['own', 'shared', 'none']),
  keyFrom: SettingEndpointIdSchema.nullable(),
  proxy: EndpointProxyStateSchema,
  detail: z.string().nullable(),
});
export type EndpointStatus = z.infer<typeof EndpointStatusSchema>;

/** Why registering the API keys failed (docs/design/settings.md#registration-in-mm-gateway). */
export const ProxySyncCodeSchema = z.enum([
  'gateway_admin_missing',
  'gateway_admin_unauthorized',
  'gateway_management_unavailable',
  'gateway_unreachable',
  'gateway_error',
]);
export type ProxySyncCode = z.infer<typeof ProxySyncCodeSchema>;

export const ProxySyncStateSchema = z.object({
  status: z.enum(['idle', 'pending', 'ok', 'failed']),
  at: z.string().nullable(),
  code: ProxySyncCodeSchema.nullable(),
  detail: z.string().nullable(),
});
export type ProxySyncState = z.infer<typeof ProxySyncStateSchema>;
