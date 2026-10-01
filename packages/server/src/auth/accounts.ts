import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import {
  type AccessSubject,
  type Actor,
  type AgentToken,
  AgentTokenSchema,
  type AuditEvent,
  type AuthMe,
  can,
  docPath,
  newId,
  type Permission,
  type Project,
  type ProjectAccess,
  ProjectAccessSchema,
  type ProjectRole,
  type PublicUser,
  projectRole,
  SYSTEM_ACTOR,
  type TokenInfo,
  type User,
  UserSchema,
} from '@rideo/shared';
import type { Config } from '../config';
import type { Logger } from '../domain/deps';
import type { ProjectRegistry } from '../domain/registry';
import { AppError, invalid, notFound } from '../errors';
import type { Metrics } from '../metrics';
import type { StorageBackend } from '../storage/backend';
import type { Layout } from '../storage/layout';
import { AuditLog, type AuditQuery } from './audit';
import type { Principal } from './context';
import { OidcClient, pkcePair, randomToken } from './oidc';
import { SessionStore } from './sessions';

export type AuthMode = 'none' | 'token' | 'oidc';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const publicUser = (u: User): PublicUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  studioRole: u.studioRole,
  disabled: u.disabled,
});
const PENDING_MS = 10 * 60_000;
export const SESSION_COOKIE = 'rideo_session';

/**
 * People, sessions, agent tokens, permissions and the audit log (docs/design/accounts.md). Every surface asks it who
 * is calling (`authenticate`) and whether they may (`authorize`).
 */
export class AccountsService {
  readonly mode: AuthMode;
  readonly sessions: SessionStore;
  readonly audit: AuditLog;
  readonly oidc: OidcClient | null;
  private readonly users = new Map<string, User>();
  private readonly tokens = new Map<string, AgentToken>();
  private readonly pending = new Map<
    string,
    { nonce: string; verifier: string; returnTo: string; at: number }
  >();

  constructor(
    private readonly deps: {
      config: Config;
      storage: StorageBackend;
      layout: Layout;
      projects: ProjectRegistry;
      metrics: Metrics;
      log: Logger;
    },
  ) {
    const c = deps.config;
    this.mode = c.auth.oidc ? 'oidc' : c.apiToken ? 'token' : 'none';
    this.sessions = new SessionStore(join(c.dataDir, 'sessions'), c.auth.sessionDays * 86_400_000);
    this.audit = new AuditLog(join(c.dataDir, 'audit'));
    this.oidc = c.auth.oidc
      ? new OidcClient({ ...c.auth.oidc, redirectUri: `${c.publicUrl}/api/auth/callback` })
      : null;
  }

  async init(): Promise<void> {
    await this.sessions.init();
    await this.audit.init();
    if (this.mode !== 'oidc') return;
    for (const [dir, map, schema] of [
      [this.deps.layout.usersDir(), this.users, UserSchema],
      [this.deps.layout.tokensDir(), this.tokens, AgentTokenSchema],
    ] as const) {
      for (const e of await this.deps.storage.list(dir).catch(() => [])) {
        if (!e.name.endsWith('.json')) continue;
        const buf = await this.deps.storage.read(`${dir}/${e.name}`).catch(() => null);
        if (!buf) continue;
        try {
          const doc = schema.parse(JSON.parse(buf.toString('utf8')));
          (map as Map<string, typeof doc>).set(doc.id, doc);
        } catch (err) {
          this.deps.log.warn(
            { file: e.name, err: (err as Error).message },
            'skipping an invalid account record',
          );
        }
      }
    }
  }

  /** The configured user as an administrator (`none` and `token` modes, the studio token). */
  studioPrincipal(): Principal {
    const u = this.deps.config.user;
    return {
      kind: 'studio',
      user: { id: u.id, email: '', name: u.name, studioRole: 'admin', disabled: false },
      admin: true,
      token: null,
      actor: { kind: 'user', id: u.id, name: u.name },
    };
  }

  private userPrincipal(user: User): Principal {
    return {
      kind: 'user',
      user: publicUser(user),
      admin: user.studioRole === 'admin',
      token: null,
      actor: { kind: 'user', id: user.id, name: user.name },
    };
  }

  /** Who is calling: a bearer or query token, else the session cookie; null when nobody valid is. */
  async authenticate(input: {
    authorization?: string;
    cookie?: string;
    token?: string;
  }): Promise<Principal | null> {
    if (this.mode === 'none') return this.studioPrincipal();
    const bearer = /^Bearer\s+(.+)$/i.exec(input.authorization ?? '')?.[1]?.trim() ?? input.token;
    if (bearer) {
      if (this.deps.config.apiToken && safeEqual(bearer, this.deps.config.apiToken))
        return this.studioPrincipal();
      if (this.mode === 'oidc' && bearer.startsWith('rdo_')) return this.tokenPrincipal(bearer);
      return null;
    }
    if (this.mode !== 'oidc') return null;
    const session = cookieValue(input.cookie, SESSION_COOKIE);
    if (!session) return null;
    const userId = await this.sessions.get(session);
    const user = userId ? this.users.get(userId) : undefined;
    return user && !user.disabled ? this.userPrincipal(user) : null;
  }

  private tokenPrincipal(secret: string): Principal | null {
    const m = /^rdo_([0-9a-z]{16})_([A-Za-z0-9_-]{20,100})$/.exec(secret);
    const token = m ? this.tokens.get(`tok_${m[1]}`) : undefined;
    if (!token || !safeEqual(sha256(secret), token.hash)) return null;
    if (token.revokedAt || (token.expiresAt && Date.parse(token.expiresAt) < Date.now())) return null;
    const owner = this.users.get(token.userId);
    if (!owner || owner.disabled) return null;
    if (!token.lastUsedAt || Date.now() - Date.parse(token.lastUsedAt) > 5 * 60_000) {
      const used = { ...token, lastUsedAt: new Date().toISOString() };
      this.tokens.set(token.id, used);
      void this.saveToken(used).catch(() => undefined);
    }
    this.deps.metrics.auth.inc({ event: 'token', outcome: 'ok' });
    return {
      kind: 'token',
      user: publicUser(owner),
      admin: false,
      token,
      actor: {
        kind: 'agent',
        id: token.id,
        name: token.name,
        onBehalfOf: { kind: 'user', id: owner.id, name: owner.name },
      },
    };
  }

  subject(p: Principal): AccessSubject {
    return {
      userId: p.user.id,
      admin: p.admin,
      token: p.token ? { role: p.token.role, projectIds: p.token.projectIds } : null,
    };
  }

  /** The caller's role in a project (null: none). */
  async roleIn(p: Principal, projectId: string): Promise<ProjectRole | null> {
    if (p.admin && !p.token) return 'director';
    const project = (await this.deps.projects.docs(projectId)).project;
    return projectRole(this.subject(p), project);
  }

  roleInProject(p: Principal, project: Pick<Project, 'id' | 'access'>): ProjectRole | null {
    return projectRole(this.subject(p), project);
  }

  /** Throws `forbidden` (and records `auth.denied`) unless the caller's role covers the permission. */
  async authorize(p: Principal, projectId: string, permission: Permission): Promise<ProjectRole> {
    const role = await this.roleIn(p, projectId);
    if (can(role, permission)) return role!;
    this.deps.metrics.auth.inc({ event: 'denied', outcome: 'denied' });
    await this.record(p, 'auth.denied', { projectId, outcome: 'denied', detail: { permission, role } });
    throw new AppError(
      'forbidden',
      role
        ? `Your role in this project (${role}) cannot do that (${permission})`
        : 'You are not a member of this project',
    );
  }

  async record(
    p: Principal | null,
    type: AuditEvent['type'],
    e: { projectId?: string | null; outcome?: AuditEvent['outcome']; detail?: Record<string, unknown> } = {},
  ): Promise<void> {
    const actor = p?.actor ?? SYSTEM_ACTOR;
    await this.audit
      .record({
        type,
        actor: { kind: actor.kind, id: actor.id, name: actor.name, userId: p?.user.id },
        projectId: e.projectId ?? null,
        outcome: e.outcome ?? 'ok',
        detail: e.detail ?? {},
      })
      .catch((err) => this.deps.log.warn({ err: (err as Error).message }, 'audit log write failed'));
  }

  me(p: Principal | null): AuthMe {
    return {
      mode: this.mode,
      provider: this.deps.config.auth.oidc?.name ?? null,
      user: p?.user ?? null,
      token: p?.token ? { id: p.token.id, name: p.token.name, role: p.token.role } : null,
      admin: !!p?.admin,
    };
  }

  // Sign-in (docs/design/accounts.md#sign-in-oidc)

  async startLogin(returnTo: string, loginHint?: string): Promise<string> {
    if (!this.oidc) throw invalid('sign-in is not configured (RIDEO_OIDC_ISSUER)');
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.at > PENDING_MS) this.pending.delete(k);
    const state = randomToken(16);
    const nonce = randomToken(16);
    const { verifier, challenge } = pkcePair();
    this.pending.set(state, { nonce, verifier, returnTo: safeReturnTo(returnTo), at: now });
    return this.oidc.authorizationUrl({ state, nonce, challenge, loginHint });
  }

  async finishLogin(code: string, state: string): Promise<{ session: string; returnTo: string; user: User }> {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!this.oidc || !pending || Date.now() - pending.at > PENDING_MS) {
      await this.record(null, 'auth.failed', {
        outcome: 'failed',
        detail: { reason: 'unknown or expired state' },
      });
      throw new AppError('unauthorized', 'This sign-in expired or was not started here; sign in again');
    }
    let claims: Awaited<ReturnType<OidcClient['exchange']>>;
    try {
      claims = await this.oidc.exchange(code, pending.verifier, pending.nonce);
    } catch (err) {
      this.deps.metrics.auth.inc({ event: 'login', outcome: 'failed' });
      await this.record(null, 'auth.failed', {
        outcome: 'failed',
        detail: { reason: (err as Error).message },
      });
      throw err;
    }
    const email = (claims.email ?? '').toLowerCase();
    const { admins, allowedDomains } = this.deps.config.auth;
    let user = [...this.users.values()].find((u) => u.issuer === claims.iss && u.sub === claims.sub);
    const now = new Date().toISOString();
    if (!user) {
      if (allowedDomains.length && !allowedDomains.includes(email.split('@')[1] ?? '')) {
        await this.record(null, 'auth.failed', {
          outcome: 'failed',
          detail: { reason: 'domain not allowed', email },
        });
        throw new AppError('forbidden', `${email || 'This account'} may not join this studio`);
      }
      user = UserSchema.parse({
        id: newId('user'),
        issuer: claims.iss,
        sub: claims.sub,
        email,
        name: claims.name ?? claims.preferred_username ?? email ?? claims.sub,
        studioRole: admins.includes(email) ? 'admin' : 'member',
        createdAt: now,
      });
    }
    user = {
      ...user,
      email: email || user.email,
      name: claims.name ?? user.name,
      studioRole: admins.includes(email) ? 'admin' : user.studioRole,
      lastLoginAt: now,
    };
    if (user.disabled) {
      await this.record(this.userPrincipal(user), 'auth.failed', {
        outcome: 'failed',
        detail: { reason: 'disabled' },
      });
      throw new AppError('forbidden', 'This account is disabled');
    }
    await this.saveUser(user);
    await this.acceptInvites(user);
    const session = await this.sessions.create(user.id);
    this.deps.metrics.auth.inc({ event: 'login', outcome: 'ok' });
    await this.record(this.userPrincipal(user), 'auth.login');
    return { session, returnTo: pending.returnTo, user };
  }

  async logout(p: Principal | null, cookie?: string): Promise<void> {
    const session = cookieValue(cookie, SESSION_COOKIE);
    if (session) await this.sessions.delete(session);
    if (p) await this.record(p, 'auth.logout');
  }

  /** Invitations by email become memberships at first sign-in. */
  private async acceptInvites(user: User): Promise<void> {
    if (!user.email) return;
    for (const id of await this.deps.projects.listIds()) {
      const project = (await this.deps.projects.docs(id).catch(() => null))?.project;
      const invite = project?.access?.invites.find((i) => i.email.toLowerCase() === user.email);
      if (!project?.access || !invite) continue;
      await this.deps.projects.handle(id).repo.transact(
        (tx) => {
          const cur = tx.require<Project>(docPath.project(), 'project');
          const access = ProjectAccessSchema.parse(cur.access ?? {});
          tx.set(docPath.project(), {
            ...cur,
            access: {
              ...access,
              invites: access.invites.filter((i) => i.email.toLowerCase() !== user.email),
              members: access.members.some((m) => m.userId === user.id)
                ? access.members
                : [...access.members, { userId: user.id, role: invite.role }],
            },
          });
        },
        {
          actor: SYSTEM_ACTOR,
          message: `${user.name} joined as ${invite.role} (invited by ${invite.invitedBy})`,
        },
      );
      await this.record(this.userPrincipal(user), 'project.access', {
        projectId: id,
        detail: { joined: user.email, role: invite.role },
      });
    }
  }

  // People

  user(id: string): PublicUser | null {
    const u = this.users.get(id);
    return u ? publicUser(u) : null;
  }

  userByEmail(email: string): User | undefined {
    const e = email.trim().toLowerCase();
    return [...this.users.values()].find((u) => u.email === e);
  }

  listUsers(p: Principal): PublicUser[] {
    if (!p.admin) throw new AppError('forbidden', 'Only administrators manage people');
    return [...this.users.values()].map(publicUser).sort((a, b) => a.name.localeCompare(b.name));
  }

  async updateUser(
    p: Principal,
    id: string,
    patch: { studioRole?: User['studioRole']; disabled?: boolean },
  ): Promise<PublicUser> {
    if (!p.admin || p.token) throw new AppError('forbidden', 'Only administrators manage people');
    const user = this.users.get(id);
    if (!user) throw notFound(`user ${id}`);
    if (id === p.user.id && (patch.disabled || patch.studioRole === 'member'))
      throw invalid('you cannot disable or demote yourself');
    const next = { ...user, ...patch };
    await this.saveUser(next);
    if (next.disabled) await this.sessions.deleteUser(id);
    await this.record(p, 'user.updated', { detail: { userId: id, ...patch } });
    return publicUser(next);
  }

  // Agent tokens (docs/design/accounts.md#agent-tokens)

  async createToken(
    p: Principal,
    input: { name: string; role: ProjectRole; projectIds?: string[] | null; expiresInDays?: number | null },
  ): Promise<{ token: TokenInfo; secret: string }> {
    if (p.kind !== 'user') throw new AppError('forbidden', 'Sign in as a person to create agent tokens');
    const id = newId('token');
    const secret = `rdo_${id.slice(4)}_${randomToken(32)}`;
    const now = Date.now();
    const token = AgentTokenSchema.parse({
      id,
      userId: p.user.id,
      name: input.name.trim(),
      hash: sha256(secret),
      role: input.role,
      projectIds: input.projectIds?.length ? input.projectIds : null,
      createdAt: new Date(now).toISOString(),
      expiresAt: input.expiresInDays ? new Date(now + input.expiresInDays * 86_400_000).toISOString() : null,
    });
    await this.saveToken(token);
    await this.record(p, 'token.created', {
      detail: { tokenId: id, name: token.name, role: token.role, projectIds: token.projectIds },
    });
    const { hash: _h, ...info } = token;
    return { token: info, secret };
  }

  listTokens(p: Principal): TokenInfo[] {
    return [...this.tokens.values()]
      .filter((t) => (p.admin && !p.token) || t.userId === p.user.id)
      .map(({ hash: _h, ...info }) => info)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async revokeToken(p: Principal, id: string): Promise<TokenInfo> {
    const token = this.tokens.get(id);
    if (!token || (token.userId !== p.user.id && !(p.admin && !p.token))) throw notFound(`token ${id}`);
    const next = { ...token, revokedAt: token.revokedAt ?? new Date().toISOString() };
    await this.saveToken(next);
    await this.record(p, 'token.revoked', { detail: { tokenId: id, name: token.name } });
    const { hash: _h, ...info } = next;
    return info;
  }

  // Audit

  async queryAudit(p: Principal, q: AuditQuery): Promise<AuditEvent[]> {
    if (p.admin && !p.token) return this.audit.query(q);
    if (!q.projectId)
      throw new AppError('forbidden', 'Only administrators read the whole audit log; name a project');
    await this.authorize(p, q.projectId, 'project.manage');
    return this.audit.query(q);
  }

  // Project access

  /** The members as people (names and emails), for the Members card. */
  describeAccess(access: ProjectAccess | null): {
    visibility: ProjectAccess['visibility'];
    members: { userId: string; role: ProjectRole; name: string; email: string }[];
    invites: ProjectAccess['invites'];
  } {
    const a = access ?? ProjectAccessSchema.parse({});
    return {
      visibility: a.visibility,
      members: a.members.map((m) => {
        const u = this.users.get(m.userId);
        return { ...m, name: u?.name ?? m.userId, email: u?.email ?? '' };
      }),
      invites: a.invites,
    };
  }

  /** The members by email: people who signed in before become members, others are invited. */
  resolveAccess(
    p: Principal,
    current: ProjectAccess | null,
    input: { visibility?: ProjectAccess['visibility']; members?: { email: string; role: ProjectRole }[] },
  ): ProjectAccess {
    const base = current ?? ProjectAccessSchema.parse({});
    let members = base.members;
    let invites = base.invites;
    if (input.members) {
      members = [];
      invites = [];
      const now = new Date().toISOString();
      for (const m of input.members) {
        const email = m.email.trim().toLowerCase();
        const user = this.userByEmail(email);
        // A studio without accounts has no people to resolve: the configured user stands for themselves.
        if (user) members.push({ userId: user.id, role: m.role });
        else if (this.mode !== 'oidc' && email === p.user.email)
          members.push({ userId: p.user.id, role: m.role });
        else invites.push({ email, role: m.role, invitedBy: p.user.name, at: now });
      }
      if (this.mode === 'oidc' && !members.some((m) => m.role === 'director'))
        throw invalid('a project needs at least one director who has signed in');
    }
    return ProjectAccessSchema.parse({ visibility: input.visibility ?? base.visibility, members, invites });
  }

  private async saveUser(user: User): Promise<void> {
    this.users.set(user.id, user);
    await this.deps.storage.write(this.deps.layout.user(user.id), JSON.stringify(user, null, 2), {
      contentType: 'application/json',
    });
  }

  private async saveToken(token: AgentToken): Promise<void> {
    this.tokens.set(token.id, token);
    await this.deps.storage.write(this.deps.layout.token(token.id), JSON.stringify(token, null, 2), {
      contentType: 'application/json',
    });
  }
}

/** A cookie's value from a Cookie header. */
export function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Only paths of this app: no open redirects after sign-in. */
export function safeReturnTo(returnTo: string | undefined): string {
  return returnTo && /^\/(?!\/)[\w\-./?=&%#:]*$/.test(returnTo) ? returnTo : '/';
}

export type { Actor };
