import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Character,
  dialogueMode,
  layoutDialogue,
  lineSeed,
  type MediaRef,
  type ModelLimits,
  type ProjectSettings,
  type Shot,
  shotSpeakers,
  staleVoices,
  type TakeAudio,
  type TakeLine,
  voicedLines,
  voiceOf,
} from '@rideo/shared';
import type { VoiceSpeaker } from '../../consistency/voice';
import { extFor } from '../../media/store';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { gatewayOptions, type HandlerDeps } from './common';

/**
 * Dialogue of one shot (docs/design/dialogue.md#from-lines-to-audio): TTS lines and their mix, or the speakers'
 * voice samples for native audio, plus what the video request and the speaker check need.
 */
export interface ShotDialogue {
  mode: 'tts' | 'native';
  lines: TakeLine[];
  /** The TTS mix (tts mode). */
  mix: { ref: MediaRef; local: string; uri: string } | null;
  /** Reference audio for the video request: the mix (tts) or the speakers' samples (native). */
  referenceAudioUris: string[];
  /** The model accepts reference audio, so the lips follow it in the first render. */
  conditioned: boolean;
  /** Seconds the shot needs to hold its lines. */
  durationSec: number;
  voiceLocks: Record<string, number>;
  /** Speakers with their reference recording as WAV, for the speaker check (native). */
  speakers: VoiceSpeaker[];
  judgeLines: { speaker: string; text: string }[];
}

async function toWav(
  deps: HandlerDeps,
  input: string,
  output: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  await deps.ff.run(
    ['-i', input, '-t', '30', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output],
    {
      signal,
    },
  );
  return readFile(output);
}

export async function prepareDialogue(
  deps: HandlerDeps,
  ctx: JobContext,
  input: {
    shot: Shot;
    characters: Record<string, Character>;
    settings: ProjectSettings;
    videoLimits: ModelLimits | null;
    dir: string;
    name: string;
  },
): Promise<ShotDialogue | null> {
  const { shot, characters, settings, dir, name } = input;
  const mode = dialogueMode(settings);
  if (mode === 'off') return null;
  const lines = voicedLines(shot, characters);
  if (!lines.length) return null;
  const projectId = ctx.job.projectId;
  const speakerIds = shotSpeakers(shot, characters);
  const voiceLocks = Object.fromEntries(speakerIds.map((id) => [id, voiceOf(characters[id]!).lock.version]));
  const conditioned = input.videoLimits?.supports_reference_audio === true;
  const judgeLines = lines.map((l) => ({ speaker: characters[l.characterId]!.name, text: l.text }));

  if (mode === 'native') {
    const speakers: VoiceSpeaker[] = [];
    const referenceAudioUris: string[] = [];
    for (const [i, id] of speakerIds.entries()) {
      const c = characters[id]!;
      const v = voiceOf(c);
      const local = await deps.media.localPath(projectId, v.sample!);
      referenceAudioUris.push(await deps.media.dataUri(projectId, v.sample!));
      speakers.push({
        id,
        name: c.name,
        description: v.description,
        sample: await toWav(deps, local, join(dir, `voice-${i}.wav`), ctx.signal),
      });
    }
    return {
      mode,
      lines: [],
      mix: null,
      referenceAudioUris: conditioned ? referenceAudioUris : [],
      conditioned,
      durationSec: shot.durationSec,
      voiceLocks,
      speakers,
      judgeLines,
    };
  }

  // TTS: a current storyboard mix is reused (docs/design/storyboard.md#video-pass); otherwise the lines are spoken.
  const spoken =
    (await reuseBoardMix(deps, ctx, shot, characters)) ??
    (await speakLines(deps, ctx, { shot, characters, settings, dir, name }));
  if (!spoken) return null;
  return {
    mode,
    lines: spoken.lines,
    mix: spoken.mix,
    referenceAudioUris: conditioned ? [spoken.mix.uri] : [],
    conditioned,
    durationSec: Math.max(shot.durationSec, spoken.durationSec),
    voiceLocks,
    speakers: [],
    judgeLines,
  };
}

/** A shot's spoken dialogue: line audio, the mix and the line timings. */
export interface SpokenDialogue {
  lines: TakeLine[];
  mix: { ref: MediaRef; local: string; uri: string };
  durationSec: number;
  voiceLocks: Record<string, number>;
}

/** The board's TTS mix when its lines and voices are still the shot's (V6), else null. */
async function reuseBoardMix(
  deps: HandlerDeps,
  ctx: JobContext,
  shot: Shot,
  characters: Record<string, Character>,
): Promise<SpokenDialogue | null> {
  const audio = shot.board?.audio;
  if (audio?.mode !== 'tts' || !audio.dialogue || staleVoices({ audio }, characters).length) return null;
  const lines = voicedLines(shot, characters);
  const same =
    lines.length === audio.lines.length &&
    lines.every((l, k) => audio.lines[k]?.characterId === l.characterId && audio.lines[k]?.text === l.text);
  if (!same) return null;
  const projectId = ctx.job.projectId;
  return {
    lines: audio.lines,
    mix: {
      ref: audio.dialogue,
      local: await deps.media.localPath(projectId, audio.dialogue),
      uri: await deps.media.dataUri(projectId, audio.dialogue),
    },
    durationSec: audio.dialogue.durationSec ?? shot.durationSec,
    voiceLocks: audio.voiceLocks,
  };
}

/**
 * Rule V3: every voiced line with its speaker's locked voice and a fixed seed, laid out and mixed into one WAV.
 * Null when the shot has no voiced line or a speaker has no provider voice.
 */
export async function speakLines(
  deps: HandlerDeps,
  ctx: JobContext,
  input: {
    shot: Shot;
    characters: Record<string, Character>;
    settings: ProjectSettings;
    dir: string;
    name: string;
  },
): Promise<SpokenDialogue | null> {
  const { shot, characters, settings, dir, name } = input;
  const lines = voicedLines(shot, characters);
  if (!lines.length || !deps.tts) return null;
  if (lines.some((l) => !voiceOf(characters[l.characterId]!).voiceId)) return null;
  const tts = deps.tts;
  const projectId = ctx.job.projectId;
  ctx.progress(0.33, 1, 'speaking the dialogue');
  const spoken: {
    line: (typeof lines)[number];
    path: string;
    durationSec: number;
    span?: { start: number; end: number };
    ref: MediaRef;
  }[] = [];
  for (const line of lines) {
    throwIfAborted(ctx.signal);
    const v = voiceOf(characters[line.characterId]!);
    const speech = await tts.speak({
      voiceId: v.voiceId!,
      text: line.text,
      seed: lineSeed(shot.id, line),
      description: v.description,
      language: settings.language,
      signal: ctx.signal,
    });
    const path = join(dir, `line-${line.index}.${extFor(speech.mime)}`);
    await writeFile(path, speech.audio);
    const probe = await deps.ff.probe(path);
    const ref = await deps.media.putFile(projectId, path, {
      kind: 'dialogue',
      name: `${name}-line${line.index + 1}`,
      mime: speech.mime,
    });
    spoken.push({
      line,
      path,
      durationSec: probe.durationSec || ref.durationSec || 1,
      span: speech.span,
      ref,
    });
  }
  const layout = layoutDialogue(spoken.map((s) => s.durationSec));
  const mixPath = join(dir, 'dialogue.wav');
  const total = layout.totalSec;
  const filters = spoken.map(
    (_, k) =>
      `[${k}:a]aformat=sample_rates=48000:channel_layouts=mono,adelay=${Math.round(layout.offsets[k]! * 1000)}:all=1[d${k}]`,
  );
  const mixed =
    spoken.length === 1
      ? `[d0]apad=whole_dur=${total},atrim=0:${total}[out]`
      : `${spoken.map((_, k) => `[d${k}]`).join('')}amix=inputs=${spoken.length}:normalize=0:dropout_transition=0,apad=whole_dur=${total},atrim=0:${total}[out]`;
  await deps.ff.run(
    [
      ...spoken.flatMap((s) => ['-i', s.path]),
      '-filter_complex',
      [...filters, mixed].join(';'),
      '-map',
      '[out]',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-c:a',
      'pcm_s16le',
      mixPath,
    ],
    { signal: ctx.signal },
  );
  const mixRef = await deps.media.putFile(projectId, mixPath, {
    kind: 'dialogue',
    name: `${name}-dialogue`,
    mime: 'audio/wav',
  });
  const takeLines: TakeLine[] = spoken.map((s, k) => {
    const at = layout.offsets[k]!;
    return {
      index: s.line.index,
      characterId: s.line.characterId,
      text: s.line.text,
      start: Math.round((at + (s.span?.start ?? 0)) * 1000) / 1000,
      end: Math.round((at + (s.span?.end ?? s.durationSec)) * 1000) / 1000,
      media: s.ref,
    };
  });
  const speakers = [...new Set(lines.map((l) => l.characterId))];
  return {
    lines: takeLines,
    mix: {
      ref: mixRef,
      local: mixPath,
      uri: `data:audio/wav;base64,${(await readFile(mixPath)).toString('base64')}`,
    },
    durationSec: total,
    voiceLocks: Object.fromEntries(speakers.map((id) => [id, voiceOf(characters[id]!).lock.version])),
  };
}

/** The take's audio as WAV for the speaker check, or null when the take is silent. */
export async function takeAudioWav(
  deps: HandlerDeps,
  video: string,
  dir: string,
  label: string,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  const probe = await deps.ff.probe(video);
  if (!probe.hasAudio) return null;
  return toWav(deps, video, join(dir, `${label}-audio.wav`), signal);
}

const LIPSYNC_PROMPT =
  'Lip sync: keep the video exactly as it is (framing, people, motion, lighting) and move the speaking characters’ lips in sync with the reference audio.';

/**
 * The lip-sync pass (docs/design/dialogue.md#from-lines-to-audio): re-renders a take whose model could not take the
 * mix as reference audio. Returns the local path of the synced video, or null when no model could do it.
 */
export async function lipSyncPass(
  deps: HandlerDeps,
  ctx: JobContext,
  input: { video: string; mixUri: string; settings: ProjectSettings; dir: string; attempt: number },
): Promise<{ path: string; taskId: string } | null> {
  try {
    const videoUri = `data:video/mp4;base64,${(await readFile(input.video)).toString('base64')}`;
    const model = input.settings.models.lipSync;
    const task = await deps.gateway.generateVideo(
      {
        ...(model && model !== 'auto' ? { model } : {}),
        input: [
          { type: 'text', text: LIPSYNC_PROMPT },
          { type: 'video', uri: videoUri, role: 'reference_video' },
          { type: 'audio', uri: input.mixUri, role: 'reference_audio' },
        ],
        parameters: { include_audio: true },
      },
      gatewayOptions(ctx, 'video', 'lipsync', input.attempt),
    );
    const out = join(input.dir, `lipsync-${input.attempt}.mp4`);
    await deps.media.downloadTo(task.outputs![0]!.uri, out, ctx.signal);
    deps.metrics.lipSync.inc({ outcome: 'ok' });
    return { path: out, taskId: task.id };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    deps.metrics.lipSync.inc({ outcome: 'failed' });
    ctx.log.warn(
      { err: (err as Error).message },
      'lip-sync pass failed; the take keeps its first render with the TTS dialogue',
    );
    return null;
  }
}

export function takeAudio(d: ShotDialogue, lipSync: TakeAudio['lipSync']): TakeAudio {
  return {
    mode: d.mode,
    dialogue: d.mix?.ref ?? null,
    lines: d.lines,
    voiceLocks: d.voiceLocks,
    lipSync,
  };
}
