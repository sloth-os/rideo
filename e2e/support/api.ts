import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { APIRequestContext } from '@playwright/test';
import { parseProbe } from '@rideo/shared';

type Job = { id: string; kind: string; status: string; error?: unknown };
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** REST helper for arranging state the spec is not about (the UI flows under test go through the page). */
export class Api {
  constructor(private readonly request: APIRequestContext) {}

  async call<T = any>(method: string, path: string, data?: unknown): Promise<T> {
    const res = await this.request.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }) });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${text}`);
    return body as T;
  }

  async waitJob(projectId: string, jobId: string, timeoutMs = 120_000): Promise<Job> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await this.call<Job>('GET', `/projects/${projectId}/jobs/${jobId}`);
      if (TERMINAL.has(job.status)) {
        if (job.status !== 'succeeded')
          throw new Error(`job ${job.kind} ${job.status}: ${JSON.stringify(job.error)}`);
        return job;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`job ${jobId} did not finish`);
  }

  async waitIdle(projectId: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const jobs = await this.call<Job[]>('GET', `/projects/${projectId}/jobs`);
      if (jobs.every((j) => TERMINAL.has(j.status))) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`jobs of ${projectId} did not settle`);
  }

  /** A story project with tiny media (320×180) and a 30 s target so generation stays fast. */
  async storyProject(
    title: string,
    opts: { screenplay?: boolean; settings?: Record<string, unknown> } = {},
  ): Promise<string> {
    const p = await this.call<{ id: string }>('POST', '/projects', {
      kind: 'story',
      title,
      brief: { prompt: 'A lighthouse keeper receives letters from the future' },
      settings: { ...TINY, ...opts.settings },
    });
    if (opts.screenplay) {
      const job = await this.call<Job>('POST', `/projects/${p.id}/screenplay/generate`, {});
      await this.waitJob(p.id, job.id);
    }
    return p.id;
  }

  /** An edit project whose timeline holds one browser-probed clip (what the studio's upload would make). */
  async editProjectWithClip(title: string, footage: string): Promise<string> {
    const p = await this.call<{ id: string }>('POST', '/projects', { kind: 'edit', title, settings: TINY });
    let banner = '';
    try {
      execFileSync(process.env.RIDEO_FFMPEG_PATH ?? 'ffmpeg', ['-hide_banner', '-i', footage], {
        stdio: 'pipe',
      });
    } catch (err) {
      banner = String((err as { stderr?: Buffer }).stderr ?? '');
    }
    const probe = parseProbe(banner);
    const res = await this.request.post(`/api/projects/${p.id}/uploads`, {
      multipart: {
        meta: JSON.stringify({ probe }),
        file: { name: 'clip.mp4', mimeType: 'video/mp4', buffer: readFileSync(footage) },
      },
    });
    if (!res.ok()) throw new Error(`upload → ${res.status()} ${await res.text()}`);
    const resource = await res.json();
    const track = (await this.call<any>('GET', `/projects/${p.id}/timeline`)).tracks[0].id;
    await this.call('POST', `/projects/${p.id}/timeline/ops`, {
      ops: [
        {
          op: 'insert',
          trackId: track,
          item: { kind: 'video', source: { type: 'media', media: resource.media }, in: 0, out: 6 },
        },
      ],
    });
    return p.id;
  }

  shrink(projectId: string) {
    return this.call('PATCH', `/projects/${projectId}`, { settings: TINY });
  }

  /**
   * Locks the cast, voices and elements of a project with a screenplay and approves the gates up to the
   * storyboard stage (what the cast spec does through the page).
   */
  async readyForStoryboard(projectId: string): Promise<void> {
    await this.call('POST', `/projects/${projectId}/workflow/approve`, { gate: 'screenplay_approved' });
    let s = await this.call<any>('GET', `/projects/${projectId}/state`);
    for (const c of Object.values<any>(s.docs.characters)) {
      const j = await this.call<Job>(
        'POST',
        `/projects/${projectId}/characters/${c.id}/references/generate`,
        {
          views: ['front'],
        },
      );
      await this.waitJob(projectId, j.id);
      const v = await this.call<Job>('POST', `/projects/${projectId}/characters/${c.id}/voice/design`, {});
      await this.waitJob(projectId, v.id);
    }
    for (const e of Object.values<any>(s.docs.elements)) {
      const j = await this.call<Job>(
        'POST',
        `/projects/${projectId}/elements/${e.id}/references/generate`,
        {},
      );
      await this.waitJob(projectId, j.id);
    }
    s = await this.call<any>('GET', `/projects/${projectId}/state`);
    for (const c of Object.values<any>(s.docs.characters)) {
      for (const r of c.references)
        await this.call('PATCH', `/projects/${projectId}/characters/${c.id}/references/${r.id}`, {
          approved: true,
        });
      await this.call('POST', `/projects/${projectId}/characters/${c.id}/lock`);
      await this.call('POST', `/projects/${projectId}/characters/${c.id}/voice/select`, {
        candidateId: c.voice.candidates[0].id,
      });
      await this.call('POST', `/projects/${projectId}/characters/${c.id}/voice/lock`);
    }
    for (const e of Object.values<any>(s.docs.elements)) {
      for (const r of e.references)
        await this.call('PATCH', `/projects/${projectId}/elements/${e.id}/references/${r.id}`, {
          approved: true,
        });
      await this.call('POST', `/projects/${projectId}/elements/${e.id}/lock`);
    }
    await this.call('POST', `/projects/${projectId}/workflow/approve`, { gate: 'cast_locked' });
    await this.call('POST', `/projects/${projectId}/workflow/approve`, { gate: 'resources_ready' });
  }
}

export const TINY = { resolution: { width: 320, height: 180 }, targetDurationSec: 30, pilotDurationSec: 10 };

export function projectIdFrom(url: string): string {
  const m = /\/p\/(prj_[0-9a-z]+)/.exec(url);
  if (!m) throw new Error(`no project id in ${url}`);
  return m[1]!;
}

/** 9 s of 320×180 footage: pattern + tone, 1 s black, fractal; 2.5 s of silence at 4–6.5 s. */
export function makeFootage(out: string): string {
  execFileSync(process.env.RIDEO_FFMPEG_PATH ?? 'ffmpeg', [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=24:duration=4',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:size=320x180:rate=24:duration=1',
    '-f',
    'lavfi',
    '-i',
    'mandelbrot=size=320x180:rate=24',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=500:duration=4',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=44100:cl=mono',
    '-filter_complex',
    '[2:v]trim=duration=4,setpts=PTS-STARTPTS[m];[0:v][1:v][m]concat=n=3:v=1:a=0,format=yuv420p[v];[3:a]atrim=duration=4[s1];[4:a]atrim=duration=2.5[sil];[3:a]atrim=duration=2.5,asetpts=PTS-STARTPTS[s2];[s1][sil][s2]concat=n=3:v=0:a=1[a]',
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-c:a',
    'aac',
    '-shortest',
    out,
  ]);
  return out;
}
