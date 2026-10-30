# AI review of every step

The [feedback](feedback.md) on an export finds what went wrong after the video is paid for. Much of what the panda
demo's feedback found was visible earlier: a chairlift scene of fine mechanical handling the video model cannot keep
(skis in paws, a pair apart on the chair), props whose state nobody wrote down, shots that all last five seconds, a
cast-only film whose scenes still mentioned other skiers. Words and stills cost a fraction of video. So Rideo reviews
the **screenplay** before the cast is made, the **cast** before it is locked and the **storyboard** before the pilot,
and the workflow goes on only when the review passes. In production every scene's **storyboard** is drawn, reviewed
and approved before its video ([production storyboards](#production-storyboards)). Every take is **watched whole**
by the vision model ([takes watched whole](#takes-watched-whole)), every scene is watched as **one video** by the
vision model and heard by the audio-visual model before the edit ([scenes before the edit](#scenes-before-the-edit)),
and the **cut** is reviewed at both levels before it is exported ([the cut before export](#the-cut-before-export)).

## Autopilot: every step reviewed and approved

With `settings.autopilot`, Idea → movie runs by itself, and no step goes on to the next one until the AI has reviewed
it and the review passed. A review that does not pass after its automatic fixes stops the run there for a person:
its notification says so ("Cast review did not pass (5.5 of 7)"), and a batch that stopped says why ("Stopped: the
storyboard of scene 3 did not pass its review"). Apply or dismiss its recommendations, edit by hand, review again, or
continue anyway.

| Step | Reviewed by | A pass approves |
|---|---|---|
| Screenplay | `screenplay.review` (text model), revisions and rounds | `screenplay_approved` |
| Cast & elements | `cast.review` (vision model: every character's and element's references), new references and rounds | the references it passed, the characters and elements locked, `cast_locked` (speaking characters' voices are still picked by a person when dialogue uses TTS) |
| Resources | nothing is generated | `resources_ready` at once |
| Storyboard | `storyboard.review` (vision model, frames beside their [blocking](director-desk.md)), redraws and rounds | the frames, `storyboard_approved` |
| Pilot | every take watched whole and heard (the gate), then the scene watched and heard (`clip.review`) | the pilot clip when its [clip gate](#the-clip-gate) holds, then `pilot_approved` |
| Production, per scene | the extension's new scenes by `screenplay.review` (`sceneIds`); the scene's storyboard by `clip.storyboard`; its takes and the scene as for the pilot | its frames, then the clip when its clip gate holds |
| Production | every clip approved and the target reached | `production_approved` |
| Edit | `cut.review`: every take of the cut watched whole and passing, every scene's review current and passing | `cut_approved` |
| Export | – | the export starts in a studio tab (an editor job), then [feedback](feedback.md) |

## The gates

| Gate | New requirement | Satisfied when |
|---|---|---|
| `screenplay_approved` | `screenplay.reviewPassed` | `settings.review.screenplay` is off, or the screenplay's review is **current** (made of the screenplay as it is now) and **passed**, or a person chose to continue anyway for the current screenplay |
| `cast_locked` | `cast.reviewPassed` | `settings.review.cast` is off, or the cast's review is current (made of the references, identities and wardrobes as they are now) and passed, or a person continued anyway for the current cast |
| `storyboard_approved` | `storyboard.reviewPassed` | `settings.review.storyboard` is off (or the storyboard is), or the storyboard's review is current and passed, or a person chose to continue anyway for the current frames |
| `cut_approved` (story) | `cut.reviewPassed` | `settings.review.cut` is off, or the cut's review is current (made of the takes in the cut and their scenes' reviews) and passed, or a person continued anyway for the current cut |

A review is current while its `subject`, a hash of what it looked at, equals the subject of the documents now
(`screenplayReviewSubject`, `castReviewSubject`, `storyboardReviewSubject`, `cutReviewSubject`, shared): editing a
scene, a beat, a reference, a shot, a frame or a take in the cut after the review makes it outdated and the gate waits
for another review. With autopilot, a passing review approves its gate
as the system (`rideo`), so the project goes on to the next stage by itself.

```ts
settings.review = {
  screenplay: boolean;    // default true
  cast: boolean;          // off in the schema, on for new projects: review the cast before it is locked
  storyboard: boolean;    // default true
  cut: boolean;           // off in the schema, on for new projects: review the cut before it is exported
  threshold: number;      // 5–9.5, default 7: the lowest overall score that passes
  maxRounds: number;      // 0–3, default 2: automatic revisions before a person decides
  autoRevise: boolean;    // default true: apply the review's fixes and review again
  scenes: boolean;        // default true: watch each scene's takes before the edit
  sceneFixes: number;     // 0–6, default 3: priority 1 regenerations applied per scene (0: watch only)
  sceneThreshold: number; // 4–9.5, default 6: the lowest overall score (0–10) a scene's review passes with
  watchTakes: boolean;    // off in the schema, on for new projects: watch every video attempt whole
  extensions: boolean;    // off in the schema, on for new projects: review the scenes production writes
};
settings.storyboard.production: boolean;  // off in the schema, on for new projects: storyboard every production scene
```

The settings that are new since a project was made are off for it, so an older project's gates and jobs stay as they
were; new projects are created with them on.

## The document

One review per stage, `ai-reviews/<stage>.json`, versioned like every document (a production scene's storyboard
review has the same shape, on its clip: `clip.boardReview`):

```ts
type StageReview = {
  stage: 'screenplay' | 'cast' | 'storyboard' | 'cut';
  status: 'running' | 'succeeded' | 'failed';
  jobId: string | null;
  model: string | null;
  subject: string;                       // what was reviewed
  round: number;                         // 1, then one more per automatic revision
  threshold: number;
  verdict: { passed: boolean; score: number; blocking: string[] } | null;
  scores: Record<Dimension, number | null>;
  summary: string;
  strengths: string[];
  issues: { id; dimension; severity: 'critical' | 'major' | 'minor'; title; detail;
            sceneId?; scene?: number; clipId?; shotId?; shot?: string }[];
  recommendations: { id; priority: 1 | 2 | 3; dimension; title; detail; issueIds: string[];
                     action: StageAction | null; status: 'open' | 'applied' | 'dismissed';
                     appliedAt?; appliedBy?; jobId? }[];
  history: { round; at; score; passed; issues: number; applied: number }[];   // earlier rounds
  override: { by: Actor; at: string; note: string; subject: string } | null;  // "continue anyway"
  error?: string;
  createdAt: string; updatedAt: string;
};

type StageAction =
  | { kind: 'revise_scene'; sceneId: string; instruction: string }      // screenplay
  | { kind: 'revise_outline'; instruction: string }                     // screenplay
  | { kind: 'redraw_board'; clipId; shotId; description?; action?; framing?; movement?;
      characters?: string[]; durationSec? }                             // storyboard
  | { kind: 'replan_scene'; clipId; direction: string }                 // storyboard
  | { kind: 'regenerate_refs'; characterId?; elementId?; instruction? } // cast
  | { kind: 'regenerate_shot'; clipId; shotId; instruction? }           // cut
  | { kind: 'note' };
```

### The verdict

`stageVerdict(scores, issues, threshold)` (shared, deterministic) decides, not the model: the score is the mean of
the dimensions the model scored, and the review **passes** when the score reaches the threshold, no issue is
critical and no dimension is below 4. `blocking` names what failed ("critical: the chairlift boarding cannot be
generated", "pacing 3/10", "score 6.4 of 7").

## Dimensions

| Screenplay | What the reviewer asks |
|---|---|
| `story` | Is there an arc (setup, inciting incident, complications, crisis, climax, resolution)? Does every scene have a goal, an obstacle and a turn? Is what is set up paid off? |
| `character` | Do the characters want something, change, and differ from each other? |
| `dialogue` | Natural, short enough for its shot, at the film's level (CEFR), in each character's voice? |
| `pacing` | Do the beats fit the target length, and does no scene overstay? |
| `visual` | Is the story told in actions a camera can see? |
| `continuity` | Does every scene state its time of day, weather, light, what each character wears and carries? Do props keep their state from scene to scene? |
| `feasibility` | Can an AI video model film it? Few characters per scene, simple clear actions, no crowds, no on-screen text, no fine hand work or mechanical handling (boarding a chairlift, tying a knot), no quick repeated motion |
| `brief` | Does it follow the brief: the named characters, the place, the tone, constraints such as a film with only its cast? |

| Storyboard | What the reviewer asks |
|---|---|
| `composition` | Is each frame readable: framing, staging, the subject where the eye goes? |
| `continuity` | Across the frames of a scene: screen direction, positions, wardrobe, props and their state, light and time of day |
| `character` | Does the cast look like itself, and is only the cast in frame? |
| `coverage` | An establishing shot, shot and reverse shot with matching eyelines, reactions, inserts; varied framing |
| `storytelling` | Do the frames tell the scene's beats in order? |
| `feasibility` | Can each frame be animated: clear poses, a simple action, nothing the model will break (hands on small objects, mechanisms)? |
| `pacing` | Do the shots' lengths fit their action and their lines? |
| `blocking` | With a [blocking](director-desk.md): does each frame keep its camera view (the camera angle, who stands where and faces which way)? Scored only when the frames have one |

| Cast | What the reviewer asks |
|---|---|
| `likeness` | Does every reference show what the identity and the outfit say (age, build, face, hair, the clothes)? Does a place or prop look as described? |
| `consistency` | Do a character's views show the same face, hair, build and outfit from every side? |
| `distinct` | Can the characters be told apart at a glance (silhouette, colours, faces)? |
| `clarity` | One figure per character sheet, whole and unobstructed, on a plain background; a place without people in it; a prop on its own |
| `style` | Do the references share the film's look (the style bible), so the frames made from them will too? |

| Cut | What it measures |
|---|---|
| `takes` | clip level: ten times the share of the cut's takes whose whole-take watch passed |
| `scenes` | scene level: the scenes' overall scores, weighted by their length |
| `continuity` | the scenes' continuity scores, weighted |
| `sound` | the scenes' sound and dialogue scores, weighted |

## How a review runs

**Screenplay** (`screenplay.review`, lane `llm`): the text model gets the brief (prompt, target length, dialogue
level, cast only), the screenplay (title, logline, synopsis, genre, tone, style, the outline with each beat's purpose
and estimate, every written scene with its heading, location, time of day, continuity, summary, action, dialogue and
cast), the cast (name, role, summary, look, voice), the places and props, and what the video model does well and
badly (`VIDEO_MODEL_FACTS`: the shot lengths it renders, few people per shot, no on-screen text, no fine hand work).
It is told that the shot planner splits every scene into shots of that length later, so it judges whether each moment
can be filmed in one shot, not how long the scene is: in the swimming demo's first review, without that sentence, the
reviewer called its 30-second scenes a critical problem for a model of 2–10 s shots and asked for the outline to be
rewritten as numbered shots. Each outline beat says whether its scene is written yet (`written`): the screenplay job
writes the opening scenes (at least the pilot) and production writes each later scene from its beat just before it is
filmed ([batch generation](generation-pipeline.md#batch-generation)), so the reviewer judges unwritten beats as an
outline and never asks for them to be written now; its second review of the swimming film, without that, failed on
"only two scenes are written for a five-minute film". It answers scores, a summary, strengths, issues and
recommendations, each scene named by its number.

**Cast** (`cast.review`, lane `llm`, the vision model): one call per character (its whole identity, wardrobe and
role, the film's style, every other character's look, and each of its references labelled by view) and one per element
in use or with references (its description and references: the pilot gate locks the whole library before production).
A review waits for reference jobs that are still drawing, and the last of them to finish queues it. The answers are merged (scores weighted equally, issues and recommendations in
cast order). A recommendation to draw a character's or an element's references again (`regenerate_refs`, with an
optional instruction) is a round's fix: the references are generated again (`character.refs`, `element.refs`) from the
ones they replace, the instruction added to every request as its direction (`params.direction`), and the cast
reviewed again. The old references stay until the new ones are drawn (`params.replaces`, then dismissed): the new
views keep the anchor the old ones had (the first approved reference, else the first), where deleting them first
drew them from text alone. In the riding demo's first cast review (2026-10-29) that lost the pandas' look, which came
from an uploaded style image, and every redraw got the same prompt and seed as before, the instructions dropped. On autopilot a pass approves every reference the
review did not flag (and the first of each character and element when it flagged them all), locks the characters and
the elements it reviewed, and approves `cast_locked`; voices that dialogue needs and nobody locked keep the gate open.

**Storyboard** (`storyboard.review`, lane `llm`, the vision model): one call per storyboarded scene with the scene
(heading, continuity, summary), its neighbours, the cast's looks, and every shot in order (label, length, camera,
description, action, cast, lines) followed by its frame (512 px wide, labelled `Shot C2·S3`) and, when the scene is
[blocked](director-desk.md), the shot's camera view (`Blocking C2·S3`) and its blocking line; the scene's blocking
issues are part of the input. The scenes' answers are merged: scores weighted by the scenes' lengths, issues and
recommendations in scene order.

**Rounds.** When a review fails, `settings.review.autoRevise` is on and fewer than `maxRounds` revisions were made,
the job applies the open recommendations of priority 1 and 2 that carry an action, and reviews again:

| Action | Applying it |
|---|---|
| `revise_scene`, `revise_outline` | one `screenplay.revise` call rewrites the named scenes and the outline as instructed and keeps everything else; the scenes keep their ids, so planned clips stay attached |
| `redraw_board` | the shot's revised fields (description, action, camera, who is in frame, length) are saved and its frame is drawn again (`shot.board`) |
| `replan_scene` | the scene's shots are planned again with the direction (`clip.plan`) and their frames drawn (`storyboard.generate` for that scene) |

The job waits for the frames, then reviews again. After the last round it stops: the review stays failed with its
recommendations, and the Inbox says so. A person applies or dismisses recommendations, edits by hand, reviews
again, or continues anyway (`override`, with a note), which the gate accepts for the current subject.

**When.** `screenplay.generate` queues the screenplay review when it finishes, the last `character.refs` or
`element.refs` of the cast in use queues the cast review, and `storyboard.generate` the storyboard review (each when
its setting is on). Each runs on request at any time.

A review queued this way while one of the same stage is already running (a reference drawn after the running review
read the cast, as when references are drawn one after another) does not join it: the running review may have read
the documents before the change. The new review is queued behind it (`params.after`, deduplicated per running job),
waits for it, and then reviews only if the review it waited for is outdated; when that review is current (it saw the
change, or the change was undone) it ends without a model call. A review not yet started takes the request, as it
reads the documents when it starts, and a review asked for by a person while one runs is that running review.

A screenplay review can be **scoped** (`sceneIds`): production reviews the scenes an extension wrote, with the rest
of the screenplay as their context, and its revisions rewrite only those scenes. Its record replaces the screenplay's
review (the screenplay gate is already approved by then) with the earlier rounds in its history.

## Production storyboards

With `settings.storyboard.production`, every production scene is storyboarded before its video, as the storyboard
stage does for the first scenes: `batch.generate` runs `clip.storyboard` for a clip and waits for it before
`clip.generate`. What decides is the clip's frames, not its place in the film: any clip whose frames are not all
approved is storyboarded, one of the first `storyboard.scenes` included. The storyboard stage draws only the scenes
written by then (the screenplay job writes the pilot's), so in the riding demo (2026-10-29) the third scene, written
by production within the first three, was generated with no frames at all.

`clip.storyboard` (lane `control`) blocks the scene ([director's desk](director-desk.md)), draws every frame that is
missing, failed, stale or outdated (the first shot first, the others with it as their scene reference), and reviews
the scene's frames with the storyboard reviewer (one call, as for a storyboarded scene). A failing review applies its
fixes (`redraw_board`, `replan_scene`) and reviews again, up to `maxRounds`; a pass approves the scene's frames as the
system. The review is the clip's `boardReview` (a `StageReview` with `stage: storyboard`, current while its subject,
`clipBoardSubject`, is the clip's shots and frames).

A scene whose review still fails stops the batch (`stopReason: the storyboard of scene 7 did not pass its review`), and
the Inbox lists it. A person applies or dismisses the recommendations, redraws frames, approves them by hand, or
continues anyway (`POST …/clips/:clipId/board-review/override`), and resumes the batch. The shots then start from their
approved frames (`firstFrameSource: storyboard`): each shot is generated alone, so a multi-shot model makes no
sequences of them ([multi-shot](multi-shot.md#when)); turn production storyboards off for sequences.

## Takes watched whole

The consistency gate judges three frames of every attempt for identity and physics (R4), and the audio-visual model
hears it ([quality checks](continuity.md#quality-checks-in-the-gate)). What happens between the frames was out of
reach: a face that morphs for half a second, a hand that melts into a ski, a figure that walks in after 85 %, an action
the take never performs. With `settings.review.watchTakes` (one of the quality checks: `consistency.qualityChecks`
must be on too), every video attempt is also **watched whole** by the vision model at the same time as the judge and
the listener (`take.watch`), so it adds no time to an attempt:

- **Input.** The take as a video (480p H.264 without sound, at most 7 MB), the shot as planned (description, action,
  camera and move, length, who is in it with their compact looks, who must not be), and the cast's first references.
- **Answer.** Scores from 0 to 1 for `motion` (no morphing, warping, flicker, popping), `physics` (weight, contact,
  objects keeping shape and number), `action` (the planned action happens, in order, within the take), `camera` (the
  framing and the move as planned) and `identity` (everyone stays themselves from the first frame to the last), an
  overall score from 0 to 10, the people seen who should not be there, and issues with the time in the take, the
  severity and what is seen.
- **Verdict** (`watchVerdict`, shared): the attempt fails when a critical issue is seen, `motion`, `physics` or
  `identity` is below `consistency.qualityThreshold`, or `action` is below 0.4; it is retried like a quality failure
  and never fails a take that passed identity (the best candidate is kept with what failed). The watch is
  `report.quality.watch` and its failure is part of `quality.passed`.
- **Who watches.** The vision model, given the video; a vision endpoint that refuses video (`400` naming the video
  part) is not sent video again, and the audio-visual model watches instead (`rideo_take_watches_total{model:
  "omni"}`). With neither, the take is not held back (`watch: null`), and the cut review counts it as not watched.

Takes made before the watch (or while no model could watch) are watched later by `takes.watch` (lane `llm`), from
their stored videos, without generating anything: the report keeps its identity and sound verdicts and gains its
watch, as a re-check does. The cut review runs it for the takes of the cut.

## The clip gate

`clipGate(clip, docs)` (shared) says whether a clip may be approved without a person:

- every shot has a selected take that is acceptable (passed or overridden, not stale: R7) and passes every check of
  its report, its watch included;
- with `settings.review.scenes` and two or more shots, the scene's review is current and its verdict passed
  (`clipReviewVerdict`: the overall score reaches `review.sceneThreshold`, no critical issue remains, and no scored
  dimension is below 4).

Its frames need not be current any more: the batch approved them before the clip's video, and a scene review's fix that
revises a shot outdates that shot's frame.

On autopilot `clip.generate` approves its clip as the system when the gate holds, after the scene review; the pilot's
approval then approves `pilot_approved`. A clip whose gate does not hold waits for a person, and the batch goes on with
the next scenes (each is reviewed on its own); `production_approved` waits for every clip.

## Scenes before the edit

The consistency gate judges one take at a time and the storyboard review sees only frames, so what the swimming demo's
feedback scored lowest was out of their reach: continuity across cuts (4 of 10, before and after 23 fixes) and
temporal (5). The ball, the swim board and the watermelon changed side, count or state between cuts, and the sun
moved. The feedback found it after the export, when every fix meant a new export.

`clip.review` (lane `control`; it waits for its fixes) watches one scene's takes **before the edit**, with the
export's feedback calls, so what it finds is what that feedback would find later. It watches the **scene as one
video**, not only some of its frames:

1. **The scene video.** The selected takes one after another (`sceneTakesVideo`: each take scaled to 480p, its sound
   or silence, joined with the concat filter), H.264 CRF 32 with mono AAC, at most 7 MB (a longer scene is encoded
   at the bitrate that fits, at 360p past 90 s). Every shot needs a selected take with a video.
2. **Strips** as anchors: for every shot in order, its selected take sampled at 15%, 50% and 85% of the whole take,
   384 px wide, side by side and labelled with the shot and its time in the scene as the takes follow each other
   (`0: C3·S1 (0.0–5.0 s)`), so every issue the model sees in the video can be pinned to a shot.
3. **The picture**: one `feedback.scene` call (the vision model) with the export feedback's scene input (the film,
   the scene as written, its neighbours, the cast, every shot as planned with its take's checks and where it is in the
   scene's video), `stage: "takes"` and `watching: true`, the strips and the scene video. The model is told these are
   the selected takes before the edit, that the editor will trim them, to ask for a shot to be generated again only for
   what a new take can fix, and to report from the video only what the strips' shot (by its time) confirms is there:
   watching a 70-second scene as one video, the audio-visual model once reported a "teleportation" in every shot
   that no frame showed. A vision model that refuses video watches the strips alone (`watched: frames`).
4. **The sound**: with an audio-visual model and takes that carry sound, one `feedback.listen` call with the same
   input and video at the same time: the `dialogue` and `sound` scores, what was heard (the transcript), and issues
   and recommendations about dialogue and sound, as the export's feedback listens.
5. **Assembly** as the feedback's (`assembleFeedback` with this one scene, the picture and the sound merged by
   `mergeSceneOutputs`, no signals): scores, the overall score, issues pinned to their shots with times in the scene,
   recommendations with their estimates, and the verdict (`clipReviewVerdict`).
5. **Fixes.** With `settings.review.sceneFixes` above 0, the open priority 1 recommendations that regenerate a shot,
   one per shot and at most `sceneFixes`, are applied as the feedback applies them (the shot revised: description,
   action, negative prompt, camera, who is in frame; then `shot.generate` at a person's priority), with one difference:
   there is no cut yet, so the new take becomes the shot's **selected take only when it passes every check**
   (`selectIfPasses`); otherwise the shot keeps its take and the fix shows *Not fixed* with the new take's issues. A
   scene already in the cut gets the passing take there too, as a feedback fix does (`swapInCut`). The job waits for
   the regenerations. A fix made while the judge was down stays unverified until a re-check passes it, which then
   selects it and puts it in the cut ([re-checking](character-consistency.md#re-checking-unverified-takes)).
6. **Once more.** When a fix was applied, the scene is watched again (round 2) for the record; the first round's
   overall score, scores and issue count stay as `before`. There is one round of fixes: what still breaks the scene
   goes to the edit, and the export's feedback has the last word. A retry of the job after its fixes were made (the
   second watch failed) waits for those fixes and watches again; it never fixes twice.

**When.** `clip.generate` queues it after the clip's shots are made, when it made at least one take, at least two
shots have a selected take, `settings.review.scenes` is on and a gateway is configured, and waits for it: the batch
assembles the cut from the fixed takes. A review that fails never fails the clip. It runs on request at any time
(`fix: false` watches without fixing).

**The record** is on the clip document, `clip.review`:

```ts
type ClipReview = {
  status: 'running' | 'succeeded' | 'failed';
  jobId: string | null; model: string | null;
  subject: string;                         // the selected takes it watched (clipReviewSubject)
  round: 1 | 2;
  overall: number | null;                  // the weighted mean of the scene's scores, as the feedback's
  scores: Partial<Record<FeedbackDimension, number>>;
  watched: 'video' | 'frames';             // the scene as one video (and its strips), or only its strips
  heard: boolean;                          // the audio-visual model listened to it
  verdict: { passed: boolean; score: number; blocking: string[] } | null;   // clipReviewVerdict
  summary: string;
  issues: FeedbackIssue[];                 // times in the scene, the takes one after another
  recommendations: FeedbackRecommendation[];
  fixes: FeedbackRecommendation[];         // round 1's applied regenerations, each with its job
  before: { overall: number | null; scores: …; issues: number } | null;   // round 1, when round 2 ran
  error?: string;
  checkedAt: string;
};
```

A review is **current** while its subject is the clip's selected takes; the clip card says when the takes changed
since. Cost: one or two vision calls per scene (and as many audio-visual calls when it listens), and each fix is a
shot generated again (its estimate is on the recommendation).

## The cut before export

With `settings.review.cut`, the cut is reviewed at both levels before it may be approved and exported. `cut.review`
(lane `control`) works through the clips of the cut in order:

1. **Clip level.** Every take an item of the cut shows is watched whole (`takes.watch` for those without a current
   watch) and must pass every check (`takePassesChecks`, the watch included). A take that fails is a critical issue
   with a `regenerate_shot` recommendation (priority 1).
2. **Scene level.** Every scene in the cut has a current scene review (`clip.review`, run for those that are missing,
   outdated or failed to run); its verdict must pass. A scene that fails is a critical issue, with its review's
   recommendations.
3. **Fixes.** With `autoRevise`, up to `sceneFixes` priority 1 regenerations per scene are applied as a scene review's
   are (each new take selected and put in the cut only when it passes every check), the scenes they touched are
   reviewed again, and the cut is reviewed again, up to `maxRounds`.
4. **The record** is `ai-reviews/cut.json`: the cut's scores (`takes`, `scenes`, `continuity`, `sound`), every take
   and scene that failed as an issue (with its shot, its scene and the time in the cut), the recommendations, and the
   verdict by `stageVerdict` against `sceneThreshold` (each take and scene has passed its own gate when no issue is
   critical). Its subject (`cutReviewSubject`) is the cut's takes and its scenes'
   review subjects: changing a take in the cut makes it outdated.

On autopilot a pass approves `cut_approved`, and entering the export stage starts the export (an editor job a studio
tab of the project claims, [editor jobs](editor.md#editor-jobs)), then its feedback. `timeline.assemble` queues the
cut review when it finishes on autopilot; it runs on request at any time (*Review the cut* in the Exports view).

## Surfaces

| REST | MCP |
|---|---|
| `GET /api/projects/:id/ai-reviews` | `ai_review_get` |
| `POST /api/projects/:id/ai-reviews/:stage/run` → job | `ai_review_run` |
| `POST /api/projects/:id/ai-reviews/:stage/recommendations/:rid/apply` → `{review, job}` | `ai_review_apply` |
| `POST /api/projects/:id/ai-reviews/:stage/recommendations/:rid/dismiss` | `ai_review_dismiss` |
| `POST /api/projects/:id/ai-reviews/:stage/override` `{note}` | `ai_review_override` |
| `POST /api/projects/:id/clips/:clipId/review` `{fix?}` → job (the record comes with the clip) | `clip_review` |
| `POST /api/projects/:id/clips/:clipId/storyboard` → job (`clip.storyboard`: block, draw, review, approve one scene) | `clip_storyboard` |
| `POST /api/projects/:id/clips/:clipId/board-review/override` `{note}` | `clip_board_review_override` |
| `POST /api/projects/:id/takes/watch` `{takes?: [{clipId, shotId, takeId}]}` → job (`takes.watch`; the cut's takes when empty) | `takes_watch` |

REST and MCP call the same `AiReviewService`. The **Story**, **Cast**, **Storyboard** and **Exports** views show their
stage's review (screenplay, cast, storyboard, cut) above their content; a production scene's row in the Storyboard view
shows its own storyboard review: the verdict and the score against the threshold, a bar per dimension, the round, the issues
(a scene or a shot links to it) and the recommendations with *Apply* and *Dismiss*, *Review again*, and *Continue
anyway* when it failed. The stepper names the failing review among the gate's unmet requirements. Each clip card
of the **Clips** view shows its scene review: the overall score (and round 1's when the scene was watched again), a
bar per dimension, the summary, the issues by shot, each fix with what became of it (*Regenerating…*, *Fixed*, *Not
fixed* with **Use the new take**), and *Review the scene* (`clip-review-run`); it says whether the scene was watched
as one video and heard. Each take's checks show its watch: the overall score, the bars of `motion`, `physics`,
`action`, `camera` and `identity`, and the issues at their times.

## Observability

`rideo_ai_reviews_total{stage, outcome}` (`passed`, `failed`, `error`), `rideo_ai_review_score{stage}`,
`rideo_ai_review_rounds{stage}` and `rideo_ai_review_recommendations_total{stage, action, outcome}` (`applied`,
`dismissed`, `auto`). Jobs log the project, the stage, the round and the score. Scene reviews:
`rideo_clip_reviews_total{outcome}` (`clean`: nothing to fix, `fixed`: fixes applied, `error`),
`rideo_clip_review_score{round}` (the overall score) and `rideo_clip_review_fixes_total{outcome}` (`fixed`,
`not_fixed`, `failed`); the job logs the project, the clip, the round and the score. Takes watched whole:
`rideo_take_watches_total{model, result}` (`model`: `vision`, `omni`; `result`: `passed`, `failed`, `error`) and
`rideo_take_watch_score` (the overall score); the scene video: `rideo_clip_review_watched_total{watched}` (`video`,
`frames`). Production storyboards reuse the storyboard stage's metrics with `stage: storyboard`; the batch logs a
scene whose storyboard stopped it. Autopilot approvals: `rideo_autopilot_approvals_total{step}` (`clip`, `pilot`,
`production`, `cast`, `cut`, `resources`, `frames`).

## Mock gateway

`screenplay.review` scores from rules over the input: a scene with more than three characters or an action that
names a crowd lowers `feasibility` with a critical issue and a `revise_scene` recommendation; a scene without
continuity lowers `continuity`. `screenplay.revise` rewrites the named scenes as instructed (the crowd leaves, the
continuity is written). `storyboard.review` passes a storyboard whose frames all passed their gate, and otherwise
recommends redrawing the weakest frame. Tests drive generate → review → revise → review → gate on it.
`feedback.scene` with `stage: "takes"` recommends a regeneration at priority 1 only for a shot with a problem: a take
that failed its quality checks or did not pass, or a description that says "continuity break", which it reports as a
major continuity issue and revises away; every other recommendation is priority 2. Tests drive generate → scene
review → fix → watched again on it. With `watching: true` it says it saw the video (`summary` starts with "Watched").
`take.watch` passes a take unless its shot's description says "motion glitch" (a critical morphing issue and motion
0.2; the shot's revised description without it passes), and `cast.review` passes a cast whose characters each have an
approved or generated reference and recommends drawing again the references of a character whose identity says
"inconsistent". Tests drive the autopilot from the brief to the export on them.
