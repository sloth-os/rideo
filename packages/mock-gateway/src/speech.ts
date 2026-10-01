import { createHash, randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { VoiceJudgeInput, VoiceJudgeOutput } from '@rideo/shared';
import { multipartFile, type ProxyResponse } from './llm';
import { runFfmpeg } from './media';

/**
 * Mock speech (docs/design/dialogue.md#mock-gateway): every voice has a signature pitch that is written into its id
 * (`gv217x…` previews, `mv217x…` saved and cloned voices); speech is a syllable-modulated tone at that pitch
 * whose length follows the text. The mock speaker check compares pitches.
 */

const OPENAI_PITCH: Record<string, number> = {
  alloy: 190,
  ash: 128,
  ballad: 150,
  coral: 232,
  echo: 140,
  fable: 205,
  nova: 255,
  onyx: 112,
  sage: 215,
  shimmer: 270,
  verse: 165,
};

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Pitches stay within 110–300 Hz, clear of the 330 Hz tone of silent mock videos. */
export function pitchFor(seed: string): number {
  return 110 + (Number.parseInt(hash(seed).slice(0, 8), 16) % 191);
}

export function pitchOfVoice(voiceId: string): number {
  const m = /^[gm]v(\d{2,3})x/.exec(voiceId);
  if (m) return Number(m[1]);
  return OPENAI_PITCH[voiceId] ?? pitchFor(voiceId);
}

export function speechDuration(text: string): number {
  return Math.min(12, Math.max(0.8, 0.25 + text.length * 0.05));
}

async function tone(dir: string, pitch: number, durationSec: number, format: 'mp3' | 'wav'): Promise<Buffer> {
  const out = join(dir, `speech-${randomBytes(6).toString('hex')}.${format}`);
  const d = Math.round(durationSec * 1000) / 1000;
  const expr = `0.4*sin(2*PI*${pitch}*t)*(0.55+0.45*sin(2*PI*3.5*t))`;
  await runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    `aevalsrc='${expr}':s=44100:d=${d}`,
    '-af',
    `afade=t=in:d=0.05,afade=t=out:st=${Math.max(0, d - 0.05)}:d=0.05`,
    ...(format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '96k'] : ['-c:a', 'pcm_s16le']),
    out,
  ]);
  try {
    return await readFile(out);
  } finally {
    await rm(out, { force: true });
  }
}

async function noise(dir: string, durationSec: number): Promise<Buffer> {
  const out = join(dir, `sfx-${randomBytes(6).toString('hex')}.mp3`);
  const d = Math.round(durationSec * 1000) / 1000;
  await runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    `anoisesrc=d=${d}:c=pink:a=0.5:r=44100`,
    '-af',
    `afade=t=in:d=0.02,afade=t=out:st=${Math.max(0, d - 0.1)}:d=0.1`,
    '-ac',
    '2',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    out,
  ]);
  try {
    return await readFile(out);
  } finally {
    await rm(out, { force: true });
  }
}

/** Decodes any audio (or video with sound) to 16 kHz mono WAV. */
export async function toWav(dir: string, data: Buffer): Promise<Buffer> {
  const id = randomBytes(6).toString('hex');
  const src = join(dir, `in-${id}`);
  const out = join(dir, `in-${id}.wav`);
  await writeFile(src, data);
  try {
    await runFfmpeg(['-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out]);
    return await readFile(out);
  } finally {
    await rm(src, { force: true });
    await rm(out, { force: true });
  }
}

/** The pitch of every voiced 0.2 s window of a 16-bit PCM WAV (zero crossings with hysteresis). */
export function wavPitchWindows(wav: Buffer): number[] {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') return [];
  let rate = 16000;
  let channels = 1;
  let bits = 16;
  let off = 12;
  let data: Buffer | null = null;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = wav.readUInt16LE(off + 10);
      rate = wav.readUInt32LE(off + 12);
      bits = wav.readUInt16LE(off + 22);
    } else if (id === 'data') {
      data = wav.subarray(off + 8, Math.min(wav.length, off + 8 + size));
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (!data || bits !== 16) return [];
  const frame = 2 * channels;
  const n = Math.floor(data.length / frame);
  const win = Math.round(rate * 0.2);
  const out: number[] = [];
  for (let start = 0; start + win <= n; start += win) {
    let crossings = 0;
    let state = 0;
    let energy = 0;
    for (let i = start; i < start + win; i++) {
      const v = data.readInt16LE(i * frame) / 32768;
      energy += v * v;
      const s = v > 0.01 ? 1 : v < -0.01 ? -1 : 0;
      if (s !== 0 && state !== 0 && s !== state) crossings++;
      if (s !== 0) state = s;
    }
    if (Math.sqrt(energy / win) < 0.02) continue;
    out.push(crossings / 2 / 0.2);
  }
  return out;
}

export function dominantPitch(wav: Buffer): number | null {
  const p = wavPitchWindows(wav).sort((a, b) => a - b);
  return p.length ? p[Math.floor(p.length / 2)]! : null;
}

const json = (payload: unknown, status = 200): ProxyResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

/** ElevenLabs and OpenAI speech endpoints under the mock proxy; null for other paths. */
export async function handleSpeech(
  path: string,
  body: unknown,
  contentType: string,
  dir: string,
): Promise<ProxyResponse | null> {
  const b = (body && typeof body === 'object' && !Buffer.isBuffer(body) ? body : {}) as Record<string, any>;
  if (/^v1\/text-to-voice\/design/.test(path)) {
    const description = String(b.voice_description ?? '');
    if (description.length < 20)
      return json({ detail: { status: 'invalid', message: 'voice_description is too short' } }, 422);
    const text = String(b.text ?? 'Hello, this is my voice. I will tell you a story tonight.');
    const previews = [];
    for (let i = 0; i < 3; i++) {
      const pitch = pitchFor(`${description}:${b.seed ?? 0}:${i}`);
      const id = `gv${pitch}x${hash(`${description}:${b.seed}:${i}`).slice(0, 10)}`;
      const duration = Math.min(4, speechDuration(text));
      previews.push({
        audio_base_64: (await tone(dir, pitch, duration, 'mp3')).toString('base64'),
        generated_voice_id: id,
        media_type: 'audio/mpeg',
        duration_secs: duration,
        language: 'en',
      });
    }
    return json({ previews, text });
  }
  if (/^v1\/text-to-voice\/?$/.test(path)) {
    const generated = String(b.generated_voice_id ?? '');
    if (!b.voice_name || !generated)
      return json({ detail: { message: 'voice_name and generated_voice_id' } }, 422);
    return json({
      voice_id: `mv${pitchOfVoice(generated)}x${hash(generated).slice(0, 10)}`,
      name: b.voice_name,
    });
  }
  if (/^v1\/voices\/add$/.test(path)) {
    const file = Buffer.isBuffer(body) ? multipartFile(body, contentType, 'files') : null;
    if (!file) return json({ detail: { message: 'files is required' } }, 422);
    let pitch = 200;
    try {
      pitch = Math.round(dominantPitch(await toWav(dir, file)) ?? 200);
    } catch {
      // not decodable: keep the default pitch
    }
    pitch = Math.max(60, Math.min(999, pitch));
    return json({
      voice_id: `mv${pitch}x${hash(file.toString('base64')).slice(0, 10)}`,
      requires_verification: false,
    });
  }
  const tts = /^v1\/text-to-speech\/([^/]+)\/with-timestamps$/.exec(path);
  if (tts) {
    const text = String(b.text ?? '');
    if (!text) return json({ detail: { message: 'text is required' } }, 422);
    const voiceId = decodeURIComponent(tts[1]!);
    const duration = speechDuration(text);
    const audio = await tone(dir, pitchOfVoice(voiceId), duration, 'mp3');
    const chars = [...text];
    const step = (duration - 0.2) / chars.length;
    const starts = chars.map((_, i) => Math.round((0.1 + i * step) * 1000) / 1000);
    const ends = chars.map((_, i) => Math.round((0.1 + (i + 1) * step) * 1000) / 1000);
    const alignment = {
      characters: chars,
      character_start_times_seconds: starts,
      character_end_times_seconds: ends,
    };
    return json({ audio_base64: audio.toString('base64'), alignment, normalized_alignment: alignment });
  }
  if (/^v1\/sound-generation$/.test(path)) {
    // Sound effects (docs/design/post-audio.md#mock-gateway): a pink-noise burst of the asked length.
    const text = String(b.text ?? '');
    if (!text) return json({ detail: { message: 'text is required' } }, 422);
    const duration = Math.min(30, Math.max(0.5, Number(b.duration_seconds ?? 2) || 2));
    return { status: 200, headers: { 'content-type': 'audio/mpeg' }, body: await noise(dir, duration) };
  }
  if (/^v1\/audio\/speech$/.test(path)) {
    const text = String(b.input ?? '');
    if (!text || !b.voice) return json({ error: { message: 'input and voice are required' } }, 400);
    const format = b.response_format === 'wav' ? 'wav' : 'mp3';
    return {
      status: 200,
      headers: { 'content-type': format === 'wav' ? 'audio/wav' : 'audio/mpeg' },
      body: await tone(dir, pitchOfVoice(String(b.voice)), speechDuration(text), format),
    };
  }
  return null;
}

/** Mock speaker check: a speaker is heard when their reference pitch is in the take (within 6%). */
export function voiceJudge(
  input: VoiceJudgeInput,
  audio: { references: Map<string, Buffer>; take: Buffer | null },
): VoiceJudgeOutput {
  const windows = audio.take ? wavPitchWindows(audio.take) : [];
  const sorted = [...windows].sort((a, b) => a - b);
  const heard = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null;
  return {
    speakers: input.speakers.map((s) => {
      const ref = audio.references.get(s.characterId);
      const pitch = ref ? dominantPitch(ref) : null;
      if (!pitch)
        return { characterId: s.characterId, present: false, score: 0, issues: ['no reference voice'] };
      const near = windows.filter((p) => Math.abs(p - pitch) / pitch < 0.06).length;
      if (near >= 2) return { characterId: s.characterId, present: true, score: 0.93, issues: [] };
      if (heard === null)
        return { characterId: s.characterId, present: false, score: 0, issues: ['no speech heard'] };
      return {
        characterId: s.characterId,
        present: true,
        score: 0.2,
        issues: [`a different voice (about ${Math.round(heard)} Hz instead of ${Math.round(pitch)} Hz)`],
      };
    }),
  };
}
