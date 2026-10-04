import { z } from 'zod';

/**
 * Studio themes (docs/design/embedding.md#themes): overrides of the brand tokens (docs/brand.md#tokens), validated
 * wherever a theme enters (the library's option, the RIDEO_THEME setting, /api/config) and turned into the CSS
 * custom properties of the studio's root element.
 */

export const THEME_COLORS = [
  'bg',
  'surface',
  'surface-2',
  'border',
  'text',
  'muted',
  'accent',
  'accent-contrast',
  'success',
  'warning',
  'danger',
  'info',
] as const;
export type ThemeColor = (typeof THEME_COLORS)[number];
export type ThemeMode = 'dark' | 'light';

/** Rideo's brand tokens (docs/brand.md), the base every theme overrides. */
export const BRAND_TOKENS: Record<ThemeMode, Record<ThemeColor, string>> = {
  dark: {
    bg: '#0b0d12',
    surface: '#12151c',
    'surface-2': '#1a1e28',
    border: '#272c38',
    text: '#e9ebf1',
    muted: '#9aa2b4',
    accent: '#ff6b3d',
    'accent-contrast': '#1a0c06',
    success: '#2ec4b6',
    warning: '#f4b740',
    danger: '#ff4d5e',
    info: '#5b8cff',
  },
  light: {
    bg: '#f6f7fa',
    surface: '#ffffff',
    'surface-2': '#eef0f5',
    border: '#d9dde6',
    text: '#141821',
    muted: '#586072',
    accent: '#e4521f',
    'accent-contrast': '#ffffff',
    success: '#10877c',
    warning: '#a86b00',
    danger: '#c8283a',
    info: '#2c5fd9',
  },
};

/** A CSS color: hex, or a color function (rgb, hsl, hwb, lab, lch, oklab, oklch, color) with plain arguments. */
export const CssColorSchema = z
  .string()
  .trim()
  .max(120)
  .regex(
    /^(#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([0-9a-zA-Z.,%/+\s-]*\)|[a-zA-Z]{3,30})$/,
    'a CSS color (#rrggbb, rgb(), hsl(), oklch(), a named color)',
  );

/** A CSS value that cannot break out of its declaration. */
const CssValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^;{}<>\\]*$/, 'a CSS value without ; { } < > or backslashes');

const ColorsSchema = z.partialRecord(z.enum(THEME_COLORS), CssColorSchema);

export const ThemeSchema = z
  .object({
    mode: z.enum(['dark', 'light', 'system']).optional(),
    colors: ColorsSchema.optional(),
    dark: ColorsSchema.optional(),
    light: ColorsSchema.optional(),
    fonts: z.object({ sans: CssValueSchema.optional(), mono: CssValueSchema.optional() }).strict().optional(),
    radius: z
      .object({
        control: CssValueSchema.optional(),
        card: CssValueSchema.optional(),
        dialog: CssValueSchema.optional(),
      })
      .strict()
      .optional(),
    brand: z
      .object({
        name: z.string().trim().min(1).max(60).optional(),
        logoUrl: z
          .string()
          .trim()
          .max(2000)
          .regex(
            /^(https?:\/\/|\/|\.{0,2}\/|data:image\/)[^\s"'<>]*$/,
            'an http(s), relative or data:image URL',
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Theme = z.infer<typeof ThemeSchema>;

/** Parses a theme given as JSON (the RIDEO_THEME setting); null when empty, an error when invalid. */
export function parseThemeJson(raw: string | undefined | null): Theme | null {
  if (!raw?.trim()) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('RIDEO_THEME is not JSON');
  }
  return ThemeSchema.parse(json);
}

/** Two themes, the second over the first (colors and fonts merge key by key). */
export function mergeThemes(...themes: (Theme | null | undefined)[]): Theme {
  const out: Theme = {};
  for (const t of themes) {
    if (!t) continue;
    if (t.mode) out.mode = t.mode;
    for (const k of ['colors', 'dark', 'light', 'fonts', 'radius', 'brand'] as const) {
      if (t[k]) (out as Record<string, unknown>)[k] = { ...(out[k] as object | undefined), ...t[k] };
    }
  }
  return out;
}

/** sRGB relative luminance of a hex color (WCAG); null for other notations. */
export function luminance(color: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const hex =
    m[1]!.length === 3
      ? m[1]!
          .split('')
          .map((c) => c + c)
          .join('')
      : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio of two hex colors; null when either is not hex. */
export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Black or white, whichever reads better on the color (white when the color is not hex). */
export function readableOn(color: string): '#000000' | '#ffffff' {
  const black = contrastRatio(color, '#000000');
  const white = contrastRatio(color, '#ffffff');
  if (black === null || white === null) return '#ffffff';
  return black >= white ? '#000000' : '#ffffff';
}

/** The colors of one mode: the mode's own over the shared ones over the brand tokens. */
export function themeColors(theme: Theme | null | undefined, mode: ThemeMode): Record<ThemeColor, string> {
  const own = { ...theme?.colors, ...theme?.[mode] };
  const colors = { ...BRAND_TOKENS[mode], ...own };
  // A new accent without its own text color gets a readable one.
  if (own.accent && !own['accent-contrast']) colors['accent-contrast'] = readableOn(own.accent);
  return colors;
}

/** The custom properties a theme sets on the studio's root element for one mode (only what it overrides). */
export function themeStyle(theme: Theme | null | undefined, mode: ThemeMode): Record<string, string> {
  const style: Record<string, string> = {};
  if (!theme) return style;
  const colors = themeColors(theme, mode);
  for (const c of THEME_COLORS) {
    if (colors[c] !== BRAND_TOKENS[mode][c]) style[`--color-${c}`] = colors[c];
  }
  if (theme.fonts?.sans) style['--font-sans'] = theme.fonts.sans;
  if (theme.fonts?.mono) style['--font-mono'] = theme.fonts.mono;
  if (theme.radius?.control) style['--radius-control'] = theme.radius.control;
  if (theme.radius?.card) style['--radius-card'] = theme.radius.card;
  if (theme.radius?.dialog) style['--radius-dialog'] = theme.radius.dialog;
  return style;
}
