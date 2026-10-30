# Right the first time

The [reviews of every step](ai-review.md) catch what is wrong before the video is paid for, but every review that
fails costs a round: a model call, the rewrites or redraws it asks for, and another review. A take that fails costs a
paid video again. The cheapest fix is the one that is never needed: each step's **first** result, before any
revision or regeneration, should pass its review. This page describes how the makers of each step aim at what their
reviewer scores, and the gate that holds every score at 8.

## What the first pass scored

The riding demo (`prj_01m63xqksfnddtj9`, image of 13b849c, qwen3.8-max reviewing, 2026-10-29) was the first run of
the reviewed autopilot on real models. Its first rounds, before any automatic fix:

| Step | Round 1 | Lowest dimensions |
|---|---|---|
| Screenplay | 7.5 | feasibility 5, continuity 7, pacing 7 |
| Cast | 7.9 | consistency 5.2, likeness 7.9 |
| Storyboard (stage) | 6.9 | blocking 5, continuity 6, feasibility 6, pacing 6.5 |
| Storyboard (10 production scenes) | 5.9–7.5 | continuity 3–6, blocking 5, feasibility 5–8 |
| Scenes (12, watched before the edit) | 5.8–7.4 | continuity 4–6, temporal 5–8 |
| Takes (80, watched whole) | 6.3 on average, 18 of 80 at 8 or more | – |
| Export feedback | 6.4 | continuity 4, temporal 5 |

Most of what round 1 found was asked for by the maker itself:

- The **screenplay** writer was never told what the video model cannot film. Its reviewer was, and marked feasibility
  5 for four characters riding side by side (two pandas and their ponies), mounting a pony, a bouncing trot and a
  carrot held in a paw: all in `VIDEO_MODEL_FACTS`, none in the writer's prompt.
- The **cast** was drawn from a head-and-shoulders front view: that view was drawn first, from text alone, and every
  other view was drawn from it. Below the shoulders each view invented the outfit again (a helmet strap black in one
  view, pink in another; a girth that became a chest strap), and the reviewer, which asks for one whole figure per
  reference, marked the busts down. Places and props were drawn twice (`establishing` and `angle`, `detail` and
  `angle`) and the second view reinvented them (a barn with a different roof, a basket with another weave), though
  the shots use only one reference per place or prop.
- The **shot planner** sized a shot to its lines at 2.2 words a second, while the storyboard reviewer judges pacing
  at "about two words a second, plus a beat": every shot sized to the planner's rule was too short for the reviewer.

## The gate at 8

`settings.review` (docs/design/ai-review.md#the-gates) has a third bar:

```ts
settings.review = {
  threshold: number;       // 5–9.5: the lowest overall score a stage review passes with
  sceneThreshold: number;  // 4–9.5: the lowest overall score a scene review (and the cut) passes with
  minDimension: number;    // 0–10: the lowest score any one dimension may have
  …
};
```

A review passes when its overall score reaches its threshold, no issue is critical and **every** scored dimension
reaches `minDimension`: a screenplay of 8.6 with continuity at 7 does not pass (`continuity 7/10, below 8`). New
projects are created with all three at **8**. The schema keeps the old bars (7, 6 and a dimension floor of 4), so a
project made before keeps its gates. The project settings show the three bars under *Review gates*.

`stageVerdict` (screenplay, cast, storyboard, a production scene's storyboard, the cut) and `clipReviewVerdict` (a
scene) take the floor from the settings; the blocking reason names the dimension, its score and the floor.

## One rubric for the maker and the reviewer

What each reviewer scores is data, `REVIEW_RUBRICS` (shared): per stage, each dimension with what the reviewer asks.
The reviewer's prompt lists it, as before, with the same words and the same scale (10 = ready to shoot, 7 = good with
small fixes, 5 = clear problems). The task that makes the step gets the same list, as the criteria its result will be
reviewed on, with the bar: every dimension 8 or more on the first review.

| Maker | Its reviewer | What the maker now gets |
|---|---|---|
| `screenplay.generate`, `screenplay.extend` | `screenplay.review` | the screenplay rubric; `video`: what the video model renders well and badly and how long its shots are (`VIDEO_MODEL_FACTS`, the facts the reviewer gets); `castOnly` |
| `clip.plan` | `storyboard.review` (the frames drawn from the plan) | the storyboard rubric (composition, continuity, coverage, storytelling, feasibility, pacing); `video` |

The reviewers are not changed: a higher first score has to come from a better first draft, not from a softer judge.
The rubric moved into shared code, and the reviewers' prompts are rendered from it word for word.

The writer also gets the rules the reviewer's dimensions imply and that it used to break, in this order:

- **The brief first.** Every character, place, landmark and event the brief names is on screen, in its order; a hard
  moment is made filmable, never dropped, split or softened. Told only what the video model cannot film, the first
  measured writer (fp1 below) split the brief's side-by-side ride into one rider at a time, left out the slide into
  the hay and never showed the barn: brief 5, with a critical issue.
- **Feasibility.** Every scene and beat is written around at most three characters on screen (a rider and the animal
  ridden count as two): the others are out of it and come back later. Only a moment the brief itself puts together
  (riding side by side) shows them all, once, far off and small, said as where it happens rather than as a shot. A step the
  video model cannot show (mounting, putting on equipment, opening a latch) happens across a cut with a visible before
  and after (at the mounting block, then in the saddle). Every action takes its slowest, simplest form that still
  tells the story (a walk before a trot, a pole stepped over at a walk, the pony standing still before Sammy slides
  off), one motion at a time. A quick repeated motion becomes one or two slow movements (one big bounce at the trot);
  fine hand work becomes a broad gesture with a big object (carrots in a wide bucket).
- **Density.** A scene holds about one clear action for every five or six seconds, with its lines between them.
- **Setups.** Every prop and landmark a later beat needs is set up earlier, where it stands (the hay pile in the
  corner of the paddock), with its state.
- **No shots.** The writer never writes shots or camera words ("a wide view shows"): the reviewer marks them down, and
  the shot planner frames the scene.
- **Continuity.** Each written scene's `continuity` names what each character wears piece by piece (never "the riding
  outfit") and every prop the scene uses with its count, its state (full, empty, open) and who carries it in which
  hand or where it rests.
- **Pacing.** Every beat turns: a beat that only moves people from one place to another gets a small want and a
  change.
- **Outfits and bodies.** Every part of an outfit says its colour and how it sits on the body (the helmet between the
  ears, one stirrup on each side), and every part of a body a picture shows says its colour (paws, hooves and the hair
  above them, muzzle, ears, tail), so no view has to guess: the first measured cast disagreed on a pony's fetlocks, a
  panda's hands and an ear through a helmet. An accessory sits where every view shows it the same way, centred on the
  front: image models mirror a one-sided detail (the riding demo's helmet flower changed sides between views and
  frames).
- **Places and props** are described by what a picture shows clearly (shapes, materials, colours, where things
  stand), never by traces or tiny details: "gentle hoofprints" came out as tufts of grass.

## Lines fit their shots

`WORDS_PER_SECOND` is 2 and every shot with lines keeps `LINE_BEAT_SEC` (1 s) after them: a line of six words needs
4 s, the storyboard reviewer's own measure ("about two words a second, plus a beat", its words unchanged).
`fitDialogue` lengthens a shot to that, up to the model's longest shot, or splits its lines over shots as before; the
planner is told the same. The words a shot can hold (`wordsCapacity`, the writer's and the planner's
`maxWordsPerShot`) leave the beat out. The feedback's signal of lines too long for their shot counts at the same rate.

## References drawn from a whole figure

- **Characters.** The views are drawn in the order `full_body`, `three_quarter`, `profile`: the whole figure first,
  head to toe, which carries the whole outfit, then the other views from it (the anchor, as before: the first
  approved reference, else the first). Every view is a whole figure from head to toe. A head-and-shoulders `front`
  view and a close-up `expression` stay available on request. `REFERENCE_VIEW_PRIORITY` puts `full_body` first, so
  keyframes get the whole outfit with the face, and the second reference a character gets is the `three_quarter`
  view.
- **Every view keeps the anchor's details.** A view drawn from the anchor says so part by part: the same face, the
  same hair, the same outfit with every part in the same colour, shape and place. It gets the views drawn before it
  too (the anchor and up to two more, `MAX_ANCHOR_IMAGES`): in the first measured cast the profile, drawn from the
  whole figure alone, was the view that drifted (a saddle pad nobody wore, a felt-toy render, an ear through the
  helmet).
- **Materials stay as described.** An element's prompt says the film's style is its light and rendering, and every
  material stays as described: the plush look turned the pole jump's wooden supports into fur.
- **Places and props** are drawn once (`establishing` for a place, `detail` for a prop): the shots use one reference
  per place or prop, and a second view the shots never use could only disagree with the first. `angle` stays
  available on request.

## Framings spelled out

The first measured storyboard (fp1 below) drew three of its fifteen frames a size wider than planned: a close-up as a
full figure, two medium close-ups head to toe. Its references are whole figures now, and the prompt said only
"close-up". Prompt version 3 (new projects) spells each framing out in the keyframe prompt, as what the picture keeps:
"close-up: the face and the top of the shoulders fill the frame", "medium shot: the characters framed from the waist
up", "wide shot: the characters whole, from head to toe, with the place around them" (`FRAMING_V3`). Version 2 keeps
its words, so its frames stay current.

Words alone may not hold: the image model draws what its references show, and every measured storyboard with whole-
figure references drew some close framings whole. So a close framing (`CLOSE_FRAMINGS`: close-up, extreme close-up, medium
close-up) of version 3 sends each character's whole-figure reference cropped to its top (`HEAD_CROP_SHARE`, 42 %: the
head and the shoulders of a standing figure), labelled "Rosie (head and shoulders)"; the identity judge keeps the whole
figures. A crop of the same picture keeps the face and the outfit's top exactly as the cast was locked, where a
separate portrait view would be one more picture to keep consistent.

## The desk on request

The [director's desk](director-desk.md) blocks every scene in 3D and gives the image model each shot's camera view and
blocking line. On real models its AI blocking chose cameras that disagreed with the shot plan (a frontal view of
Clover for a side two-shot of Rosie brushing her, Sammy from behind for a reaction facing the camera): the frames got
three accounts of the same picture (the shot's description, the blocking line, the camera view) and followed none
consistently. The storyboard review scored blocking 5 on the riding demo and 4 on the first measured storyboard, and
blocking a scene took about ten minutes of reasoning. New projects are created with the desk off
(`blocking.enabled: false`): the shot's description is the one account, written with its screen positions
([the planner's rules](#one-rubric-for-the-maker-and-the-reviewer)). A person turns the desk on, or blocks a scene by
hand, when a scene needs it. What would let the AI blocking back on is in [what is left](#what-is-left).

## Frames that follow their shot

The storyboards' weakest dimension was continuity (5 on every measured run), and most of what it found was a frame
that did not draw its own shot: a second kite in the sky, a prop on the wrong rail or floating, a character on the
other side of the frame, a close-up drawn whole. A frame passed its gate on identity alone, and those mistakes went to
the review, and on to the video.

With prompt version 3 a frame that passes the identity and quality checks is read against its shot as it is drawn
(`frame.reconcile`, below) and is drawn again, within `consistency.maxAttempts`, while the reading says `redraw`: it
contradicts what the shot needs (who is in it, where each stands and faces, what each holds, someone or something
missing or shown twice, a framing a size off). Details (the clouds, a texture) are listed as conflicts without a
redraw. The first frame that needs no redraw is kept, else the one with the fewest conflicts; its reading is kept on
the board (`board.seen`) and the video pass uses it without reading the frame again. Storyboard frames and a take's
own keyframes are checked; a person's own prompt is not (`rideo_frame_reconciles_total{outcome: redraw}` counts the
frames drawn again). This is part of drawing a frame, like the identity check that also draws a frame again: the
storyboard the review sees is the first one presented, and no review round is spent on it.

## The video reads its first frame

A take starts from a picture, its approved storyboard frame or its keyframe, and its prompt restated the shot as
planned. When the picture showed something else (a gate drawn open where the shot said closed, an over-the-shoulder
shot drawn over the other shoulder), the video model morphed the picture toward the text: in the riding demo's pilot a
translucent second Sammy and a dissolving gate failed shot 5 at 3/10 on every attempt; rewriting the shot to what its
frame showed took it to 8/10 (docs/improvements.md item 56).

So before a version 2 take starts from a frame, `frame.reconcile` (the vision model) reads it beside the shot as
planned and answers the shot's text as the frame shows it: `description` (who is where, facing which way, holding
what), `action` (the planned beat, starting from what the frame shows) and `conflicts` (what differs from the plan). The
video prompt and the take's watch use that text in place of the planned one; the keyframe and the board's prompt hash
keep the plan, so the frame stays current. A storyboard frame is read once and keeps its reading
(`board.seen`, by the frame's hash); a keyframe is read for its generation. A person's own prompt (`promptOverride`)
is never replaced, and a call that fails leaves the planned text (`rideo_frame_reconciles_total{source, outcome}`:
`agreed`, `adjusted`, `error`). It is one vision call per frame, a fraction of the video it keeps from morphing.

## Scenes count what they heard

A scene watched before the edit is heard by the audio-visual model ([scenes before the
edit](ai-review.md#scenes-before-the-edit)), and its review is meant to carry the `dialogue` and `sound` scores it
heard. They were dropped: the scene was assembled as if nobody had listened, so every scene review of the riding
demo, and of the first measured pilots, kept only the picture's eight scores (the summaries said "Heard: all five
scripted lines are present…" beside `dialogue: null`). A heard scene now counts them, as an export's feedback does:
in its overall score and against the gate's floor.

## Efficiency

A first result that passes is the largest saving: no second round of model calls, redraws or regenerated video. The
first pass also asks for less, and waits less:

- **Fewer references.** Three views per character instead of four, one per place or prop instead of two: the riding
  demo's cast (4 characters, 9 places and props) is 21 images instead of 34, and its review reads that many fewer.
- **Reviews in parallel.** The cast review makes one call per character and per place or prop, and the storyboard
  review one per scene; they ran one after another (13 calls of 1–3.5 minutes each, about 25 minutes, on the riding
  demo). They run three at a time now (`CAST_REVIEW_CONCURRENCY`, `SCENE_REVIEW_CONCURRENCY`), and the review keeps
  the cast's and the scenes' order.

## Measuring the first pass

`scripts/first-pass.mjs` measures a build on real models. It creates a project from a brief with every automatic
fix off (`review.maxRounds` 0, `review.sceneFixes` 0, `consistency.maxAttempts` 1), lets the autopilot run, and
continues past every gate that does not pass (*continue anyway*, as a person would), so that each step is made once
and reviewed once. It records each review's first round: the overall score, every dimension, and the issues, and
prints them against the gate:

```text
node scripts/first-pass.mjs --base http://127.0.0.1:8790 --brief brief.txt --target 60 --until storyboard
```

`--until` stops after `screenplay`, `cast`, `storyboard` or `pilot` (the pilot's takes watched whole and its scene
reviewed: the first stage that pays for video). `RIDEO_API_TOKEN` is read from the environment. The report is JSON
(`--out`) and a table on standard output.

## Measured

Every build below ran on the demo server's models (`qwen3.8-max` writing and reviewing, Seedream frames and
references) from the riding demo's brief (two pandas, two ponies, five minutes) and from a second, simpler brief (the
same pandas flying a kite, three minutes, two characters), with `scripts/first-pass.mjs` (October 30, 2026). Each
cell is one run's first round; the scores of the same build and brief differ by up to a point between runs.

| Build | Screenplay | Cast | Storyboard |
|---|---|---|---|
| Before (13b849c, the riding demo) | 7.5 | 7.9 (consistency 5.2) | 6.9 (desk on) |
| fp1: rubric and video facts, whole-figure anchor, lines fit | riding 7.1 (brief 5) | riding 8.7 (consistency 7.5) | riding 6.7 (desk on, blocking 4) |
| fp2: the brief first | riding 6.9, 7.6 | – | – |
| fp3: scenes of three, setups, no shots, multi-anchor, materials | riding 8.1, 7.1, 7.4 | riding 8.3 | riding 6.3 (desk on, blocking 3.4) |
| fp4: slowest forms, costumes piece by piece, first frames read | riding 7.3; kite 8.3, 8.5 | riding 8.6; kite 8.7, 8.8 | riding 5.6; kite 6.8, 6.9 (desk on, blocking 3–4) |
| fp5: the desk off (the runs kept prompt version 2) | riding 7.5; kite 7.6 | riding 8.6; kite **8.9, every dimension 8 or more** | riding 7.1; kite 7.3 (desk off) |
| fp6: the same, first frames read for the pilot's video | riding 7.3; kite 7.6 | riding 8.7; kite 8.6 | riding 6.5; kite 7.1 (desk off) |
| fp7: prompt version 3 (framings spelled out, close framings from the head and shoulders), desk off | riding 7.6; kite 8.0 | riding 8.5; kite 8.4 | riding 7.0; kite 6.7 (no close framing drawn whole) |

- **Screenplay.** A brief without built-in conflicts passes 8 overall on its first round (kite 8.3, 8.5, 8.0; 7.6 twice),
  with every dimension at 8 or 9 except feasibility (7). The riding brief stays at 7.1–8.1: it asks for what the video
  model renders badly (two riders side by side are four characters, a bouncing trot, a slide off a pony), so the
  reviewer marks feasibility 5–6 whatever the writer does with it, and brief 5 when the writer leaves it out.
- **Cast.** Up from 7.9 to 8.3–8.9: whole figures lifted clarity from 8.3 to about 9.4, and consistency rose from 5.2
  to 7.5–8.3. One run (kite, fp5) passed every dimension at 8.
- **Video** (fp6, the pilot scene of each brief, every take made once): scene review 5.9 (riding) and 6.0 (kite),
  against 5.8 for the riding demo's pilot; first takes watched whole 6.4 and 7.3 on average (the riding demo's 6.3).
  The whole run to the pilot cost $12.74 (riding, 30 s of video) and $8.35 (kite, 20 s).
- **Storyboard.** Up from about 6.5 (five runs with the desk on) to 6.5–7.3 with the desk off (six runs, mean 6.9):
  coverage, storytelling, feasibility and pacing reach 7–8; continuity between frames stays at 5. With prompt version
  2 every run drew some close framings whole (fp6: four of nine); with version 3 (fp7) none of seven was, and
  composition's remaining issues were an eyeline and a tree drawn floating on a patch of grass in the sky.

## What is left

What still keeps a first pass under 8, with what to try next:

1. **A brief that asks for what the video model cannot film** (screenplay feasibility 5–7). The reviewer is right
   about the model, and the writer cannot satisfy both the brief and the model. *Next:* check the brief before writing
   (the same `VIDEO_MODEL_FACTS`): name the moments the model renders badly (four characters together, a jump, a
   bouncing trot, a kite caught in a tree, food in paws) and offer the filmable form to the person, who accepts it as
   part of the brief, so the reviewer judges the writer's staging against an agreed brief.
2. **Small details that drift between views** (cast consistency 7.5–8.3): a backpack's buckles, a coat open in one view
   and closed in another, sole colours. *Next:* draw a character's views in one picture (a turnaround of three figures
   side by side on one background, which an image model keeps consistent within one image) and split it into the
   three references; measure it against views drawn one by one.
3. **Frames that do not follow their shot** (storyboard continuity 5–6): a prop drawn in another place or state than
   the shot says, a duplicate prop, a character a few metres from where the cut before left them, a morning scene lit
   like a sunset. The staging check ([frames that follow their shot](#frames-that-follow-their-shot)) draws such a
   frame again; its measurement is below. *Next:* frames that agree with each other, not only with their own text:
   a scene's frames drawn as edits of its first frame (the same place and props).
4. **Close framings drawn whole** (composition, fixed): every storyboard on prompt version 2 drew some close-ups and
   medium close-ups as whole figures (fp6: four of nine); version 3's spelled-out framing and head-and-shoulders
   references drew none of seven whole (fp7).
5. **The AI blocking** (blocking 3–5, now off for new projects): its cameras must reproduce each shot's planned screen
   positions and facing before its camera views and lines go to the image model, and it has no riders
   (docs/improvements.md item 55).
6. **The video** (the pilot's scene review 5.9 and 6.0 on fp6, 5.8 on the riding demo; first takes watched whole 6.4
   and 7.3 on average, half of them at 8 or more). The first pass of the words and the stills has not reached the
   video yet: a frame's mistakes go into its take (a second kite in the sky, a kite's tail blowing against the wind,
   a string running up into an empty sky), and the video model adds its own (ghost heads in a two-character walk,
   a stumble with no weight). Reading the first frame (fp6) found those contradictions on most frames and kept the
   video from morphing toward the text; it does not remove a mistake the frame already has. *Next:* the reading's
   `conflicts` are the frame check of item 3: a frame whose reading contradicts its shot (a duplicate prop, the wrong
   framing, someone on the wrong side) is drawn again before its video is paid for.
