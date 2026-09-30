import {
  aggregateVerdicts,
  type Character,
  type ConsistencyReport,
  identityFragment,
  type MediaRef,
  type Shot,
} from '@rideo/shared';
import type { Metrics } from '../metrics';
import type { ConsistencyJudge } from './judge';

export interface VerifyInput {
  judge: ConsistencyJudge;
  shot: Pick<Shot, 'description' | 'wardrobe'>;
  /** Characters expected in the frames (shot.characterIds order). */
  characters: Character[];
  /** PNG references per character id. */
  references: Map<string, Buffer[]>;
  /** PNG frames to judge. */
  frames: Buffer[];
  frameRefs: MediaRef[];
  threshold: number;
  attempts: number;
  metrics?: Metrics;
  log?: { warn: (o: unknown, m?: string) => void };
  signal?: AbortSignal;
}

/** Runs the judge and applies the gate's scoring rules; judge failures fail closed as `unverified` (R9). */
export async function verifyFrames(input: VerifyInput): Promise<ConsistencyReport> {
  const base = {
    judge: input.judge.id,
    threshold: input.threshold,
    attempts: input.attempts,
    checkedAt: new Date().toISOString(),
    frames: input.frameRefs,
  };
  if (input.characters.length === 0) {
    input.metrics?.consistency.inc({ result: 'passed' });
    return { ...base, status: 'passed', score: 1, characters: [], note: 'no characters in shot' };
  }
  let verdicts: Awaited<ReturnType<ConsistencyJudge['judge']>>;
  try {
    verdicts = await input.judge.judge({
      characters: input.characters.map((c) => ({
        id: c.id,
        name: c.name,
        identity: identityFragment(c, input.shot),
        references: input.references.get(c.id) ?? [],
      })),
      frames: input.frames,
      shotDescription: input.shot.description,
      signal: input.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    input.log?.warn({ err: (err as Error).message }, 'consistency judge unavailable; take stays unverified');
    input.metrics?.consistency.inc({ result: 'unverified' });
    return {
      ...base,
      status: 'unverified',
      score: 0,
      characters: input.characters.map((c) => ({ characterId: c.id, present: false, score: 0, issues: [] })),
      note: `judge unavailable: ${(err as Error).message.slice(0, 300)}`,
    };
  }
  const agg = aggregateVerdicts(
    input.characters.map((c) => c.id),
    verdicts,
    {
      threshold: input.threshold,
      expectsWardrobe: (id) => (input.characters.find((c) => c.id === id)?.wardrobe.length ?? 0) > 0,
    },
  );
  input.metrics?.consistency.inc({ result: agg.status });
  return { ...base, status: agg.status, score: agg.score, characters: agg.characters };
}
