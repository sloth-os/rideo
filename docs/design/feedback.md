# Feedback on the finished film

The consistency gate judges takes one at a time. Nobody judges the film until a person watches it, and by then what
is wrong (a sun that jumps between cuts, a scene that tells nothing, skis through a leg, the same medium shot eight
times) is spread over hours of footage. **Feedback** watches every export of a story project with the vision model,
and listens to it with the [audio-visual model](settings.md) when one is set, with the whole project in hand
(screenplay, cast, shots, takes and their reports), and writes:

- **scores** for the dimensions of a good film, for each scene and for the film (the screenplay and the storyboard get
  an [AI review](ai-review.md) of their own before any video is made);
- **issues**, each pinned to a time in the export and to the shot that made it;
- **recommendations**, as many as are useful, most important first, each one with an **action** Rideo can apply
  (regenerate a shot with a revised prompt, re-plan a scene, change a setting);
- the **retrospective**: what to improve in how the film was made, from the run's own numbers (cost, time, retries,
  failures), written after every project so the next one goes better.

## Dimensions

`FEEDBACK_DIMENSIONS` (shared) is the table; the model scores each 0–10, and the overall score is the weighted mean of
the dimensions that have a score.

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
| `dialogue` | 1 | heard (`feedback.listen`), so only with an audio-visual model: every line spoken as written, clear for the film's dialogue level, in its character's voice, lips in sync, nothing said that the script does not say |
| `sound` | 0.5 | measured (loudness on target, no long silences or clipping, lines that fit their shots) and, with an audio-visual model, heard (ambience that fits the place, no stray music or noise, a clean mix): the mean of both |

## How a film is watched

`export.feedback` (lane `llm`) runs after the export succeeds:

1. **Signals** (ffmpeg on the export, no model): black stretches (`blackdetect`), frozen stretches
   (`freezedetect`, 1.5 s), long silences (`silencedetect`, 3 s at −50 dB) and **unexpected cuts**: scene changes
   (`select='gt(scene,0.4)'`) farther than 0.3 s from every cut of the render timeline are jumps inside a shot. Plus
   numbers from the project: shot lengths, runs of the same framing, takes in the cut by consistency state (passed,
   unverified, overridden), quality-check failures, lines faster than `WORDS_PER_SECOND`, loudness against its target,
   the length against the target. Signals become issues on their own (`source: signal`).
2. **Frames, and the scene with its sound.** For every video item of the render timeline, frames at 15%, 50% and 85%
   of the item, 384 px wide, side by side in one labelled strip (`Shot C3·S2, 41.0–46.0 s`). Consecutive strips show
   each cut from both sides. The frames come from the item's clean part (`clean`): its own incoming transition and the
   next item's, where two shots are blended, are left out (unless that leaves less than half a second). The swimming
   film's second feedback sampled 85% of short scene exits inside the 0.5 s crossfade into the next scene and called
   the blend a critical ghost double exposure, twice. With an audio-visual model, each scene is also cut from the export as a video with its
   sound: 480p (360p past 90 s), H.264 CRF 32, mono AAC at 48 kb/s, at most 7 MB (a longer scene is encoded at the
   bitrate that fits; one that still does not fit is not heard).
3. **Scenes.** The picture: `feedback.scene`, one vision call per clip, with the film (title, logline, genre, tone,
   style, dialogue level), the scene (heading, location, time of day, continuity, summary, action, dialogue), the
   scenes before and after it, the cast (compact identities), every shot (time range, description, action, camera,
   dialogue, who is in it, its take's consistency and quality), the signals inside the scene, and the strips. The
   answer: scores, a summary, strengths, issues (shot, dimension, severity, title, detail, where in the shot) and
   recommendations (shot, dimension, priority, title, detail, action). The sound, with an audio-visual model, at the
   same time: `feedback.listen` gets the same input with the cast's voices and where each shot is in the scene's
   video, and the video, and answers only for what is heard: the `dialogue` and `sound` scores, the **transcript**
   (every line heard, with its time and speaker), and issues and recommendations about dialogue and sound, placed by
   shot or by time in the scene. The two answers make one review of the scene. Each model judges what it does best: in
   the panda demo, `qwen3.8-omni-flash` watching a 70-second scene of 14 shots on a ski slope as one video reported a
   critical "teleportation" to the lodge and back for each of shots 2 to 14, which no frame shows, while the strips,
   one labelled still per shot and position, pinned every issue to a frame; the same model heard all 61 lines and who
   said them.
4. **The film** (`feedback.film`, one text call): the project (logline, synopsis, outline with purposes), every
   scene's scores, summary and main issues, the signals and the run's numbers. The answer: the film's scores (the
   arc and pacing are only visible here), the summary, strengths, recommendations across scenes, and production
   lessons for the retrospective.
5. **Assembly** (deterministic): scene issues get their export time from the render timeline (the shot's item plus
   where in the shot) and keep their clip and shot; recommendations are ordered by priority, then the score of their
   dimension; ids are stable (`i1…`, `r1…`); the film's scores fall back to the duration-weighted mean of the scenes'
   scores; `sound` is computed from the signals (and averaged with the heard score). The transcript is compared with
   the lines of each shot (`dialogueDelivery`, shared): each utterance counts for one shot, the one within ±1 s whose
   lines it matches best, and a line with fewer than `LINE_HEARD_RATIO` (0.6) of its words heard is an issue (`dialogue`, major, `source: signal`) with a `regenerate_shot`
   recommendation unless one already names that shot; the counts are kept as `signals.dialogue`. The Markdown report
   is written and stored.

A scene call that fails after its retries leaves that scene without scores (`scenes[].error`), and the run still
succeeds with the others; without a gateway only signals, `sound` and the retrospective are written (`model: null`).
Cost: one vision call per clip plus one text call (a 118-shot film: 21 calls, 118 strips). Listening adds one
audio-visual call per clip: the panda demo's nine minutes were about 300,000 input tokens, 2–8 minutes a scene.

## The document

`feedback/<id>.json`, one per export (`feedbackIdFor(exportId)`: running it again replaces it; the history keeps the
earlier one):

```ts
type Feedback = {
  id: string; exportId: string; jobId?: string;
  status: 'running' | 'succeeded' | 'failed'; error?: string;
  createdAt: string; updatedAt: string;
  model: string | null;                       // the vision model; null without a gateway
  listener: string | null;                    // the audio-visual model that heard the scenes, if any
  listened: boolean;                          // the scenes were heard
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
  previousFeedbackId: string | null;          // the feedback `retakes` compares with
  retakes: { clipId: string; shotId: string; shot: string; recommendationId: string | null;
             before: { takeId: string; issues: number }; after: { takeId: string; issues: number };
             outcome: 'better' | 'same' | 'worse' }[];
};
```

### Actions

| `action.kind` | Fields | Applying it |
|---|---|---|
| `regenerate_shot` | `clipId`, `shotId`, `description?`, `action?`, `negativePrompt?`, `framing?`, `movement?`, `characters?` | updates the shot with the revised fields (the same service as the shot editor) and regenerates it (`shot.generate`, priority of a user regenerate); `characters` names who is in frame after the change, the shot's cast becomes those of the project's characters; the new take replaces the old one in the cut only when it passes every check ([when a fix does not pass](#when-a-fix-does-not-pass)) |
| `replan_scene` | `clipId`, `direction?` | re-plans the scene's shots (`clip.plan` with the direction added to the scene) and generates them |
| `settings` | `patch` (project settings) | applies the patch (for example quality checks on, a higher threshold, the storyboard on, cast only) |
| `note` | – | nothing to apply: the recommendation is advice for the editor or the next film |

**Who is in frame.** A fix may bring a character into the shot ("put Rosie's head and pink beanie at frame right") or
take one out. Without `characters` the shot's cast stayed as planned, so the gate's cast check counted the character
the fix asked for as an extra: in the panda demo's third pass four of thirteen fixes failed every attempt that way
while their takes showed what the recommendations asked for.

Applying or dismissing records who and when on the recommendation (a commit like any other edit). An action that no
longer fits (the shot was deleted, the export's cut changed) fails with `feedback_stale` (409).

### When a fix does not pass

A fix's new take used to replace the cut's take whenever its identity passed, even when its other checks failed. In
the panda demo's second pass that was right for one shot (the new take failed only a jump check but showed panda Rosie
where the old one had a human child) and wrong for another (the new take put a human girl on the chairlift where the
old one had a stray cut). Which of two flawed takes is better is a person's call, so:

| The fix's take (`take.jobId` = the recommendation's `jobId`) | The cut | The panel |
|---|---|---|
| not there yet | unchanged | *Regenerating…* (or the job's error) |
| passes every check: identity passed or overridden, and the quality checks passed or off (`takePassesChecks`) | shows the new take (`replace_source` on every item of the shot) | *Fixed: the new take passed its checks and is in the cut* |
| fails a check | keeps the previous take | *Not fixed*, with the new take's issues and **Use the new take**: it selects the take and puts it in the cut in one commit (`take_select` with `inCut`) |

The outcome is derived from the documents (`fixOutcome`, shared), so the REST API, MCP and the panel agree, and a
take a person put in the cut later shows as theirs.

### What changed since the last feedback

A fix passes the gate's checks, but whether it fixed what the feedback saw shows only in the next export. The swimming
demo's 23 priority 1 fixes all passed their checks and went into the cut, and the next feedback scored 6.5 against
6.2 with continuity unchanged, with nothing to say which shots got better. So when a feedback is written, every shot
whose take in the cut changed since the project's previous feedback (the latest succeeded one of another export) is
compared (`compareRetakes`, shared, deterministic). Its takes come from the two exports' render timelines, so this
holds whether the new take came from a fix, a scene review or a person, and after a feedback was run again:

| Field | What it is |
|---|---|
| `before`, `after` | the take in each export, and the issues pinned to the shot in each feedback, weighted by severity (critical 3, major 2, minor 1) |
| `recommendationId` | the previous feedback's recommendation whose job made the new take, when it is still recorded |
| `outcome` | `better` (`after` < `before`), `worse` (`after` > `before`) or `same` |

The results are on the document (`retakes`, with `previousFeedbackId`), in the report (*What changed since the last
feedback*), in the retrospective (rule `retake_results`: how many shots with a new take got better, stayed the same or
got worse, naming the worse ones) and on the panel under the scores (`23 shots have a new take since the last
feedback: 15 better · 6 same · 2 worse`).

### What a fix costs

The panda demo's strip review recommended regenerating 68 shots, 27 of them at priority 1: at least $100 at that run's
prices, with nothing on the screen to say so. When the feedback is written, each `regenerate_shot` and `replan_scene`
recommendation gets an `estimate {usd, videoSeconds, attempts}` (`fixEstimate`, shared):

- the video seconds are the shot's length (a re-planned scene's shots together) times `attempts`, the mean attempts of
  the project's selected takes (at least 1): what a shot of this film has cost so far;
- the dollars price those seconds with the project's pinned video model (`settings.models.video`, else the model of
  the shot's take) and add a keyframe image per attempt for a shot without an approved storyboard frame, from
  `RIDEO_PRICES`; `usd` is null when the video model has no price;
- a `settings` change or a `note` costs nothing and has no estimate.

The panel shows `≈ $1.65 · 6 s of video` on each recommendation and, above the list, **Apply the priority 1 fixes**
with their count and total (the open priority 1 recommendations with an action, applied one after the other).

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
| `undelivered_lines` | quality | lines of the script were not heard in the film (listening feedback) |
| `target_missed` | quality | the film is more than 10% off its target length |
| `retake_results` | quality | shots have a new take since the previous feedback: how many got better, stayed the same or got worse ([what changed since the last feedback](#what-changed-since-the-last-feedback)) |

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
*Dismiss*, their estimated cost and *Apply the priority 1 fixes* ([what a fix costs](#what-a-fix-costs)), the
retrospective, *Download report*). Long lists scroll inside the panel; on phones the panel takes the
screen. The Inbox announces finished feedback (`Feedback ready`).

## Observability

Logs carry `projectId`, `jobId`, `exportId` and `feedbackId`. Metrics: `rideo_feedback_total{outcome}`,
`rideo_feedback_score{dimension}` (histogram of the film scores), `rideo_feedback_recommendations_total{action,
outcome}` (applied, dismissed, stale), and the language and vision calls under `rideo_llm_calls_total{task}`.

## Mock gateway

`feedback.scene` answers from the input: scores lower for shots whose quality check failed or whose take is not
`passed`, an issue for every signal inside the scene, and a `regenerate_shot` recommendation (with a revised
description, and the scene's whole cast in frame) for the lowest shot. `feedback.listen` scores `dialogue` and `sound` and hears every line except those of
shots whose description says the speaker mumbles. `feedback.film` averages the scenes and adds one lesson.
`sound.check` hears the shot's lines the same way, music when the description asks for it, and nothing in a shot
without lines. Tests drive a full
export → feedback → apply → regenerate loop on it.
