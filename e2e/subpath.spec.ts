import { expect, test } from '@playwright/test';
import { at, PORTS } from './support/ports';

/**
 * Serving under a subpath (docs/design/subpath.md): the same build of the app under /studio (the proxy keeps the
 * prefix, RIDEO_BASE_PATH says it) and under /rideo (a proxy strips it and sends X-Forwarded-Prefix, like nginx).
 */
const CASES = [
  { name: 'the prefix kept, set by RIDEO_BASE_PATH', base: at(PORTS.subpath, '/studio/') },
  { name: 'the prefix stripped by a reverse proxy', base: at(PORTS.proxy, '/rideo/') },
];

// Routing follows the proxy and the studio's own base path, never a client's X-Forwarded-Prefix
// (docs/design/subpath.md#both-proxy-styles).
test('a client’s X-Forwarded-Prefix never re-roots the studio, and a stripped path is not stripped again', async ({
  request,
}) => {
  const reached = async (url: string, headers: Record<string, string> = {}) => {
    const res = await request.get(url, { headers });
    return `${res.status()} ${(res.headers()['content-type'] ?? '').split(';')[0]}`;
  };
  // the studio under /studio with the prefix kept: its API, and none under a prefix the client names
  expect(await reached(at(PORTS.subpath, '/studio/api/health'))).toBe('200 application/json');
  expect(await reached(at(PORTS.subpath, '/x/api/health'), { 'x-forwarded-prefix': '/x' })).toBe(
    '200 text/html',
  );
  expect(
    await reached(at(PORTS.subpath, '/studio/x/api/health'), { 'x-forwarded-prefix': '/studio/x' }),
  ).toBe('200 text/html');
  // through the stripping proxy at /rideo: its API, and /rideo/studio/… arrives as /studio/… and stays there
  expect(await reached(at(PORTS.proxy, '/rideo/api/health'))).toBe('200 application/json');
  expect(await reached(at(PORTS.proxy, '/rideo/studio/api/health'))).toBe('200 text/html');
});

for (const { name, base } of CASES) {
  test(`the studio works under a subpath: ${name}`, async ({ page }) => {
    const prefix = new URL(base).pathname;
    const outside: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      // (the bare prefix is where this test starts)
      if (u.origin === new URL(base).origin && !u.pathname.startsWith(prefix) && `${u.pathname}/` !== prefix)
        outside.push(u.pathname);
    });
    // the bare prefix lands in the studio too
    await page.goto(base.replace(/\/$/, ''));
    await expect(page.getByTestId('new-edit')).toBeVisible();
    expect(await page.locator('base').getAttribute('href')).toBe(prefix);
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-status', 'live');

    await page.getByTestId('new-edit').click();
    await page.getByLabel('Title').fill(`Under ${prefix}`);
    await page.getByTestId('create-project-submit').click();
    await expect(page).toHaveURL(new RegExp(`^${base}p/prj_[0-9a-z]+/resources$`));
    // a deep link reloads under the prefix
    await page.reload();
    await expect(page.getByTestId('view-resources')).toBeVisible();
    await page.getByTestId(test.info().project.name === 'mobile' ? 'mnav-overview' : 'nav-overview').click();
    await expect(page.getByTestId('mcp-command')).toContainText(`${prefix}mcp`);

    // the installable app: manifest, icons and the service worker live under the prefix too
    const manifest = await page.request.get(new URL('manifest.webmanifest', base).href);
    expect(manifest.ok()).toBe(true);
    expect((await manifest.json()).start_url).toBe('./');
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(scope).toBe(base);
    // the API, the live channel and every asset went through the prefix
    expect(outside).toEqual([]);
    // an unknown API route is a problem, not the app
    const missing = await page.request.get(new URL('api/nothing-here', base).href);
    expect(missing.status()).toBe(404);
    expect(missing.headers()['content-type']).toContain('application/problem+json');
  });
}
