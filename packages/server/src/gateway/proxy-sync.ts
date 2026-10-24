import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type DesiredProxy,
  desiredProxies,
  type ProxySyncCode,
  type ProxySyncState,
  SETTING_ENDPOINT_IDS,
} from '@rideo/shared';
import {
  Configuration,
  type ManagedKey,
  type ManagedProxy,
  ManagementApi,
  type ManagementConfigOutput,
  type ManagementConfigResponse,
  MetaApi,
} from '@sloth-os/mm-gateway-ts';
import axios, { type AxiosResponse, isAxiosError } from 'axios';
import type { Config } from '../config';
import type { Logger } from '../domain/deps';
import type { Metrics } from '../metrics';
import { KeyedMutex } from '../util/mutex';
import type { ProxyRoutes } from './proxy-client';

/**
 * API keys set in Settings, registered in mm-gateway as proxy accounts through its management API
 * (docs/design/settings.md#registration-in-mm-gateway): the desired proxies come from the endpoints, a pure plan
 * compares them with the gateway's configuration, and the plan's operations are applied with `If-Match`.
 */

/** What the gateway sends instead of a secret, and keeps when it is sent back. */
export const REDACTED = '[redacted]';

/** The studio in mm-gateway: an instance id and the token of its own gateway key (`<dataDir>/gateway.json`). */
export interface GatewayIdentity {
  instance: string;
  token: string;
}

export function gatewayNames(instance: string): { tag: string; keyId: string; accountPrefix: string } {
  return { tag: `rideo-${instance}`, keyId: `rideo-${instance}`, accountPrefix: `rideo-${instance}-` };
}

/** An account named after its key: the instance and the key's fingerprint (a new key is a new account). */
export function accountIdFor(instance: string, key: string): string {
  return `${gatewayNames(instance).accountPrefix}${createHash('sha256').update(key).digest('hex').slice(0, 8)}`;
}

export function identityPath(dataDir: string): string {
  return join(dataDir, 'gateway.json');
}

export async function hasIdentity(dataDir: string): Promise<boolean> {
  return stat(identityPath(dataDir)).then(
    () => true,
    () => false,
  );
}

/** The studio's identity, made once (mode 0600: it holds the token of the studio's gateway key). */
export async function loadIdentity(dataDir: string): Promise<GatewayIdentity> {
  const path = identityPath(dataDir);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<GatewayIdentity>;
    if (typeof parsed.instance === 'string' && /^[0-9a-f]{6}$/.test(parsed.instance) && parsed.token)
      return { instance: parsed.instance, token: parsed.token };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
  }
  const identity = { instance: randomBytes(3).toString('hex'), token: randomBytes(32).toString('hex') };
  await mkdir(dataDir, { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return identity;
}

export type ProxyOp =
  | { kind: 'put-proxy'; domain: string; body: ManagedProxy; created: boolean }
  | { kind: 'delete-proxy'; domain: string }
  | { kind: 'put-key'; keyId: string; body: ManagedKey; created: boolean }
  | { kind: 'delete-key'; keyId: string };

export interface ProxyPlan {
  ops: ProxyOp[];
  /** Domains whose proxy carries the studio's accounts once the plan is applied. */
  registered: string[];
  /** Domains the studio leaves alone, and why. */
  conflicts: Record<string, string>;
  /** The studio's gateway key exists already (its token can be checked). */
  keyExists: boolean;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
};
const trimUrl = (url: string): string => url.replace(/\/+$/, '');
const sameNames = (a: Record<string, string> = {}, b: Record<string, string> = {}) =>
  Object.keys(a).sort().join('\n') === Object.keys(b).sort().join('\n');

/**
 * What to change in mm-gateway so that its proxies carry the desired accounts and nothing else of this studio's
 * (docs/design/settings.md#registration-in-mm-gateway). Pure: `current` is the gateway's redacted configuration,
 * and everything sent back that the studio does not own keeps its `[redacted]` values, which the gateway restores.
 */
export function planProxySync(
  current: ManagementConfigOutput,
  desired: ReadonlyMap<string, DesiredProxy>,
  identity: GatewayIdentity,
  opts: { rewriteKey?: boolean } = {},
): ProxyPlan {
  const { tag, keyId, accountPrefix } = gatewayNames(identity.instance);
  const ops: ProxyOp[] = [];
  const registered: string[] = [];
  const conflicts: Record<string, string> = {};
  const proxies = current.proxies ?? [];
  const ours = (id: string) => id.startsWith(accountPrefix);

  // A proxy only this studio uses: tagged for it alone, with its accounts alone
  const onlyOurs = (p: ManagedProxy) => {
    const tags = p.tags ?? [];
    return tags.length > 0 && tags.every((t) => t === tag) && (p.accounts ?? []).every((a) => ours(a.id));
  };

  for (const want of desired.values()) {
    const existing = proxies.find((p) => hostOf(p.base_url) === want.domain);
    // None yet, or the studio's own at another origin (its base URL changed): written whole
    if (!existing || (onlyOurs(existing) && trimUrl(existing.base_url) !== want.origin)) {
      ops.push({
        kind: 'put-proxy',
        domain: want.domain,
        created: !existing,
        body: {
          domain: want.domain,
          base_url: want.origin,
          tags: [tag],
          timeout: 600,
          enabled: true,
          accounts: want.accounts.map((a) => ({ id: a.id, headers: a.headers })),
        },
      });
      registered.push(want.domain);
      continue;
    }
    if (trimUrl(existing.base_url) !== want.origin) {
      conflicts[want.domain] =
        `mm-gateway's proxy for ${want.domain} forwards to ${existing.base_url}; the studio needs it at ${want.origin}. Change it in mm-gateway, or remove it there and save again.`;
      continue;
    }
    if (existing.enabled === false) {
      conflicts[want.domain] =
        `mm-gateway's proxy for ${want.domain} is turned off. Turn it on in mm-gateway, or remove it there and save again.`;
      continue;
    }
    registered.push(want.domain);
    const accounts = existing.accounts ?? [];
    const unchanged = (a: DesiredProxy['accounts'][number]) => {
      const there = accounts.find((x) => x.id === a.id);
      return !!there && sameNames(there.headers, a.headers);
    };
    const stale = accounts.filter((a) => ours(a.id) && !want.accounts.some((w) => w.id === a.id));
    const tags = existing.tags ?? [];
    if (!stale.length && want.accounts.every(unchanged) && tags.includes(tag)) continue;
    // Sent back whole, `domain` included: the gateway matches it to restore the `[redacted]` values
    ops.push({
      kind: 'put-proxy',
      domain: want.domain,
      created: false,
      body: {
        ...existing,
        domain: want.domain,
        tags: tags.includes(tag) ? tags : [...tags, tag],
        accounts: [
          ...accounts.filter((a) => !ours(a.id)),
          ...want.accounts.map((a) =>
            unchanged(a) ? accounts.find((x) => x.id === a.id)! : { id: a.id, headers: a.headers },
          ),
        ],
      },
    });
  }

  // What this studio registered before and no longer wants
  for (const existing of proxies) {
    const domain = hostOf(existing.base_url);
    if (desired.has(domain)) continue;
    const accounts = existing.accounts ?? [];
    const tags = existing.tags ?? [];
    if (!accounts.some((a) => ours(a.id)) && !tags.includes(tag)) continue;
    const remaining = accounts.filter((a) => !ours(a.id));
    const otherTags = tags.filter((t) => t !== tag);
    if (!remaining.length && !otherTags.length) {
      ops.push({ kind: 'delete-proxy', domain });
      continue;
    }
    ops.push({
      kind: 'put-proxy',
      domain,
      created: false,
      body: { ...existing, domain, tags: otherTags, accounts: remaining },
    });
  }

  // The studio's own gateway key: it may use the proxies tagged for this studio
  const key = (current.keys ?? []).find((k) => k.id === keyId);
  if (registered.length) {
    if (!key)
      ops.push({
        kind: 'put-key',
        keyId,
        created: true,
        body: { id: keyId, key: identity.token, allow_tags: [tag], enabled: true },
      });
    else if (opts.rewriteKey || key.enabled === false || !(key.allow_tags ?? []).includes(tag))
      ops.push({
        kind: 'put-key',
        keyId,
        created: false,
        body: {
          ...key,
          key: opts.rewriteKey ? identity.token : REDACTED,
          enabled: true,
          allow_tags: [...new Set([...(key.allow_tags ?? []), tag])],
        },
      });
  } else if (key) ops.push({ kind: 'delete-key', keyId });

  return { ops, registered, conflicts, keyExists: !!key };
}

/** A failed management call as a sync failure code and a sentence (docs/design/settings.md#registration-in-mm-gateway). */
export function classifySyncError(err: unknown): { code: ProxySyncCode; detail: string } {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    const body = err.response?.data as { detail?: string; title?: string } | undefined;
    const said = typeof body === 'object' && body ? (body.detail ?? body.title) : undefined;
    if (!err.response)
      return { code: 'gateway_unreachable', detail: `mm-gateway did not answer: ${err.message}` };
    if (status === 401 || status === 403)
      return {
        code: 'gateway_admin_unauthorized',
        detail: `mm-gateway refused the admin token (${status}): set its MANAGEMENT_API_KEY as the admin token`,
      };
    if (status === 404 || status === 405)
      return {
        code: 'gateway_management_unavailable',
        detail: `mm-gateway has no management API (${status}): enable it with MANAGEMENT_API_KEY, or use a newer gateway`,
      };
    return { code: 'gateway_error', detail: `mm-gateway answered ${status}: ${said ?? err.message}` };
  }
  return { code: 'gateway_error', detail: err instanceof Error ? err.message : String(err) };
}

/** Syncs of one gateway run one at a time, whichever studio (before and after a reload) asks. */
const SYNCS = new KeyedMutex();

type DomainState = { state: 'registered' | 'conflict'; detail: string | null };

/**
 * Keeps mm-gateway's proxies in step with the API keys of one studio's configuration, and tells the proxy client
 * which key each domain is called with (the studio's own key for the proxies it registered).
 */
export class GatewayProxies implements ProxyRoutes {
  private identity: GatewayIdentity | null = null;
  private registered = new Set<string>();
  private domains = new Map<string, DomainState>();
  /** Domains the gateway proxies, from the last configuration read; null until one was read. */
  private gatewayDomains: Set<string> | null = null;
  private inflight: Promise<ProxySyncState> | null = null;
  private stopped = false;
  private last: ProxySyncState = { status: 'idle', at: null, code: null, detail: null };
  /** Domains of the endpoints that have an API key. */
  readonly keyed: ReadonlySet<string>;

  constructor(
    private readonly deps: {
      config: Config;
      log: Logger;
      metrics: Metrics;
      /** How long a call to a domain being registered waits for it. */
      waitMs?: number;
    },
  ) {
    const keyed = new Set<string>();
    for (const id of SETTING_ENDPOINT_IDS) {
      const ep = deps.config.endpoints[id];
      if (ep?.apiKey) keyed.add(ep.base.domain);
    }
    this.keyed = keyed;
  }

  get state(): ProxySyncState {
    return this.inflight ? { ...this.last, status: 'pending' } : this.last;
  }

  /** The outcome for a domain with keys: registered or in conflict; undefined before a sync settled it. */
  domainState(domain: string): DomainState | undefined {
    return this.domains.get(domain);
  }

  /** Whether the gateway proxies a domain (null when its configuration could not be read). */
  gatewayHas(domain: string): boolean | null {
    return this.gatewayDomains ? this.gatewayDomains.has(domain) : null;
  }

  keyFor(domain: string): string | undefined {
    return this.registered.has(domain) ? this.identity?.token : undefined;
  }

  async ready(domain: string): Promise<void> {
    const inflight = this.inflight;
    if (!inflight || !this.keyed.has(domain)) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      inflight,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.deps.waitMs ?? 20_000);
      }),
    ]);
    clearTimeout(timer);
  }

  /** The sync running now, or the last outcome. */
  settled(): Promise<ProxySyncState> {
    return this.inflight ?? Promise.resolve(this.last);
  }

  /**
   * Starts a sync when there is something to register, something registered before to clean up, or an admin token to
   * read the gateway's proxies with (endpoint statuses).
   */
  async start(): Promise<void> {
    const { config } = this.deps;
    if (!config.gateway.url) return;
    if (this.keyed.size || config.gateway.adminKey || (await hasIdentity(config.dataDir))) void this.sync();
  }

  stop(): void {
    this.stopped = true;
  }

  sync(): Promise<ProxySyncState> {
    if (this.inflight) return this.inflight;
    const url = this.deps.config.gateway.url ?? '';
    this.inflight = SYNCS.run(url, () => this.run()).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private management(token: string): { api: ManagementApi; meta: (key: string) => MetaApi } {
    const basePath = this.deps.config.gateway.url!;
    // A direct connection with a short timeout, like the SDK client's: environment proxies are not used.
    const http = axios.create({
      timeout: 15_000,
      proxy: false,
      headers: { 'User-Agent': 'rideo/0.1 (@sloth-os/mm-gateway-ts)' },
    });
    return {
      api: new ManagementApi(new Configuration({ basePath, accessToken: token }), undefined, http),
      meta: (key) => new MetaApi(new Configuration({ basePath, accessToken: key }), undefined, http),
    };
  }

  private finish(next: Omit<ProxySyncState, 'at'>): ProxySyncState {
    this.last = { ...next, at: new Date().toISOString() };
    return this.last;
  }

  private async run(): Promise<ProxySyncState> {
    const { config, log, metrics } = this.deps;
    const started = Date.now();
    if (this.stopped || !config.gateway.url) return this.last;
    const token = config.gateway.adminKey ?? config.gateway.apiKey;
    if (!token) {
      if (!this.keyed.size) return this.last;
      metrics.gatewayProxySync.inc({ result: 'failed' });
      return this.finish({
        status: 'failed',
        code: 'gateway_admin_missing',
        detail: 'Set mm-gateway’s admin token so the studio can register the API keys',
      });
    }
    try {
      this.identity ??= await loadIdentity(config.dataDir);
      const identity = this.identity;
      const { proxies: desired } = desiredProxies(config.endpoints, (key) =>
        accountIdFor(identity.instance, key),
      );
      const { api, meta } = this.management(token);
      let rewriteKey = false;
      for (let attempt = 0; ; attempt++) {
        const read = await api.getManagementConfig();
        let revision = read.data.revision;
        const plan = planProxySync(read.data.config, desired, identity, { rewriteKey });
        // A key that is there but whose token no longer works (a restored gateway, a new data directory)
        if (plan.keyExists && plan.registered.length && !rewriteKey && !(await this.tokenWorks(meta))) {
          rewriteKey = true;
          continue;
        }
        let final: ManagementConfigOutput = read.data.config;
        try {
          for (const op of plan.ops) {
            if (this.stopped) return this.last;
            const res = await apply(api, op, revision);
            revision = res.data.revision;
            final = res.data.config;
          }
        } catch (err) {
          // Someone else changed the configuration: read it again and plan again
          if (isAxiosError(err) && err.response?.status === 412 && attempt < 2) continue;
          throw err;
        }
        this.registered = new Set(plan.registered);
        this.domains = new Map<string, DomainState>([
          ...plan.registered.map((d): [string, DomainState] => [d, { state: 'registered', detail: null }]),
          ...Object.entries(plan.conflicts).map(([d, detail]): [string, DomainState] => [
            d,
            { state: 'conflict', detail },
          ]),
        ]);
        this.gatewayDomains = new Set((final.proxies ?? []).map((p) => hostOf(p.base_url)));
        const count = (kind: ProxyOp['kind'], created?: boolean) =>
          plan.ops.filter(
            (o) => o.kind === kind && (created === undefined || ('created' in o && o.created === created)),
          ).length;
        const conflicts = Object.keys(plan.conflicts);
        metrics.gatewayProxySync.inc({ result: conflicts.length ? 'conflict' : 'ok' });
        log.info(
          {
            created: count('put-proxy', true),
            updated: count('put-proxy', false),
            removed: count('delete-proxy'),
            conflicts,
            durationMs: Date.now() - started,
          },
          'gateway proxies synced',
        );
        return this.finish({ status: 'ok', code: null, detail: null });
      }
    } catch (err) {
      const { code, detail } = classifySyncError(err);
      metrics.gatewayProxySync.inc({ result: 'failed' });
      log.warn({ code, err: detail, durationMs: Date.now() - started }, 'gateway proxy sync failed');
      return this.finish({ status: 'failed', code, detail });
    }
  }

  /** Whether the gateway still knows the studio's key (401 means it does not). */
  private async tokenWorks(meta: (key: string) => MetaApi): Promise<boolean> {
    try {
      await meta(this.identity!.token).listModels();
      return true;
    } catch (err) {
      return !(isAxiosError(err) && err.response?.status === 401);
    }
  }
}

function apply(
  api: ManagementApi,
  op: ProxyOp,
  revision: string,
): Promise<AxiosResponse<ManagementConfigResponse>> {
  const ifMatch = `"${revision}"`;
  switch (op.kind) {
    case 'put-proxy':
      return api.putManagementProxy(op.domain, op.body, ifMatch);
    case 'delete-proxy':
      return api.deleteManagementProxy(op.domain, ifMatch);
    case 'put-key':
      return api.putManagementKey(op.keyId, op.body, ifMatch);
    case 'delete-key':
      return api.deleteManagementKey(op.keyId, ifMatch);
  }
}
