import { z } from 'zod';
import { ActorSchema } from '../schemas/common';
import {
  EndpointStatusSchema,
  PROVIDER_APIS,
  ProxySyncStateSchema,
  SETTING_ENDPOINT_IDS,
  SettingEndpointIdSchema,
} from './endpoints';

export * from './endpoints';

/**
 * Studio settings edited in the web UI (docs/design/settings.md): declared once as data. A setting is stored under the
 * name of the environment variable it stands for, so a value means the same in `.env` and in Settings; the server
 * parses both with one schema (`EnvSchema`), and the Settings page renders its form from this table.
 */

export const SETTING_GROUPS = [
  {
    id: 'storage',
    label: 'Storage',
    help: 'Where projects, their history and their media are kept.',
  },
  {
    id: 'gateway',
    label: 'mm-gateway',
    help: 'Image, video and music generation, and the proxy every other AI call goes through. Without it the editor works and AI features are off.',
  },
  {
    id: 'models',
    label: 'Models',
    help: 'Default gateway models of new projects (`auto` lets the gateway route).',
  },
  {
    id: 'ai',
    label: 'Language, vision and speech',
    help: 'Models reached through the gateway proxy: the writer, the consistency judge, transcripts and search. Set an API key to have the studio register it in mm-gateway; leave it empty to use the gateway’s own account.',
  },
  {
    id: 'audio',
    label: 'Voices and sound',
    help: 'Dialogue voices, sound effects and the speaker check, through the gateway proxy like the models above.',
  },
  { id: 'consistency', label: 'Consistency', help: 'The gate every generated take passes.' },
  {
    id: 'accounts',
    label: 'Accounts',
    help: 'Sign-in through your identity provider (OIDC). Add your own email to the administrators before turning it on.',
  },
  {
    id: 'provenance',
    label: 'Brand and provenance',
    help: 'What generated media says about where it comes from.',
  },
  {
    id: 'jobs',
    label: 'Limits and embedding',
    help: 'Job concurrency, leases, upload sizes, browser isolation, and the sites that may embed the studio.',
  },
  { id: 'appearance', label: 'Appearance', help: 'The studio theme every tab starts with.' },
] as const;
export type SettingGroupId = (typeof SETTING_GROUPS)[number]['id'];

export type SettingKind =
  | 'text'
  | 'url'
  | 'secret'
  | 'number'
  | 'boolean'
  | 'select'
  | 'list'
  | 'pem'
  | 'theme';

export interface SettingField {
  /** The environment variable it stands for, and the key it is stored under. */
  env: string;
  group: SettingGroupId;
  label: string;
  help?: string;
  kind: SettingKind;
  /** Choices of a `select`; '' stands for "not set" (the default). */
  options?: readonly string[];
  /** What each option of a `select` reads as. */
  optionLabels?: Readonly<Record<string, string>>;
  /** The documented default, shown when the field is empty. */
  placeholder?: string;
  /** Rarely changed: under "Advanced" in its section. */
  advanced?: boolean;
  /** Shown only while another setting has one of these values (its effective value, '' when unset). */
  showIf?: { env: string; in: readonly string[] };
}

const PROVIDERS = ['openai', 'gemini', 'anthropic'] as const;
const PROVIDER_LABELS = Object.fromEntries(Object.entries(PROVIDER_APIS).map(([id, api]) => [id, api.label]));
const BASE_URL_HELP = 'The API base URL as the provider documents it, or just its domain.';

export const SETTING_FIELDS: readonly SettingField[] = [
  // Storage (docs/design/browser-storage.md, docs/design/storage-webdav.md)
  {
    env: 'RIDEO_STORAGE',
    group: 'storage',
    label: 'Projects are stored',
    kind: 'select',
    options: ['auto', 'browser', 'webdav', 'embedded'],
    optionLabels: {
      auto: 'Automatic',
      browser: 'In each person’s browser',
      webdav: 'On a WebDAV server',
      embedded: 'In the built-in WebDAV server',
    },
    placeholder: 'auto',
    help: 'In each person’s browser: export project files to keep a copy. On a WebDAV server, or in the built-in one on this machine. Automatic: WebDAV when a URL is set, else the built-in server when it holds projects, else the browser.',
  },
  {
    env: 'RIDEO_WEBDAV_URL',
    group: 'storage',
    label: 'WebDAV URL',
    kind: 'url',
    placeholder: 'https://files.example.com/dav',
    showIf: { env: 'RIDEO_STORAGE', in: ['webdav', 'auto', ''] },
  },
  {
    env: 'RIDEO_WEBDAV_USERNAME',
    group: 'storage',
    label: 'WebDAV username',
    kind: 'text',
    showIf: { env: 'RIDEO_STORAGE', in: ['webdav', 'auto', ''] },
  },
  {
    env: 'RIDEO_WEBDAV_PASSWORD',
    group: 'storage',
    label: 'WebDAV password',
    kind: 'secret',
    showIf: { env: 'RIDEO_STORAGE', in: ['webdav', 'auto', ''] },
  },
  {
    env: 'RIDEO_WEBDAV_ROOT',
    group: 'storage',
    label: 'Root folder',
    kind: 'text',
    placeholder: '/rideo',
    help: 'The folder inside the share (and inside the built-in server) that holds the studio.',
  },
  {
    env: 'RIDEO_DAV_USERNAME',
    group: 'storage',
    label: 'Built-in WebDAV username',
    kind: 'text',
    help: 'Basic auth for mounting the built-in server at /dav.',
    showIf: { env: 'RIDEO_STORAGE', in: ['embedded'] },
  },
  {
    env: 'RIDEO_DAV_PASSWORD',
    group: 'storage',
    label: 'Built-in WebDAV password',
    kind: 'secret',
    showIf: { env: 'RIDEO_STORAGE', in: ['embedded'] },
  },
  {
    env: 'RIDEO_WEBDAV_SYNC_INTERVAL_SEC',
    group: 'storage',
    label: 'External-edit sync (seconds)',
    kind: 'number',
    placeholder: '15',
    advanced: true,
    help: 'How often open projects pick up edits made over WebDAV (0 turns it off).',
  },
  {
    env: 'RIDEO_COALESCE_WINDOW_SEC',
    group: 'storage',
    label: 'Commit coalescing window (seconds)',
    kind: 'number',
    placeholder: '30',
    advanced: true,
  },
  // mm-gateway (docs/design/ai-gateway.md)
  {
    env: 'MM_GATEWAY_URL',
    group: 'gateway',
    label: 'Gateway URL',
    kind: 'url',
    placeholder: 'http://localhost:8000',
    help: 'Empty: no AI. The editor, uploads, analysis rules, exports and review keep working.',
  },
  { env: 'MM_GATEWAY_API_KEY', group: 'gateway', label: 'Gateway key', kind: 'secret' },
  {
    env: 'MM_GATEWAY_ADMIN_KEY',
    group: 'gateway',
    label: 'Admin token',
    kind: 'secret',
    help: 'The gateway’s `MANAGEMENT_API_KEY`: lets the studio register the API keys set under Language, vision and speech and Voices and sound as gateway proxies. Empty: the gateway key is tried.',
  },
  {
    env: 'MM_GATEWAY_ROUTING_PROFILE',
    group: 'gateway',
    label: 'Routing profile',
    kind: 'text',
    advanced: true,
  },
  {
    env: 'RIDEO_GATEWAY_POLL_MS',
    group: 'gateway',
    label: 'Task poll interval (ms)',
    kind: 'number',
    placeholder: '2000',
    advanced: true,
  },
  {
    env: 'RIDEO_GATEWAY_TIMEOUT_IMAGE_SEC',
    group: 'gateway',
    label: 'Image timeout (seconds)',
    kind: 'number',
    placeholder: '300',
    advanced: true,
  },
  {
    env: 'RIDEO_GATEWAY_TIMEOUT_VIDEO_SEC',
    group: 'gateway',
    label: 'Video timeout (seconds)',
    kind: 'number',
    placeholder: '1200',
    advanced: true,
  },
  {
    env: 'RIDEO_GATEWAY_TIMEOUT_MUSIC_SEC',
    group: 'gateway',
    label: 'Music timeout (seconds)',
    kind: 'number',
    placeholder: '600',
    advanced: true,
  },
  // Models (projects can override; the pilot pins them)
  { env: 'RIDEO_IMAGE_MODEL', group: 'models', label: 'Image', kind: 'text', placeholder: 'auto' },
  { env: 'RIDEO_VIDEO_MODEL', group: 'models', label: 'Video', kind: 'text', placeholder: 'auto' },
  { env: 'RIDEO_MUSIC_MODEL', group: 'models', label: 'Music', kind: 'text', placeholder: 'auto' },
  { env: 'RIDEO_EDIT_MODEL', group: 'models', label: 'Take edits', kind: 'text', placeholder: 'auto' },
  { env: 'RIDEO_LIPSYNC_MODEL', group: 'models', label: 'Lip sync', kind: 'text', placeholder: 'auto' },
  {
    env: 'RIDEO_ENHANCE_MODEL',
    group: 'models',
    label: 'Upscale and interpolation',
    kind: 'text',
    placeholder: 'auto',
    help: '`off` uses ffmpeg.',
  },
  {
    env: 'RIDEO_PERFORMANCE_MODEL',
    group: 'models',
    label: 'Performance takes',
    kind: 'text',
    placeholder: 'auto',
    help: '`off` disables them.',
  },
  // Language, vision and speech through the gateway proxy (docs/design/settings.md#provider-endpoints-and-api-keys)
  {
    env: 'RIDEO_LLM_PROVIDER',
    group: 'ai',
    label: 'Provider',
    kind: 'select',
    options: PROVIDERS,
    optionLabels: PROVIDER_LABELS,
    placeholder: 'openai',
  },
  { env: 'RIDEO_LLM_MODEL', group: 'ai', label: 'Model', kind: 'text', placeholder: 'gpt-4.1-mini' },
  {
    env: 'RIDEO_LLM_PROXY_DOMAIN',
    group: 'ai',
    label: 'API base URL',
    kind: 'url',
    placeholder: 'https://api.openai.com/v1',
    help: BASE_URL_HELP,
  },
  {
    env: 'RIDEO_LLM_API_KEY',
    group: 'ai',
    label: 'API key',
    kind: 'secret',
    help: 'Empty: mm-gateway’s own account for this API.',
  },
  {
    env: 'RIDEO_VISION_PROVIDER',
    group: 'ai',
    label: 'Provider',
    kind: 'select',
    options: ['', ...PROVIDERS],
    optionLabels: { '': 'Same as the text model', ...PROVIDER_LABELS },
    placeholder: 'the text model’s',
  },
  { env: 'RIDEO_VISION_MODEL', group: 'ai', label: 'Model', kind: 'text', placeholder: 'the text model' },
  {
    env: 'RIDEO_VISION_PROXY_DOMAIN',
    group: 'ai',
    label: 'API base URL',
    kind: 'url',
    placeholder: 'the text model’s, for the same provider',
    help: BASE_URL_HELP,
  },
  {
    env: 'RIDEO_VISION_API_KEY',
    group: 'ai',
    label: 'API key',
    kind: 'secret',
    help: 'Empty: the key of another endpoint on the same API, else mm-gateway’s own account.',
  },
  {
    env: 'RIDEO_STT_PROXY_DOMAIN',
    group: 'ai',
    label: 'API base URL',
    kind: 'url',
    placeholder: 'https://api.openai.com/v1',
    help: 'An OpenAI-style API. Empty: footage is analyzed without a transcript.',
  },
  { env: 'RIDEO_STT_MODEL', group: 'ai', label: 'Model', kind: 'text', placeholder: 'whisper-1' },
  {
    env: 'RIDEO_STT_API_KEY',
    group: 'ai',
    label: 'API key',
    kind: 'secret',
    help: 'Empty: the key of another endpoint on the same API, else mm-gateway’s own account.',
  },
  {
    env: 'RIDEO_EMBEDDINGS_PROXY_DOMAIN',
    group: 'ai',
    label: 'API base URL',
    kind: 'url',
    placeholder: 'https://api.openai.com/v1',
    help: 'An OpenAI-style API. Empty: media search ranks by words instead of meaning.',
  },
  {
    env: 'RIDEO_EMBEDDINGS_MODEL',
    group: 'ai',
    label: 'Model',
    kind: 'text',
    placeholder: 'text-embedding-3-small',
  },
  {
    env: 'RIDEO_EMBEDDINGS_API_KEY',
    group: 'ai',
    label: 'API key',
    kind: 'secret',
    help: 'Empty: the key of another endpoint on the same API, else mm-gateway’s own account.',
  },
  {
    env: 'RIDEO_LLM_TIMEOUT_SEC',
    group: 'ai',
    label: 'Text and vision timeout (seconds)',
    kind: 'number',
    placeholder: '600',
    help: 'How long one text or vision model call may take: the screenplay of a long film takes minutes on slower models.',
    advanced: true,
  },
  // Voices and sound (docs/design/dialogue.md, docs/design/post-audio.md)
  {
    env: 'RIDEO_TTS_PROVIDER',
    group: 'audio',
    label: 'Provider',
    kind: 'select',
    options: ['off', 'elevenlabs', 'openai'],
    optionLabels: {
      off: 'Off',
      elevenlabs: 'ElevenLabs (design, clone, timings)',
      openai: 'OpenAI (preset voices)',
    },
    placeholder: 'off',
  },
  {
    env: 'RIDEO_TTS_MODEL',
    group: 'audio',
    label: 'Model',
    kind: 'text',
    placeholder: 'the provider’s',
    showIf: { env: 'RIDEO_TTS_PROVIDER', in: ['elevenlabs', 'openai'] },
  },
  {
    env: 'RIDEO_TTS_PROXY_DOMAIN',
    group: 'audio',
    label: 'API base URL',
    kind: 'url',
    placeholder: 'the provider’s',
    help: BASE_URL_HELP,
    showIf: { env: 'RIDEO_TTS_PROVIDER', in: ['elevenlabs', 'openai'] },
  },
  {
    env: 'RIDEO_TTS_API_KEY',
    group: 'audio',
    label: 'API key',
    kind: 'secret',
    help: 'Empty: the key of another endpoint on the same API, else mm-gateway’s own account.',
    showIf: { env: 'RIDEO_TTS_PROVIDER', in: ['elevenlabs', 'openai'] },
  },
  {
    env: 'RIDEO_SFX_PROVIDER',
    group: 'audio',
    label: 'Provider',
    kind: 'select',
    options: ['off', 'elevenlabs'],
    optionLabels: { off: 'Off', elevenlabs: 'ElevenLabs' },
    placeholder: 'off',
  },
  {
    env: 'RIDEO_SFX_MODEL',
    group: 'audio',
    label: 'Model',
    kind: 'text',
    placeholder: 'eleven_text_to_sound_v2',
    showIf: { env: 'RIDEO_SFX_PROVIDER', in: ['elevenlabs'] },
  },
  {
    env: 'RIDEO_SFX_PROXY_DOMAIN',
    group: 'audio',
    label: 'API base URL',
    kind: 'url',
    placeholder: 'https://api.elevenlabs.io/v1',
    help: BASE_URL_HELP,
    showIf: { env: 'RIDEO_SFX_PROVIDER', in: ['elevenlabs'] },
  },
  {
    env: 'RIDEO_SFX_API_KEY',
    group: 'audio',
    label: 'API key',
    kind: 'secret',
    help: 'Empty: the key of another endpoint on the same API, else mm-gateway’s own account.',
    showIf: { env: 'RIDEO_SFX_PROVIDER', in: ['elevenlabs'] },
  },
  {
    env: 'RIDEO_VOICE_JUDGE_PROVIDER',
    group: 'audio',
    label: 'Provider',
    kind: 'select',
    options: ['', 'openai', 'gemini', 'off'],
    optionLabels: {
      '': 'Same as vision',
      openai: PROVIDER_APIS.openai.label,
      gemini: PROVIDER_APIS.gemini.label,
      off: 'Off',
    },
    placeholder: 'the vision provider’s',
  },
  {
    env: 'RIDEO_VOICE_JUDGE_MODEL',
    group: 'audio',
    label: 'Model',
    kind: 'text',
    placeholder: 'gpt-4o-audio-preview',
    showIf: { env: 'RIDEO_VOICE_JUDGE_PROVIDER', in: ['', 'openai', 'gemini'] },
  },
  {
    env: 'RIDEO_VOICE_JUDGE_PROXY_DOMAIN',
    group: 'audio',
    label: 'API base URL',
    kind: 'url',
    placeholder: 'the vision model’s, for the same provider',
    help: BASE_URL_HELP,
    showIf: { env: 'RIDEO_VOICE_JUDGE_PROVIDER', in: ['', 'openai', 'gemini'] },
  },
  {
    env: 'RIDEO_VOICE_JUDGE_API_KEY',
    group: 'audio',
    label: 'API key',
    kind: 'secret',
    help: 'Empty: the key of another endpoint on the same API, else mm-gateway’s own account.',
    showIf: { env: 'RIDEO_VOICE_JUDGE_PROVIDER', in: ['', 'openai', 'gemini'] },
  },
  // Consistency (docs/design/character-consistency.md)
  {
    env: 'RIDEO_CONSISTENCY_JUDGE',
    group: 'consistency',
    label: 'Judge',
    kind: 'select',
    options: ['vision-llm', 'off'],
    optionLabels: { 'vision-llm': 'The vision model', off: 'Off' },
    placeholder: 'vision-llm',
    help: '`off` fails closed: takes stay unverified until a person overrides them.',
  },
  {
    env: 'RIDEO_CONSISTENCY_THRESHOLD',
    group: 'consistency',
    label: 'Threshold of new projects',
    kind: 'number',
    placeholder: '0.75',
  },
  {
    env: 'RIDEO_CONSISTENCY_MAX_ATTEMPTS',
    group: 'consistency',
    label: 'Attempts per step',
    kind: 'number',
    placeholder: '3',
  },
  // Accounts (docs/design/accounts.md)
  {
    env: 'RIDEO_OIDC_ISSUER',
    group: 'accounts',
    label: 'OpenID Connect issuer',
    kind: 'url',
    help: 'Empty: no sign-in. The redirect URI to register is <public URL>/api/auth/callback.',
  },
  { env: 'RIDEO_OIDC_CLIENT_ID', group: 'accounts', label: 'Client id', kind: 'text' },
  {
    env: 'RIDEO_OIDC_CLIENT_SECRET',
    group: 'accounts',
    label: 'Client secret',
    kind: 'secret',
    help: 'Empty: a public client with PKCE.',
  },
  {
    env: 'RIDEO_OIDC_SCOPES',
    group: 'accounts',
    label: 'Scopes',
    kind: 'text',
    placeholder: 'openid profile email',
    advanced: true,
  },
  {
    env: 'RIDEO_OIDC_NAME',
    group: 'accounts',
    label: 'Provider name on the sign-in button',
    kind: 'text',
    placeholder: 'your identity provider',
  },
  { env: 'RIDEO_ADMINS', group: 'accounts', label: 'Administrators (emails)', kind: 'list' },
  {
    env: 'RIDEO_OIDC_ALLOWED_DOMAINS',
    group: 'accounts',
    label: 'Email domains that may join',
    kind: 'list',
    help: 'Empty: anyone the provider signs in.',
  },
  {
    env: 'RIDEO_SESSION_DAYS',
    group: 'accounts',
    label: 'Session lifetime (days)',
    kind: 'number',
    placeholder: '14',
    advanced: true,
  },
  {
    env: 'RIDEO_USER_NAME',
    group: 'accounts',
    label: 'Name of the studio user',
    kind: 'text',
    placeholder: 'You',
    help: 'Who changes are attributed to without sign-in.',
  },
  // Brand and provenance (docs/design/provenance.md, docs/design/watermark.md)
  { env: 'RIDEO_BRAND_NAME', group: 'provenance', label: 'Brand name', kind: 'text', placeholder: 'Rideo' },
  { env: 'RIDEO_BRAND_OWNER', group: 'provenance', label: 'Brand owner', kind: 'text' },
  { env: 'RIDEO_BRAND_URL', group: 'provenance', label: 'Brand URL', kind: 'url' },
  {
    env: 'RIDEO_WATERMARK_STRENGTH',
    group: 'provenance',
    label: 'Watermark strength',
    kind: 'number',
    placeholder: '16',
    advanced: true,
  },
  {
    env: 'RIDEO_C2PA',
    group: 'provenance',
    label: 'Content Credentials (C2PA)',
    kind: 'select',
    options: ['on', 'off'],
    optionLabels: { on: 'On', off: 'Off' },
    placeholder: 'on',
  },
  {
    env: 'RIDEO_C2PA_CERT',
    group: 'provenance',
    label: 'Signing certificate chain (PEM)',
    kind: 'pem',
    help: 'Leaf first. Empty: a development signer made in the data directory.',
  },
  { env: 'RIDEO_C2PA_KEY', group: 'provenance', label: 'Signing key (PEM)', kind: 'secret' },
  {
    env: 'RIDEO_C2PA_TSA_URL',
    group: 'provenance',
    label: 'Time-stamp authority',
    kind: 'url',
    advanced: true,
  },
  {
    env: 'RIDEO_C2PA_TRUST_ANCHORS',
    group: 'provenance',
    label: 'Trusted CAs (PEM bundle)',
    kind: 'pem',
    advanced: true,
  },
  {
    env: 'RIDEO_VAPID_SUBJECT',
    group: 'provenance',
    label: 'Push contact',
    kind: 'text',
    placeholder: 'mailto:rideo@localhost',
    help: 'What push services see (mailto: or https:).',
    advanced: true,
  },
  // Jobs and limits
  {
    env: 'RIDEO_LANES',
    group: 'jobs',
    label: 'Lane concurrency',
    kind: 'text',
    placeholder: 'control=16,llm=2,image=2,video=2,music=1,media=1',
    advanced: true,
  },
  {
    env: 'RIDEO_EDITOR_LEASE_SEC',
    group: 'jobs',
    label: 'Editor-job lease (seconds)',
    kind: 'number',
    placeholder: '60',
    advanced: true,
  },
  {
    env: 'RIDEO_EDITOR_FILE_MAX_BYTES',
    group: 'jobs',
    label: 'Largest editor-job file (bytes)',
    kind: 'number',
    placeholder: '4294967296',
    advanced: true,
  },
  {
    env: 'RIDEO_PUBLIC_DETECT_MAX_BYTES',
    group: 'jobs',
    label: 'Largest file of the public detector (bytes)',
    kind: 'number',
    placeholder: '536870912',
    advanced: true,
  },
  {
    env: 'RIDEO_CACHE_MAX_BYTES',
    group: 'jobs',
    label: 'Media cache (bytes)',
    kind: 'number',
    placeholder: '5368709120',
    advanced: true,
  },
  {
    env: 'RIDEO_CROSS_ORIGIN_ISOLATION',
    group: 'jobs',
    label: 'Cross-origin isolation',
    kind: 'select',
    options: ['require-corp', 'credentialless', 'off'],
    placeholder: 'require-corp',
    help: 'Lets the editor engine run on every core.',
    advanced: true,
  },
  {
    env: 'RIDEO_CORS_ORIGINS',
    group: 'jobs',
    label: 'Origins that may embed the studio',
    kind: 'list',
    help: 'Pages on these origins can use this server through the studio library (docs/design/embedding.md); `*` allows any.',
  },
  // Appearance (docs/design/embedding.md#themes)
  {
    env: 'RIDEO_THEME',
    group: 'appearance',
    label: 'Studio theme',
    kind: 'theme',
    help: 'The default mode and colors every tab starts with.',
  },
];

export const SETTING_KEYS: ReadonlySet<string> = new Set(SETTING_FIELDS.map((f) => f.env));

export function settingField(env: string): SettingField | undefined {
  return SETTING_FIELDS.find((f) => f.env === env);
}

export function isSecretSetting(env: string): boolean {
  return settingField(env)?.kind === 'secret';
}

/** Whether a field shows given the other settings' effective values (`showIf`). */
export function settingVisible(
  field: SettingField,
  values: Readonly<Record<string, string | null>>,
): boolean {
  if (!field.showIf) return true;
  return field.showIf.in.includes(values[field.showIf.env] ?? '');
}

export const SettingSourceSchema = z.enum(['env', 'settings', 'default']);
export type SettingSource = z.infer<typeof SettingSourceSchema>;

export const SettingValueSchema = z.object({
  /** The raw value (secrets: null); null when unset (the default applies). */
  value: z.string().nullable(),
  source: SettingSourceSchema,
  /** Set in the environment: read-only in the UI. */
  locked: z.boolean(),
  /** A value is set (for secrets, whose value is never sent). */
  set: z.boolean(),
});
export type SettingValue = z.infer<typeof SettingValueSchema>;

export const StorageModeSchema = z.enum(['browser', 'webdav', 'embedded']);
export type StorageMode = z.infer<typeof StorageModeSchema>;

export const SettingsViewSchema = z.object({
  fields: z.record(z.string(), SettingValueSchema),
  /** Where projects are stored now (`auto` resolved). */
  storage: StorageModeSchema,
  gateway: z.boolean(),
  updatedAt: z.string().nullable(),
  updatedBy: ActorSchema.nullable(),
  /** Why the stored settings are not in effect (they failed validation at start). */
  error: z.string().nullable(),
  /** Jobs that a change would interrupt (they resume after the reload). */
  runningJobs: z.number().int().nonnegative(),
  /** Each AI endpoint: what it resolves to and how it is reached (docs/design/settings.md#endpoint-status-and-tests). */
  endpoints: z.record(SettingEndpointIdSchema, EndpointStatusSchema),
  /** Registering the API keys in mm-gateway (docs/design/settings.md#registration-in-mm-gateway). */
  proxySync: ProxySyncStateSchema,
});
export type SettingsView = z.infer<typeof SettingsViewSchema>;

const SettingKeySchema = z
  .string()
  .refine((k) => SETTING_KEYS.has(k), { message: 'not a setting the studio can change' });

export const SettingsUpdateInputSchema = z.object({
  values: z.record(
    SettingKeySchema,
    z
      .string()
      .max(64 * 1024)
      .nullable(),
  ),
});
export type SettingsUpdateInput = z.infer<typeof SettingsUpdateInputSchema>;

export const SETTINGS_TEST_TARGETS = ['webdav', 'gateway', ...SETTING_ENDPOINT_IDS] as const;
export type SettingsTestTarget = (typeof SETTINGS_TEST_TARGETS)[number];

export const SettingsTestInputSchema = z.object({
  /** A connection with the values as they would be saved, or an AI endpoint with the saved settings. */
  target: z.enum(SETTINGS_TEST_TARGETS),
  values: z
    .record(
      SettingKeySchema,
      z
        .string()
        .max(64 * 1024)
        .nullable(),
    )
    .default({}),
});
export type SettingsTestInput = z.infer<typeof SettingsTestInputSchema>;

export const SettingsTestResultSchema = z.object({
  ok: z.boolean(),
  detail: z.string(),
  /** The gateway's model catalogue, by modality (gateway tests). */
  models: z.record(z.string(), z.array(z.string())).optional(),
  /** How long the call took (endpoint tests). */
  latencyMs: z.number().nonnegative().optional(),
});
export type SettingsTestResult = z.infer<typeof SettingsTestResultSchema>;

/** The settings file (`<dataDir>/settings.json`). */
export const SettingsFileSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().nullable().default(null),
  updatedBy: ActorSchema.nullable().default(null),
  values: z.record(z.string(), z.string()).default({}),
});
export type SettingsFile = z.infer<typeof SettingsFileSchema>;
