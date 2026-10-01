import { createHash } from 'node:crypto';
import {
  applyOps,
  cueLength,
  DEFAULT_TRACK_IDS,
  docPath,
  EFFECTS_TRACK_ID,
  effectItems,
  effectLength,
  newId,
  type PlannedEffect,
  primaryTrack,
  type Resource,
  SFX_MAX_PER_SHOT,
  scoreCues,
  scoreItems,
  type Timeline,
  type TimelineOp,
  trackRole,
  type VideoItem,
} from '@rideo/shared';
import { AppError, invalid } from '../../errors';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { commitAs, docsFor, gatewayOptions, type HandlerDeps } from './common';

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Ops that replace a track's items (and create the track first when the cut has none). */
function replaceTrackItems(
  t: Timeline,
  track: { id: string; name: string; role: 'music' | 'effects' },
  items: Extract<TimelineOp, { op: 'insert' }>['item'][],
): TimelineOp[] {
  const ops: TimelineOp[] = [];
  const existing = t.tracks.find((tr) => tr.id === track.id);
  if (existing) for (const it of existing.items) ops.push({ op: 'remove', itemId: it.id });
  else
    ops.push({ op: 'add_track', track: { id: track.id, kind: 'audio', name: track.name, role: track.role } });
  for (const item of items) ops.push({ op: 'insert', trackId: track.id, item });
  return ops;
}

/** The cut's audio tracks in display order: a new Effects track goes right after the Dialogue track. */
function placeEffectsTrack(t: Timeline): Timeline {
  const k = t.tracks.findIndex((tr) => tr.id === EFFECTS_TRACK_ID);
  if (k < 0) return t;
  const tracks = [...t.tracks];
  const [fx] = tracks.splice(k, 1);
  const after = tracks
    .map((tr, i) => (trackRole(tr) === 'dialogue' && tr.kind === 'audio' ? i : -1))
    .filter((i) => i >= 0);
  const at = after.length ? after[after.length - 1]! + 1 : tracks.findIndex((tr) => tr.kind === 'text');
  tracks.splice(at < 0 ? tracks.length : at, 0, fx!);
  return { ...t, tracks };
}

/**
 * `score.generate` (docs/design/post-audio.md#score-one-cue-per-scene): one generated cue per scene of the cut,
 * laid on the Music track with crossfades in one commit.
 */
export async function scoreGenerate(deps: HandlerDeps, ctx: JobContext) {
  const { direction = '' } = ctx.job.params as { direction?: string };
  const projectId = ctx.job.projectId;
  const log = deps.log.child({ projectId, jobId: ctx.job.id });
  const docs = await docsFor(deps, ctx);
  const timeline = docs.timeline;
  if (!timeline || !primaryTrack(timeline).items.length) throw invalid('the cut has no picture yet');
  const settings = docs.project.settings;
  const model = settings.models.music;
  const limits = (await deps.gateway.limitsFor('music', model)).limits;
  const minSec = Math.max(4, limits?.min_duration_seconds ?? 5);
  const maxSec = Math.max(minSec, limits?.max_duration_seconds ?? 300);
  const cues = scoreCues(timeline, docs.clips, { minSec });
  const scenes = new Map((docs.screenplay?.scenes ?? []).map((s) => [s.id, s]));
  const sp = docs.screenplay;
  ctx.progress(0, cues.length + 1, 'planning the score');
  const plan = await deps.llm.planScore(
    {
      film: {
        title: sp?.title || docs.project.title,
        logline: sp?.logline ?? '',
        genre: sp?.genre ?? '',
        tone: sp?.tone ?? '',
        style: sp?.style ? Object.values(sp.style).filter(Boolean).join('; ') : '',
      },
      direction,
      cues: cues.map((c) => {
        const scene = c.sceneId ? scenes.get(c.sceneId) : undefined;
        return {
          index: c.index,
          durationSec: round1(cueLength(cues, c.index)),
          heading: scene?.heading ?? docs.project.title,
          summary: (scene?.summary ?? '').slice(0, 1000),
          action: (scene?.action ?? '').slice(0, 800),
          dialogue: (scene?.dialogue.length ?? 0) > 0,
        };
      }),
    },
    ctx.signal,
  );
  const resources: Resource[] = [];
  const music: { media: Resource['media']; resourceId: string }[] = [];
  for (const cue of cues) {
    throwIfAborted(ctx.signal);
    const planned = plan.cues.find((c) => c.index === cue.index) ?? plan.cues[cue.index];
    const scene = cue.sceneId ? scenes.get(cue.sceneId) : undefined;
    const prompt =
      planned?.prompt ??
      `Instrumental underscore for “${scene?.heading ?? docs.project.title}”, ${direction}`;
    const len = Math.min(maxSec, Math.max(minSec, Math.ceil(cueLength(cues, cue.index))));
    ctx.progress(cue.index + 1, cues.length + 1, `composing cue ${cue.index + 1}/${cues.length}`);
    const seed = Number.parseInt(
      createHash('sha256').update(`${projectId}:cue:${cue.index}`).digest('hex').slice(0, 7),
      16,
    );
    const task = await deps.gateway.generateMusic(
      {
        ...(model && model !== 'auto' ? { model } : {}),
        input: [{ type: 'text', text: prompt }],
        parameters: {
          title: `Cue ${cue.index + 1}`,
          duration_seconds: len,
          instrumental: true,
          file_format: 'mp3',
          seed,
          ...(planned?.bpm ? { bpm: planned.bpm } : {}),
        },
      },
      gatewayOptions(ctx, 'music', `cue-${cue.index}`),
    );
    const media = await deps.media.importUri(projectId, task.outputs![0]!.uri, {
      kind: 'music',
      name: `cue-${cue.index + 1}`,
      signal: ctx.signal,
    });
    const resource: Resource = {
      id: newId('resource'),
      kind: 'audio',
      role: 'music',
      name: `Cue ${cue.index + 1} — ${scene?.heading ?? docs.project.title}`.slice(0, 300),
      media,
      createdAt: new Date().toISOString(),
      origin: 'generated',
      status: 'ready',
      generation: { prompt: prompt.slice(0, 4000), model: task.model || undefined, taskId: task.id },
    };
    resources.push(resource);
    music.push({ media, resourceId: resource.id });
    deps.metrics.postAudio.inc({ op: 'score_cue', outcome: 'ok' });
  }
  const items = scoreItems(cues, music, () => newId('item'));
  const { commit } = await commitAs(
    deps,
    ctx,
    (tx) => {
      for (const r of resources) tx.set(docPath.resource(r.id), r);
      const current = tx.get<Timeline>('timeline.json');
      if (!current) throw invalid('the cut was removed');
      tx.set(
        'timeline.json',
        applyOps(
          current,
          replaceTrackItems(current, { id: DEFAULT_TRACK_IDS.audio, name: 'Music', role: 'music' }, items),
        ),
      );
    },
    `Score the cut (${cues.length} cue${cues.length === 1 ? '' : 's'})`,
  );
  log.info({ cues: cues.length, items: items.length }, 'scored the cut');
  return { cues: cues.length, resourceIds: resources.map((r) => r.id), commit: commit?.id ?? null };
}

/**
 * `sfx.generate` (docs/design/post-audio.md#effects-from-action-lines): effects planned from the takes' action
 * lines, generated through the proxy and placed on the Effects track in one commit.
 */
export async function sfxGenerate(deps: HandlerDeps, ctx: JobContext) {
  if (!deps.sfx)
    throw new AppError('sfx_unavailable', 'no sound-effects provider is configured (RIDEO_SFX_PROVIDER)');
  const projectId = ctx.job.projectId;
  const log = deps.log.child({ projectId, jobId: ctx.job.id });
  const docs = await docsFor(deps, ctx);
  const timeline = docs.timeline;
  if (!timeline || !primaryTrack(timeline).items.length) throw invalid('the cut has no picture yet');
  const shots = (primaryTrack(timeline).items as VideoItem[]).flatMap((item) => {
    if (item.source.type !== 'take') return [];
    const src = item.source;
    const shot = docs.clips[src.clipId]?.shots.find((s) => s.id === src.shotId);
    return shot ? [{ item, shot, clip: docs.clips[src.clipId]! }] : [];
  });
  if (!shots.length) throw invalid('the cut has no takes to add effects to');
  const scenes = new Map((docs.screenplay?.scenes ?? []).map((s) => [s.id, s]));
  ctx.progress(0, 1, 'spotting effects');
  const plan = await deps.llm.planSfx(
    {
      maxPerShot: SFX_MAX_PER_SHOT,
      shots: shots.map(({ item, shot, clip }, index) => ({
        index,
        durationSec: round1(item.out - item.in),
        description: shot.description.slice(0, 600),
        action: shot.action.slice(0, 600),
        location: (clip.sceneId ? scenes.get(clip.sceneId)?.heading : '') ?? '',
      })),
    },
    ctx.signal,
  );
  const perShot = new Map<number, number>();
  const planned = plan.effects.filter((e) => {
    if (e.shot >= shots.length) return false;
    const n = (perShot.get(e.shot) ?? 0) + 1;
    perShot.set(e.shot, n);
    return n <= SFX_MAX_PER_SHOT;
  });
  // One sound per distinct description and length.
  const sounds = new Map<string, { media: Resource['media']; resourceId: string }>();
  const resources: Resource[] = [];
  const items: ReturnType<typeof effectItems> = [];
  for (const [k, e] of planned.entries()) {
    throwIfAborted(ctx.signal);
    const { item } = shots[e.shot]!;
    const effect: PlannedEffect = {
      at: e.at,
      durationSec: e.durationSec,
      kind: e.kind,
      description: e.description,
    };
    const seconds = effectLength(item, effect);
    const key = `${e.description.toLowerCase()}|${seconds}`;
    let sound = sounds.get(key);
    if (!sound) {
      ctx.progress(k, planned.length, `generating “${e.description.slice(0, 40)}”`);
      const fx = await deps.sfx.generate({ text: e.description, durationSec: seconds, signal: ctx.signal });
      const media = await deps.media.putBuffer(projectId, fx.audio, {
        kind: 'sfx',
        name: e.description.slice(0, 40),
        mime: fx.mime,
      });
      const resource: Resource = {
        id: newId('resource'),
        kind: 'audio',
        role: 'sfx',
        name: e.description.slice(0, 300),
        media,
        createdAt: new Date().toISOString(),
        origin: 'generated',
        status: 'ready',
        generation: { prompt: e.description, model: deps.sfx.model },
      };
      resources.push(resource);
      sound = { media, resourceId: resource.id };
      sounds.set(key, sound);
    }
    items.push(...effectItems(item, effect, sound, () => newId('item')));
  }
  const { commit } = await commitAs(
    deps,
    ctx,
    (tx) => {
      for (const r of resources) tx.set(docPath.resource(r.id), r);
      const current = tx.get<Timeline>('timeline.json');
      if (!current) throw invalid('the cut was removed');
      const next = applyOps(
        current,
        replaceTrackItems(current, { id: EFFECTS_TRACK_ID, name: 'Effects', role: 'effects' }, items),
      );
      tx.set('timeline.json', placeEffectsTrack(next));
    },
    `Add ${planned.length} sound effect${planned.length === 1 ? '' : 's'} from the action lines`,
  );
  log.info({ effects: planned.length, sounds: resources.length }, 'added sound effects');
  return { effects: planned.length, resourceIds: resources.map((r) => r.id), commit: commit?.id ?? null };
}
