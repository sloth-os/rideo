import {
  compileSheetRequest,
  type MediaRef,
  SHEET_MAX_PANELS,
  type ShotContext,
  sheetLayout,
  shotContextOf,
} from '@rideo/shared';
import { assertCastReady } from '../../domain/clips';
import { invalid, notFound } from '../../errors';
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
 * `clip.sheet` (docs/design/storyboard.md#scene-sheets): a scene's shots, up to `SHEET_MAX_PANELS`, drawn together as
 * the panels of one image and cut apart at the gutters; each panel read against its shot, and the sheet drawn again
 * whole, told what each failed panel must show, while one fails. Returns each shot's panel of the best sheet.
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
  const shots = clip.shots.filter((s) => shotIds.includes(s.id)).sort((a, b) => a.index - b.index);
  if (shots.length < 2 || shots.length > SHEET_MAX_PANELS)
    throw invalid(`a scene sheet draws 2 to ${SHEET_MAX_PANELS} shots, not ${shots.length}`);
  assertCastReady(shots, docs.characters, docs.elements);
  const settings = docs.project.settings;
  try {
    return await deps.media.withTmpDir(async (dir) => {
      const imageLimits = await deps.gateway.limitsFor('image', settings.models.image);
      const ctxs: ShotContext[] = shots.map((shot) => shotContextOf(shot, docs, clip));
      const characters = [...new Map(ctxs.flatMap((c) => c.characters).map((c) => [c.id, c])).values()];
      const elements = [...new Map(ctxs.flatMap((c) => c.elements ?? []).map((e) => [e.id, e])).values()];
      // The cast and the elements of all its shots, as one shot's would be chosen
      const refs = await prepareShotReferences(deps, ctx, {
        shot: {
          ...shots[0]!,
          characterIds: characters.map((c) => c.id),
          elementIds: elements.map((e) => e.id),
        },
        characters,
        elements,
        judgedElements: [],
        maxInputImages: imageLimits.limits?.max_input_images,
        dir,
      });
      const layout = sheetLayout(shots.length, settings.resolution, settings.storyboard.sheetPixels);
      let best: { drawn: SheetPanel[]; redraws: number; conflicts: number } | null = null;
      let correction: string | null = null;
      const attempts = Math.max(1, settings.consistency.maxAttempts);
      for (let attempt = 0; attempt < attempts; attempt++) {
        throwIfAborted(ctx.signal);
        ctx.progress(
          attempt,
          attempts,
          `drawing the sheet of scene ${clip.index + 1} (attempt ${attempt + 1})`,
        );
        const req = compileSheetRequest(ctxs, layout, {
          referenceUris: refs.referenceUris,
          referenceLabels: refs.referenceLabels.slice(0, refs.referenceUris.length),
          correction,
          attempt,
          model: settings.models.image,
        });
        const task = await deps.gateway.generateImage(req, gatewayOptions(ctx, 'image', 'sheet', attempt));
        const sheet = await deps.media.importUri(projectId, task.outputs![0]!.uri, {
          kind: 'keyframes',
          name: `sheet-c${clip.index + 1}-a${attempt + 1}`,
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
        for (const [k, shot] of shots.entries())
          drawn.push({
            keyframe: await deps.media.putFile(projectId, cut.files[k]!, {
              kind: 'keyframes',
              name: `board-c${clip.index + 1}-s${shot.index + 1}-panel`,
            }),
            sheet,
            panel: k + 1,
            panels: shots.length,
            prompt: (req.input[0] as { text: string }).text,
            seed: req.parameters?.seed ?? 0,
            imageModel: task.model,
            taskId: task.id,
          });
        // Each panel read against its shot, the sheet's first panel as the others' opening frame
        const readings = await Promise.all(
          drawn.map((panel, k) => {
            const staging = stagingFor(ctxs[k]!, 'storyboard', k > 0 ? drawn[0]!.keyframe : null);
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
            attempt,
            panels: shots.length,
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
      return { panels: Object.fromEntries(shots.map((shot, k) => [shot.id, best!.drawn[k]!])) };
    });
  } catch (err) {
    if (!ctx.signal.aborted) deps.metrics.storyboardSheets.inc({ outcome: 'failed' });
    throw err;
  }
}
