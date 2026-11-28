# Serving under a subpath

Rideo can live under a path of another site, behind Caddy, nginx or Apache httpd: `https://example.com/rideo/`
serves the studio, its API, `/mcp`, the live channel, the embedded `/dav`, the service worker and the media, with the
same build of the web app as at the root.

## The base path

A request's pages and links are written with its base path, taken from the first of:

| Source | Example | Precedence |
|---|---|---|
| `X-Forwarded-Prefix` request header (sent by the proxy) | `/rideo` | per request, highest |
| `RIDEO_BASE_PATH` | `/rideo` | |
| the path of `RIDEO_PUBLIC_URL` | `https://example.com/rideo` → `/rideo` | |
| none | | the root |

A base path is a slash followed by path segments of `A-Z a-z 0-9 . _ ~ -`, at most 256 characters, without a trailing
slash. The configured one (`RIDEO_BASE_PATH`, or the path of `RIDEO_PUBLIC_URL`) also has a first segment that is none
of the studio's own top-level paths: its routes (`api`, which holds the health checks and the live channel, `mcp`,
`metrics`), the built-in WebDAV server (`dav`), and the top of the web app's build, which the server answers at the
root (`assets`, `icons`, `index.html`, `logo.svg`, `manifest.webmanifest`, `sw.js`, `sw.js.map`). The configured base
path is removed from paths, and under such a base a path could be read two ways: with `RIDEO_BASE_PATH=/api`, a request
that keeps `/api/settings` as it came reaches the settings, whatever a proxy's rule says about `/api/api/settings`.
`/api-docs` and `/apis` are fine. The base in `X-Forwarded-Prefix` may start with one of the studio's own paths (a
stripping proxy at `/mcp/`): a request that carries the header is routed as it came and the header's value is never
removed from a path, so no path is read two ways. What is not a base path:

- in `RIDEO_BASE_PATH`, stops the server at start with the rule it breaks (`a path of at most 256 characters`,
  `a path like /rideo …`, `a path whose first segment is not one of the studio's own …`);
- in the path of `RIDEO_PUBLIC_URL`, is not used as the base path: the studio serves at the root and logs a warning at
  start that says why and what can serve it under that path. A path whose first segment is one of the studio's own
  (`https://example.com/mcp`) is served under that path only behind a stripping proxy that sends it in
  `X-Forwarded-Prefix`; `RIDEO_BASE_PATH` cannot be such a path. A path over 256 characters or with other characters
  is served under that path by nothing, since the header follows the same rules: give `RIDEO_PUBLIC_URL` a path like
  `/rideo`;
- in `X-Forwarded-Prefix`, is ignored as a base (`//evil.example`, `..`, query strings), so the header cannot steer
  redirects off the site. A value longer than 256 characters is ignored as a base before it is read any further; like
  any `X-Forwarded-Prefix`, it still means the request came through a stripping proxy, so nothing is removed from its
  path ([both proxy styles](#both-proxy-styles)).

Reading a base path takes time linear in its length, and so does reading the URL settings (`RIDEO_PUBLIC_URL`,
`RIDEO_CORS_ORIGINS`, `MM_GATEWAY_URL`, the WebDAV URL and root, the OIDC issuer, API base URLs): their slashes are
trimmed by a loop, so a run of slashes costs no more than any other character. Without `RIDEO_PUBLIC_URL`, the
studio's public URL is `http://localhost:<port><base>`.

### Both proxy styles

A proxy either **strips** the prefix (nginx `proxy_pass http://rideo:8787/;`, Caddy `handle_path`) or **keeps** it
(nginx `proxy_pass http://rideo:8787;`, Caddy `handle`). The server accepts both:

- **A stripping proxy** sets `X-Forwarded-Prefix` itself, replacing what the client sent (the configurations below
  do), and delivers it whatever the client sends ([below](#a-stripping-proxy-delivers-its-header)). A request that
  carries the header is routed as it came, and its pages and links are written with the header's base. One that
  arrives without the header is taken for a keeping proxy's: with a configured base path, the client's
  `/rideo/rideo/metrics` would arrive as `/rideo/metrics` and reach `/metrics`.
- **A keeping proxy** forwards `/rideo/…` as it came and sends no `X-Forwarded-Prefix`; the server needs its base path
  from `RIDEO_BASE_PATH` or a `RIDEO_PUBLIC_URL` with the path. Before routing (in the HTTP server factory, so
  Fastify, the WebSocket upgrade and the embedded `/dav` all see the same path), a request without the header has
  that configured base path removed, once, from the front of its path. Such a proxy must drop a client's
  `X-Forwarded-Prefix` ([the directive of each proxy](#upgrading-from-an-earlier-version)): a request that brings one
  keeps the prefix on its path and reaches no route.

The server never removes the header's value from a path, nor a prefix twice. So a client cannot re-root the studio
under a prefix of its choice (`X-Forwarded-Prefix: /x` with `/x/metrics` is not `/metrics`), a path the proxy stripped
is not stripped again (behind a stripping proxy at `/rideo` with `RIDEO_PUBLIC_URL=https://example.com/rideo`,
`/rideo/rideo/metrics` reaches `/rideo/metrics`, which no route serves), and, since no configured base path starts with
one of the studio's own paths, a proxy rule that denies a path under the prefix
(`location /rideo/metrics { deny all; }`) holds on the server too, as long as a stripping proxy delivers its header.
Requests in absolute form (`GET http://host/rideo/api/projects`) are not stripped either: they reach no route under the
base path, and the routes they do reach (`http://host/api/projects`) ask for credentials like any other.

#### A stripping proxy delivers its header

A stripping proxy must deliver its `X-Forwarded-Prefix` whatever the client sends, including the headers a client
names in `Connection`. A proxy that follows HTTP's hop-by-hop rule drops every header the client lists there
(`Connection: X-Forwarded-Prefix`); if it drops the one it set itself, the request arrives as a keeping proxy's would,
and the configured base path is removed from it: `/rideo/rideo/metrics` reaches `/metrics` past the proxy's rule for
`/rideo/metrics`. Tested with the configurations below and deny rules under the prefix, for `Connection` naming the
header in any case, alone or in a list (commas, `;`, tabs, several `Connection` lines, with `close`, `keep-alive` or
`Upgrade`):

| Proxy (stripping the prefix) | Delivers its `X-Forwarded-Prefix` when a client names it in `Connection` |
|---|---|
| nginx 1.24 | yes: `proxy_set_header Connection` replaces the client's `Connection`, and nginx drops no header it names |
| Caddy v2.11.9 | yes: `header_up` sets the header after the headers the client names are dropped |
| Apache httpd 2.4.58 | only with `RequestHeader unset Connection "expr=req_novary('Connection') =~ /x-forwarded-prefix/i"`: mod_proxy_http drops the headers a client names in `Connection` after mod_headers has set `X-Forwarded-Prefix`, so the configuration removes such a `Connection` header first |

The Apache line removes the client's `Connection` only when it names `X-Forwarded-Prefix` (in any case, anywhere in
it, so in every form mod_proxy_http would read as that name; the `close` or `keep-alive` of such a client goes with
it). Removing it from every request also works, but then Apache ignores a client's `Connection: close` (it keeps the
connection open) and an HTTP/1.0 client's `keep-alive` (it closes the connection after each answer). Either way the
live channel still upgrades (`upgrade=websocket` follows the `Upgrade` header), and uploads (512 MiB, with a length or
chunked) and HTTP/2 requests, which carry no `Connection` header, are not affected.

### Upgrading from an earlier version

Earlier versions also removed the base path from requests that carried `X-Forwarded-Prefix`, so a proxy that kept the
prefix and sent the header worked. Now a request that carries the header is routed as it came, and a proxy must be
set up as follows:

- **A proxy that strips the prefix must send `X-Forwarded-Prefix`**, replacing any a client sent (the
  [configurations below](#proxy-configurations) do). A request without the header is taken for one from a keeping
  proxy.
- **A proxy that keeps the prefix must not send `X-Forwarded-Prefix`, must drop a client's, and needs
  `RIDEO_BASE_PATH`** (or a `RIDEO_PUBLIC_URL` with the path). A request that carries the header keeps the prefix on
  its path and reaches no route: the API answers with the app's page and the live channel does not upgrade.

| Proxy (keeping the prefix) | Drops a client's `X-Forwarded-Prefix` |
|---|---|
| nginx (`proxy_pass http://127.0.0.1:8787;`) | `proxy_set_header X-Forwarded-Prefix "";` in the `location`, beside its other `proxy_set_header` lines (an empty value is not sent; without it nginx passes the client's on, and nginx takes `proxy_set_header` lines from an outer block only when the `location` has none) |
| Caddy (`handle /rideo/*` with `reverse_proxy`) | `header_up -X-Forwarded-Prefix` |
| Apache httpd (`ProxyPass /rideo/ http://127.0.0.1:8787/rideo/`) | `RequestHeader unset X-Forwarded-Prefix` |

A request that carries `X-Forwarded-Prefix` and whose path starts with the configured base path, or with the header's
own base path, is what a keeping proxy that sends the header produces, so the server logs a warning, at most once
every 10 minutes per server: if the proxy keeps the prefix in paths, it must not send `X-Forwarded-Prefix` and must
drop a client's (with the directives above). A header base whose first segment is one of the studio's own paths is no
such sign: behind a stripping proxy at `/api/`, the app's own requests have paths under it (`/api/api/projects`
arrives as `/api/projects`), so with such a header only the configured base path is a sign. The line carries `base`,
the base path the path starts with (always a valid one, never the header's text), `signal`, which base that is
(`configured` or `header`), and `method`, the request's method; never the rest of the path or the query, which can
hold a share link's secret (`/review/<project>.<review>.<secret>`) or a `token`. Behind a stripping proxy that sends
the header, a client that asks for a doubled prefix (`/rideo/rideo/…`) causes the same line; the proxy is right and
nothing needs to change. So does a visit to one of the app's pages when the base path has that page's name (base
`/library`: the library page is `/library/library`, which arrives as `/library`), so there the line can come back
every 10 minutes though the proxy is right.

### What the server writes with the base

| Output | With base `/rideo` |
|---|---|
| `index.html` (every page of the app) | `<base href="/rideo/">`, injected per request; served with `cache-control: no-cache` |
| redirects (sign-in, errors) | `Location: /rideo/login?…`, `/rideo/p/prj_…` |
| the session cookie | `Path=/rideo` |
| links in MCP results, share links, the WebDAV URL, interchange media | from the public URL: `https://example.com/rideo/review/…`, `…/rideo/dav/` |
| OIDC redirect URI | `https://example.com/rideo/api/auth/callback` (register this one at the identity provider) |
| the embedded WebDAV server's `href`s | under `/rideo/dav/`, so Finder and Explorer can follow them |

## The web app

The app is built with a relative base (`vite build`, `base: './'`), so its HTML, scripts, styles, the ffmpeg.wasm
cores and the fonts load relative to the document's `<base>`. At start the app reads its runtime base from
`document.baseURI` (`packages/web/src/lib/runtime.ts`) and derives everything from it:

| Use | URL |
|---|---|
| API and media | `<base>api/…` |
| live channel | `ws(s)://<host><base>api/live` |
| router | `BrowserRouter basename="/rideo"`: routes stay `/p/:projectId/:view`, links and redirects get the prefix |
| service worker | `<base>sw.js`, scope `<base>`; its shell files, its strategy and notification links are relative to the scope |
| manifest | `<base>manifest.webmanifest` with relative `start_url`, `scope`, icons and shortcuts |
| MCP command shown in the Overview | `claude mcp add --transport http rideo <origin><base>mcp` |

The Vite dev server runs at the root and proxies `/api`, `/mcp`, `/dav` to the server; a subpath is a deployment
concern and is covered by the end-to-end suite against the built app.

## Proxy configurations

Copy-ready files are in `deploy/`: `deploy/caddy/Caddyfile`, `deploy/nginx/rideo.conf`, `deploy/httpd/rideo.conf`.
Each serves `/rideo/` and redirects `/rideo` to it, strips the prefix and sets `X-Forwarded-Prefix` itself (over any a
client sent, and whatever the client names in `Connection`: [a stripping proxy delivers its
header](#a-stripping-proxy-delivers-its-header)), forwards WebSocket upgrades (`/api/live`, MCP streams), does not
buffer uploads or media, and allows long requests (editor-job uploads, exports).

```caddy
# Caddy: handle_path strips /rideo; the header tells Rideo where it lives
example.com {
	redir /rideo /rideo/ 308
	handle_path /rideo/* {
		reverse_proxy 127.0.0.1:8787 {
			header_up X-Forwarded-Prefix /rideo
			flush_interval -1
		}
	}
}
```

```nginx
# nginx: the trailing slash on proxy_pass strips /rideo
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
location = /rideo { return 308 /rideo/; }
location /rideo/ {
    proxy_pass http://127.0.0.1:8787/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Prefix /rideo;
    proxy_buffering off;
    proxy_request_buffering off;
    client_max_body_size 0;
    proxy_read_timeout 1h;
}
```

```apache
# Apache httpd 2.4.47+ (mod_proxy, mod_proxy_http, mod_headers, mod_rewrite)
RewriteEngine On
RewriteRule ^/rideo$ /rideo/ [R=308,L]
ProxyPreserveHost On
RequestHeader set X-Forwarded-Prefix "/rideo"
# mod_proxy_http drops the headers a client names in Connection: one that names X-Forwarded-Prefix goes first
RequestHeader unset Connection "expr=req_novary('Connection') =~ /x-forwarded-prefix/i"
ProxyPass        /rideo/ http://127.0.0.1:8787/ upgrade=websocket flushpackets=on timeout=3600
ProxyPassReverse /rideo/ http://127.0.0.1:8787/
```

Set `RIDEO_PUBLIC_URL=https://example.com/rideo` as well, so links that leave the browser (share links, MCP results,
the OIDC redirect URI) carry the full address.

## Cross-origin isolation behind a proxy

The studio sends `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` with its pages
([engine performance](engine-performance.md#cross-origin-isolation-and-multi-threaded-ffmpegwasm)). Under a subpath of
a larger site they apply to the studio's pages only; other pages of the site are not affected. A proxy must pass the
headers through (all three examples do).
