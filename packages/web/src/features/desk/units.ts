import {
  type AuthMe,
  type Character,
  cutText,
  DESK_UNIT_DATA_VERSION,
  DESK_UNIT_FORMAT,
  DESK_UNIT_LIBRARY_KIND,
  DESK_UNIT_LIMITS,
  type DeskBriefPinSlot,
  type DeskOpenUnit,
  type DeskPublishRefusal,
  type DeskUnitFileKind,
  type DeskUnitPin,
  type DeskUnitPublishMessage,
  deskText,
  type Element,
  LIBRARY_LIMITS,
  type LibraryUploadResult,
  libraryAllows,
  type ProjectDocs,
} from '@rideo/shared';
import { ApiError, getToken, type ProblemDetails } from '../../lib/api';
import { apiUrl } from '../../lib/runtime';
import { workspaceId } from '../../workspace/id';
import type { DeskUnitPublishOutcome } from './bridge';

/**
 * Library units in the desk, the studio's side (docs/design/director-desk.md#library-units): the unit files of an
 * `open`, fetched from the library and checked, and a `unit-publish` saved to the library and linked by the
 * contract's rule. The library's REST calls the desk needs live here; the library's own pages have theirs.
 */

/** How long a unit file may send nothing before it is left out of the open. */
export const DESK_UNIT_FETCH_IDLE_MS = 30_000;
/** Unit files fetched at once. */
export const DESK_UNIT_FETCHES = 2;

/** A request to the studio's API (`/api` + path) with the token and this browser's workspace. */
export type DeskApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** The studio's API, as `lib/api.ts` calls it: the token and the workspace on every request. */
export const deskApiFetch: DeskApiFetch = (path, init = {}) => {
  const token = getToken();
  return fetch(apiUrl(path), {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      // Browser storage (docs/design/browser-storage.md#routing-on-the-server): which browser asks
      'x-rideo-workspace': workspaceId(),
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
  });
};

/** The problem of a failed answer as the API client's `ApiError`. */
async function failure(res: Response): Promise<ApiError> {
  const body = await res.text().catch(() => '');
  let json: Partial<ProblemDetails> = {};
  try {
    json = body ? (JSON.parse(body) as Partial<ProblemDetails>) : {};
  } catch {
    json = { detail: body };
  }
  return new ApiError(
    res.status,
    {
      type: json.type ?? 'about:blank',
      title: json.title ?? res.statusText,
      status: res.status,
      detail: json.detail ?? res.statusText,
      code: json.code ?? 'internal_error',
      errors: json.errors,
    },
    res.headers ?? null,
  );
}

/** The sha256 of the bytes in lowercase hex (WebCrypto). */
export async function unitSha256(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether the person may publish to the library (`open.options.units.publish`): `libraryAllows(…, 'publish')` for the
 * signed-in principal. Without accounts (or before `me` arrives) the configured user may; the server decides anyway.
 */
export function deskPublishAllowed(me: AuthMe | null): boolean {
  if (me?.mode !== 'oidc' || !me.user) return true;
  return libraryAllows(
    {
      userId: me.user.id,
      admin: me.admin && !me.token,
      // the studio does not tell a token's projects: the server refuses a token limited to projects (403)
      token: me.token ? { role: me.token.role, projectIds: null } : null,
    },
    'publish',
  );
}

// ---------------------------------------------------------------- the files of an open

/** A pin whose file did not go in the open, and why (logged to the console, `[desk] …`). */
export interface DeskUnitLeftOut {
  slot: string;
  ref: string;
  version: number;
  why: 'failed' | 'timeout' | 'mismatch' | 'too_large' | 'over_budget' | 'cancelled';
  detail?: string;
}

export interface DeskUnitsFetched {
  /** The entries of `open.units`, in slot order. */
  units: DeskOpenUnit[];
  left: DeskUnitLeftOut[];
}

export interface DeskUnitFetchOptions {
  fetch?: DeskApiFetch;
  sha256?: (data: ArrayBuffer) => Promise<string>;
  /** Files finished (got or left out) of all. */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  idleMs?: number;
  /** What an open's files may weigh in all (48 MiB). */
  budget?: number;
}

/** The format and version a unit file's header names (`3DUNIT\r\n`, the header's length at 12, its JSON at 16). */
export function deskUnitHeader(data: ArrayBuffer): { format: string; version: number } | null {
  if (data.byteLength < 18) return null;
  const view = new DataView(data);
  const magic = new Uint8Array(data, 0, 8);
  if (String.fromCharCode(...magic) !== '3DUNIT\r\n') return null;
  const length = view.getUint32(12, true);
  if (length < 2 || 16 + length > data.byteLength || length > 64 * 1024) return null;
  try {
    const h = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 16, length))) as {
      format?: unknown;
      version?: unknown;
    };
    if (typeof h.format !== 'string' || !h.format || h.format.length > 64) return null;
    if (typeof h.version !== 'number' || !Number.isInteger(h.version) || h.version < 1) return null;
    return { format: h.format, version: h.version };
  } catch {
    return null;
  }
}

/** The body of an answer, at most `max` bytes, each chunk restarting the idle timer (`kick`). */
async function readBody(res: Response, max: number, kick: () => void): Promise<ArrayBuffer | 'too_large'> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const data = await res.arrayBuffer();
    return data.byteLength > max ? 'too_large' : data;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    kick();
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return 'too_large';
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

/**
 * The unit files of an open's pins (docs/design/director-desk.md#unit-bytes-in-open), from the library's file route,
 * `DESK_UNIT_FETCHES` at a time: a file whose bytes do not hash to its pin, that does not arrive (offline, an answer
 * other than `200`, nothing for 30 seconds) or that is over 32 MiB is left out; in slot order, the first file that
 * would take the open past 48 MiB, and every one after it, is left out too (no fetch starts for them).
 */
export async function fetchDeskUnits(
  pins: readonly DeskBriefPinSlot[],
  opts: DeskUnitFetchOptions = {},
): Promise<DeskUnitsFetched> {
  const call = opts.fetch ?? deskApiFetch;
  const hash = opts.sha256 ?? unitSha256;
  const idleMs = opts.idleMs ?? DESK_UNIT_FETCH_IDLE_MS;
  const budget = opts.budget ?? DESK_UNIT_LIMITS.openBytes;
  const total = pins.length;
  const results: (ArrayBuffer | { why: DeskUnitLeftOut['why']; detail?: string } | undefined)[] = new Array(
    total,
  );
  const controllers: (AbortController | null)[] = new Array(total).fill(null);
  let next = 0;
  let finished = 0;
  /** The first slot the budget cuts: it and every one after it are left out. */
  let cut = total;

  // in slot order, once every file before it is in: the first that would pass the budget is cut
  const settle = () => {
    let sum = 0;
    for (let i = 0; i < cut; i++) {
      const r = results[i];
      if (r === undefined) return;
      if (!(r instanceof ArrayBuffer)) continue;
      if (sum + r.byteLength > budget) {
        cut = i;
        for (let j = i; j < total; j++) controllers[j]?.abort();
        return;
      }
      sum += r.byteLength;
    }
  };

  const one = async (i: number) => {
    const { pin } = pins[i]!;
    const ctl = new AbortController();
    controllers[i] = ctl;
    const outer = () => ctl.abort();
    opts.signal?.addEventListener('abort', outer);
    let idle = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        idle = true;
        ctl.abort();
      }, idleMs);
    };
    kick();
    try {
      const res = await call(
        `/library/items/${encodeURIComponent(pin.ref)}/versions/${pin.version}/files/${pin.sha256}`,
        { signal: ctl.signal },
      );
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        results[i] = { why: 'failed', detail: `the library answered ${res.status}` };
        return;
      }
      kick();
      const data = await readBody(res, DESK_UNIT_LIMITS.unitBytes, kick);
      if (data === 'too_large') {
        results[i] = { why: 'too_large', detail: 'over 32 MiB' };
        return;
      }
      results[i] =
        (await hash(data)) === pin.sha256
          ? data
          : { why: 'mismatch', detail: 'the bytes do not hash to the pin' };
    } catch (err) {
      results[i] = idle
        ? { why: 'timeout', detail: `nothing arrived for ${Math.round(idleMs / 1000)} seconds` }
        : i >= cut
          ? { why: 'over_budget' }
          : opts.signal?.aborted
            ? { why: 'cancelled' }
            : { why: 'failed', detail: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', outer);
      controllers[i] = null;
    }
  };

  const worker = async () => {
    while (next < total) {
      const i = next++;
      if (i < cut && !opts.signal?.aborted) await one(i);
      finished += 1;
      settle();
      opts.onProgress?.(finished, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DESK_UNIT_FETCHES, total) }, worker));
  settle();

  const units: DeskOpenUnit[] = [];
  const left: DeskUnitLeftOut[] = [];
  pins.forEach(({ slot, pin }, i) => {
    const r = results[i];
    if (i < cut && r instanceof ArrayBuffer) {
      const header = deskUnitHeader(r);
      units.push({
        ref: pin.ref,
        version: pin.version,
        sha256: pin.sha256,
        unit: {
          format: header?.format ?? DESK_UNIT_FORMAT,
          version: header?.version ?? DESK_UNIT_DATA_VERSION,
          data: r,
        },
      });
      return;
    }
    const why =
      i >= cut
        ? 'over_budget'
        : r && !(r instanceof ArrayBuffer)
          ? r.why
          : opts.signal?.aborted
            ? 'cancelled'
            : 'failed';
    const detail = r && !(r instanceof ArrayBuffer) && i < cut ? r.detail : undefined;
    left.push({ slot, ref: pin.ref, version: pin.version, why, ...(detail ? { detail } : {}) });
  });
  return { units, left };
}

// ---------------------------------------------------------------- publishing and linking

/** What a publish is answered against. */
export interface DeskPublishContext {
  projectId: string;
  /** The clip the desk is open on: its scene's place is the `{set: true}` slot. */
  clipId: string;
  /** The open was read-only (an approved clip): a publish is never linked. */
  readOnly: boolean;
  /** The person may edit the project (`project.edit`). */
  mayEdit: boolean;
  docs: () => ProjectDocs | null;
}

export interface DeskPublishDeps {
  fetch?: DeskApiFetch;
  sha256?: (data: ArrayBuffer) => Promise<string>;
}

const NOUN: Record<DeskUnitFileKind, string> = { set: 'set', prop: 'prop', figure: 'figure' };

/** The refusal code of what the library answered (docs/design/director-desk.md#publishing-and-linking). */
export function deskPublishRefusal(err: unknown): DeskPublishRefusal {
  if (err instanceof ApiError) {
    if (err.status === 412) return 'conflict';
    if (err.status === 413) return 'too_large';
    if (err.status === 422) return 'invalid';
    if (err.status === 403) return 'refused';
    if (err.status === 503) return 'unavailable';
    return 'failed';
  }
  // offline, or a request the network did not carry (fetch rejects with a TypeError)
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'unavailable';
  if (err instanceof TypeError) return 'unavailable';
  return 'failed';
}

const own = <T>(record: Readonly<Record<string, T>>, id: string | null | undefined): T | undefined =>
  id && Object.hasOwn(record, id) ? record[id] : undefined;

/** The entity a publish's `from` names, or why there is none. */
function linkTarget(
  msg: DeskUnitPublishMessage,
  docs: ProjectDocs | null,
  clipId: string,
):
  | {
      target: { kind: 'character' | 'element'; id: string };
      name: string;
      label: string;
      pin: DeskUnitPin | null;
    }
  | string {
  const from = msg.from;
  if (!from || !docs) return 'it comes from no place, character or prop of the scene';
  if (from.set) {
    const clip = own(docs.clips, clipId);
    const scene = clip?.sceneId ? docs.screenplay?.scenes.find((s) => s.id === clip.sceneId) : undefined;
    const place: Element | undefined = own(docs.elements, scene?.locationId);
    if (!place) return 'the scene has no place';
    return {
      target: { kind: 'element', id: place.id },
      name: place.name,
      label: `the scene's place (${place.name})`,
      pin: place.deskUnit ?? null,
    };
  }
  if (from.castId) {
    const character: Character | undefined = own(docs.characters, from.castId);
    if (!character) return 'the character is not in the project any more';
    return {
      target: { kind: 'character', id: character.id },
      name: character.name,
      label: character.name,
      pin: character.deskUnit ?? null,
    };
  }
  const element: Element | undefined = own(docs.elements, from.elementId);
  if (!element) return 'the prop is not in the project any more';
  return {
    target: { kind: 'element', id: element.id },
    name: element.name,
    label: element.name,
    pin: element.deskUnit ?? null,
  };
}

/**
 * A `unit-publish` (docs/design/director-desk.md#publishing-and-linking): the bytes checked against its sha256, a new
 * item or a new version of `newVersionOf` (`basedOn` its version) published through the library, the digest the
 * server computed checked again, then linked by the contract's rule (not read-only, the person may edit, the entity of
 * `from` unpinned or pinning the same item) with an apply in mode `pin` that never replaces another item's pin (one
 * commit). The answer is the `unit-ack` and what the panel says.
 */
export async function publishDeskUnit(
  msg: DeskUnitPublishMessage,
  ctx: DeskPublishContext,
  deps: DeskPublishDeps = {},
): Promise<DeskUnitPublishOutcome> {
  const call = deps.fetch ?? deskApiFetch;
  const refuse = (code: DeskPublishRefusal, message: string): DeskUnitPublishOutcome => {
    const said = deskText(message).slice(0, 2000) || code;
    return {
      ack: { type: 'unit-ack', id: msg.id, ok: false, code, message: said },
      notice: `Not saved to the library: ${said}`,
      level: 'warning',
    };
  };
  if ((await (deps.sha256 ?? unitSha256)(msg.unit.data)) !== msg.sha256)
    return refuse('invalid', "the unit's bytes do not hash to its sha256");

  const kind = DESK_UNIT_LIBRARY_KIND[msg.kind];
  const unit = { format: msg.unit.format, formatVersion: msg.unit.version, meta: msg.meta };
  // a new version keeps its item's name (the message's only names the file); its description is the version's note
  const note = cutText(msg.description?.trim() ?? '', LIBRARY_LIMITS.note);
  const meta = msg.newVersionOf
    ? { kind, unit, basedOn: msg.newVersionOf.version, ...(note ? { note } : {}) }
    : {
        kind,
        name: msg.name,
        ...(msg.description ? { description: msg.description } : {}),
        unit,
      };
  const form = new FormData();
  form.append('meta', JSON.stringify(meta));
  form.append('payload', new Blob([msg.unit.data], { type: 'application/octet-stream' }), 'unit.bin');
  if (msg.thumbnail)
    form.append('thumbnail', new Blob([msg.thumbnail.data], { type: 'image/png' }), 'thumbnail.png');
  let published: LibraryUploadResult;
  try {
    const res = await call(
      msg.newVersionOf
        ? `/library/items/${encodeURIComponent(msg.newVersionOf.ref)}/versions`
        : '/library/items',
      { method: 'POST', body: form },
    );
    if (!res.ok) throw await failure(res);
    published = (await res.json()) as LibraryUploadResult;
  } catch (err) {
    return refuse(
      deskPublishRefusal(err),
      err instanceof ApiError
        ? err.message
        : deskPublishRefusal(err) === 'unavailable'
          ? 'the studio cannot be reached'
          : err instanceof Error
            ? err.message
            : String(err),
    );
  }
  if (published.version.digest !== msg.sha256)
    return refuse('invalid', 'the library stored other bytes than the desk sent');

  const ref = published.item.id;
  const version = published.version.version;
  const saved = published.unchanged
    ? `${published.item.name} v${version} is already in the library`
    : `Saved ${published.item.name} v${version} to the library`;
  const linked = await linkUnit(msg, ctx, call, ref, version);
  return {
    ack: {
      type: 'unit-ack',
      id: msg.id,
      ok: true,
      ref,
      version,
      linked: linked.linked,
      ...(linked.linked ? {} : { message: deskText(linked.reason).slice(0, 2000) }),
    },
    notice: linked.linked ? `${saved}; linked to ${linked.label}` : `${saved}; not linked: ${linked.reason}`,
    level: linked.linked ? 'success' : 'info',
  };
}

/** The link of a published version, by the contract's rule; `reason` says why not. */
async function linkUnit(
  msg: DeskUnitPublishMessage,
  ctx: DeskPublishContext,
  call: DeskApiFetch,
  ref: string,
  version: number,
): Promise<{ linked: true; label: string } | { linked: false; reason: string }> {
  if (ctx.readOnly) return { linked: false, reason: 'the scene is read-only' };
  if (!ctx.mayEdit) return { linked: false, reason: 'you may not edit this project' };
  const target = linkTarget(msg, ctx.docs(), ctx.clipId);
  if (typeof target === 'string') return { linked: false, reason: target };
  // a publish never re-points an entity that uses another item
  if (target.pin && target.pin.itemId !== ref)
    return {
      linked: false,
      reason: `${target.name} uses another library ${NOUN[msg.kind]} (${target.pin.name})`,
    };
  try {
    const res = await call(`/projects/${encodeURIComponent(ctx.projectId)}/library/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId: ref, version, target: target.target, replacePin: false }),
    });
    if (!res.ok) throw await failure(res);
    return { linked: true, label: target.label };
  } catch (err) {
    // someone pinned another item meanwhile: the rule again; any other failure says what it was
    if (err instanceof ApiError && err.status === 409) return { linked: false, reason: err.message };
    return {
      linked: false,
      reason: `the link failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
