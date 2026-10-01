import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runFfmpeg, synthesizeFrame, synthesizeMusic, synthesizeVideo } from './media';
import type { Modality } from './models';
import { decodePng, encodePng, isPng, parseDataUri } from './png';
import { allSignatures, type Rgb, signatureColor } from './signature';
import { type RunResult, TaskError } from './tasks';

const execFileP = promisify(execFile);

export interface GenerateContext {
  dir: string;
  fileUrl: (name: string) => string;
  /** True when this generation should drift (identity lost) — MOCK_FLAKY_EVERY / metadata.mock_flaky. */
  flaky: boolean;
}

export interface ValidationIssue {
  loc: string;
  msg: string;
}

const ENVELOPE = new Set(['model', 'input', 'parameters', 'routing', 'metadata']);

const PARAMS: Record<Modality, Set<string>> = {
  image: new Set([
    'background',
    'compression',
    'delivery',
    'dimensions',
    'file_format',
    'guidance_scale',
    'inference_steps',
    'negative_prompt',
    'output_count',
    'quality',
    'seed',
    'strength',
    'style',
    'watermark',
  ]),
  video: new Set([
    'camera_motion',
    'dimensions',
    'duration_seconds',
    'enhance_prompt',
    'file_format',
    'fps',
    'frame_count',
    'guidance_scale',
    'include_audio',
    'include_last_frame',
    'motion_intensity',
    'negative_prompt',
    'seed',
    'watermark',
  ]),
  music: new Set([
    'bitrate_kbps',
    'bpm',
    'duration_seconds',
    'enhance_lyrics',
    'file_format',
    'guidance_scale',
    'inference_steps',
    'instrumental',
    'key',
    'negative_prompt',
    'novelty',
    'output_count',
    'provenance',
    'reference_audio_strength',
    'respect_section_durations',
    'sample_rate_hz',
    'scale',
    'seed',
    'style',
    'style_strength',
    'time_signature',
    'title',
    'vocal_gender',
    'vocal_language',
    'voice',
  ]),
};

const PART_TYPES: Record<Modality, Set<string>> = {
  image: new Set(['text', 'image']),
  video: new Set(['text', 'image', 'audio', 'video']),
  music: new Set(['text', 'lyrics', 'image', 'audio']),
};

const ROLES: Record<string, Set<string>> = {
  'video:image': new Set(['first_frame', 'last_frame', 'reference_image']),
  'video:audio': new Set(['reference_audio']),
  'video:video': new Set(['reference_video']),
  'music:audio': new Set(['reference_audio', 'continuation_audio']),
};

export interface Part {
  type: string;
  text?: string;
  uri?: string;
  role?: string;
}

/** Strict request validation, mirroring the gateway: unknown envelope or parameter fields are 422s. */
export function validateRequest(modality: Modality, body: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return [{ loc: 'body', msg: 'must be an object' }];
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b))
    if (!ENVELOPE.has(k)) issues.push({ loc: k, msg: 'extra fields not permitted' });
  if (!Array.isArray(b.input) || b.input.length === 0) {
    issues.push({ loc: 'input', msg: 'must be a non-empty list' });
  } else {
    (b.input as Part[]).forEach((p, i) => {
      if (!p || typeof p !== 'object' || !PART_TYPES[modality].has(p.type)) {
        issues.push({ loc: `input.${i}.type`, msg: `unsupported part type for ${modality}` });
        return;
      }
      if (p.type === 'text' || p.type === 'lyrics') {
        if (typeof p.text !== 'string' || p.text.length === 0)
          issues.push({ loc: `input.${i}.text`, msg: 'required' });
      } else {
        if (typeof p.uri !== 'string' || !/^(https?:\/\/|data:)/.test(p.uri)) {
          issues.push({ loc: `input.${i}.uri`, msg: 'must be an absolute http(s) or data URI' });
        }
        const allowed = ROLES[`${modality}:${p.type}`];
        if (p.role !== undefined && !allowed?.has(p.role)) {
          issues.push({ loc: `input.${i}.role`, msg: `invalid role ${p.role}` });
        }
      }
    });
  }
  if (b.parameters !== undefined) {
    if (!b.parameters || typeof b.parameters !== 'object')
      issues.push({ loc: 'parameters', msg: 'must be an object' });
    else
      for (const k of Object.keys(b.parameters))
        if (!PARAMS[modality].has(k))
          issues.push({ loc: `parameters.${k}`, msg: 'extra fields not permitted' });
  }
  return issues;
}

async function loadUri(uri: string): Promise<Buffer> {
  const data = parseDataUri(uri);
  if (data) return data.data;
  const res = await fetch(uri);
  if (!res.ok) throw new TaskError('invalid_input', `could not fetch ${uri}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function promptOf(parts: Part[]): string {
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('\n');
}

function referenceSheetName(prompt: string): string | null {
  if (!/(Character|Element) reference sheet/i.test(prompt)) return null;
  const m = /no text\.\s+([^:]{1,80}):/.exec(prompt);
  return m ? m[1]!.trim() : null;
}

async function signaturesFromImages(parts: Part[]): Promise<Rgb[]> {
  const sigs: Rgb[] = [];
  for (const p of parts) {
    if (p.type !== 'image' || !p.uri || p.role === 'first_frame' || p.role === 'last_frame') continue;
    const buf = await loadUri(p.uri);
    if (!isPng(buf)) continue;
    for (const s of allSignatures(decodePng(buf)))
      if (!sigs.some((x) => x.every((v, i) => Math.abs(v - s[i]!) < 30))) sigs.push(s);
  }
  return sigs;
}

function dims(params: Record<string, unknown> | undefined, fallback: { width: number; height: number }) {
  const d = params?.dimensions as { width?: number; height?: number } | undefined;
  const width = Math.max(64, Math.min(2048, Math.round(d?.width ?? fallback.width)));
  const height = Math.max(64, Math.min(2048, Math.round(d?.height ?? fallback.height)));
  return { width, height };
}

export async function runImage(body: Record<string, any>, ctx: GenerateContext): Promise<RunResult> {
  const parts = body.input as Part[];
  const params = (body.parameters ?? {}) as Record<string, unknown>;
  const prompt = promptOf(parts);
  const { width, height } = dims(params, { width: 1024, height: 1024 });
  const count = Math.max(1, Math.min(4, Number(params.output_count ?? 1)));
  const sheetName = referenceSheetName(prompt);
  let sigs = await signaturesFromImages(parts);
  if (sheetName && sigs.length === 0) sigs = [signatureColor(sheetName)];
  if (sheetName && sigs.length > 1) sigs = sigs.slice(0, 1);
  if (ctx.flaky) sigs = [];
  const outputs = [];
  for (let i = 0; i < count; i++) {
    const seed = hash(prompt) ^ Number(params.seed ?? 0) ^ i;
    const png = encodePng(synthesizeFrame(width, height, seed, sigs));
    const name = `${randomBytes(8).toString('hex')}.png`;
    if (params.delivery === 'inline') {
      outputs.push({ uri: `data:image/png;base64,${png.toString('base64')}`, mime_type: 'image/png' });
    } else {
      await writeFile(join(ctx.dir, name), png);
      outputs.push({ uri: ctx.fileUrl(name), mime_type: 'image/png', revised_prompt: prompt.slice(0, 200) });
    }
  }
  return { outputs, usage: { output_count: count } };
}

/** Decodes the reference audio parts and joins them (each speaker's sample in order). */
async function referenceAudio(parts: Part[], dir: string, name: string): Promise<string | undefined> {
  const audio = parts.filter(
    (p) => p.type === 'audio' && (p.role ?? 'reference_audio') === 'reference_audio',
  );
  if (!audio.length) return undefined;
  const inputs: string[] = [];
  for (const [i, p] of audio.entries()) {
    const path = join(dir, `${name}-ref-${i}`);
    await writeFile(path, await loadUri(p.uri!));
    inputs.push(path);
  }
  const out = join(dir, `${name}-audio.wav`);
  const filter =
    inputs.length === 1
      ? '[0:a]aformat=sample_rates=48000:channel_layouts=mono[out]'
      : `${inputs.map((_, i) => `[${i}:a]aformat=sample_rates=48000:channel_layouts=mono[a${i}]`).join(';')};${inputs.map((_, i) => `[a${i}]`).join('')}concat=n=${inputs.length}:v=0:a=1[out]`;
  await runFfmpeg([...inputs.flatMap((p) => ['-i', p]), '-filter_complex', filter, '-map', '[out]', out]);
  return out;
}

async function videoDuration(path: string): Promise<number> {
  const { stdout } = await execFileP(process.env.RIDEO_FFPROBE_PATH ?? 'ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=duration',
    '-of',
    'csv=p=0',
    path,
  ]);
  return Number.parseFloat(stdout) || 5;
}

/** Audio-driven lip sync: the reference video's pictures with the reference audio as its sound. */
async function lipSync(parts: Part[], ctx: GenerateContext, name: string): Promise<RunResult> {
  const video = parts.find((p) => p.type === 'video' && p.role === 'reference_video')!;
  const src = join(ctx.dir, `${name}-src.mp4`);
  await writeFile(src, await loadUri(video.uri!));
  const audio = await referenceAudio(parts, ctx.dir, name);
  if (!audio) throw new TaskError('invalid_input', 'lip sync needs reference_audio');
  const out = join(ctx.dir, `${name}.mp4`);
  await runFfmpeg([
    '-i',
    src,
    '-i',
    audio,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-af',
    'apad',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-t',
    String(await videoDuration(src)),
    '-movflags',
    '+faststart',
    out,
  ]);
  return {
    outputs: [{ uri: ctx.fileUrl(`${name}.mp4`), mime_type: 'video/mp4' }],
    usage: { output_count: 1 },
  };
}

export async function runVideo(body: Record<string, any>, ctx: GenerateContext): Promise<RunResult> {
  const parts = body.input as Part[];
  const params = (body.parameters ?? {}) as Record<string, unknown>;
  const prompt = promptOf(parts);
  const { width, height } = dims(params, { width: 1280, height: 720 });
  const durationSec = Math.max(2, Math.min(10, Number(params.duration_seconds ?? 5)));
  const first = parts.find((p) => p.type === 'image' && p.role === 'first_frame');
  const name = randomBytes(8).toString('hex');
  // Audio-driven lip sync: a reference video and audio without a first frame (a motion reference has a prompt
  // and a first frame).
  if (isLipSyncRequest(parts)) return lipSync(parts, ctx, name);
  const last = parts.find((p) => p.type === 'image' && p.role === 'last_frame');
  // A drifting generation also loses the voices: its sound is the plain tone.
  const audioPath =
    params.include_audio && !ctx.flaky ? await referenceAudio(parts, ctx.dir, name) : undefined;
  if (first?.uri && !ctx.flaky) {
    await synthesizeVideo({
      dir: ctx.dir,
      name,
      width,
      height,
      durationSec,
      firstFrame: await loadUri(first.uri),
      includeAudio: !!params.include_audio,
      audioPath,
    });
    if (last?.uri)
      await endOn(join(ctx.dir, `${name}.mp4`), await loadUri(last.uri), ctx.dir, name, durationSec);
  } else {
    const sigs = ctx.flaky ? [] : await signaturesFromImages(parts);
    const frame = synthesizeFrame(
      width - (width % 2),
      height - (height % 2),
      hash(prompt) ^ Number(params.seed ?? 0),
      sigs,
    );
    await synthesizeVideo({
      dir: ctx.dir,
      name,
      width,
      height,
      durationSec,
      frame,
      includeAudio: !!params.include_audio,
      audioPath,
    });
  }
  return {
    outputs: [
      {
        uri: ctx.fileUrl(`${name}.mp4`),
        mime_type: 'video/mp4',
        cover_uri: ctx.fileUrl(`${name}-frame.png`),
      },
    ],
    usage: { output_count: 1, duration_seconds: durationSec },
  };
}

export function isLipSyncRequest(parts: { type?: string; role?: string }[]): boolean {
  const has = (type: string, role: string) => parts.some((p) => p.type === type && (p.role ?? role) === role);
  return has('video', 'reference_video') && has('audio', 'reference_audio') && !has('image', 'first_frame');
}

/** The video ends on the given last frame: a one-second crossfade into it (`last_frame`). */
async function endOn(video: string, lastFrame: Buffer, dir: string, name: string, durationSec: number) {
  const still = join(dir, `${name}-last.png`);
  await writeFile(still, lastFrame);
  const tmp = join(dir, `${name}-main.mp4`);
  await rename(video, tmp);
  const fade = Math.min(1, durationSec / 3);
  const probe = await execFileP(process.env.RIDEO_FFPROBE_PATH ?? 'ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0',
    tmp,
  ]);
  const [w, h] = probe.stdout.trim().split(',');
  await runFfmpeg([
    '-i',
    tmp,
    '-loop',
    '1',
    '-framerate',
    '24',
    '-t',
    String(fade + 0.5),
    '-i',
    still,
    '-filter_complex',
    `[1:v]scale=${w}:${h},setsar=1,format=yuv420p,fps=24[l];[0:v]setsar=1,format=yuv420p,fps=24[m];[m][l]xfade=transition=fade:duration=${fade}:offset=${Math.max(0, durationSec - fade)}[v]`,
    '-map',
    '[v]',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '20',
    '-c:a',
    'copy',
    '-t',
    String(durationSec),
    '-movflags',
    '+faststart',
    video,
  ]);
}

export async function runMusic(body: Record<string, any>, ctx: GenerateContext): Promise<RunResult> {
  const parts = body.input as Part[];
  const params = (body.parameters ?? {}) as Record<string, unknown>;
  const durationSec = Math.max(5, Math.min(300, Number(params.duration_seconds ?? 30)));
  const format = params.file_format === 'wav' ? 'wav' : 'mp3';
  const name = randomBytes(8).toString('hex');
  await synthesizeMusic({ dir: ctx.dir, name, durationSec, seed: hash(promptOf(parts)), format });
  const lyrics =
    params.instrumental === false
      ? `[Verse]\n${promptOf(parts).slice(0, 80)}\n[Chorus]\nLa la la`
      : undefined;
  return {
    outputs: [
      { uri: ctx.fileUrl(`${name}.${format}`), mime_type: format === 'wav' ? 'audio/wav' : 'audio/mpeg' },
    ],
    usage: { output_count: 1, duration_seconds: durationSec },
    lyrics,
  };
}
