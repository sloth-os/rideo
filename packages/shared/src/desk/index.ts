/**
 * The 3D-Editor's director's desk embedded in the studio (docs/design/director-desk.md): the brief rideo makes of a
 * clip, the plan of a desk's result, the desk's setting and the bridge's timings.
 */
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
