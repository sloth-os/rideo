import {
  type Clip,
  type DeskMode,
  type DeskResultMessage,
  type DeskShotOutcome,
  deskResultSummary,
  deskShotPatch,
  type Probe,
  type Project,
  planDeskResult,
} from '@rideo/shared';

/** What a `result-ack` says, shot by shot (docs/design/director-desk.md#the-result). */
export interface DeskAck {
  ok: boolean;
  message: string;
  shots: { shotId: string; ok: boolean; error?: string }[];
}

export interface DeskResultDeps {
  /** The browser upload every reference takes (`uploadReference`), the bytes let go afterwards. */
  upload: (file: File, opts: { probe: Probe; poster: Blob | null }) => Promise<{ id: string }>;
  /** `PATCH …/shots/:shotId`. */
  patchShot: (shotId: string, body: Record<string, unknown>) => Promise<unknown>;
  /** The still (PNG) as the poster: posters are stored as JPEG. */
  poster: (png: ArrayBuffer) => Promise<Blob | null>;
}

/**
 * Applies a desk's result (docs/design/director-desk.md#the-result): the shots in order, one at a time, each refused
 * with its reason or uploaded as `desk-c<clip>-s<shot>-<mode>.mp4` with the probe made from the result and the still
 * as its poster, then the shot's PATCH. A shot that fails does not stop the others. The files' bytes are let go once
 * the shots are done.
 */
export async function applyDeskResult(
  result: DeskResultMessage,
  context: {
    project: Pick<Project, 'settings'>;
    clip: Pick<Clip, 'id' | 'index' | 'status' | 'shots'> | null | undefined;
    mode: DeskMode;
  },
  deps: DeskResultDeps,
): Promise<DeskAck> {
  const plans = planDeskResult({ result, ...context });
  const outcomes: DeskShotOutcome[] = [];
  for (const plan of plans) {
    if (!plan.ok) {
      outcomes.push({ shotId: plan.shotId, shot: plan.shot, ok: false, error: plan.reason });
      continue;
    }
    try {
      const file = new File([plan.file.data], plan.fileName, { type: 'video/mp4' });
      const poster = plan.poster ? await deps.poster(plan.poster.data).catch(() => null) : null;
      const resource = await deps.upload(file, { probe: plan.probe, poster });
      await deps.patchShot(plan.shotId, deskShotPatch(plan, resource.id));
      outcomes.push({ shotId: plan.shotId, shot: plan.shot, ok: true, planAgrees: plan.planAgrees });
    } catch (err) {
      outcomes.push({
        shotId: plan.shotId,
        shot: plan.shot,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // the ArrayBuffers the desk transferred are not kept
  result.files.length = 0;
  plans.length = 0;
  const summary = deskResultSummary(outcomes);
  return {
    ...summary,
    shots: outcomes.map((o) => ({ shotId: o.shotId, ok: o.ok, ...(o.error ? { error: o.error } : {}) })),
  };
}

/** A PNG re-encoded as JPEG in the browser (posters are stored as JPEG); null when the browser cannot. */
export async function pngToJpeg(png: ArrayBuffer, quality = 0.85): Promise<Blob | null> {
  if (typeof createImageBitmap === 'undefined') return null;
  const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      return await canvas.convertToBlob({ type: 'image/jpeg', quality });
    }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  } finally {
    bitmap.close();
  }
}
