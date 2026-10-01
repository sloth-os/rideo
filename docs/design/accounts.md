# Accounts, roles and teams

Rideo started as a single-studio deployment with one optional bearer token. Accounts lift that: people sign in
with the studio's identity provider (OIDC), every project has members with a role, agents act through scoped
tokens on behalf of a person, and security-relevant events go to an audit log. Without an identity provider
configured, nothing changes: the configured user is the only user and may do everything.

## Modes

| Mode | When | Who is calling |
|---|---|---|
| `none` | no `RIDEO_OIDC_ISSUER`, no `RIDEO_API_TOKEN` | the configured user (`RIDEO_USER_ID`, `RIDEO_USER_NAME`), an admin |
| `token` | `RIDEO_API_TOKEN` only | the configured user, with the token |
| `oidc` | `RIDEO_OIDC_ISSUER` set | a signed-in person (session cookie), an agent token (bearer), or the studio token |

In `oidc` mode `RIDEO_API_TOKEN` remains a **studio token**: it acts as the configured user with admin rights
(automation, break-glass). `GET /api/auth/me` tells the web app the mode and who is calling.

## Sign-in (OIDC)

Authorization code flow with PKCE (S256), implemented with `node:crypto` (no OIDC library):

1. `GET /api/auth/login?returnTo=/p/…` reads the issuer's discovery document
   (`/.well-known/openid-configuration`, cached), keeps `state`, `nonce` and the PKCE verifier for ten minutes and
   redirects to the authorization endpoint (`RIDEO_OIDC_SCOPES`, default `openid profile email`).
2. `GET /api/auth/callback` exchanges the code at the token endpoint (`client_secret_basic` when
   `RIDEO_OIDC_CLIENT_SECRET` is set, else a public client) and verifies the ID token: signature against the
   issuer's JWKS (RS256, ES256), `iss`, `aud`, `exp`/`iat` (60 s skew) and `nonce`.
3. The user is found by `(issuer, sub)` or created: a new person may join when `RIDEO_OIDC_ALLOWED_DOMAINS` is
   empty or lists their email's domain; `RIDEO_ADMINS` (emails) are admins. A disabled user cannot sign in.
4. A session starts: a random 256-bit id in the `rideo_session` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` on
   https, 14 days, renewed on use). Only the id's SHA-256 is stored (`<dataDir>/sessions/`), so sessions
   survive restarts. `POST /api/auth/logout` ends it.

The web app sends people without a session to `/login` ("Sign in with …"); the live WebSocket and media URLs use
the same cookie.

## Users, roles and projects

Users live in the studio registry (`/rideo/accounts/users/<id>.json` on the storage backend):
`{id, issuer, sub, email, name, studioRole: "admin" | "member", disabled, createdAt, lastLoginAt}`.

Each project says who may do what in `project.json` (versioned like everything else):

```ts
access: {
  visibility: 'private' | 'studio',   // studio: every member of the studio reads and comments (reviewer)
  members: { userId: string; role: 'director' | 'editor' | 'reviewer' }[],
  invites: { email: string; role: …; invitedBy: string; at: string }[],  // become members at first sign-in
}
```

The person who creates a project is its director. Admins are directors of every project. Older projects have no
`access` and are readable by everyone, as before.

**Permissions** are one table (`PERMISSIONS` in `packages/shared/src/accounts`), checked the same way for REST,
MCP, the live WebSocket and editor jobs:

| Permission | Minimal role | Covers |
|---|---|---|
| `project.read` | reviewer | state, documents, media, history, jobs, exports, live updates |
| `project.comment` | reviewer | review comments and annotations ([review](review.md)) |
| `project.edit` | editor | documents, timeline, uploads, generation, exports, editor jobs |
| `project.approve` | director | workflow gates, clip approvals, take overrides |
| `project.manage` | director | settings, access (members, visibility), branches, deletion |

REST routes map to a permission declaratively (`ROUTE_PERMISSIONS`: method and path pattern → permission; reads
default to `project.read`, writes to `project.edit`); MCP tools declare theirs when they are registered. A call
without the permission fails with `forbidden` (403) and an `auth.denied` audit event. The project list only shows
projects the caller may read.

## Agent tokens

People create **scoped tokens** for agents (MCP clients, scripts): `POST /api/tokens {name, role, projectIds?,
expiresInDays?}` returns the secret once (`rdo_<id>_<secret>`; only its SHA-256 is stored, in
`/rideo/accounts/tokens/<id>.json`). A token acts as an `agent` **on behalf of** its owner: its role on a project is
the lower of the owner's role and the token's `role`, on the listed projects only (all of the owner's projects
when none are listed), until it expires or is revoked. Commits and activity name both (`Claude Code for Mira`).
Admins see and revoke every token.

## Audit log

Security-relevant events are appended as JSON lines to `<dataDir>/audit/<yyyy-mm-dd>.jsonl`:

| Event | When |
|---|---|
| `auth.login`, `auth.logout`, `auth.failed` | sign-in and sign-out |
| `auth.denied` | a call without the permission (who, what, which project) |
| `token.created`, `token.revoked` | agent tokens |
| `user.updated` | studio role, disabled |
| `project.access` | members, invites and visibility changed |
| `project.approval` | gates approved, clips approved, takes overridden |

`GET /api/audit?since&until&projectId&actor&type&limit` (admins; directors for their projects) reads it newest
first. Logins, denials and token use are also counted in `rideo_auth_total{event, outcome}`.

## Surfaces

| Surface | REST | MCP |
|---|---|---|
| who am I | `GET /api/auth/me` | – |
| sign in / out | `GET /api/auth/login`, `GET /api/auth/callback`, `POST /api/auth/logout` | – |
| members | `PUT /api/projects/:id/access` `{visibility?, members?, invites?}` | `project_access` |
| users | `GET /api/users`, `PATCH /api/users/:id` `{studioRole?, disabled?}` (admins) | – |
| tokens | `GET /api/tokens`, `POST /api/tokens`, `DELETE /api/tokens/:id` | – |
| audit | `GET /api/audit` | – |

The web app shows the signed-in person in the header (their tokens, admin pages, sign-out), a **Members** card in
the project overview (directors add people by email with a role, change roles, remove them, make the project
studio-visible), a **Tokens** page and, for admins, **People** (studio roles, disabling) and the **Audit log**.
Controls a person may not use are hidden or disabled (`can(permission)`).

## Limits

The embedded WebDAV server keeps one studio credential (`RIDEO_DAV_USERNAME` / `RIDEO_DAV_PASSWORD`): it is an
administrator's channel, not per-person.

## Testing

The mock gateway package also runs a **mock identity provider** (`startMockIdp`): discovery, an authorization
endpoint that signs in a chosen test user without a form, the token endpoint with PKCE checks and an RS256 JWKS.
