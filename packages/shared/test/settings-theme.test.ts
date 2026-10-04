import { describe, expect, it } from 'vitest';
import {
  BRAND_TOKENS,
  contrastRatio,
  mergeThemes,
  parseThemeJson,
  readableOn,
  SETTING_FIELDS,
  SETTING_GROUPS,
  SETTING_KEYS,
  SettingsUpdateInputSchema,
  settingVisible,
  THEME_COLORS,
  ThemeSchema,
  themeColors,
  themeStyle,
} from '../src';

describe('the settings table (docs/design/settings.md#the-settings-table)', () => {
  it('declares each setting once, in a known group, with options for selects', () => {
    expect(SETTING_KEYS.size).toBe(SETTING_FIELDS.length);
    const groups = new Set<string>(SETTING_GROUPS.map((g) => g.id));
    for (const f of SETTING_FIELDS) {
      expect(groups.has(f.group), f.env).toBe(true);
      expect(f.env, f.env).toMatch(/^(RIDEO|MM_GATEWAY)_[A-Z0-9_]+$/);
      if (f.kind === 'select') expect(f.options?.length, f.env).toBeGreaterThan(1);
      if (f.showIf) expect(SETTING_KEYS.has(f.showIf.env), f.env).toBe(true);
    }
    // every group has settings
    for (const g of SETTING_GROUPS)
      expect(
        SETTING_FIELDS.some((f) => f.group === g.id),
        g.id,
      ).toBe(true);
  });

  it('keeps what the process needs to start, binaries and key material out of the UI', () => {
    for (const env of [
      'RIDEO_HOST',
      'RIDEO_PORT',
      'RIDEO_DATA_DIR',
      'RIDEO_BASE_PATH',
      'RIDEO_PUBLIC_URL',
      'RIDEO_API_TOKEN',
      'RIDEO_FFMPEG_PATH',
      'RIDEO_FFPROBE_PATH',
      'RIDEO_WATERMARK_KEY',
      'RIDEO_VAPID_PRIVATE_KEY',
      'NODE_ENV',
    ])
      expect(SETTING_KEYS.has(env), env).toBe(false);
    for (const secret of [
      'MM_GATEWAY_API_KEY',
      'RIDEO_WEBDAV_PASSWORD',
      'RIDEO_OIDC_CLIENT_SECRET',
      'RIDEO_C2PA_KEY',
    ])
      expect(SETTING_FIELDS.find((f) => f.env === secret)?.kind, secret).toBe('secret');
  });

  it('accepts updates of settings only', () => {
    expect(
      SettingsUpdateInputSchema.safeParse({ values: { MM_GATEWAY_URL: 'http://g', RIDEO_THEME: null } })
        .success,
    ).toBe(true);
    expect(SettingsUpdateInputSchema.safeParse({ values: { RIDEO_DATA_DIR: '/' } }).success).toBe(false);
  });

  it('shows a field only while the setting it depends on has one of its values', () => {
    const url = SETTING_FIELDS.find((f) => f.env === 'RIDEO_WEBDAV_URL')!;
    expect(settingVisible(url, { RIDEO_STORAGE: 'webdav' })).toBe(true);
    expect(settingVisible(url, {})).toBe(true);
    expect(settingVisible(url, { RIDEO_STORAGE: 'browser' })).toBe(false);
  });
});

describe('themes (docs/design/embedding.md#themes)', () => {
  it('validates colors and CSS values so a theme cannot break out of its declaration', () => {
    expect(ThemeSchema.parse({ colors: { accent: '#7c3aed', bg: 'oklch(0.2 0.02 270)' } })).toBeTruthy();
    expect(ThemeSchema.safeParse({ colors: { accent: 'red; background: url(x)' } }).success).toBe(false);
    expect(ThemeSchema.safeParse({ colors: { mystery: '#fff' } }).success).toBe(false);
    expect(ThemeSchema.safeParse({ fonts: { sans: 'Inter}body{color:red' } }).success).toBe(false);
    expect(ThemeSchema.safeParse({ brand: { logoUrl: 'javascript:alert(1)' } }).success).toBe(false);
    expect(ThemeSchema.parse({ brand: { logoUrl: '/logo.svg', name: 'Nine' } })).toBeTruthy();
    expect(parseThemeJson('')).toBeNull();
    expect(() => parseThemeJson('{')).toThrow(/not JSON/);
  });

  it('turns a theme into the custom properties of one mode, mode colors over shared ones', () => {
    const theme = {
      colors: { accent: '#7c3aed' },
      light: { bg: '#ffffff' },
      fonts: { sans: 'Geist, sans-serif' },
    };
    expect(themeStyle(theme, 'dark')).toEqual({
      '--color-accent': '#7c3aed',
      '--color-accent-contrast': '#ffffff',
      '--font-sans': 'Geist, sans-serif',
    });
    expect(themeStyle(theme, 'light')).toMatchObject({
      '--color-bg': '#ffffff',
      '--color-accent': '#7c3aed',
    });
    expect(themeStyle(null, 'dark')).toEqual({});
    expect(Object.keys(themeColors(null, 'light'))).toEqual([...THEME_COLORS]);
    expect(themeColors({ dark: { accent: '#fde047' } }, 'dark')['accent-contrast']).toBe('#000000');
  });

  it('picks readable text for an accent and keeps the brand tokens readable (WCAG AA)', () => {
    expect(readableOn('#ffffff')).toBe('#000000');
    expect(readableOn('#111111')).toBe('#ffffff');
    for (const mode of ['dark', 'light'] as const) {
      const t = BRAND_TOKENS[mode];
      expect(contrastRatio(t.text, t.bg)!).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.muted, t.surface)!).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('merges themes key by key, later over earlier', () => {
    expect(
      mergeThemes(
        { mode: 'dark', colors: { accent: '#111111', bg: '#000000' } },
        { colors: { accent: '#222222' } },
      ),
    ).toEqual({ mode: 'dark', colors: { accent: '#222222', bg: '#000000' } });
  });
});
