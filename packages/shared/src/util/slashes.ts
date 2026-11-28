/**
 * Slashes trimmed from the ends of URLs and paths in time linear in their length
 * (docs/design/settings.md#where-values-come-from, docs/design/subpath.md#the-base-path). A regular expression such as
 * `/\/+$/` or `/^\/+|\/+$/g` backtracks: on a run of slashes followed by another character it tries every slash of the
 * run as the start of a match, which takes time quadratic in the run's length (about 17 s for 200,000 slashes).
 */
const SLASH = 0x2f;

/** `s` without its trailing slashes: `'/a/b//'` is `'/a/b'`, `'///'` is `''`. */
export function withoutTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === SLASH) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** `s` without its leading and trailing slashes: `'//a/b/'` is `'a/b'`, `'///'` is `''`. */
export function withoutEdgeSlashes(s: string): string {
  let start = 0;
  while (start < s.length && s.charCodeAt(start) === SLASH) start++;
  let end = s.length;
  while (end > start && s.charCodeAt(end - 1) === SLASH) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}
