import {
  type Actor,
  type Clip,
  cutLines,
  docPath,
  type Job,
  type Localization,
  type LocalizationState,
  languageName,
  localizationState,
  subtitleCues,
  type Timeline,
  toSrt,
  toVtt,
} from '@rideo/shared';
import { AppError, invalid, notFound } from '../errors';
import { Service } from './base';
import { cutVariant } from './variants';

/** Translation, dubbing and subtitles of the cut (docs/design/localization.md#surfaces); REST and MCP share it. */
export class LocalizationService extends Service {
  /** Queues `localize.generate`: translate the cut, and dub it (`dub`), lip-syncing close-ups (`lipSync`). */
  async localize(
    actor: Actor,
    projectId: string,
    input: { language: string; dub?: boolean; lipSync?: boolean },
  ): Promise<Job> {
    const docs = await this.deps.projects.docs(projectId);
    if (!docs.timeline?.tracks.some((t) => t.kind === 'video' && t.items.length))
      throw invalid('the cut has no picture yet: assemble it first');
    if (!cutLines(docs.timeline, docs.clips).length) throw invalid('the cut has no dialogue to translate');
    if (input.dub && !this.deps.tts)
      throw new AppError(
        'tts_unavailable',
        'dubbing needs a TTS provider on the server (RIDEO_TTS_PROVIDER)',
      );
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'localize.generate',
      params: { language: input.language, dub: !!input.dub, lipSync: !!input.lipSync },
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: `localize:${input.language}`,
      priority: 10,
    });
  }

  /** Every language of the project with how far it is for the current cut. */
  async list(projectId: string): Promise<(Localization & { state: LocalizationState })[]> {
    const docs = await this.deps.projects.docs(projectId);
    return Object.values(docs.localizations).map((loc) => ({
      ...loc,
      state: docs.timeline
        ? localizationState(loc, docs.timeline, docs.clips, docs.characters)
        : {
            lines: { total: 0, current: 0, missing: [], stale: [] },
            dubs: { needed: 0, current: 0, missing: [], stale: [], lipSynced: 0 },
          },
    }));
  }

  /** A person's translation of one line; it stays when the cut is translated again. */
  async updateLine(
    actor: Actor,
    projectId: string,
    language: string,
    input: { shotId: string; index: number; text: string },
  ): Promise<Localization> {
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const loc = tx.get<Localization>(docPath.localization(language));
        if (!loc) throw notFound(`localization ${language}`);
        const timeline = tx.get<Timeline>('timeline.json');
        const clips = Object.fromEntries(tx.list<Clip>('clips/').map((c) => [c.id, c]));
        const line = timeline
          ? cutLines(timeline, clips).find((l) => l.shotId === input.shotId && l.index === input.index)
          : null;
        if (!line) throw notFound(`line ${input.index} of shot ${input.shotId} in the cut`);
        const entry = {
          shotId: line.shotId,
          index: line.index,
          characterId: line.characterId,
          source: line.text,
          text: input.text.trim(),
          edited: true,
        };
        const next: Localization = {
          ...loc,
          lines: [...loc.lines.filter((l) => !(l.shotId === input.shotId && l.index === input.index)), entry],
          updatedAt: new Date().toISOString(),
        };
        tx.set(docPath.localization(language), next);
        return next;
      },
      { message: `Edit the ${languageName(language)} translation of a line` },
    );
    return result;
  }

  async remove(actor: Actor, projectId: string, language: string): Promise<void> {
    await this.mutate(
      actor,
      projectId,
      (tx) => {
        if (!tx.get(docPath.localization(language))) throw notFound(`localization ${language}`);
        tx.delete(docPath.localization(language));
      },
      { message: `Remove the ${languageName(language)} localization` },
    );
  }

  /** The cut's subtitles (SRT or WebVTT), in a language when given (docs/design/localization.md#subtitle-files). */
  async subtitles(projectId: string, input: { language?: string; format: 'srt' | 'vtt' }): Promise<string> {
    const docs = await this.deps.projects.docs(projectId);
    const t = cutVariant(docs, { language: input.language ?? null, dubbed: false });
    const cues = subtitleCues(t);
    return input.format === 'srt' ? toSrt(cues) : toVtt(cues);
  }
}
