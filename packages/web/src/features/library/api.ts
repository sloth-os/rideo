import {
  type LibraryApplyInput,
  type LibraryApplyResult,
  LibraryApplyResultSchema,
  type LibraryDetachInput,
  type LibraryDetachResult,
  LibraryDetachResultSchema,
  type LibraryItem,
  type LibraryItemPatch,
  LibraryItemSchema,
  type LibraryKind,
  type LibraryListResult,
  LibraryListResultSchema,
  type LibraryProjectStatus,
  LibraryProjectStatusSchema,
  type LibrarySaveInput,
  type LibrarySaveResult,
  LibrarySaveResultSchema,
  type LibraryUses,
  LibraryUsesSchema,
  type LibraryVersion,
  LibraryVersionSchema,
} from '@rideo/shared';
import { ApiError, getToken, type ProblemDetails } from '../../lib/api';
import { apiUrl } from '../../lib/runtime';
import { workspaceEnabled, workspaceId } from '../../workspace/id';

/**
 * The studio library's REST client for the library's own pages (docs/design/library.md#surfaces,
 * docs/api/rest.md#library): the list, an item and its versions, its uses, changes by its manager, and a project's
 * save, apply (use, update, link, pin), detach and status. Answers are checked against the shared schemas. The desk's
 * own calls (unit files, publishing) live with the desk (`features/desk/units.ts`).
 */

/** What a list asks for (`GET /api/library/items`). */
export interface LibraryQuery {
  kinds?: readonly LibraryKind[] | null;
  tag?: string | null;
  q?: string | null;
  /** true: archived items too. */
  archived?: boolean;
  sort?: 'updated' | 'name';
  limit?: number;
  cursor?: string | null;
}

/** A schema the answer is checked against (the shared zod schemas). */
interface Checked<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { message: string } };
}

/** A request to the studio's API with the token and this browser's workspace, as `lib/api.ts` sends them. */
function send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const token = getToken();
  return fetch(apiUrl(path), {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      // Browser storage (docs/design/browser-storage.md#routing-on-the-server): which browser asks
      'x-rideo-workspace': workspaceId(),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The answer's JSON, checked; a refusal as the API client's `ApiError` (its `code`, `errors` and headers). */
async function call<T>(
  method: string,
  path: string,
  schema: Checked<T>,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const res = await send(method, path, body, headers);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { detail: text };
  }
  if (!res.ok) {
    const problem = (json ?? {}) as Partial<ProblemDetails>;
    throw new ApiError(
      res.status,
      {
        type: problem.type ?? 'about:blank',
        title: problem.title ?? res.statusText,
        status: res.status,
        detail: problem.detail ?? res.statusText,
        code: problem.code ?? 'internal_error',
        errors: problem.errors,
      },
      res.headers ?? null,
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success)
    throw new Error(
      `The studio answered ${method} ${path} with something unexpected: ${parsed.error.message}`,
    );
  return parsed.data;
}

/** The query string of a list. */
export function listQuery(query: LibraryQuery = {}): string {
  const q = new URLSearchParams();
  if (query.kinds?.length) q.set('kinds', query.kinds.join(','));
  if (query.tag) q.set('tag', query.tag);
  if (query.q?.trim()) q.set('q', query.q.trim());
  if (query.archived) q.set('archived', 'true');
  if (query.sort) q.set('sort', query.sort);
  if (query.limit) q.set('limit', String(query.limit));
  if (query.cursor) q.set('cursor', query.cursor);
  const s = q.toString();
  return s ? `?${s}` : '';
}

const item = (itemId: string) => `/library/items/${encodeURIComponent(itemId)}`;
const project = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/library`;

export const libraryApi = {
  list: (query: LibraryQuery = {}): Promise<LibraryListResult> =>
    call('GET', `/library/items${listQuery(query)}`, LibraryListResultSchema),
  get: (itemId: string): Promise<LibraryItem> => call('GET', item(itemId), LibraryItemSchema),
  version: (itemId: string, version: number): Promise<LibraryVersion> =>
    call('GET', `${item(itemId)}/versions/${version}`, LibraryVersionSchema),
  /** The manager's change; `rev` sends `If-Match` (a stale one is `412` `library_conflict`). */
  update: (itemId: string, patch: LibraryItemPatch, rev?: number): Promise<LibraryItem> =>
    call('PATCH', item(itemId), LibraryItemSchema, patch, rev ? { 'if-match': `"r${rev}"` } : {}),
  uses: (itemId: string): Promise<LibraryUses> => call('GET', `${item(itemId)}/uses`, LibraryUsesSchema),
  status: (projectId: string): Promise<LibraryProjectStatus> =>
    call('GET', project(projectId), LibraryProjectStatusSchema),
  save: (projectId: string, input: LibrarySaveInput): Promise<LibrarySaveResult> =>
    call('POST', `${project(projectId)}/save`, LibrarySaveResultSchema, input),
  apply: (projectId: string, input: Partial<LibraryApplyInput> & Pick<LibraryApplyInput, 'itemId'>) =>
    call<LibraryApplyResult>('POST', `${project(projectId)}/apply`, LibraryApplyResultSchema, input),
  detach: (projectId: string, input: LibraryDetachInput): Promise<LibraryDetachResult> =>
    call('POST', `${project(projectId)}/detach`, LibraryDetachResultSchema, input),
};

/**
 * A version's file for elements that load it themselves (`<img>`): the token and the workspace ride in the query, as
 * media URLs do. Immutable, so the browser's cache serves it again.
 */
export function libraryFileUrl(itemId: string, version: number, sha256: string): string {
  const q = new URLSearchParams();
  const token = getToken();
  if (token) q.set('token', token);
  if (workspaceEnabled()) q.set('ws', workspaceId());
  const qs = q.toString();
  return apiUrl(`${item(itemId)}/versions/${version}/files/${sha256}${qs ? `?${qs}` : ''}`);
}

/** The item's current thumbnail, or null. */
export function libraryThumbnailUrl(i: Pick<LibraryItem, 'id' | 'thumbnail'>): string | null {
  return i.thumbnail ? libraryFileUrl(i.id, i.thumbnail.version, i.thumbnail.hash) : null;
}
