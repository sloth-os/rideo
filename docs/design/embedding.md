# The studio as a library: embedding and themes

The web app is also a package other projects can embed: `@rideo/web` exports the whole studio as a React component
and as a framework-free `mount` function, talking to a Rideo server that may be on another origin, routed inside the
host page, and themed to match it.

## Package

`npm run build:lib -w @rideo/web` builds `packages/web/dist-lib/`:

| File | What |
|---|---|
| `rideo.js` | ES module: `RideoStudio`, `mountRideo`, `defineTheme`, `THEME_TOKENS` |
| `rideo.d.ts` | types of the public API (`RideoOptions`, `RideoTheme`, `RideoHandle`) |
| `rideo.css` | the studio's styles, scoped to `.rideo-root` (below) |
| `assets/` | code-split chunks, the ffmpeg.wasm cores, the font the title renderer uses, the logo |

The build (`scripts/build-lib.mjs`) runs Vite with `vite.lib.config.ts`, scopes the stylesheet, emits the
declarations of `src/embed` only (it fails if they would refer to internal modules) and writes `dist-lib/package.json`,
so `npm publish packages/web/dist-lib` publishes exactly the library. In the monorepo, `@rideo/web`'s own
`package.json` maps `.` to `dist-lib/rideo.js` (with its types) and `./style.css` to `dist-lib/rideo.css`.

React 19 and React DOM are peer dependencies; everything else (the router, the stores, the editor engine,
`@rideo/shared`) is bundled, so the host's versions of those never meet the studio's. The library never touches the
host page outside its container: no service worker unless asked, no `<html>` attributes, no global styles.

The library works whether the host serves `dist-lib/` as it is or bundles it again:

- Files loaded by URL (the ffmpeg.wasm cores, the video font) are referenced as `new URL(<file>, import.meta.url)`,
  which Vite, Rollup and webpack 5 hosts copy into their own build. A host that serves the files elsewhere sets
  `assetsBase` (the build's `renderBuiltUrl` reads it at run time from `globalThis.__RIDEO_ASSETS__`).
- Module preload hints are off, so a host's bundler follows the imports and does not copy chunks as assets.
- ffmpeg.wasm's worker is passed to it explicitly (`@ffmpeg/ffmpeg/worker?worker&url`). A host bundler may inline that
  small script (or the multi-threaded core's thread worker) as a `data:` URL, whose opaque origin cannot load the core:
  the engine turns such a script into a `blob:` URL of the page's origin before starting it.
- A host on Vite's dev server excludes the package from dependency pre-bundling
  (`optimizeDeps: { exclude: ['@rideo/web'] }`), like any package that loads files by `import.meta.url`.

```tsx
import { RideoStudio } from '@rideo/web';
import '@rideo/web/style.css';

<RideoStudio
  server="https://studio.example.com/rideo/"
  token={() => session.rideoToken}
  routing={{ mode: 'browser', basename: '/video' }}
  theme={{ mode: 'light', colors: { accent: '#7c3aed' }, fonts: { sans: 'Geist, sans-serif' } }}
/>;
```

```js
import { mountRideo } from '@rideo/web';
const studio = mountRideo(document.getElementById('studio'), { server: '/rideo/', routing: { mode: 'hash' } });
studio.navigate('/p/prj_0123456789abcdef/editor');
studio.setTheme({ mode: 'dark' });
studio.unmount();
```

### Options

| Option | Default | Meaning |
|---|---|---|
| `server` | the page's own base URL | where the Rideo server is (`/api`, `/mcp`, the live channel); absolute or relative to the page |
| `token` | the token saved by the studio's sign-in, if any | a bearer token (an agent token, or the studio token) or a function returning one, for servers that need one |
| `routing.mode` | `browser` | `browser` (the URL, under `basename`), `hash` (`#/p/…`, nothing to configure on the host's server) or `memory` (the URL never changes) |
| `routing.basename` | `/` | the path the studio is mounted at in `browser` mode |
| `routing.initialPath` | `/` | the first route in `memory` mode |
| `onNavigate(path)` | – | called after every route change (to sync the host's own navigation) |
| `theme` | the server's studio theme (`RIDEO_THEME`), else Rideo's | [themes](#themes) |
| `assetsBase` | next to `rideo.js` | where `assets/` is served, when the host copies it elsewhere |
| `pwa` | `false` | register the studio's service worker (only when the studio owns its origin path) |
| `chrome.header` | `true` | `false` hides the studio's header, for hosts that bring their own navigation |

`mountRideo(element, options)` returns `{navigate(path), setTheme(theme), unmount()}`. One studio per page: its
stores are module singletons.

### Talking to a server on another origin

The server answers cross-origin calls from the origins in `RIDEO_CORS_ORIGINS` (comma-separated, or `*`; a setting in
the [Settings](settings.md) page): `Access-Control-Allow-Origin` for that origin, the methods the API uses, the headers
it reads (`authorization`, `content-type`, `range`, `x-rideo-workspace`, `x-rideo-coalesce`) and exposes
(`content-range`, `accept-ranges`, `content-length`, `content-disposition`), and `Cross-Origin-Resource-Policy:
cross-origin` on media so a cross-origin-isolated host can play it. Cookies are not sent cross-origin; such hosts pass a
`token`. The live channel accepts the same origins (the `Origin` header is checked on the upgrade).

[Browser storage](browser-storage.md) works embedded: projects go to the host origin's IndexedDB. The editor engine runs
multi-threaded when the host page is cross-origin isolated and single-threaded otherwise.

## Themes

The studio's look is a set of CSS custom properties ([brand](../brand.md#tokens)) on its root element,
`<div class="rideo-root" data-theme="dark|light">`. A theme overrides them:

```ts
interface RideoTheme {
  mode?: 'dark' | 'light' | 'system';          // the default mode (people can still switch)
  colors?: Partial<Record<ThemeColor, string>>; // both modes
  dark?: Partial<Record<ThemeColor, string>>;   // dark mode only
  light?: Partial<Record<ThemeColor, string>>;  // light mode only
  fonts?: { sans?: string; mono?: string };
  radius?: { control?: string; card?: string; dialog?: string };
  brand?: { name?: string; logoUrl?: string };  // the header's name and mark
}
type ThemeColor = 'bg' | 'surface' | 'surface-2' | 'border' | 'text' | 'muted' | 'accent' | 'accent-contrast'
  | 'success' | 'warning' | 'danger' | 'info';
```

`ThemeSchema` (`packages/shared/src/theme`) validates a theme wherever it enters: the library's option, the
`RIDEO_THEME` setting (JSON) and `/api/config` (`theme`), which carries the studio-wide theme to every tab. Colors are
CSS colors (`#rgb`, `#rrggbb`, `rgb()`, `hsl()`, `oklch()`); fonts and radii are CSS values without `;{}`.
`themeStyle(theme, mode)` turns a theme into the custom properties for one mode: the mode's own colors over the shared
ones over the brand defaults. When only `accent` is given, `accent-contrast` is picked (black or white, whichever
contrasts more), so a host never ships unreadable primary buttons.

Precedence, highest first: the library's `theme` option, the studio theme (`RIDEO_THEME`, Settings → Appearance),
Rideo's brand tokens. The person's own light/dark choice (the header's toggle, saved per browser) wins over a theme's
default `mode`.

## Styles scoped to the container

The standalone app and the library share one stylesheet (`src/styles/index.css`, Tailwind v4). For the library, a build
step (`scripts/scope-css.mjs`, PostCSS) rewrites it so it cannot affect the host page and the host's global styles do
not break the studio:

- every selector is scoped to the container: `.flex` → `.rideo-root .flex`; `:root`, `html`, `body` and `:host` →
  `.rideo-root`; `[data-theme=…]` → the root itself and anything inside it;
- cascade layers are flattened in their order (theme, base, components, utilities), so a host's unlayered element
  styles (`a { color: blue }`) do not beat the studio's layered utilities; the added class keeps the studio's rules
  ahead of the host's element selectors;
- `@keyframes`, `@property` and `@font-face` stay global; the studio's own keyframes are named `rideo-*`.

Dialogs, menus and toasts render inside the container, never in `document.body`, so they keep the theme.
