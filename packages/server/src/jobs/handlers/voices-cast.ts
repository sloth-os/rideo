import { isTerminalJob, speakingCharacters, voiceOf } from '@rideo/shared';
import { AppError } from '../../errors';
import type { JobContext } from '../queue';
import { docsFor, type HandlerDeps } from './common';

/**
 * `voices.cast` (docs/design/agents.md#many-things-at-once): candidates for every speaking character without a voice,
 * then, when asked, the first candidate chosen and the voice locked.
 */
export async function voicesCast(deps: HandlerDeps, ctx: JobContext) {
  const { characterIds, pick, lock } = ctx.job.params as {
    characterIds: string[] | null;
    pick: boolean;
    lock: boolean;
  };
  const projectId = ctx.job.projectId;
  const wanted = (docs: Awaited<ReturnType<typeof docsFor>>) =>
    speakingCharacters(docs).filter(
      (c) => (!characterIds?.length || characterIds.includes(c.id)) && !voiceOf(c).lock.locked,
    );
  let docs = await docsFor(deps, ctx);
  const cast = wanted(docs);
  ctx.progress(0, 3, `${cast.length} voice(s) to cast`);
  const designs = [];
  for (const c of cast) {
    const v = voiceOf(c);
    if (!v.voiceId && !v.sample && v.candidates.length === 0)
      designs.push(await deps.services.voices.design(ctx.actor, projectId, c.id));
  }
  if (designs.length) {
    const done = await ctx.waitFor(designs.map((j) => j.id));
    const failed = done.find((j) => isTerminalJob(j) && j.status !== 'succeeded');
    if (failed)
      throw new AppError(
        'validation_error',
        `voice design failed: ${failed.error?.message ?? failed.status}`,
      );
  }
  ctx.progress(1, 3, 'candidates ready');
  const out: { characterId: string; name: string; picked: boolean; locked: boolean }[] = [];
  docs = await docsFor(deps, ctx);
  for (const c of wanted(docs)) {
    let v = voiceOf(c);
    let picked = false;
    if (pick && !v.voiceId && !v.sample && v.candidates[0]) {
      const next = await deps.services.voices.select(ctx.actor, projectId, c.id, v.candidates[0].id);
      v = voiceOf(next);
      picked = true;
    }
    let locked = false;
    if (lock && (v.voiceId || v.sample)) {
      await deps.services.voices.lock(ctx.actor, projectId, c.id);
      locked = true;
    }
    out.push({ characterId: c.id, name: c.name, picked, locked });
  }
  ctx.progress(3, 3, 'cast');
  deps.log.info({ projectId, jobId: ctx.job.id, voices: out.length }, 'voices cast');
  return { characters: out };
}
