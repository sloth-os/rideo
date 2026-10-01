import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ContentCredentialsStamp,
  currentTranslation,
  cutLines,
  cutTakes,
  type Dub,
  docPath,
  dubIsCurrent,
  type Localization,
  LocalizationSchema,
  languageName,
  lineKey,
  type MediaRef,
  needsLipSync,
  type TranslatedLine,
  voicedLines,
} from '@rideo/shared';
import { assertVoicesReady } from '../../domain/clips';
import { AppError, invalid } from '../../errors';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { commitAs, docsFor, type HandlerDeps } from './common';
import { lipSyncPass, speakLines } from './dialogue';

const BATCH = 40;

/**
 * `localize.generate` (docs/design/localization.md): translates the cut's dialogue into a language and, with `dub`,
 * speaks every speaking take in it with the characters' locked voices, lip-syncing close-ups with `lipSync`.
 */
export async function localizeGenerate(deps: HandlerDeps, ctx: JobContext) {
  const { language, dub, lipSync } = ctx.job.params as { language: string; dub?: boolean; lipSync?: boolean };
  const projectId = ctx.job.projectId;
  const log = deps.log.child({ projectId, jobId: ctx.job.id, language });
  let docs = await docsFor(deps, ctx);
  const cut = docs.timeline;
  if (!cut) throw invalid('the cut has no picture yet');
  const now = () => new Date().toISOString();
  const name = languageName(language);

  // 1. Translation: missing and stale lines, scene by scene; edited lines stay while their source is unchanged.
  const lines = cutLines(cut, docs.clips);
  const loc0 = docs.localizations[language];
  const todo = lines.filter((l) => !currentTranslation(loc0, l.shotId, l.index, l.text));
  const sceneOf = new Map<string, string>();
  for (const { shot, clip } of cutTakes(cut, docs.clips)) {
    const scene = docs.screenplay?.scenes.find((s) => s.id === clip.sceneId);
    sceneOf.set(shot.id, scene?.heading ?? clip.title);
  }
  const translated = new Map<string, string>();
  const groups = new Map<string, typeof todo>();
  for (const l of todo)
    groups.set(sceneOf.get(l.shotId) ?? '', [...(groups.get(sceneOf.get(l.shotId) ?? '') ?? []), l]);
  let done = 0;
  for (const [scene, group] of groups) {
    for (let k = 0; k < group.length; k += BATCH) {
      throwIfAborted(ctx.signal);
      const batch = group.slice(k, k + BATCH);
      ctx.progress(done, todo.length, `translating into ${name} (${done}/${todo.length})`);
      const out = await deps.llm.translate(
        {
          language,
          languageName: name,
          film: {
            title: docs.screenplay?.title || docs.project.title,
            logline: docs.screenplay?.logline ?? '',
            tone: docs.screenplay?.tone ?? '',
          },
          characters: Object.values(docs.characters).map((c) => ({ name: c.name, summary: c.summary })),
          scene,
          lines: batch.map((l) => ({
            key: lineKey(l.shotId, l.index),
            speaker: l.characterId ? (docs.characters[l.characterId]?.name ?? '') : '',
            text: l.text,
          })),
        },
        ctx.signal,
      );
      const byKey = new Map(out.lines.map((x) => [x.key, x.text.trim()]));
      for (const l of batch) {
        const text = byKey.get(lineKey(l.shotId, l.index));
        if (!text)
          throw new AppError(
            'llm_invalid_output',
            `no translation for line ${lineKey(l.shotId, l.index)}`,
            [],
            true,
          );
        translated.set(lineKey(l.shotId, l.index), text);
      }
      done += batch.length;
    }
  }
  if (translated.size || !loc0) {
    await commitAs(
      deps,
      ctx,
      (tx) => {
        const cur = tx.get<Localization>(docPath.localization(language));
        const kept = (cur?.lines ?? []).filter((x) => !translated.has(lineKey(x.shotId, x.index)));
        const added: TranslatedLine[] = todo
          .filter((l) => translated.has(lineKey(l.shotId, l.index)))
          .map((l) => ({
            shotId: l.shotId,
            index: l.index,
            characterId: l.characterId,
            source: l.text,
            text: translated.get(lineKey(l.shotId, l.index))!,
            edited: false,
          }));
        const next = LocalizationSchema.parse({
          id: language,
          name,
          lines: [...kept, ...added],
          dubs: cur?.dubs ?? {},
          createdAt: cur?.createdAt ?? now(),
          updatedAt: now(),
        });
        tx.set(docPath.localization(language), next);
      },
      `Translate the cut into ${name} (${translated.size} line${translated.size === 1 ? '' : 's'})`,
    );
    deps.metrics.localization.inc({ op: 'translate', outcome: 'ok' }, translated.size);
  }
  log.info({ translated: translated.size, lines: lines.length }, 'translated the cut');
  if (!dub) return { language, translated: translated.size, dubbed: 0, lipSynced: 0 };

  // 2. Dubbing: every speaking take of the cut without a current dub.
  docs = await docsFor(deps, ctx);
  const loc = docs.localizations[language]!;
  const takes = cutTakes(docs.timeline!, docs.clips).filter(
    ({ shot }, k, all) =>
      voicedLines(shot, docs.characters).length > 0 && all.findIndex((x) => x.shot.id === shot.id) === k,
  );
  assertVoicesReady(
    deps,
    takes.map((x) => x.shot),
    docs.characters,
    { dialogue: { ...docs.project.settings.dialogue, mode: 'tts' } },
  );
  if (!deps.tts)
    throw new AppError('tts_unavailable', 'dubbing needs a TTS provider on the server (RIDEO_TTS_PROVIDER)');
  let dubbed = 0;
  let lipSynced = 0;
  for (const [k, { clip, shot, take }] of takes.entries()) {
    throwIfAborted(ctx.signal);
    if (dubIsCurrent(loc.dubs[take.id], loc, shot, docs.characters)) continue;
    ctx.progress(k, takes.length, `dubbing ${k + 1}/${takes.length} in ${name}`);
    const wanted = voicedLines(shot, docs.characters).map((l) => ({
      ...l,
      text: currentTranslation(loc, shot.id, l.index, l.text)!.text,
    }));
    const tag = `${language}-c${clip.index + 1}-s${shot.index + 1}`;
    const result = await deps.media.withTmpDir(async (dir) => {
      const spoken = await speakLines(deps, ctx, {
        shot,
        characters: docs.characters,
        settings: docs.project.settings,
        dir,
        name: tag,
        lines: wanted,
        language,
      });
      if (!spoken) throw new AppError('tts_unavailable', `could not speak the ${name} lines of ${tag}`);
      let video: {
        ref: MediaRef;
        watermarkId: string | null;
        contentCredentials: ContentCredentialsStamp | null;
      } | null = null;
      if (lipSync && take.video && needsLipSync(shot, docs.characters)) {
        const local = await deps.media.localPath(projectId, take.video);
        const synced = await lipSyncPass(deps, ctx, {
          video: local,
          mixUri: spoken.mix.uri,
          settings: docs.project.settings,
          dir,
          attempt: 0,
          step: `lipsync-${take.id}`,
        });
        if (synced)
          video = await finishDubVideo(deps, ctx, {
            local: synced.path,
            dir,
            tag,
            clip,
            shot,
            take,
            language,
            name,
          });
        deps.metrics.localization.inc({ op: 'lipsync', outcome: synced ? 'ok' : 'failed' });
      }
      return { spoken, video };
    });
    const entry: Dub = {
      takeId: take.id,
      shotId: shot.id,
      clipId: clip.id,
      dialogue: result.spoken.mix.ref,
      lines: result.spoken.lines,
      voiceLocks: result.spoken.voiceLocks,
      video: result.video?.ref ?? null,
      watermarkId: result.video?.watermarkId ?? null,
      contentCredentials: result.video?.contentCredentials ?? null,
      createdAt: now(),
    };
    await commitAs(
      deps,
      ctx,
      (tx) => {
        const cur = tx.require<Localization>(docPath.localization(language), `localization ${language}`);
        tx.set(docPath.localization(language), {
          ...cur,
          dubs: { ...cur.dubs, [take.id]: entry },
          updatedAt: now(),
        });
      },
      `Dub ${tag} in ${name}${entry.video ? ' (lip-synced)' : ''}`,
    );
    dubbed++;
    if (entry.video) lipSynced++;
    deps.metrics.localization.inc({ op: 'dub', outcome: 'ok' });
  }
  log.info({ dubbed, lipSynced, takes: takes.length }, 'dubbed the cut');
  return { language, translated: translated.size, dubbed, lipSynced };
}

/** A lip-synced take: watermarked and signed as an AI edit of the take (docs/design/localization.md#dubbing). */
async function finishDubVideo(
  deps: HandlerDeps,
  ctx: JobContext,
  input: {
    local: string;
    dir: string;
    tag: string;
    clip: { id: string };
    shot: { id: string };
    take: { id: string; video: MediaRef | null };
    language: string;
    name: string;
  },
): Promise<{
  ref: MediaRef;
  watermarkId: string | null;
  contentCredentials: ContentCredentialsStamp | null;
}> {
  const projectId = ctx.job.projectId;
  const settings = (await deps.projects.docs(projectId)).project.settings;
  const watermarkId = settings.watermark.enabled ? await deps.watermark.allocateId() : null;
  const marked = join(input.dir, `${input.tag}-dub.mp4`);
  if (watermarkId)
    await deps.watermark.embedVideo(input.local, marked, {
      id: watermarkId,
      title: `${input.tag} (${input.name})`,
      crf: 18,
      preset: 'veryfast',
      signal: ctx.signal,
    });
  else await copyFile(input.local, marked);
  let stored = marked;
  let contentCredentials: ContentCredentialsStamp | null = null;
  if (deps.c2pa.enabled && input.take.video) {
    stored = join(input.dir, `${input.tag}-dub-signed.mp4`);
    contentCredentials = await deps.c2pa.signTake({
      input: marked,
      output: stored,
      title: `${input.tag} (${input.name})`,
      projectId,
      asset: { clipId: input.clip.id, shotId: input.shot.id, takeId: input.take.id },
      watermarkId,
      models: { videoModel: settings.models.lipSync },
      consistency: { status: 'unverified', score: 0, judge: 'off' },
      parent: {
        path: await deps.media.localPath(projectId, input.take.video),
        op: 'dub',
        instruction: `Lips re-rendered to the ${input.name} dub`,
      },
    });
  }
  const ref = await deps.media.putFile(projectId, stored, {
    kind: 'takes',
    name: `${input.tag}-dub`,
    mime: 'video/mp4',
  });
  if (watermarkId)
    await deps.watermark.register({
      id: watermarkId,
      projectId,
      asset: {
        kind: 'dub',
        id: input.take.id,
        clipId: input.clip.id,
        shotId: input.shot.id,
        language: input.language,
      },
      media: { path: ref.path, hash: ref.hash },
      embed: {
        width: ref.width ?? 0,
        height: ref.height ?? 0,
        strength: deps.watermark.params.strength,
        pair: deps.watermark.params.pair,
      },
    });
  return { ref, watermarkId, contentCredentials };
}
