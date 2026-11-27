import {
  byCount,
  FEEDBACK_DIMENSIONS,
  type FeedbackDimension,
  type FeedbackRetake,
  type FeedbackScores,
  type FeedbackShotSpan,
  type FeedbackSignals,
  type Job,
  type ProjectDocs,
  type ProjectUsage,
  plural,
  type RetrospectiveArea,
  type RetrospectiveItem,
} from '@rideo/shared';

/**
 * The retrospective of a project (docs/design/feedback.md#retrospective-improvements-after-every-project): rules over
 * the run's own numbers, each a predicate with a message carrying them, so every finished film leaves behind what to
 * do better next time.
 */
export interface RunFacts {
  docs: ProjectDocs;
  usage: ProjectUsage;
  /** Job records of the last seven days. */
  jobs: Job[];
  signals: FeedbackSignals;
  scores: FeedbackScores;
  spans: FeedbackShotSpan[];
  /** The shots with a new take since the previous feedback (docs/design/feedback.md#what-changed-since-the-last-feedback). */
  retakes?: FeedbackRetake[];
}

interface Rule {
  id: string;
  area: RetrospectiveArea;
  check: (f: RunFacts) => { title: string; detail: string } | null;
}

/** What addresses a weak dimension, for `low_dimension`. */
const ADVICE: Record<FeedbackDimension, string> = {
  storytelling:
    'Re-plan the weakest scenes with a clear goal, obstacle and turn (apply the re-plan recommendations), and keep the brief and the beat purposes in every extension (prompt version 2).',
  continuity:
    'Keep prompt version 2 (the scene line and the scene reference frame) and write each scene’s continuity state: time of day, weather, light, wardrobe.',
  character:
    'Approve a clearer front reference for the characters who fail most, keep their identity text short and visual, or raise the consistency threshold.',
  temporal:
    'Turn the quality checks on so takes that jump or morph are generated again, and regenerate the shots the feedback names.',
  physics:
    'Turn the quality checks on (or raise their threshold) and describe weight, contact and direction in each shot’s action.',
  realism:
    'Make the style bible concrete (lens, light, materials, palette) and give every shot a real focal length.',
  cinematography:
    'Vary the framing (wide, medium, close, inserts), one motivated camera move per shot, a lens per framing.',
  editing: 'Trim long holds, vary shot lengths with the action, and cut on movement.',
  dialogue:
    'Set an audio-visual model so the sound check hears every take, keep lines short and at the film’s level, and name each speaker’s voice in the same words in every prompt (prompt version 2).',
  sound:
    'Normalize loudness, fill silent stretches with ambience or music, and keep each line short enough for its shot.',
};

function percent(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

function jobSeconds(j: Job): number | null {
  if (!j.startedAt || !j.finishedAt) return null;
  return Math.max(0, (Date.parse(j.finishedAt) - Date.parse(j.startedAt)) / 1000);
}

/** The cut's selected takes with their shots. */
function cutTakes(f: RunFacts) {
  return f.spans.flatMap((span) => {
    const shot = f.docs.clips[span.clipId]?.shots.find((s) => s.id === span.shotId);
    const take = shot?.takes.find((t) => t.id === span.takeId);
    return shot && take ? [{ shot, take, span }] : [];
  });
}

export const RETROSPECTIVE_RULES: Rule[] = [
  {
    id: 'gate_first_try',
    area: 'quality',
    check: (f) => {
      const takes = cutTakes(f).filter((t) => t.take.video);
      if (takes.length < 3) return null;
      const first = takes.filter(
        (t) => t.take.consistency.status === 'passed' && t.take.consistency.attempts <= 1,
      );
      const share = first.length / takes.length;
      if (share >= 0.6) return null;
      // The character who failed most across every take of the project.
      const failures = new Map<string, number>();
      for (const clip of Object.values(f.docs.clips))
        for (const shot of clip.shots)
          for (const take of shot.takes)
            for (const c of take.consistency.characters)
              if (!c.present || c.score < take.consistency.threshold)
                failures.set(c.characterId, (failures.get(c.characterId) ?? 0) + 1);
      const worst = [...failures.entries()].sort((a, b) => b[1] - a[1])[0];
      const name = worst ? f.docs.characters[worst[0]]?.name : undefined;
      return {
        title: `Only ${percent(share)} of the shots passed the identity check on the first try`,
        detail: `${first.length} of ${plural(takes.length, 'take')} in the cut passed at once; every retry is another paid generation.${name ? ` ${name} failed most (${plural(worst![1], 'time')}): approve a clearer front reference or simplify their identity.` : ''}`,
      };
    },
  },
  {
    id: 'discarded_generations',
    area: 'cost',
    check: (f) => {
      const t = f.usage.totals;
      if (t.videoSeconds <= 0 || t.discardedVideoSeconds / t.videoSeconds <= 0.2) return null;
      const discarded = Math.round(t.discardedVideoSeconds);
      return {
        title: `${percent(t.discardedVideoSeconds / t.videoSeconds)} of the generated video was thrown away`,
        detail: `${discarded} of ${plural(Math.round(t.videoSeconds), 'second')} ${byCount(discarded, 'was an attempt', 'were attempts')} the gate discarded${t.discardedCostUsd ? ` (about $${t.discardedCostUsd.toFixed(2)})` : ''}. Clearer references and the storyboard stage catch problems before video is paid for.`,
      };
    },
  },
  {
    id: 'unverified_takes',
    area: 'reliability',
    check: (f) => {
      const n = f.signals.takes.unverified;
      if (!n) return null;
      return {
        title: `${plural(n, 'take')} in the cut ${byCount(n, 'was', 'were')} never verified`,
        detail: `The vision judge was unavailable when ${byCount(n, 'it was', 'they were')} made. Check the vision provider, then re-check ${byCount(n, 'that take instead of overriding it', 'those takes instead of overriding them one by one')}.`,
      };
    },
  },
  {
    id: 'overridden_takes',
    area: 'quality',
    check: (f) => {
      const n = f.signals.takes.overridden;
      if (!n) return null;
      const them = byCount(n, 'it', 'them');
      return {
        title: `${plural(n, 'take')} in the cut ${byCount(n, 'was', 'were')} overridden`,
        detail: `A person accepted ${them} without a passing check: look at ${them} first when the film looks wrong.`,
      };
    },
  },
  {
    id: 'quality_failures',
    area: 'quality',
    check: (f) => {
      const n = f.signals.takes.qualityFailed;
      if (!n) return null;
      return {
        title: `${plural(n, 'take')} in the cut failed the temporal or physics check`,
        detail: `${byCount(n, 'It was', 'They were')} kept because no attempt did better. Regenerate ${byCount(n, 'it', 'them')} with a revised action (the feedback recommends how).`,
      };
    },
  },
  {
    id: 'llm_retries',
    area: 'reliability',
    check: (f) => {
      const n = f.usage.totals.llmRetries;
      if (!n) return null;
      return {
        title: `${plural(n, 'language or vision call')} ${byCount(n, 'was', 'were')} turned away for load`,
        detail: `The provider answered 429 or 5xx and ${byCount(n, 'the call was', 'the calls were')} made again. A second provider, or fewer parallel jobs in the llm lane, keeps writing and judging moving.`,
      };
    },
  },
  {
    id: 'queue_wait',
    area: 'performance',
    check: (f) => {
      const k = f.usage.byKind['shot.generate'];
      if (!k || k.jobs < 5 || k.waitSeconds <= k.runSeconds) return null;
      return {
        title: 'Shots waited longer in the queue than they ran',
        detail: `${plural(Math.round(k.waitSeconds / 60), 'minute')} waiting against ${plural(Math.round(k.runSeconds / 60), 'minute')} running: raise the video lane (RIDEO_LANES video=…) if the gateway and provider allow more at once.`,
      };
    },
  },
  {
    id: 'slow_shots',
    area: 'performance',
    check: (f) => {
      const p90 = quantile(
        f.jobs
          .filter((j) => j.kind === 'shot.generate' && j.status === 'succeeded')
          .map(jobSeconds)
          .filter((x): x is number => x !== null),
        0.9,
      );
      if (p90 === null || p90 <= 600) return null;
      return {
        title: `The slowest tenth of shots took over ${plural(Math.round(p90 / 60), 'minute')}`,
        detail:
          'Look at rideo_shot_step_seconds and rideo_take_attempts: retries, a slow video model or a slow judge each show there.',
      };
    },
  },
  {
    id: 'failed_jobs',
    area: 'reliability',
    check: (f) => {
      const failed = f.jobs.filter((j) => j.status === 'failed');
      if (!failed.length) return null;
      const byKind = new Map<string, Job[]>();
      for (const j of failed) byKind.set(j.kind, [...(byKind.get(j.kind) ?? []), j]);
      const top = [...byKind.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3);
      return {
        title: `${plural(failed.length, 'job')} failed`,
        detail: top
          .map(([kind, jobs]) => {
            const codes = new Map<string, number>();
            for (const j of jobs)
              codes.set(j.error?.code ?? 'unknown', (codes.get(j.error?.code ?? 'unknown') ?? 0) + 1);
            const code = [...codes.entries()].sort((a, b) => b[1] - a[1])[0]![0];
            return `${kind}: ${jobs.length} (mostly ${code})`;
          })
          .join('; '),
      };
    },
  },
  {
    id: 'cost_per_minute',
    area: 'cost',
    check: (f) => {
      const t = f.usage.totals;
      const minutes = f.signals.durationSec / 60;
      const unpriced = Object.entries(t.byModel)
        .filter(([, m]) => m.unpriced > 0)
        .map(([id]) => id);
      if (t.costUsd > 0 && minutes > 0)
        return {
          title: `About $${(t.costUsd / minutes).toFixed(2)} per finished minute`,
          detail: `$${t.costUsd.toFixed(2)} for ${minutes.toFixed(1)} minutes of film${unpriced.length ? `; not priced: ${unpriced.join(', ')}` : ''}.`,
        };
      if (unpriced.length)
        return {
          title: 'The cost of this film is not known',
          detail: `Set prices for ${unpriced.join(', ')} in Settings (RIDEO_PRICES) to see what films cost.`,
        };
      return null;
    },
  },
  {
    id: 'low_dimension',
    area: 'quality',
    check: (f) => {
      const low = FEEDBACK_DIMENSIONS.map((d) => ({ d, v: f.scores[d.id] }))
        .filter(
          (x): x is { d: (typeof FEEDBACK_DIMENSIONS)[number]; v: number } =>
            typeof x.v === 'number' && x.v < 7,
        )
        .sort((a, b) => a.v - b.v)
        .slice(0, 2);
      if (!low.length) return null;
      return {
        title: `Weakest: ${low.map((x) => `${x.d.label.toLowerCase()} (${x.v.toFixed(1)}/10)`).join(' and ')}`,
        detail: low.map((x) => ADVICE[x.d.id]).join(' '),
      };
    },
  },
  {
    id: 'unexpected_cuts',
    area: 'quality',
    check: (f) => {
      const n = f.signals.unexpectedCuts.length;
      if (!n) return null;
      return {
        title: `${plural(n, 'shot')} ${byCount(n, 'jumps', 'jump')} inside the shot`,
        detail: `Stray cuts, pops or morphs the model made. The quality checks retry such takes; regenerate ${byCount(n, 'the one', 'the ones')} in this cut.`,
      };
    },
  },
  {
    id: 'framing_runs',
    area: 'quality',
    check: (f) =>
      f.signals.framingRuns.length
        ? {
            title: `${plural(f.signals.framingRuns.length, 'run')} of more than three shots with the same framing`,
            detail: 'Vary coverage: establish wide, move closer for emotion, cut to inserts and reactions.',
          }
        : null,
  },
  {
    id: 'rushed_lines',
    area: 'quality',
    check: (f) => {
      const n = f.signals.rushedLines.length;
      if (!n) return null;
      return {
        title: `${plural(n, 'line')} ${byCount(n, 'is too long for its shot', 'are too long for their shots')}`,
        detail: `${byCount(n, 'It is', 'They are')} spoken too fast or cut off. Prompt version 2 fits lines to shots when planning; shorten or split ${byCount(n, 'it', 'these')}.`,
      };
    },
  },
  {
    id: 'undelivered_lines',
    area: 'quality',
    check: (f) => {
      const d = f.signals.dialogue;
      if (!d?.missing.length) return null;
      const shots = new Set(d.missing.map((m) => m.shotId)).size;
      return {
        title: `${d.missing.length} of ${plural(d.lines, 'line')} ${byCount(d.missing.length, 'is', 'are')} not heard in the film`,
        detail: `The video model did not voice ${byCount(d.missing.length, 'it', 'them')} clearly. Apply the recommendations to generate ${byCount(shots, 'that shot', 'those shots')} again, and turn the quality checks on with an audio-visual model so the sound check catches such lines while generating.`,
      };
    },
  },
  {
    id: 'retake_results',
    area: 'quality',
    check: ({ retakes }) => {
      if (!retakes?.length) return null;
      const n = (o: FeedbackRetake['outcome']) => retakes.filter((r) => r.outcome === o);
      const [better, same, worse] = [n('better'), n('same'), n('worse')];
      const names = (rs: FeedbackRetake[]) =>
        `${rs
          .slice(0, 8)
          .map((r) => r.shot)
          .join(', ')}${rs.length > 8 ? '…' : ''}`;
      return {
        title: `${plural(retakes.length, 'shot')} ${byCount(retakes.length, 'has', 'have')} a new take since the last feedback: ${better.length} better, ${same.length} the same, ${worse.length} worse`,
        detail:
          worse.length || same.length
            ? `${worse.length ? `Worse now: ${names(worse)}. ` : ''}${same.length ? `No better: ${names(same)}. ` : ''}A shot that fails the same way twice needs a new plan (re-plan the scene, or describe what goes wrong in the shot's negative prompt), not another attempt.`
            : 'Every new take fixed what the previous feedback saw.',
      };
    },
  },
  {
    id: 'target_missed',
    area: 'quality',
    check: (f) => {
      const target = f.signals.targetDurationSec;
      if (!target || Math.abs(f.signals.durationSec - target) / target <= 0.1) return null;
      return {
        title: `The film is ${f.signals.durationSec > target ? 'longer' : 'shorter'} than its target`,
        detail: `${Math.round(f.signals.durationSec)} s against ${Math.round(target)} s.`,
      };
    },
  },
];

export function retrospective(facts: RunFacts): RetrospectiveItem[] {
  const out: RetrospectiveItem[] = [];
  for (const rule of RETROSPECTIVE_RULES) {
    const hit = rule.check(facts);
    if (hit) out.push({ area: rule.area, ...hit, source: 'rule', rule: rule.id });
  }
  return out;
}
