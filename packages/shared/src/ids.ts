/**
 * Identifiers: `<3-letter prefix>_<16 chars>`. The first 10 chars encode the creation time (ms, base32),
 * the last 6 are random, so ids sort by creation time and never collide in practice.
 */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export const ID_PREFIXES = {
  project: 'prj',
  character: 'chr',
  element: 'ele',
  reference: 'ref',
  voice: 'voc',
  wardrobe: 'wdr',
  scene: 'scn',
  beat: 'otl',
  clip: 'clp',
  shot: 'sht',
  take: 'tak',
  job: 'job',
  resource: 'res',
  analysis: 'ana',
  suggestion: 'sug',
  export: 'exp',
  track: 'trk',
  item: 'itm',
  session: 'ses',
  command: 'cmd',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export const ID_PATTERN = /^[a-z]{3}_[0-9a-z]{10,32}$/;

function randomChars(n: number): string {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[bytes[i]! % 32];
  return out;
}

function timeChars(ms: number): string {
  let out = '';
  let t = Math.floor(ms);
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

export function newId(kind: IdKind, now: number = Date.now()): string {
  return `${ID_PREFIXES[kind]}_${timeChars(now)}${randomChars(6)}`;
}

export function isId(value: unknown, kind?: IdKind): value is string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) return false;
  return kind ? value.startsWith(`${ID_PREFIXES[kind]}_`) : true;
}

export function assertId(value: string, kind?: IdKind): string {
  if (!isId(value, kind)) throw new Error(`invalid ${kind ?? ''} id: ${value}`);
  return value;
}
