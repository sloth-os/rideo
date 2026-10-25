# Feedback on the finished film

The consistency gate judges takes one at a time. Nobody judges the film until a person watches it, and by then what
is wrong (a sun that jumps between cuts, a scene that tells nothing, skis through a leg, the same medium shot eight
times) is spread over hours of footage. **Feedback** watches every export of a story project with the vision model,
with the whole project in hand (screenplay, cast, shots, takes and their reports), and writes:

- **scores** for the dimensions of a good film, for each scene and for the film;
- **issues**, each pinned to a time in the export and to the shot that made it;
- **recommendations**, as many as are useful, most important first, each one with an **action** Rideo can apply
  (regenerate a shot with a revised prompt, re-plan a scene, change a setting);
- the **retrospective**: what to improve in how the film was made, from the run's own numbers (cost, time, retries,
  failures), written after every project so the next one goes better.

## Dimensions

`FEEDBACK_DIMENSIONS` (shared) is the table; the model scores each 0–10, and the overall score is the weighted mean.

| Id | Weight | What is judged |
|---|---|---|
| `storytelling` | 2 | clear setup, goals, conflict, turns and payoff; scenes follow from each other; the pace serves the story; the dialogue moves it |
| `continuity` | 1.5 | across cuts: time of day, light direction, weather, wardrobe, props, positions and screen direction match |
| `character` | 1.5 | the same faces, bodies and outfits all film long |
| `temporal` | 1 | inside shots: no morphing, flicker, popping or stray cuts; smooth motion |
| `physics` | 1 | weight, gravity, momentum, contact with the ground, anatomy, objects keeping their shape and number |
| `realism` | 1 | believable light, materials, scale and depth, a camera that behaves like a camera, no AI artefacts |
| `cinematography` | 1 | framing, composition, coverage, lens choice, camera movement |
| `editing` | 1 | shot lengths, rhythm, cut points, transitions, no repetition |
| `sound` | 0.5 | from measurements, not the vision model: loudness on target, no long silences or clipping, lines that fit their shots |

## How a film is watched

`export.feedback` (lane `llm`) runs after the export succeeds:

1. **Signals** (ffmpeg on the export, no model): black stretches (`blackdetect`), frozen stretches
   (`freezedetect`, 1.5 s), long silences (`silencedetect`, 3 s at −50 dB) and **unexpected cuts**: scene changes
   (`select='gt(scene,0.4)'`) farther than 0.3 s from every cut of the render timeline are jumps inside a shot. Plus
   numbers from the project: shot lengths, runs of the same framing, takes in the cut by consistency state (passed,
   unverified, overridden), quality-check failures, lines faster than `WORDS_PER_SECOND`, loudness against its target,
   the length against the target. Signals become issues on their own (`source: signal`).
2. **Frames.** For every video item of the render timeline, frames at 15%, 50% and 85% of the item, 384 px wide, side
   by side in one labelled strip (`Shot C3·S2, 41.0–46.0 s`). Consecutive strips show each cut from both sides.
3. **Scenes** (`feedback.scene`, one vision call per clip): the film (title, logline, genre, tone, style, dialogue
   level), the scene (heading, location, time of day, continuity, summary, action, dialogue), the scenes before and
   after it, the cast (compact identities), every shot (time range, description, action, camera, dialogue, who is in
   it, its take's consistency and quality), the signals inside the scene, and the strips. The answer: scores, a
   summary, strengths, issues (shot, dimension, severity, title, detail, where in the shot) and recommendations
   (shot, dimension, priority, title, detail, action).
4. **The film** (`feedback.film`, one text call): the project (logline, synopsis, outline with purposes), every
   scene's scores, summary and main issues, the signals and the run's numbers. The answer: the film's scores (the
   arc and pacing are only visible here), the summary, strengths, recommendations across scenes, and production
   lessons for the retrospective.
5. **Assembly** (deterministic): scene issues get their export time from the render timeline (the shot's item plus
   where in the shot) and keep their clip and shot; recommendations are ordered by priority, then the score of their
   dimension; ids are stable (`i1…`, `r1…`); the film's scores fall back to the duration-weighted mean of the scenes'
   scores; `sound` is computed from the signals. The Markdown report is written and stored.

A scene call that fails after its retries leaves that scene without scores (`scenes[].error`), and the run still
succeeds with the others; without a gateway only signals, `sound` and the retrospective are written (`model: null`).
Cost: one vision call per clip plus one text call (a 118-shot film: 21 calls, 118 strips).

## The document

`feedback/<id>.json`, one per export (`feedbackIdFor(exportId)`: running it again replaces it; the history keeps the
earlier one):

```ts
type Feedback = {
  id: string; exportId: string; jobId?: string;
  status: 'running' | 'succeeded' | 'failed'; error?: string;
  createdAt: string; updatedAt: string;
  model: string | null;                       // the vision model; null without a gateway
  timelineCommit: string | null; durationSec: number;
  overall: number | null;                     // 0–10
  scores: Record<FeedbackDimension, number | null>;
  summary: string; strengths: string[];
  scenes: { clipId: string; index: number; title: string; start: number; end: number;
            scores: Partial<Record<FeedbackDimension, number>>; summary: string; error?: string }[];
  issues: {
    id: string; dimension: FeedbackDimension; severity: 'critical' | 'major' | 'minor';
    title: string; detail: string; start: number; end: number;        // seconds of the export
    clipId: string | null; shotId: string | null; shot: string | null; // "C3·S2"
    source: 'vision' | 'signal';
  }[];
  recommendations: {
    id: string; priority: 1 | 2 | 3; dimension: FeedbackDimension;
    title: string; detail: string; issueIds: string[];
    action: FeedbackAction | null;
    status: 'open' | 'applied' | 'dismissed';
    appliedAt?: string; appliedBy?: Actor; jobId?: string;
  }[];
  retrospective: { area: 'quality' | 'cost' | 'performance' | 'reliability' | 'ux';
                   title: string; detail: string; source: 'rule' | 'vision'; rule?: string }[];
  signals: FeedbackSignals;                   // the measurements of step 1
  report: MediaRef | null;                    // media/reports/<exportId>-feedback.md
};
```

### Actions

| `action.kind` | Fields | Applying it |
|---|---|---|
| `regenerate_shot` | `clipId`, `shotId`, `description?`, `action?`, `negativePrompt?`, `framing?`, `movement?` | updates the shot with the revised fields (the same service as the shot editor) and regenerates it (`shot.generate`, priority of a user regenerate); the new take is selected when it passes and replaces the old one in the cut |
| `replan_scene` | `clipId`, `direction?` | re-plans the scene's shots (`clip.plan` with the direction added to the scene) and generates them |
| `settings` | `patch` (project settings) | applies the patch (for example quality checks on, a higher threshold, the storyboard on) |
| `note` | – | nothing to apply: the recommendation is advice for the editor or the next film |

Applying or dismissing records who and when on the recommendation (a commit like any other edit). An action that no
longer fits (the shot was deleted, the export's cut changed) fails with `feedback_stale` (409).

## Retrospective: improvements after every project

The retrospective turns the run into a list of improvements, so every finished project leaves behind what to do
better. Rules are data (`RETROSPECTIVE_RULES`, server), each a predicate over the run and a message with its numbers:

| Rule | Area | When |
|---|---|---|
| `gate_first_try` | quality, cost | fewer than 60% of shots passed identity on the first attempt (names the character who failed most) |
| `discarded_generations` | cost | more than 20% of the video seconds generated were discarded (failed attempts, replaced takes) |
| `unverified_takes` | reliability | takes in the cut were never verified (the judge was down) |
| `overridden_takes` | quality | takes in the cut were overridden |
| `quality_failures` | quality | takes in the cut failed the temporal or physics check |
| `llm_retries` | reliability | language or vision calls were turned away for load and made again |
| `queue_wait` | performance | shots waited longer in the queue than they ran (raise the video lane) |
| `slow_shots` | performance | the slowest tenth of shots took more than 10 minutes |
| `failed_jobs` | reliability | jobs failed (by kind, with the most common error) |
| `cost_per_minute` | cost | the estimated cost per finished minute, or the models without a price |
| `low_dimension` | quality | the film's two lowest dimensions, with the setting or step that addresses each |
| `unexpected_cuts` | quality | the signals found jumps inside shots |
| `framing_runs` | quality | runs of more than three shots with the same framing |
| `rushed_lines` | quality | lines faster than `WORDS_PER_SECOND` for their shot |
| `target_missed` | quality | the film is more than 10% off its target length |

The film call adds lessons the rules cannot see (`source: vision`). The retrospective is part of the document and of
the report, and the [insights](observability.md#insights) page lists it next to the run's numbers.

## The report

The Markdown report (`media/reports/<exportId>-feedback.md`, on WebDAV with the project's media) has the scores, the
summary and strengths, the issues by scene with their times, the recommendations, the retrospective, the signals and
the run's cost and time. People read it in any WebDAV client; agents read it through MCP.

## When it runs

`settings.feedback.auto` (on by default): when an export of a story project succeeds, `export.feedback` is queued
(`dedupeKey: feedback:<exportId>`). Exports of footage edits, animatics, cut-downs and language variants get it only
on request. On request: the export card's *Get feedback*, REST and MCP.

## Surfaces

| REST | MCP |
|---|---|
| `POST /api/projects/:id/exports/:eid/feedback` → `{feedback, job}` (202) | `export_feedback {projectId, exportId}` |
| `GET /api/projects/:id/feedback` → `Feedback[]` | `feedback_get {projectId, exportId?}` (the latest when no export is given) |
| `POST /api/projects/:id/feedback/:fid/recommendations/:rid/apply` → `{feedback, job}` | `feedback_apply {projectId, feedbackId, recommendationId}` |
| `POST /api/projects/:id/feedback/:fid/recommendations/:rid/dismiss` → `feedback` | `feedback_dismiss {projectId, feedbackId, recommendationId}` |

Every surface calls `FeedbackService` (`server/src/domain/feedback.ts`). Running feedback and applying or dismissing a
recommendation need `project.edit`; a `settings` action also needs `project.manage`
([accounts](accounts.md#users-roles-and-projects)).

**UI.** Each export card shows its feedback: the overall score, a bar per dimension, the summary and *Show feedback*,
which opens the full feedback (scenes, issues with *Play from here* on the export, recommendations with *Apply* and
*Dismiss*, the retrospective, *Download report*). Long lists scroll inside the panel; on phones the panel takes the
screen. The Inbox announces finished feedback (`Feedback ready`).

## Observability

Logs carry `projectId`, `jobId`, `exportId` and `feedbackId`. Metrics: `rideo_feedback_total{outcome}`,
`rideo_feedback_score{dimension}` (histogram of the film scores), `rideo_feedback_recommendations_total{action,
outcome}` (applied, dismissed, stale), and the language and vision calls under `rideo_llm_calls_total{task}`.

## Mock gateway

`feedback.scene` answers from the input: scores lower for shots whose quality check failed or whose take is not
`passed`, an issue for every signal inside the scene, and a `regenerate_shot` recommendation (with a revised
description) for the lowest shot; `feedback.film` averages the scenes and adds one lesson. Tests drive a full
export → feedback → apply → regenerate loop on it.
