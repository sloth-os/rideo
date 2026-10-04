# Serving under a subpath

Rideo can live under a path of another site, behind Caddy, nginx or Apache httpd: `https://example.com/rideo/`
serves the studio, its API, `/mcp`, the live channel, the embedded `/dav`, the service worker and the media, with the
same build of the web app as at the root.

## The base path

| Source | Example | Precedence |
|---|---|---|
| `X-Forwarded-Prefix` request header (sent by the proxy) | `/rideo` | per request, highest |
| `RIDEO_BASE_PATH` | `/rideo` | |
| the path of `RIDEO_PUBLIC_URL` | `https://example.com/rideo` → `/rideo` | |
| none | | the root |

A base path is a slash followed by path segments of `A-Z a-z 0-9 . _ ~ -`, without a trailing slash; anything else
(`//evil.example`, `..`, query strings) is ignored, so the header cannot steer redirects off the site. Without
`RIDEO_PUBLIC_URL`, the studio's public URL is `http://localhost:<port><base>`.

### Both proxy styles

A proxy either **strips** the prefix (nginx `proxy_pass http://rideo:8787/;`, Caddy `handle_path`) or **keeps** it
(nginx `proxy_pass http://rideo:8787;`, Caddy `handle`). The server accepts both: before routing (in the HTTP server
factory, so Fastify, the WebSocket upgrade and the embedded `/dav` all see the same URL), a request path that starts
with the base path has it removed. With a stripping proxy the server learns the base from `RIDEO_BASE_PATH`, the
public URL or `X-Forwarded-Prefix`; it needs one of them to write correct links.

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
Each serves `/rideo/` and redirects `/rideo` to it, forwards WebSocket upgrades (`/api/live`, MCP streams), does not
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
