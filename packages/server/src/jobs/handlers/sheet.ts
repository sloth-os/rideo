import {
  compileSheetRequest,
  type MediaRef,
  type ShotContext,
  sheetGroups,
  sheetLayout,
  shotContextOf,
} from '@rideo/shared';
import { assertCastReady } from '../../domain/clips';
import { notFound } from '../../errors';
import { cutSheet } from '../../media/sheet';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { docsFor, gatewayOptions, type HandlerDeps } from './common';
import { type FrameReading, prepareShotReferences, readFrame, stagingFor } from './keyframe';

/** A shot's panel of its scene's sheet: the first attempt of its `shot.board` (docs/design/storyboard.md#scene-sheets). */
export interface SheetPanel {
  keyframe: MediaRef;
  sheet: MediaRef;
  panel: number;
  panels: number;
  prompt: string;
  seed: number;
  imageModel?: string;
  taskId: string;
  /** Its reading against its shot, when the staging check ran. */
  seen?: FrameReading | null;
}

/**
 * `clip.sheet` (docs/design/storyboard.md#scene-sheets): these shots of a scene drawn together as the panels of one
 * image, a sheet of up to six, and cut apart at the gutters; later sheets take the first panel as their scene
 * reference. Returns each shot's panel.
 */
export async function clipSheet(
  deps: HandlerDeps,
  ctx: JobContext,
): Promise<{ panels: Record<string, SheetPanel> }> {
  const { clipId, shotIds } = ctx.job.params as { clipId: string; shotIds: string[] };
  const projectId = ctx.job.projectId;
  const docs = await docsFor(deps, ctx);
  const clip = docs.clips[clipId];
  if (!clip) throw notFound(`clip ${clipId}`);
  const shots = clip.shots.filter((s) => shotIds.includes(s.id));
  assertCastReady(shots, docs.characters, docs.elements);
  const settings = docs.project.settings;
  const groups = sheetGroups(shots);
  const panels: Record<string, SheetPanel> = {};
  try {
    return await deps.media.withTmpDir(async (dir) => {
      const imageLimits = await deps.gateway.limitsFor('image', settings.models.image);
      // The first sheet's first panel: the scene reference of the sheets after it
      let opening: MediaRef | null = null;
      for (const [g, group] of groups.entries()) {
        throwIfAborted(ctx.signal);
        ctx.progress(g, groups.length, `drawing sheet ${g + 1}/${groups.length} of scene ${clip.index + 1}`);
        const ctxs: ShotContext[] = group.map((shot) => shotContextOf(shot, docs, clip));
        const characters = [...new Map(ctxs.flatMap((c) => c.characters).map((c) => [c.id, c])).values()];
        const elements = [...new Map(ctxs.flatMap((c) => c.elements ?? []).map((e) => [e.id, e])).values()];
        // The cast and the elements of all its shots, as one shot's would be chosen
        const refs = await prepareShotReferences(deps, ctx, {
          shot: {
            ...group[0]!,
            characterIds: characters.map((c) => c.id),
            elementIds: elements.map((e) => e.id),
          },
          characters,
          elements,
          judgedElements: [],
          maxInputImages: imageLimits.limits?.max_input_images,
          dir,
        });
        const sceneReference = opening ? await deps.media.pngDataUri(projectId, opening, 1024) : null;
        const layout = sheetLayout(group.length, settings.resolution, settings.storyboard.sheetPixels);
        // The sheet drawn again whole while a panel contradicts its shot, told what each such panel must show; the
        // sheet with the fewest panels to redraw is kept (docs/design/storyboard.md#scene-sheets)
        let best: { drawn: SheetPanel[]; redraws: number; conflicts: number } | null = null;
        let correction: string | null = null;
        const attempts = Math.max(1, settings.consistency.maxAttempts);
        for (let attempt = 0; attempt < attempts; attempt++) {
          throwIfAborted(ctx.signal);
          const req = compileSheetRequest(ctxs, layout, {
            referenceUris: [...refs.referenceUris, ...(sceneReference ? [sceneReference] : [])],
            referenceLabels: refs.referenceLabels.slice(0, refs.referenceUris.length),
            sceneReference: !!sceneReference,
            correction,
            attempt,
            model: settings.models.image,
          });
          const task = await deps.gateway.generateImage(
            req,
            gatewayOptions(ctx, 'image', `sheet${g + 1}`, attempt),
          );
          const sheet = await deps.media.importUri(projectId, task.outputs![0]!.uri, {
            kind: 'keyframes',
            name: `sheet-c${clip.index + 1}-${g + 1}-a${attempt + 1}`,
            signal: ctx.signal,
          });
          const cut = await cutSheet(
            deps.ff,
            await deps.media.localPath(projectId, sheet),
            layout,
            settings.resolution,
            dir,
            ctx.signal,
          );
          deps.metrics.storyboardSheets.inc({ outcome: cut.gutters ? 'gutters' : 'cells' });
          const drawn: SheetPanel[] = [];
          for (const [k, shot] of group.entries())
            drawn.push({
              keyframe: await deps.media.putFile(projectId, cut.files[k]!, {
                kind: 'keyframes',
                name: `board-c${clip.index + 1}-s${shot.index + 1}-panel`,
              }),
              sheet,
              panel: k + 1,
              panels: group.length,
              prompt: (req.input[0] as { text: string }).text,
              seed: req.parameters?.seed ?? 0,
              imageModel: task.model,
              taskId: task.id,
            });
          // Each panel read against its shot, the sheet's (or the scene's) first panel as its opening frame
          const readings = await Promise.all(
            drawn.map((panel, k) => {
              const staging = stagingFor(ctxs[k]!, 'storyboard', k > 0 ? drawn[0]!.keyframe : opening);
              return staging ? readFrame(deps, ctx, staging, panel.keyframe) : Promise.resolve(null);
            }),
          );
          readings.forEach((seen, k) => {
            drawn[k]!.seen = seen;
          });
          const redraws = readings.filter((r) => r?.redraw).length;
          const conflicts = readings.reduce((n, r) => n + (r?.conflicts.length ?? 0), 0);
          ctx.log.info(
            {
              clipId,
              sheet: g + 1,
              attempt,
              panels: group.length,
              layout: `${layout.columns}x${layout.rows}`,
              gutters: cut.gutters,
              redraws,
              conflicts,
            },
            'cut a scene sheet into its panels',
          );
          if (!best || redraws < best.redraws || (redraws === best.redraws && conflicts < best.conflicts))
            best = { drawn, redraws, conflicts };
          if (!redraws) break;
          correction = readings
            .map((r, k) =>
              r?.redraw
                ? `in panel ${k + 1}, ${r.fix.trim() || r.conflicts.join('; ') || 'it follows its shot'}`
                : '',
            )
            .filter(Boolean)
            .join('; ');
        }
        for (const [k, shot] of group.entries()) {
          panels[shot.id] = best!.drawn[k]!;
          opening ??= best!.drawn[k]!.keyframe;
        }
      }
      return { panels };
    });
  } catch (err) {
    if (!ctx.signal.aborted) deps.metrics.storyboardSheets.inc({ outcome: 'failed' });
    throw err;
  }
}
