import type { FrameCaptionInput, FrameCaptionOutput } from '@rideo/shared';
import { decodePng, isPng } from './png';

/** Hue ranges (degrees) to colour names; greys by lightness. */
const HUES: [number, string][] = [
  [15, 'red'],
  [45, 'orange'],
  [70, 'yellow'],
  [170, 'green'],
  [200, 'teal'],
  [260, 'blue'],
  [300, 'purple'],
  [345, 'pink'],
  [360, 'red'],
];

/** The mean colour of an image: its name and how bright it is (HSV value). */
export function meanColour(png: Buffer): { name: string; value: number } {
  const img = decodePng(png);
  let r = 0;
  let g = 0;
  let b = 0;
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    r += img.data[i * 4]!;
    g += img.data[i * 4 + 1]!;
    b += img.data[i * 4 + 2]!;
  }
  [r, g, b] = [r / n / 255, g / n / 255, b / n / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max ? (max - min) / max : 0;
  if (sat < 0.2) return { name: max < 0.2 ? 'black' : max > 0.85 ? 'white' : 'grey', value: max };
  const d = max - min;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { name: HUES.find(([to]) => h < to)![1], value: max };
}

const SHOT: Record<FrameCaptionInput['kind'], string> = {
  take: 'medium shot',
  footage: 'wide shot',
  still: 'still frame',
  reference: 'close-up',
};

/**
 * `frame.caption`: a sentence from the frame's mean colour and brightness (dark frames are night, bright ones
 * daylight), naming what the input says the frame shows.
 */
export function frameCaption(input: FrameCaptionInput, images: Buffer[]): FrameCaptionOutput {
  const img = images.find(isPng);
  const { name, value } = img ? meanColour(img) : { name: 'grey', value: 0.5 };
  const light = value < 0.45 ? 'at night' : value > 0.8 ? 'in bright daylight' : 'in soft light';
  const who = input.known.map((k) => k.name).join(' and ');
  const scene = `${who ? `${who} in a` : 'A'} ${name} scene ${light}, ${SHOT[input.kind]}.`;
  return { caption: scene };
}

/** Words meaning the same thing share a concept, so embeddings find synonyms that words miss. */
const CONCEPTS: Record<string, string[]> = {
  night: ['night', 'dark', 'evening', 'nocturnal', 'moonlit', 'midnight', 'nighttime'],
  day: ['day', 'daylight', 'bright', 'sunny', 'noon', 'sunlit', 'daytime'],
  red: ['red', 'crimson', 'scarlet', 'ruby'],
  blue: ['blue', 'azure', 'navy', 'cobalt'],
  yellow: ['yellow', 'golden', 'gold', 'amber'],
  green: ['green', 'emerald', 'verdant'],
  sea: ['sea', 'ocean', 'harbour', 'harbor', 'wave', 'shore', 'coast'],
  closeup: ['closeup', 'close'],
  wide: ['wide', 'establishing'],
};
const CONCEPT = new Map(Object.entries(CONCEPTS).flatMap(([c, words]) => words.map((w) => [w, c] as const)));
const STOP = new Set('a an the of in on at to and or with by for from is are scene shot frame'.split(' '));
const DIMS = 128;

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** A deterministic embedding: the sum of each concept's two signed dimensions, normalized. */
export function embed(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const w = raw.length > 3 && raw.endsWith('s') ? raw.slice(0, -1) : raw;
    if (STOP.has(w)) continue;
    const h = fnv(CONCEPT.get(w) ?? w);
    v[h % DIMS]! += h & 0x10000 ? 1 : -1;
    v[(h >>> 8) % DIMS]! += h & 0x20000 ? 1 : -1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => Math.round((x / norm) * 1e6) / 1e6);
}

/** OpenAI-style `POST /v1/embeddings`. */
export function embeddings(body: unknown): { status: number; body: unknown } {
  const b = body as { model?: string; input?: string | string[] };
  const input = typeof b?.input === 'string' ? [b.input] : b?.input;
  if (!Array.isArray(input) || !input.every((x) => typeof x === 'string') || !input.length)
    return { status: 400, body: { error: { message: 'input must be a string or an array of strings' } } };
  const tokens = input.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
  return {
    status: 200,
    body: {
      object: 'list',
      model: b.model ?? 'mock-embed',
      data: input.map((t, index) => ({ object: 'embedding', index, embedding: embed(t) })),
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    },
  };
}
