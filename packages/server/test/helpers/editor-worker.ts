import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AnalysisSignalsParamsSchema,
  AUDIO_ROLES,
  analysisCommand,
  chunkEncodeArgs,
  chunkGraph,
  ExportRenderParamsSchema,
  type Job,
  MediaProcessParamsSchema,
  type MediaRef,
  parseAnalysisLog,
  parseProbe,
  planChunks,
  posterCommand,
  probeCommand,
  renderInputs,
  renderSize,
  SOUNDTRACK_FILE,
  soundtrackEncodeArgs,
  soundtrackGraph,
  speechCommand,
  stemFile,
  stemOutputArgs,
  type Timeline,
  thumbnailCommand,
  thumbnailPicks,
  totalFrames,
  withDisclosure,
} from '@rideo/shared';
import type { Stack } from './stack';

/**
 * The reference editor worker: a Node stand-in for a studio tab (docs/design/editor.md#editor-jobs). It runs the
 * same shared commands and render plan as the browser engine, with native ffmpeg instead of ffmpeg.wasm.
 */

const FFMPEG = process.env.RIDEO_FFMPEG_PATH ?? 'ffmpeg';
const FONT = resolve(import.meta.dirname, '../../../web/public/fonts/DejaVuSans.ttf');

function ffmpeg(args: string[]): Promise<{ code: number | null; log: string[] }> {
  return new Promise((done, fail) => {
    const proc = spawn(FFMPEG, ['-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    proc.on('error', fail);
    proc.on('close', (code) => done({ code, log: err.split('\n') }));
  });
}

async function mustRun(args: string[]): Promise<string[]> {
  const { code, log } = await ffmpeg(args);
  if (code !== 0) throw new Error(`ffmpeg exited with ${code}: ${log.slice(-5).join(' | ')}`);
  return log;
}

export interface EditorWorkerOptions {
  kinds?: string[];
  pollMs?: number;
  /** Simulates a tab that dies: stop (without completing) after staging this many render parts. */
  dieAfterParts?: number;
  /** Report every claimed job as failed with this code (retry and give-up paths). */
  failWith?: string;
  heartbeatMs?: number;
}

export interface EditorWorker {
  sessionId: string;
  handled: Job[];
  /** Resolves when the worker has stopped (after `stop()` or a simulated death). */
  stopped: Promise<void>;
  stop(): Promise<void>;
}

export async function startEditorWorker(
  stack: Stack,
  projectId: string,
  opts: EditorWorkerOptions = {},
): Promise<EditorWorker> {
  const api = stack.url;
  const ws = new WebSocket(`${api.replace(/^http/, 'ws')}/api/live`);
  const sessionId = await new Promise<string>((ok, fail) => {
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.type === 'hello') ok(msg.sessionId);
    });
    ws.addEventListener('error', () => fail(new Error('live connection failed')));
  });
  ws.send(JSON.stringify({ type: 'subscribe', projectId }));
  await new Promise((r) => setTimeout(r, 50));
  const dir = await mkdtemp(join(tmpdir(), 'rideo-editor-'));
  const handled: Job[] = [];
  let running = true;

  const json = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${api}/api${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok)
      throw Object.assign(new Error(`${method} ${path} → ${res.status} ${text}`), { status: res.status });
    return (text ? JSON.parse(text) : null) as T;
  };
  const upload = async (job: Job, name: string, file: string) => {
    const res = await fetch(`${api}/api/editor/jobs/${job.id}/files/${name}?sessionId=${sessionId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: await readFile(file),
    });
    if (!res.ok) throw new Error(`upload ${name} → ${res.status} ${await res.text()}`);
  };
  const cache = new Map<string, string>();
  const download = async (media: MediaRef) => {
    const hit = cache.get(media.hash);
    if (hit) return hit;
    const res = await fetch(`${api}/api/projects/${projectId}/media/${media.path}`);
    if (!res.ok) throw new Error(`download ${media.path} → ${res.status}`);
    const file = join(dir, `${media.hash.slice(0, 16)}${media.path.slice(media.path.lastIndexOf('.'))}`);
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    cache.set(media.hash, file);
    return file;
  };
  const probe = async (file: string) => {
    const p = parseProbe((await ffmpeg(probeCommand(file))).log);
    if (!p) throw new Error('not a media file');
    return p;
  };

  class Died extends Error {}

  const handlers: Record<
    string,
    (job: Job, beat: (done: number, total: number, message?: string) => Promise<void>) => Promise<unknown>
  > = {
    async 'media.process'(job) {
      const { resourceId } = MediaProcessParamsSchema.parse(job.params);
      const state = await json<any>('GET', `/projects/${projectId}/state`);
      const file = await download(state.docs.resources[resourceId].media);
      const p = await probe(file);
      if (!p.hasVideo) return { probe: p };
      const poster = join(dir, `${job.id}-poster.jpg`);
      await mustRun(posterCommand(file, poster, p));
      await upload(job, 'poster.jpg', poster);
      return { probe: p, poster: 'poster.jpg' };
    },
    async 'analysis.signals'(job, beat) {
      const params = AnalysisSignalsParamsSchema.parse(job.params);
      const state = await json<any>('GET', `/projects/${projectId}/state`);
      const file = await download(state.docs.resources[params.resourceId].media);
      const p = await probe(file);
      await beat(0.1, 1, 'detecting scenes, silences and black frames');
      const signals = parseAnalysisLog(await mustRun(analysisCommand(file, p)), p.durationSec);
      const thumbnails: { sceneIndex: number; at: number; file: string }[] = [];
      for (const pick of thumbnailPicks(signals.scenes, params.maxThumbnails)) {
        const out = join(dir, `${job.id}-thumb-${pick.sceneIndex}.jpg`);
        await mustRun(thumbnailCommand(file, pick.at, out));
        const name = `thumb-${pick.sceneIndex}.jpg`;
        await upload(job, name, out);
        thumbnails.push({ ...pick, file: name });
      }
      let speech: string | undefined;
      if (params.speech && p.hasAudio) {
        const out = join(dir, `${job.id}-speech.mp3`);
        await mustRun(speechCommand(file, out));
        await upload(job, 'speech.mp3', out);
        speech = 'speech.mp3';
      }
      return { probe: p, signals, thumbnails, ...(speech ? { speech } : {}) };
    },
    async 'export.render'(job, beat) {
      const params = ExportRenderParamsSchema.parse(job.params);
      // The disclosure label is part of the render, like in the browser (docs/design/provenance.md).
      // The cut or the animatic (docs/design/storyboard.md#animatic), at the requested commit.
      // A language variant renders its derived timeline (docs/design/localization.md#language-variants).
      const t = withDisclosure(
        params.timelineCommit || params.timelinePath !== 'timeline.json'
          ? await json<Timeline>(
              'GET',
              `/projects/${projectId}/docs/${params.timelinePath}${params.timelineCommit ? `?at=${params.timelineCommit}` : ''}`,
            )
          : await json<Timeline>('GET', `/projects/${projectId}/timeline`),
        params.disclosure,
      );
      const paths = new Map<string, string>();
      for (const m of renderInputs(t)) paths.set(m.hash, await download(m));
      const chunks = planChunks(t, { targetSec: params.chunkSec });
      const parts: string[] = [];
      let staged = 0;
      for (const chunk of chunks) {
        const name = `part-${String(chunk.index + 1).padStart(4, '0')}.mp4`;
        parts.push(name);
        if (job.staged.includes(name)) continue; // resume: already uploaded by an earlier lease
        const g = chunkGraph(t, chunk, {
          quality: params.quality,
          inputPath: (m) => paths.get(m.hash)!,
          fontFile: existsSync(FONT) ? FONT : undefined,
          textPath: (i) => join(dir, `${job.id}-text-${i}.txt`),
        });
        for (const f of g.textFiles) await writeFile(f.path, f.content);
        const out = join(dir, `${job.id}-${name}`);
        await mustRun([...g.args, ...chunkEncodeArgs(params.quality), out]);
        await upload(job, name, out);
        await beat(
          chunk.index + 1,
          chunks.length + 1,
          `rendered ${chunk.index + 1}/${chunks.length} chunk(s)`,
        );
        staged++;
        if (opts.dieAfterParts !== undefined && staged >= opts.dieAfterParts) throw new Died();
      }
      // The soundtrack (lossless) and, when asked, the stems from the same run (docs/design/post-audio.md#stems).
      const audioFiles = [SOUNDTRACK_FILE, ...(params.stems ? AUDIO_ROLES.map(stemFile) : [])];
      if (!audioFiles.every((f) => job.staged.includes(f))) {
        const s = soundtrackGraph(t, { inputPath: (m) => paths.get(m.hash)!, stems: params.stems });
        const local = (name: string) => join(dir, `${job.id}-${name}`);
        await mustRun([
          ...s.args,
          ...soundtrackEncodeArgs(),
          local(SOUNDTRACK_FILE),
          ...stemOutputArgs(s, (role) => local(stemFile(role))),
        ]);
        for (const f of audioFiles) await upload(job, f, local(f));
      }
      const size = renderSize(t, params.quality);
      return {
        engine: 'ffmpeg',
        codec: 'h264',
        ...size,
        fps: t.fps,
        durationSec: totalFrames(t) / t.fps,
        parts,
        soundtrack: SOUNDTRACK_FILE,
        stems: params.stems
          ? { dialogue: stemFile('dialogue'), music: stemFile('music'), effects: stemFile('effects') }
          : null,
      };
    },
  };

  let resolveStopped: () => void = () => undefined;
  const stopped = new Promise<void>((r) => {
    resolveStopped = r;
  });

  const loop = async () => {
    while (running) {
      let job: Job | null = null;
      try {
        job = (
          await json<{ job: Job | null }>('POST', '/editor/claim', {
            sessionId,
            projectId,
            kinds: opts.kinds,
          })
        ).job;
      } catch {
        // the server is restarting or the session was dropped
      }
      if (!job) {
        await new Promise((r) => setTimeout(r, opts.pollMs ?? 100));
        continue;
      }
      handled.push(job);
      let cancelled = false;
      const beat = async (done: number, total: number, message?: string) => {
        const r = await json<{ cancelled: boolean }>('POST', `/editor/jobs/${job!.id}/heartbeat`, {
          sessionId,
          progress: { done, total, ...(message ? { message } : {}) },
        });
        if (r.cancelled || cancelled) throw new Error('cancelled');
      };
      // Like a tab: heartbeat on a timer so long steps never outlive the lease.
      const timer = setInterval(() => {
        json<{ cancelled: boolean }>('POST', `/editor/jobs/${job!.id}/heartbeat`, { sessionId })
          .then((r) => {
            cancelled ||= r.cancelled;
          })
          .catch(() => undefined);
      }, opts.heartbeatMs ?? 400);
      try {
        if (opts.failWith)
          throw Object.assign(new Error(`simulated ${opts.failWith}`), { code: opts.failWith });
        const result = await handlers[job.kind]!(job, beat);
        await json('POST', `/editor/jobs/${job.id}/complete`, { sessionId, result });
      } catch (err) {
        if (err instanceof Died) {
          running = false;
          ws.close();
          break;
        }
        await json('POST', `/editor/jobs/${job.id}/fail`, {
          sessionId,
          error: {
            code: (err as { code?: string }).code ?? 'editor_error',
            message: (err as Error).message.slice(0, 2000),
          },
        }).catch(() => undefined);
      } finally {
        clearInterval(timer);
      }
    }
    resolveStopped();
  };
  void loop();

  return {
    sessionId,
    handled,
    stopped,
    async stop() {
      running = false;
      await stopped;
      ws.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
