import {
  type Browser,
  type BrowserContextOptions,
  expect,
  type Page,
  type TestInfo,
  test,
} from '@playwright/test';
import { Api } from './support/api';
import { at, PORTS } from './support/ports';

const VIEWS = [
  'overview',
  'story',
  'cast',
  'elements',
  'resources',
  'storyboard',
  'clips',
  'editor',
  'search',
  'history',
  'exports',
] as const;

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.querySelector('main');
    return { page: doc.scrollWidth - doc.clientWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
  });
  expect(overflow.page, 'page scrolls horizontally').toBeLessThanOrEqual(1);
  expect(overflow.main, 'main view scrolls horizontally').toBeLessThanOrEqual(1);
}

test('every main view fits a phone, with navigation and primary actions reachable', async ({
  page,
  request,
}) => {
  const api = new Api(request);
  const pid = await api.storyProject('Responsive e2e', { screenplay: true });

  await page.goto('/');
  await expect(page.getByTestId('new-story')).toBeVisible();
  await expect(page.getByTestId('new-edit')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  for (const view of VIEWS) {
    await page.goto(`/p/${pid}/${view}`);
    await expect(page.getByTestId(`view-${view}`)).toBeVisible();
    await expect(page.getByTestId('mnav-overview')).toBeVisible();
    await expect(page.getByTestId(`nav-${view}`)).toBeHidden();
    await expectNoHorizontalOverflow(page);
  }

  await page.goto(`/p/${pid}/overview`);
  await expect(page.getByTestId('approve-gate')).toBeVisible();
  await page.getByTestId('mnav-story').tap();
  await expect(page).toHaveURL(/\/story$/);
  await expect(page.getByTestId('approve-screenplay')).toBeVisible();
  await page.getByTestId('mnav-more').tap();
  await page.getByTestId('mnav-history').tap();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByTestId('commit').first()).toBeVisible();
});

const LONG_TITLE = 'Harbour lights at the far end of the long pier, where the letters from the future wait';
const SHORT_TITLE = 'Ox';
const BRANCH = 'try-a-much-longer-alternative-ending-for-the-pier-scene';
/** Phones below `sm` (640 px), the bottom bar and its More menu below `md` (768 px), desktops above. */
const WIDTHS = [360, 390, 412, 640, 768, 1024, 1440] as const;
const ACCOUNTS = at(PORTS.accounts);

/**
 * The project header as the eye sees it (docs/brand.md#layout-and-responsiveness): every visible box left to right, the
 * title row's children cut to whatever clips them, and the title's text measured on its own (its natural width).
 */
async function headerLayout(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector('header');
    const title = header?.querySelector<HTMLElement>('[data-testid="project-title"]');
    if (!header || !title) throw new Error('no project header');
    const row = title.parentElement!;
    /** The part of an element left once every ancestor below the header that clips it has cut it. */
    const seen = (e: Element) => {
      let { left, right } = e.getBoundingClientRect();
      for (let a = e.parentElement; a && a !== header; a = a.parentElement)
        if (getComputedStyle(a).overflowX !== 'visible') {
          const r = a.getBoundingClientRect();
          left = Math.max(left, r.left);
          right = Math.min(right, r.right);
        }
      return { left, right, width: Math.max(0, right - left) };
    };
    const shown = (e: Element | null): e is Element => {
      if (!e) return false;
      const style = getComputedStyle(e);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const boxes: { name: string; left: number; right: number }[] = [];
    const add = (e: Element, name: string) => {
      const b = seen(e);
      if (shown(e) && b.width > 0.5) boxes.push({ name, left: b.left, right: b.right });
    };
    for (const child of header.children) {
      if (child.contains(row)) for (const e of row.children) add(e, e.getAttribute('data-testid') ?? 'badge');
      else add(child, child.getAttribute('data-testid') ?? child.getAttribute('aria-label') ?? child.tagName);
    }
    // the title's text on one line, in its own font: how wide it is when nothing squeezes it
    const probe = document.createElement('span');
    const font = getComputedStyle(title);
    probe.textContent = title.textContent;
    probe.style.cssText = `position:fixed;left:-9999px;top:0;visibility:hidden;white-space:pre;font:${font.font};letter-spacing:${font.letterSpacing}`;
    document.body.append(probe);
    const natural = probe.getBoundingClientRect().width;
    probe.remove();
    const stage = header.querySelector('[data-testid="project-stage"]');
    const branch = header.querySelector('[data-testid="project-branch"]');
    const icon = branch?.querySelector('svg') ?? null;
    return {
      boxes: boxes.sort((a, b) => a.left - b.left),
      title: { box: title.getBoundingClientRect().width, seen: seen(title).width, natural },
      stage: shown(stage) ? { full: stage.getBoundingClientRect().width, seen: seen(stage).width } : null,
      branch: shown(branch)
        ? {
            label: branch.getAttribute('title') ?? '',
            icon: shown(icon) ? { full: icon.getBoundingClientRect().width, seen: seen(icon).width } : null,
          }
        : null,
    };
  });
}

/**
 * A studio's project header at every width, on main and on a long-named branch, with a long and a short title
 * (docs/brand.md#layout-and-responsiveness): the title never wider than its text and, when long, never under 48 px; the
 * stage badge whole from `sm`; the branch at least its icon, named in its tooltip; nothing over anything, nothing off
 * the screen, no sideways scroll; below `md` the studio's links under More, from `md` in the header.
 */
async function headerHolds(
  browser: Browser,
  testInfo: TestInfo,
  opts: {
    who: string;
    base: string;
    api: Api;
    storageState?: BrowserContextOptions['storageState'];
    admin: boolean;
  },
) {
  const phone = await browser.newContext({
    baseURL: opts.base,
    storageState: opts.storageState,
    viewport: { width: 412, height: 800 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  const desktop = await browser.newContext({
    baseURL: opts.base,
    storageState: opts.storageState,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const pages = { phone: await phone.newPage(), desktop: await desktop.newPage() };
  for (const [kind, title] of [
    ['long', LONG_TITLE],
    ['short', SHORT_TITLE],
  ] as const) {
    const pid = await opts.api.storyProject(title, { screenplay: true });
    for (const branch of [null, BRANCH]) {
      if (branch) {
        await opts.api.call('POST', `/projects/${pid}/branches`, { name: branch });
        await opts.api.call('POST', `/projects/${pid}/branches/${branch}/switch`);
      }
      for (const width of WIDTHS) {
        const page = width < 640 ? pages.phone : pages.desktop;
        await page.setViewportSize({ width, height: width < 640 ? 800 : 900 });
        await page.goto(`/p/${pid}/cast`);
        await expect(page.getByTestId('project-title')).toHaveText(title);
        await expect(page.getByTestId('engine-status')).toBeVisible();
        if (branch) await expect(page.getByTestId('project-branch')).toBeAttached();
        const l = await headerLayout(page);
        const where = `${opts.who}, ${kind} title, ${branch ? 'branch' : 'main'}, ${width} px: ${l.boxes
          .map((b) => `${b.name} ${Math.round(b.left)}–${Math.round(b.right)}`)
          .join(', ')}`;
        // the title: never forced wider than its text, never under 48 px (all of it when shorter)
        expect(l.title.box, `${where}: title box against its text`).toBeLessThanOrEqual(l.title.natural + 1);
        expect(l.title.seen, `${where}: title shown`).toBeGreaterThanOrEqual(
          Math.min(l.title.natural, 48) - 0.5,
        );
        // the stage badge whole from sm, none on a phone
        if (width >= 640) {
          expect(l.stage, `${where}: stage badge`).not.toBeNull();
          expect(l.stage!.seen, `${where}: stage badge cut`).toBeGreaterThanOrEqual(l.stage!.full - 0.5);
        } else expect(l.stage, `${where}: stage badge on a phone`).toBeNull();
        // the branch: its whole icon at least, its name in its tooltip
        if (branch) {
          expect(l.branch, `${where}: branch badge`).not.toBeNull();
          expect(l.branch!.label, `${where}: branch tooltip`).toContain(branch);
          expect(l.branch!.icon, `${where}: branch icon`).not.toBeNull();
          expect(l.branch!.icon!.seen, `${where}: branch icon cut`).toBeGreaterThanOrEqual(
            l.branch!.icon!.full - 0.5,
          );
        }
        // nothing over anything, nothing off the screen, no sideways scroll
        for (const [i, b] of l.boxes.entries())
          if (i > 0)
            expect(b.left, `${where}: ${l.boxes[i - 1]!.name} and ${b.name} overlap`).toBeGreaterThanOrEqual(
              l.boxes[i - 1]!.right - 0.5,
            );
        expect(l.boxes.at(-1)!.right, where).toBeLessThanOrEqual(width + 0.5);
        await expectNoHorizontalOverflow(page);
        if (kind === 'long' && branch && [360, 640, 1024].includes(width)) {
          const shot = testInfo.outputPath(`header-${opts.who}-${width}.png`);
          await page.screenshot({ path: shot, clip: { x: 0, y: 0, width, height: 64 } });
          await testInfo.attach(`header-${opts.who}-${width}`, { path: shot, contentType: 'image/png' });
        }
      }
    }
    if (kind === 'short') {
      // the studio's links: under More while the bottom bar shows (below md), in the header from md
      const links = ['library-link', 'brand-kits-link', ...(opts.admin ? ['settings-link'] : [])];
      for (const width of [360, 640, 768]) {
        const page = width < 640 ? pages.phone : pages.desktop;
        await page.setViewportSize({ width, height: width < 640 ? 800 : 900 });
        await page.goto(`/p/${pid}/cast`);
        await expect(page.getByTestId('project-title')).toBeVisible();
        for (const link of links)
          if (width < 768) await expect(page.getByTestId(link), `${link} at ${width} px`).toBeHidden();
          else await expect(page.getByTestId(link), `${link} at ${width} px`).toBeVisible();
        if (width >= 768) continue;
        // one tap away under More: the Library, the brand kits, Settings for administrators
        await page.getByTestId('mnav-more').click();
        await expect(page.getByTestId('mnav-brand-kits')).toBeVisible();
        await expect(page.getByTestId('mnav-settings')).toHaveCount(opts.admin ? 1 : 0);
        await page.getByTestId('mnav-library').click();
        await expect(page).toHaveURL(/\/library$/);
      }
    }
  }
  await phone.close();
  await desktop.close();
}

test('the project header keeps its title, stage and branch apart from its controls from 360 to 1440 px', async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(480_000);
  // auth none: everyone administers the studio, so the header has Settings too
  await headerHolds(browser, testInfo, {
    who: 'none',
    base: at(PORTS.main),
    api: new Api(request),
    admin: true,
  });
});

test('a signed-in header (OIDC) keeps the title, stage and branch apart from the account and the notifications', async ({
  browser,
}, testInfo) => {
  test.setTimeout(480_000);
  // Mira administers the accounts studio: the fullest header there is (Settings, notifications, her account)
  const signIn = await browser.newContext({ baseURL: ACCOUNTS });
  const page = await signIn.newPage();
  await page.goto(`/api/auth/login?login_hint=${encodeURIComponent('mira@studio.test')}&returnTo=%2F`);
  await expect(page.getByTestId('user-menu')).toBeVisible();
  const storageState = await signIn.storageState();
  await headerHolds(browser, testInfo, {
    who: 'oidc',
    base: ACCOUNTS,
    api: new Api(signIn.request),
    storageState,
    admin: true,
  });
  await signIn.close();
});
