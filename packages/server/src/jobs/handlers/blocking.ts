import {
  type BlockingShotInput,
  blockingFromPlan,
  blockingShotOf,
  blockingState,
  type Clip,
  compactIdentity,
  figureLegend,
  normalizeBlocking,
  type ProjectDocs,
  renderShotView,
  type SceneBlockInput,
  type Shot,
} from '@rideo/shared';
import { blockingContextFor } from '../../domain/storyboard';
import { invalid, notFound } from '../../errors';
import { encodePng } from '../../media/png';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { docsFor, type HandlerDeps } from './common';
import type { ShotReferences } from './keyframe';

/** What the floor plan means, told to the text model with every scene. */
export const BLOCKING_CONVENTIONS =
  'Metres. The floor is y = 0 and its centre is x = 0, z = 0. x runs to the right and z towards the front of the set (the audience side), so a camera at the front looks towards -z and sees +x on its right. facingDeg: 0 faces the front (+z), 90 faces the right (+x), 180 the back (-z), 270 the left (-x). The set spans x from -width/2 to width/2 and z from -depth/2 to depth/2; landmarks may lie beyond it (the sea on the horizon).';

/** The scene and its shots as `scene.block` reads them. */
export function sceneBlockInput(docs: ProjectDocs, clip: Clip): SceneBlockInput {
  const scene = docs.screenplay?.scenes.find((s) => s.id === clip.sceneId);
  const ctx = blockingContextFor(docs, clip);
  const nameOf = (id: string) => docs.characters[id]?.name ?? '';
  const place = scene?.locationId ? docs.elements[scene.locationId] : undefined;
  const propIds = [...new Set([...(scene?.elementIds ?? []), ...clip.shots.flatMap((s) => s.elementIds)])];
  return {
    scene: {
      heading: scene?.heading ?? clip.title,
      location: scene?.location ?? place?.name ?? '',
      timeOfDay: scene?.timeOfDay ?? '',
      continuity: scene?.continuity ?? '',
      summary: scene?.summary ?? '',
      action: (scene?.action ?? '').slice(0, 4000),
    },
    place: place ? { name: place.name, description: place.description.slice(0, 1000) } : null,
    props: propIds
      .map((id) => docs.elements[id])
      .filter((e) => !!e && e.kind === 'prop')
      .map((e) => ({ name: e!.name, description: e!.description.slice(0, 500) })),
    cast: ctx.characterIds.map((id) => ({
      name: nameOf(id),
      heightM: ctx.heights?.[id] ?? 1.7,
      look: compactIdentity(docs.characters[id]!),
    })),
    shots: [...clip.shots]
      .sort((a, b) => a.index - b.index)
      .map((s) => ({
        index: s.index,
        framing: s.camera.framing,
        movement: s.camera.movement,
        lensMm: s.camera.lensMm ?? null,
        description: s.description,
        action: s.action,
        endState: s.endState,
        characters: s.characterIds.map(nameOf).filter(Boolean),
        speakers: [
          ...new Set(s.dialogue.map((d) => (d.characterId ? nameOf(d.characterId) : '')).filter(Boolean)),
        ],
        continuity: s.continuity,
      })),
    conventions: BLOCKING_CONVENTIONS,
  };
}

/**
 * `scene.block` (docs/design/director-desk.md#jobs): the text model's floor plan of one clip's scene, its cameras
 * solved and kept on the line, saved as the clip's blocking.
 */
export async function sceneBlock(deps: HandlerDeps, ctx: JobContext) {
  const { clipId } = ctx.job.params as { clipId: string };
  const docs = await docsFor(deps, ctx);
  const clip = docs.clips[clipId];
  if (!clip) throw notFound(`clip ${clipId}`);
  if (!clip.shots.length) throw invalid(`plan the shots of clip ${clip.index + 1} first`);
  ctx.progress(0.1, 1, `blocking scene ${clip.index + 1}`);
  const out = await deps.llm.blockScene(sceneBlockInput(docs, clip), ctx.signal);
  throwIfAborted(ctx.signal);
  const bctx = blockingContextFor(docs, clip);
  const { blocking, fixed } = blockingFromPlan(out, {
    ...bctx,
    cast: bctx.characterIds.map((id) => ({ id, name: docs.characters[id]?.name ?? '' })),
    elements: Object.values(docs.elements).map((e) => ({ id: e.id, name: e.name, kind: e.kind })),
  });
  ctx.progress(0.8, 1, 'solving the cameras');
  const view = await deps.services.storyboard.setBlocking(ctx.actor, ctx.job.projectId, clipId, blocking, {
    fix: true,
    source: 'ai',
  });
  ctx.log.info(
    { clipId, shots: clip.shots.length, lineFixes: fixed.length, issues: view.issues.map((i) => i.code) },
    'blocked the scene',
  );
  return { shots: clip.shots.length, issues: view.issues.length, lineFixes: fixed.length };
}

/**
 * Blocks the clips that have no blocking (`scene.block`) and completes the incomplete ones, when the project blocks
 * its scenes (docs/design/director-desk.md#jobs). A blocking that fails leaves the scene unblocked: its frames are
 * drawn from words, as before.
 */
export async function ensureBlocking(deps: HandlerDeps, ctx: JobContext, clipIds: string[]): Promise<void> {
  const docs = await docsFor(deps, ctx);
  if (docs.project.settings.blocking?.enabled !== true || promptVersionBelow2(docs)) return;
  const jobs = [];
  for (const id of clipIds) {
    const clip = docs.clips[id];
    if (!clip?.shots.length || clip.status === 'approved') continue;
    const shots = clip.shots.map(blockingShotOf);
    const state = blockingState(clip.blocking, shots);
    if (state === 'missing')
      jobs.push(await ctx.spawn('scene.block', { clipId: id }, { dedupeKey: `block:${id}` }));
    else if (state === 'incomplete') {
      const ctxFor = blockingContextFor(docs, clip);
      const { blocking } = normalizeBlocking(clip.blocking!, ctxFor);
      await deps.services.storyboard.setBlocking(ctx.actor, ctx.job.projectId, id, blocking, {
        source: clip.blocking!.source,
      });
    }
  }
  if (!jobs.length) return;
  const done = await ctx.waitFor(jobs.map((j) => j.id));
  for (const j of done)
    if (j?.status !== 'succeeded')
      ctx.log.warn({ jobId: j?.id, err: j?.error?.message?.slice(0, 300) }, 'a scene could not be blocked');
}

function promptVersionBelow2(docs: ProjectDocs): boolean {
  return (docs.project.settings.generation?.promptVersion ?? 1) < 2;
}

/** The camera view of a blocked shot as a PNG data URI, with its figures' legend; null when the shot has none. */
export function cameraView(
  docs: ProjectDocs,
  clip: Clip,
  shot: Shot,
  width = 1024,
): { uri: string; png: Buffer; legend: string } | null {
  const settings = docs.project.settings;
  const b = clip.blocking;
  if (!b || settings.blocking?.enabled !== true || settings.blocking.layoutImage === false) return null;
  if (promptVersionBelow2(docs) || !b.shots[shot.id]) return null;
  const input: BlockingShotInput = blockingShotOf(shot);
  const { width: rw, height: rh } = settings.resolution;
  const png = encodePng(renderShotView(b, input, { width, height: Math.round((width * rh) / rw) }));
  const names = Object.fromEntries(Object.values(docs.characters).map((c) => [c.id, c.name]));
  return {
    uri: `data:image/png;base64,${png.toString('base64')}`,
    png,
    legend: figureLegend(b, input, names),
  };
}

/**
 * The image inputs of a keyframe with the shot's camera view (docs/design/director-desk.md): after the cast's and the
 * elements' references, before the scene reference, when the model leaves a slot for it.
 */
export function withCameraView(
  refs: ShotReferences,
  view: { uri: string; legend: string } | null,
  opts: { maxImages: number | undefined; sceneReferenceUri?: string | null },
): { refs: ShotReferences; blockingImage: boolean; sceneReference: boolean } {
  const scene = opts.sceneReferenceUri ?? null;
  const used = refs.referenceUris.length + (scene ? 1 : 0);
  const fits = !!view && (opts.maxImages === undefined || used + 1 <= opts.maxImages);
  const uris = [...refs.referenceUris, ...(fits ? [view!.uri] : []), ...(scene ? [scene] : [])];
  const labels = fits
    ? [
        ...refs.referenceLabels.slice(0, refs.referenceUris.length),
        `the blocking${view!.legend ? ` (${view!.legend})` : ''}`,
      ]
    : refs.referenceLabels;
  return {
    refs: { ...refs, referenceUris: uris, referenceLabels: labels },
    blockingImage: fits,
    sceneReference: !!scene,
  };
}
