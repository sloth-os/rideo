import { expect, type Page } from '@playwright/test';

/**
 * Exports from the editor: this tab claims the `export.render` editor job, renders it with its engine
 * (ffmpeg.wasm or WebCodecs) and the server watermarks it (docs/design/editor.md#rendering).
 */
export async function exportInThisTab(
  page: Page,
  opts: {
    quality?: 'draft' | 'standard' | 'high';
    engine?: 'auto' | 'ffmpeg' | 'webcodecs';
    /** Loudness target and stems (docs/design/post-audio.md#loudness). */
    loudness?: 'streaming' | 'broadcast' | 'off';
    stems?: boolean;
    /** A language variant (docs/design/localization.md#language-variants). */
    language?: string;
    dubbed?: boolean;
    captions?: 'burn' | 'sidecar';
  } = {},
): Promise<void> {
  await page.getByTestId('open-export').click();
  await expect(page.getByTestId('webcodecs-caps')).not.toContainText('detecting');
  if (opts.quality) await page.getByLabel('Quality').selectOption(opts.quality);
  if (opts.engine) await page.getByTestId('export-engine').selectOption(opts.engine);
  if (opts.loudness) await page.getByTestId('export-loudness').selectOption(opts.loudness);
  if (opts.stems) await page.getByTestId('export-stems').check();
  if (opts.language) await page.getByTestId('export-language').selectOption(opts.language);
  if (opts.dubbed) await page.getByTestId('export-dubbed').check();
  if (opts.captions) await page.getByTestId('export-captions').selectOption(opts.captions);
  await page.getByTestId('export-start').click();
  const status = page.getByTestId('export-status');
  const failed = page.getByTestId('export-error');
  await expect(status).toContainText(/Rendering in this tab|Rendered|Ready/, { timeout: 60_000 });
  await expect(status.getByText(/^Ready/).or(failed)).toBeVisible({ timeout: 240_000 });
  if (await failed.isVisible()) throw new Error(`export failed: ${await failed.innerText()}`);
  await page.getByTestId('export-close').click();
}
