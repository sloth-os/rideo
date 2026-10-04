// Scopes the studio's stylesheet to its container for the library build (docs/design/embedding.md#styles-scoped-to-the-container):
// every selector inside `.rideo-root`, `:root`/`html`/`body`/`:host` as the root itself, `[data-theme]` on the root
// and inside it, cascade layers flattened in their order. Keyframes, @property and @font-face stay global.
import postcss from 'postcss';

export const ROOT_CLASS = 'rideo-root';
const ROOT = `.${ROOT_CLASS}`;

/** One selector in, the scoped selectors out. */
export function scopeSelector(selector) {
  const s = selector.trim();
  if (!s) return [s];
  // relative to an outer rule (CSS nesting), or already the studio's own
  if (s.includes('&') || s === ROOT || s.startsWith(`${ROOT} `) || /^\.rideo-root[.:[#>+~]/.test(s))
    return [s];
  // the document's root, the shadow host, html and body: the studio's root element itself
  const own = /^(?::root|:host|html|body)(?=$|[\s.:#[>+~])/.exec(s);
  if (own) return [`${ROOT}${s.slice(own[0].length)}`];
  // the theme attribute sits on the root itself, and may on elements inside it
  if (s.startsWith('[data-theme')) return [`${ROOT}${s}`, `${ROOT} ${s}`];
  return [`${ROOT} ${s}`];
}

/** Scoped CSS of a stylesheet. */
export function scopeCss(code) {
  const root = postcss.parse(code);
  // flatten cascade layers in their order: a host's unlayered styles would beat layered ones
  root.walkAtRules('layer', (rule) => {
    if (rule.nodes?.length) rule.replaceWith(rule.nodes);
    else rule.remove();
  });
  root.walkRules((rule) => {
    const parent = rule.parent;
    if (parent?.type === 'atrule' && /keyframes$/i.test(parent.name)) return;
    rule.selectors = [...new Set(rule.selectors.flatMap(scopeSelector))];
  });
  return root.toString();
}
