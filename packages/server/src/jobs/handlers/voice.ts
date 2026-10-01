import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Character,
  docPath,
  fnv1a32,
  newId,
  type VoiceCandidate,
  voiceOf,
  voiceSampleText,
} from '@rideo/shared';
import { AppError, notFound } from '../../errors';
import { extFor } from '../../media/store';
import type { JobContext } from '../queue';
import { commitAs, docsFor, type HandlerDeps } from './common';

/** `voice.design` (docs/design/dialogue.md#voice-of-a-character): previews to pick from, replacing earlier ones. */
export async function voiceDesign(deps: HandlerDeps, ctx: JobContext) {
  const { characterId } = ctx.job.params as { characterId: string };
  const projectId = ctx.job.projectId;
  const docs = await docsFor(deps, ctx);
  const c = docs.characters[characterId];
  if (!c) throw notFound(`character ${characterId}`);
  const voice = voiceOf(c);
  if (voice.lock.locked) throw new AppError('voice_locked', `${c.name}'s voice is locked (rule V2)`);
  const tts = deps.services.voices.tts();
  const lines = (docs.screenplay?.scenes ?? [])
    .flatMap((s) => s.dialogue)
    .filter((d) => d.characterId === characterId)
    .map((d) => d.line);
  const description =
    voice.description.trim() ||
    [c.identity.age, c.identity.gender, c.personality].filter((x) => x?.trim()).join(', ');
  ctx.progress(0.1, 1, 'designing voices');
  const previews = await tts.design({
    description,
    text: voiceSampleText(c, lines),
    seed: fnv1a32(`voice:${characterId}:${voice.candidates.length}`),
    signal: ctx.signal,
  });
  const candidates: VoiceCandidate[] = await deps.media.withTmpDir(async (dir) => {
    const out: VoiceCandidate[] = [];
    for (const [i, p] of previews.slice(0, 4).entries()) {
      const path = join(dir, `preview-${i}.${extFor(p.mime)}`);
      await writeFile(path, p.audio);
      const sample = await deps.media.putFile(projectId, path, {
        kind: 'voices',
        name: `${c.name}-voice-${i + 1}`,
        mime: p.mime,
      });
      out.push({ id: newId('voice'), voiceId: p.voiceId, sample, createdAt: new Date().toISOString() });
    }
    return out;
  });
  await commitAs(
    deps,
    ctx,
    (tx) => {
      const cur = structuredClone(
        tx.require<Character>(docPath.character(characterId), `character ${characterId}`),
      );
      const v = voiceOf(cur);
      if (v.lock.locked) throw new AppError('voice_locked', `${cur.name}'s voice is locked (rule V2)`);
      tx.set(docPath.character(characterId), {
        ...cur,
        voice: { ...v, description: v.description || description, candidates },
      });
    },
    `Design ${candidates.length} voices for ${c.name}`,
  );
  ctx.progress(1, 1, `${candidates.length} voices`);
  return { candidates: candidates.length };
}
