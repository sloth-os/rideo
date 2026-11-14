/**
 * The 3D-Editor's director's desk embedded in the studio (docs/design/director-desk.md): the brief rideo makes of a
 * clip, the plan of a desk's result, the desk's setting and the bridge's timings.
 */
import { cutText } from './brief';

export * from './brief';
export * from './result';

/** No `hello` this long after the iframe's `load`: the desk did not answer (docs/design/director-desk.md#the-desk). */
export const DESK_HELLO_TIMEOUT_MS = 15_000;
/**
 * While the desk stays open, its newest state is stored at most this often, when it changed: every state is a media
 * file kept until the project is deleted (docs/design/director-desk.md#when-rideo-stores-it).
 */
export const DESK_STATE_WRITE_INTERVAL_MS = 10 * 60_000;
/**
 * A state write that failed is tried again after this, then after twice as long each time, at most
 * `DESK_STORE_RETRY_MAX_MS`, whatever states arrive meanwhile (docs/design/director-desk.md#when-rideo-stores-it).
 */
export const DESK_STORE_RETRY_MS = 30_000;
export const DESK_STORE_RETRY_MAX_MS = 10 * 60_000;
/** Closing waits at most this long for the last state's write, then aborts it (docs/design/director-desk.md#the-desk). */
export const DESK_CLOSE_STORE_TIMEOUT_MS = 10_000;
/** Text the desk supplies is cut to this many characters wherever the studio shows it (status line, toasts). */
export const DESK_TEXT_MAX = 300;

/** Text the desk supplied, cut to `DESK_TEXT_MAX` characters (an ellipsis says it was cut). */
export function deskText(text: string, max = DESK_TEXT_MAX): string {
  return text.length <= max ? text : `${cutText(text, max - 1)}…`;
}

/**
 * What is wrong with a desk URL (`RIDEO_DESK_URL`, docs/design/director-desk.md#the-setting), or null: an https: page,
 * or an http: one on localhost or 127.0.0.1 (both pages must be secure contexts), the page itself, not a folder.
 */
export function deskUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return 'a URL like https://desk.example.com/desk.html';
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    return 'an https:// URL (http:// only on localhost or 127.0.0.1)';
  if (url.username || url.password) return 'a URL without a user name or password';
  if (url.pathname.endsWith('/')) return 'the desk page itself (…/desk.html), not a folder';
  return null;
}

/** The origin a desk URL is served from: the only origin the bridge posts to and accepts messages from. */
export function deskOrigin(url: string): string {
  return new URL(url).origin;
}

/**
 * What is wrong with a desk on the studio's own host, or null (docs/design/director-desk.md#topology-and-headers):
 * browsers keep cookies per host, not per port, so a desk on any port of the studio's host name gets the studio's
 * host-only session cookie with every request. Checked when accounts are on (`RIDEO_OIDC_ISSUER`).
 */
export function deskHostProblem(deskUrl: string, studioUrl: string): string | null {
  let desk: string;
  let studio: string;
  try {
    desk = new URL(deskUrl.trim()).hostname.toLowerCase();
    studio = new URL(studioUrl.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  return desk === studio
    ? `a desk on another host than the studio's (${studio}): with accounts on, browsers send the studio's session cookie to every port of its host`
    : null;
}
