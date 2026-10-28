# AI review of the screenplay and the storyboard

The [feedback](feedback.md) on an export finds what went wrong after the video is paid for. Much of what the panda
demo's feedback found was visible earlier: a chairlift scene of fine mechanical handling the video model cannot keep
(skis in paws, a pair apart on the chair), props whose state nobody wrote down, shots that all last five seconds, a
cast-only film whose scenes still mentioned other skiers. Words and stills cost a fraction of video. So Rideo reviews
the **screenplay** before the cast is made and the **storyboard** before the pilot, and the workflow goes on only when
the review passes.

## The gates

| Gate | New requirement | Satisfied when |
|---|---|---|
| `screenplay_approved` | `screenplay.reviewPassed` | `settings.review.screenplay` is off, or the screenplay's review is **current** (made of the screenplay as it is now) and **passed**, or a person chose to continue anyway for the current screenplay |
| `storyboard_approved` | `storyboard.reviewPassed` | `settings.review.storyboard` is off (or the storyboard is), or the storyboard's review is current and passed, or a person chose to continue anyway for the current frames |

A review is current while its `subject`, a hash of what it looked at, equals the subject of the documents now
(`screenplayReviewSubject`, `storyboardReviewSubject`, shared): editing a scene, a beat, a shot or a frame after the
review makes it outdated and the gate waits for another review. With autopilot, a passing review approves its gate
as the system (`rideo`), so the project goes on to the next stage by itself.

```ts
settings.review = {
  screenplay: boolean;    // default true
  storyboard: boolean;    // default true
  threshold: number;      // 5–9.5, default 7: the lowest overall score that passes
  maxRounds: number;      // 0–3, default 2: automatic revisions before a person decides
  autoRevise: boolean;    // default true: apply the review's fixes and review again
};
```

## The document

One review per stage, `ai-reviews/<stage>.json`, versioned like every document:

```ts
type StageReview = {
  stage: 'screenplay' | 'storyboard';
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

**Storyboard** (`storyboard.review`, lane `llm`, the vision model): one call per storyboarded scene with the scene
(heading, continuity, summary), its neighbours, the cast's looks, and every shot in order (label, length, camera,
description, action, cast, lines) followed by its frame (512 px wide, labelled `Shot C2·S3`). The scenes' answers are
merged: scores weighted by the scenes' lengths, issues and recommendations in scene order.

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

**When.** `screenplay.generate` queues the screenplay review when it finishes, and `storyboard.generate` the
storyboard review (each when its setting is on). Either runs on request at any time.

## Surfaces

| REST | MCP |
|---|---|
| `GET /api/projects/:id/ai-reviews` | `ai_review_get` |
| `POST /api/projects/:id/ai-reviews/:stage/run` → job | `ai_review_run` |
| `POST /api/projects/:id/ai-reviews/:stage/recommendations/:rid/apply` → `{review, job}` | `ai_review_apply` |
| `POST /api/projects/:id/ai-reviews/:stage/recommendations/:rid/dismiss` | `ai_review_dismiss` |
| `POST /api/projects/:id/ai-reviews/:stage/override` `{note}` | `ai_review_override` |

REST and MCP call the same `AiReviewService`. The **Story** view and the **Storyboard** view show the stage's review
above their content: the verdict and the score against the threshold, a bar per dimension, the round, the issues
(a scene or a shot links to it) and the recommendations with *Apply* and *Dismiss*, *Review again*, and *Continue
anyway* when it failed. The stepper names the failing review among the gate's unmet requirements.

## Observability

`rideo_ai_reviews_total{stage, outcome}` (`passed`, `failed`, `error`), `rideo_ai_review_score{stage}`,
`rideo_ai_review_rounds{stage}` and `rideo_ai_review_recommendations_total{stage, action, outcome}` (`applied`,
`dismissed`, `auto`). Jobs log the project, the stage, the round and the score.

## Mock gateway

`screenplay.review` scores from rules over the input: a scene with more than three characters or an action that
names a crowd lowers `feasibility` with a critical issue and a `revise_scene` recommendation; a scene without
continuity lowers `continuity`. `screenplay.revise` rewrites the named scenes as instructed (the crowd leaves, the
continuity is written). `storyboard.review` passes a storyboard whose frames all passed their gate, and otherwise
recommends redrawing the weakest frame. Tests drive generate → review → revise → review → gate on it.
