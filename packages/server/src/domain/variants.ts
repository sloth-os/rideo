import {
  type Localization,
  localizationState,
  localizeTimeline,
  newId,
  type ProjectDocs,
  type Timeline,
} from '@rideo/shared';
import { AppError, invalid } from '../errors';

/**
 * A language variant of the cut (docs/design/localization.md#language-variants), or the cut itself without a
 * language. Fails with `localization_incomplete` when a line has no current translation or, dubbed, a speaking take
 * has no current dub.
 */
export function cutVariant(docs: ProjectDocs, opts: { language: string | null; dubbed: boolean }): Timeline {
  const cut = docs.timeline;
  if (!cut) throw invalid('the cut has no picture yet');
  if (!opts.language) {
    if (opts.dubbed) throw invalid('a dubbed export needs a language');
    return cut;
  }
  const loc: Localization | undefined = docs.localizations[opts.language];
  if (!loc)
    throw new AppError(
      'localization_incomplete',
      `the cut has not been translated into ${opts.language} yet`,
    );
  const state = localizationState(loc, cut, docs.clips, docs.characters);
  const lines = [...state.lines.missing, ...state.lines.stale];
  if (lines.length)
    throw new AppError(
      'localization_incomplete',
      `${lines.length} line(s) of the cut have no current ${loc.name} translation: translate again`,
      lines.slice(0, 20).map((key) => ({ line: key })),
    );
  if (opts.dubbed) {
    const takes = [...state.dubs.missing, ...state.dubs.stale];
    if (takes.length)
      throw new AppError(
        'localization_incomplete',
        `${takes.length} speaking take(s) of the cut have no current ${loc.name} dub: dub again`,
        takes.slice(0, 20).map((takeId) => ({ takeId })),
      );
  }
  return localizeTimeline(cut, {
    loc,
    clips: docs.clips,
    characters: docs.characters,
    dubbed: opts.dubbed,
    newId: () => newId('item'),
  });
}
