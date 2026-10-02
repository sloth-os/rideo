// Renders the app icons of the PWA from the logo (docs/design/pwa.md#the-app-shell): `node scripts/make-icons.mjs`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const logo = readFileSync(join(here, '../public/logo.svg'), 'utf8');
const out = join(here, '../public/icons');
mkdirSync(out, { recursive: true });
// The mark alone (the logo without its tile), for maskable and badge icons
const mark = (color) =>
  `<path d="M20 14h6v36h-6z" fill="${color}"/><path d="M26 14l24 18-24 18z" fill="${color}"/>` +
  (color === '#FF6B3D'
    ? '<path d="M26 32l12 9" stroke="#12151C" stroke-width="4" stroke-linecap="round"/>'
    : '');
const icons = [
  // the logo as it is (rounded tile)
  { name: 'icon-192.png', size: 192, svg: logo, background: 'transparent' },
  { name: 'icon-512.png', size: 512, svg: logo, background: 'transparent' },
  // maskable: full bleed tile, the mark inside the 80 % safe zone
  {
    name: 'icon-maskable-512.png',
    size: 512,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#12151C"/><g transform="translate(9.6 9.6) scale(0.7)">${mark('#FF6B3D')}</g></svg>`,
    background: '#12151C',
  },
  // iOS home screen: opaque
  {
    name: 'apple-touch-icon.png',
    size: 180,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#12151C"/><g transform="translate(6.4 6.4) scale(0.8)">${mark('#FF6B3D')}</g></svg>`,
    background: '#12151C',
  },
  // Android's status bar badge: the mark's silhouette, white on transparent
  {
    name: 'badge-72.png',
    size: 72,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${mark('#FFFFFF')}</svg>`,
    background: 'transparent',
  },
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const icon of icons) {
  await page.setViewportSize({ width: icon.size, height: icon.size });
  await page.setContent(
    `<html><body style="margin:0;background:${icon.background}"><div style="width:${icon.size}px;height:${icon.size}px">${icon.svg.replace('<svg ', `<svg width="${icon.size}" height="${icon.size}" `)}</div></body></html>`,
  );
  writeFileSync(
    join(out, icon.name),
    await page.screenshot({ omitBackground: icon.background === 'transparent' }),
  );
  console.log('wrote', icon.name);
}
await browser.close();
