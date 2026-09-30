#!/bin/sh
# Starts an Apache mod_dav server on http://localhost:${PORT:-8080}/ (user rideo / rideo) for
# RIDEO_TEST_WEBDAV_URL=http://rideo:rideo@localhost:8080/ npm run test:integration -- storage
set -eu
here=$(cd "$(dirname "$0")" && pwd)
docker rm -f rideo-webdav >/dev/null 2>&1 || true
docker run -d --name rideo-webdav -p "${PORT:-8080}:80" \
  -v "$here/httpd.conf:/usr/local/apache2/conf/httpd.conf:ro" \
  httpd:2.4 sh -c 'htpasswd -bc /usr/local/apache2/conf/dav.passwd rideo rideo \
    && rm -f /usr/local/apache2/htdocs/index.html && mkdir -p /usr/local/apache2/var \
    && chown -R daemon:daemon /usr/local/apache2/htdocs /usr/local/apache2/var \
    && exec httpd-foreground'
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -u rideo:rideo -X PROPFIND -H 'Depth: 0' "http://localhost:${PORT:-8080}/" || true)
  [ "$code" = "207" ] && echo "Apache WebDAV ready on :${PORT:-8080}" && exit 0
  sleep 1
done
docker logs rideo-webdav
exit 1
