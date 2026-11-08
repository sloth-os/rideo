# Right the first time

The [reviews of every step](ai-review.md) catch what is wrong before the video is paid for, but every review that
fails costs a round: a model call, the rewrites or redraws it asks for, and another review. A take that fails costs a
paid video again. The cheapest fix is the one that is never needed: each step's **first** result, before any
revision or regeneration, should pass its review. This page describes how the makers of each step aim at what their
reviewer scores, and the gate that holds every score at 8.

## The image model never saw its references

Found on November 3, 2026, and it changes how to read this page: **every image up to fp44 was drawn from its prompt
alone.** The studio sends reference images inline (`data:` URIs, `MediaStore.pngDataUri`). mm-gateway parses an inline image
into the part's `data` (`translators/rest.py`, since 52fce2b9e, August 11), and its `volcengine` provider, which serves
`doubao-seedream-5.0-pro`, forwards only `url`:

```python
kwargs["image"] = [i.url for i in request.input_images() if i.url]
```

So Seedream gets none of them, and nothing reports it. Asked only to "draw the first reference image again" with a panel of two
pandas attached, it drew graduation classes and dockworkers (fp44). The video route keeps the URI as `url`, so Wan does get its
first frames.

With that line patched on an eval copy of the gateway (`i.url or f"data:{i.mime_type or 'image/png'};base64,{i.data}"`, as its
`openrouter` provider does), and the provider accepting all of them (fp45):

| The same prompt, drawn from a scene's panels | References dropped (fp44) | Delivered (fp45) |
|---|---|---|
| Likeness to the panel (SSIM at 720×405) | 0.27–0.42 | 0.55–0.97 (8 of 13 at 0.95 or more; the lowest were drawn again to a correction) |
| Identity check | 0 of 8 passed: no panda in the frame | 13 of 13 passed |

What to discount on this page: anything measured about what the image model does with an image, because it tested the prompt
alone. That is the [desk](#the-desk-on-request)'s camera views ("the image model did not follow"), frame edits, the scene's
opening frame as a reference, ten references against six, a character's views drawn from their anchor, the sheets' cast
references and fp43's frames from panels. What stands: what goes by words (the writers, the reviewers, the planner's rules,
framings spelled out) and what Wan did with its first frames (fp42's takes from panels).

mm-gateway has the fix since f3ff138, and the real-model suite and the demo server run it (`e2e/real/env.ts`).

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

**One change, a person's decision** (November 1, 2026): screenplay `feasibility` judges a moment the brief itself
asks for by how filmably the screenplay stages it, never by its being there. Through fp4–fp32 the reviewer marked
down the briefs' own events (four characters riding together, a kite that falls every time he runs) at 5–7 in every
run, so no screenplay that kept its brief could reach 8, and a draft that dropped them lost `brief` instead. The
writer gets the same words, as it gets every dimension. Feasibility scores from fp33 on are not comparable with
earlier ones. With the decision worded only as "how filmably it is staged", fp40's reviewer still marked down the
kite's repeated failed runs and its catch in the tree and the four riders' finish as major, staged as the writer's
rules stage them; so the criterion names the filmable forms it accepts (its hardest part across a cut or off-screen;
many characters far off and small, at a walk or standing; a repeated event as two or three slow, separate attempts;
a fall or a catch as a slow settle seen in its before and after), the same words the writer gets. The person decided
the filmable form; this list is the implementation's reading of it, and a softer judge on those forms than the decision
alone: feasibility scores from fp41 on are not comparable with fp33–fp40. Feasibility rose from 5 and 6.7 (fp32) to 6.7–7.3
(fp41), an eighth of the screenplay's score, so most of that score's rise from 7.4 to 8.08 is in the other dimensions.

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
  fine hand work becomes a broad gesture with a big object (carrots in a wide bucket). Thin, loose parts (a string,
  a strap, a tail, a loop) are never wrapped round, tied to or looped over anyone and nothing turns on their path, and
  what a bag holds stays out of sight until the beat that takes it out: fp33's reviewer marked down a kite string
  looped round Sammy's forearm through three scenes and a sandwich kept in view in an open backpack, both the
  writer's own details, once feasibility no longer marked down the brief's events.
- **Density.** A scene holds about one clear action for every five or six seconds, with its lines between them.
- **Setups.** Every prop and landmark a later beat needs is set up earlier, where it stands (the hay pile in the
  corner of the paddock), with its state.
- **No shots.** The writer never writes shots or camera words ("a wide view shows"): the reviewer marks them down, and
  the shot planner frames the scene.
- **A last pass.** Before it answers, the writer goes through its screenplay moment by moment against
  `video.weaknesses` and gives every moment that touches one its safest form that keeps the brief. A repeated event
  the brief asks for is never cut to one attempt: it is shown two or three times within one or two beats, each attempt
  short and going wrong in a new way (fp22: three like attempts over a minute "repeat the same failure too often").
  The last pass first said "one attempt shown instead of several", and the kite brief's "the kite falls every time he
  runs" became one failed run with a major brief issue on half the runs (fp17, fp20: "only one failed run does not
  show 'every time'"); the runs that showed several scored brief 9.

The shot planner also plans for what the video model does with a frame: **one mover at a time** (in a shot with two
or more characters one moves across the ground and the others stay where they stand: both pandas walking drew ghost
heads), **props at rest** on the ground or in a hand (a bucket balanced on a fence rail floated), and **one clear
motion** that starts at once and ends within the shot (a brush raised at the end of a dolly-out never was), with
its first frame already in the motion (a walk drawn standing never started). A shot whose beat is a gesture or a pose
(a point, a turn toward the tree, a kite held up) starts on that pose, readable in a still (the arm already out and
pointing), and its action holds or finishes it: the storyboard review reads the frames as the scene, and fp16's frames
started Rosie "mid-turn" before the point her line needs ("Rosie's point at the bent grass is not in the frame",
storytelling 7). The shot before ends with the pose begun, so the cut does not jump (fp19: an arm down at the end of
one take and out at the start of the next read as a jump across the cut), and a shot in which someone walks somewhere
lasts at least four seconds (fp19's three-second wide never got its walk). The camera still moves where it tells the scene: fp10's pilot planned every shot locked off and its
review called it "five static tableaux".

The shot planner fixes the scene's **geography** before its shots (where each landmark stands, where the sun is, which
way the wind blows) and says in every shot which way the camera looks, what is behind the characters on which side,
and which way the wind blows across the frame: the measured storyboards' frames each followed their own shot and
still disagreed with each other (the wind blowing both ways, a tree on either side of the lake).
- **Continuity.** Each written scene's `continuity` names what each character wears piece by piece (never "the riding
  outfit") and every prop the scene uses with its count, its state (full, empty, open) and who carries it in which
  hand or where it rests. A prop that changes place or state between beats changes in a moment the outline shows, or
  the next beat says who moved it and where it is now, and anything that could drift off (a flying kite, a loose pony)
  is held by someone named or tied in every beat: fp17's and fp18's reviews marked continuity down for a sandwich
  that went from the closed backpack to the grass and a kite flying over the picnic with nobody holding it.
- **Every object a prop.** Every object a scene uses is in its props with its look (fp22 used a kite's handle and
  string the props never listed, a major continuity issue).
- **Forces obeyed.** Every action keeps to the forces the continuity states: what the wind moves streams the way it
  blows, whoever walks into it is slowed and whoever walks with it is pushed on, and a lesson about a force shows its
  cause. Stating the wind was not enough: both fp21 kite screenplays had a major continuity issue for actions against
  their own wind (a tail trailing behind Sammy as he walked downwind, a walker pushed back by a tailwind).
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

### Two drafts, the better kept

The same writer and brief gave screenplays from 7.4 to 8.2 between runs (fp35, fp39): one draft is a draw from a wide
spread. With `review.screenplayDrafts` (1–3, default 1; *Screenplay drafts* in the project settings) and the screenplay reviewed,
`screenplay.generate` writes that many drafts at once from the same input, reviews each as the screenplay review would (its judge samples, one draft
after another so the calls in flight stay those of one review), and keeps the draft with the higher score (a draft
that passes before one that does not; `bestDraft`). Only the kept draft is saved. The stage's own review then reviews
it afresh, with new judge answers, and that is the score the gate and the measurement read: a draft picked on one
review's noise does not carry that noise into its own score. A paused model (ai-gateway.md#outages) is waited for, as a job waits for it, up to three times; a draft whose
review still fails to run is kept only when no other could be scored. `rideo_screenplay_drafts_total{kept}` counts whether the first or a later draft was kept; the
job's result lists every draft's score.

Measured: 7.92 (fp40) against 7.80 for one draft (fp35, fp39), within the runs' spread, with three of fp40's runs
losing a draft's review to a paused model. It costs about $1.60 more a screenplay ($0.63–1.01 to $2.14–2.70) and about ten
minutes. Its gain is not established, so new projects write one draft, and a project that wants more asks for it in its settings.

### Paws that hold, never handle (tried, not built)

The storyboard reviews of fp39's plans mark fine paw work in nearly every run: the pink brush picked out of a crowded
bucket, held up and put back (riding 1, three shots in a row), and the kite drawn out from under Rosie's arm by its
handle (kite 1); each of fp65's two runs had three such majors. The planner was already told "no hands handling small
objects", and its shots kept those moments because the scene's action has them. fp77 (November 8, 2026) added a rule:
hands and paws hold, they do not handle. A paw grips one object in the whole paw and moves it with the whole arm, and
the fine work of taking, giving or putting away an object (out of a bucket, a bag or a pocket, from under an arm, back
again, paw to paw) is never filmed: the shot starts with the object already in the paw that uses it, and a change of
paws or a putting away is cut around, the object held out at the end of one shot and already there at the start of the
next. Planned again with it, riding 1's brush starts in Rosie's paw for one slow sweep and is gone from it in the next
shot, and kite 1's kite is held out by Rosie at the end of the first shot and in Sammy's paw at the start of the second
(six shots for the scene's 20 seconds instead of five; the other scenes kept their counts). Drawn and reviewed like
fp65's two runs of the same code:

| Scene | fp65, check capped | fp65, check in full | Paws hold | Feasibility (capped, full → rule) |
|---|---|---|---|---|
| Kite 1 | 7.5 | 7.3 | 7.5 | 6.3, 6.7 → 7.3 |
| Kite 2 | 7.3 | 6.7 | 7.5 | 7.0, 6.7 → 7.0 |
| Riding 1 | 6.7 | 7.5 | 7.3 | 5.3, 6.0 → 6.7 |
| Riding 2 | 7.4 | 7.1 | 7.1 | 7.3, 7.0 → 7.3 |
| Mean | 7.22 | 7.15 | 7.35 | 6.54 → 7.08 |

+0.12 against the capped run (95% CI −0.48 to +0.73) and +0.20 against the full one: under the 0.5 a rule needs, not
built. The rule did what it says: no review marked fine paw work, and feasibility rose 0.54. The moments it cuts around
cost about what they saved: storytelling fell 0.36 (7.17 against 7.54), kite 1's reviews calling the hand-off "never
staged" and marking Sammy holding the handle from the first frame, as
[fp61's cuts](#a-moving-prop-kept-to-one-motion-a-shot-tried-not-built) moved a prop's faults from the takes to the cuts. The new plans brought their own faults too (riding 1's sun on the
barn's side, the hay pile across the axis; continuity 5.60 against 5.66). Cost $4.58, of which the four plans $0.76.

## The brief, adapted for the video model

A brief can ask for what the video model renders badly: the riding brief's two riders side by side over a pole are four
characters in one moment, its "bouncing up and down" a quick repeated motion, its slide into the hay a fall; the kite
brief's kite caught in a tree and its shared sandwich, contact and food in paws. The screenplay reviewer marks
feasibility down for each (5–7 on every measured screenplay), and marks the brief down when the writer leaves one out.
No draft can satisfy both, because the conflict is in the brief.

So with `settings.brief.adapt` (off unless a person turns it on) `screenplay.generate` first reads the brief as a
producer would (`brief.adapt`, the text model, with `VIDEO_MODEL_FACTS`): it names each moment the video model renders
badly, why, and the filmable form that keeps what it means for the story (far off and small, one slow motion, the
contact out of sight, the before and after of a cut, one attempt shown), and rewrites the brief with those forms. The
project keeps it beside the brief as written (`brief.adapted`: the moments, the adapted text, the hash of the brief it
adapts); the writer, the extensions, the shot planner and the screenplay reviewer work from it (`workingBrief`), so
the reviewer judges the screenplay against the brief as adapted. A brief edited since is adapted again before the next
screenplay; a call that fails writes from the brief as it is (`rideo_brief_adaptations_total{outcome}`). The Story view
lists what was adapted ("Asked: riding side by side · four characters in one moment. Filmed as: …"), and the project
settings turn it on or off.

Measured (fp11, fp12): a first version wrote the forms in camera words ("from far behind", "cut to") and over-prescribed
them; the reviewer then held the screenplay to those words (a critical brief issue: "the pole crossing is shown instead
of implied") and the riding screenplay fell to 6.4. Written in story words, changing as few of the brief's words as it
can, it lifted the riding screenplay's brief to 9 (7.8 and 7.4 overall, from about 7.3 without) and left feasibility at
6: the adapted brief is still a riding story, and the reviewer marks riding, trotting and handling a brush risky
whatever form they take. On the kite brief it scored 7.9 and 7.4, against about 8.0 without. So it stays off unless a
person turns it on for a brief that asks for what the model renders badly.

### A second reader for the screenplay (tried, removed)

fp16 tried a `screenplay.check` that read the writer's draft against the video model's weaknesses, as a script
supervisor would, and rewrote in place each beat or scene it found in a hard form. It applied the writer's own rules
(one attempt instead of several, the result already there rather than the handling, at most three together) to the
brief's events as well: "the kite falls every time he runs" became one slow step and one slide, the shared sandwich
was "already placed", the riders' side-by-side ride over the pole was split into one rider after the other. The
reviewer marked each as missing (story 6 and brief 6 on the kite screenplay, a critical brief issue on the riding one)
while feasibility rose by one point at most: kite 6.8 and riding 7.0, against 7.4–8.5 and 6.8–7.9 without it, and
each read took 8–12 minutes of the text model. A brief's events are its story: making one filmable belongs in how its
shots show it, not in taking it out of the screenplay.

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

### A character's views drawn on one sheet

Views drawn one after another, each from the views before it, still disagreed: fp32's cast reviews held consistency at
7.9 for both films (a backpack teal in one view and green in the others, a raincoat open in two views and buttoned in
the third, a pony's blaze ending at the eyes in one view, a helmet's flower moving from the front to the side). A
scene's frames agreed more when drawn together ([a scene drawn on one sheet](#a-scene-drawn-on-one-sheet): character
7.2 → 8.0), and a character's views may too.

With `consistency.turnaround` (off in the schema, on for new projects), `character.refs` draws the views it is asked
for as the panels of one image, in one row of square cells (`compileTurnaroundRequest`: `Character reference sheet of
three panels in three columns and one row`, each panel its view's words, the same neutral background, every panel the
same character part by part), cuts it at the gutters (`cutSheet`) and keeps each panel as its view's reference, at the
canvas's size (three square cells of about 1,230 pixels at 4.6 million). An approved or uploaded reference is sent as
the anchor, as before. Each panel is checked against its subject and the sheet's other panels (`reference.check`); while
one fails, the sheet is drawn again whole, within `consistency.maxAttempts`, told what each failed panel must show
(`Make sure: in panel 2, …`), and the sheet with the fewest failed panels is kept. A single view is drawn alone.

**Measured on frozen casts** (fp38: the screenplays and elements of fp27 and fp32, every character's three views drawn
again either alone or on one sheet, each cast reviewed as the mean of three judge answers):

| Cast | Views alone | One sheet |
|---|---|---|
| Kite fp32 | 9.3 (consistency 8.5) | 9.5 (consistency 8.9) |
| Riding fp32 | 9.1 (consistency 8.3) | 9.1 (consistency 8.5) |
| Kite fp27 | 9.3 (consistency 8.5) | 9.3 (consistency 8.9) |
| Riding fp27 | 9.0 (consistency 8.1) | 9.3 (consistency 8.7) |

Every cast had every dimension at 8 or more in both arms; on its sheet each was as good or better, and consistency, the
dimension that fell to 7.9 in fp32, rose in all four (8.35 → 8.75). New projects draw their characters' views on one
sheet.

### References that match their subject

Most of what the cast reviews still found was one reference adding or changing something: a toy dragon in a
backpack, fillings the sandwich never had, a goat on a fence and a mouse on a pole in two props' pictures, a field and
a kite around a character's whole figure, boots open at the toe, a helmet with vents in one view and a brim in the
next. With prompt version 3 each view is read as it is drawn (`reference.check`, the vision model) against its
subject (a character's identity and outfit, a place's or prop's description) and the views drawn before it, and drawn
again with another seed, within `consistency.maxAttempts`, while it does not match: the first that matches is kept,
else the one with the fewest issues (`rideo_reference_checks_total{kind, outcome}`). As with frames, it is part of
drawing a reference: the cast the review sees is the first one presented.

Correcting a view by an edit of itself (as for frames, [also removed](#frames-that-follow-their-shot)) was tried and
removed: sent with the views drawn before it and told to keep the subject "the same as in them", the edit pulled a
profile toward their angle ("Reference 3 is not a profile view"), and the riding cast fell to 8.5 (consistency 7.5) on
fp24, against 9.0 with every dimension at 8 on fp23, built the same but drawing each corrected view anew. An edit of
the view alone, without the earlier views, is untested.
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

### Nobody looks into the lens

Image and video models turn a face to the viewer: fp10's takes had "Sammy turns to face camera, breaking blocking"
(major) and a head turning to the camera mid-take, and fp15's storyboard a close-up "facing the lens instead of
off-screen right" (major) and a reverse "playing to camera" while every shot said where its characters look. Prompt
version 3 adds "anyone looking into the camera" to what a frame and a take avoid (`LOOKING_INTO_CAMERA`, in the prompt's
`Avoid:` line and the video's negative prompt), unless the shot itself asks for a look into the lens.

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

The runs above [never showed the image model a camera view](#the-image-model-never-saw-its-references). Measured again with
references delivered (fp46, the frozen plans of fp39, one run of four scenes): 7.00 with blocking 4.4 and continuity 5.8, against
7.27 and 5.6 with the desk off, and the reviews now fault the blocking itself ("crosses the 180-degree line", "line crosses on
nearly every cut"). The desk stays off, now on a measurement that tests it.

## Frames that follow their shot

The storyboards' weakest dimension was continuity (5 on every measured run), and most of what it found was a frame
that did not draw its own shot: a second kite in the sky, a prop on the wrong rail or floating, a character on the
other side of the frame, a close-up drawn whole. A frame passed its gate on identity alone, and those mistakes went to
the review, and on to the video.

With prompt version 3 a frame that passes the identity and quality checks is read against its shot as it is drawn
(`frame.reconcile`, below) and is drawn again, within `consistency.maxAttempts`, while the reading says `redraw`: it
contradicts what the shot needs (who is in it, where each stands and faces, what each holds, someone or something
missing or shown twice, a framing a size off, a landmark on the other side of the frame than the shot puts it, the
wind or the sun from the other side, the gesture the shot turns on missing or aimed elsewhere, a piece of an outfit
missing, any letters or words: fp19's riding storyboard had a critical "PONY SCHOOL" sign and a Rosie without her
trousers and boots in two frames; a string, rope, lead or strap that does not join what it should, or one too many: in
fp57 two approved frames drew the kite's string from Sammy's handle up into empty sky while the kite lay on the grass,
the check passed them and the scene review marked both). The reading says what each string or strap runs between.
Details (the clouds, a texture) are listed as conflicts without a redraw. The
sides came last: the planner writes into every shot what is behind the characters on which side and which way the
wind blows, and the reviews still found a close-up with the lake on the wrong side and scarves and tails blowing
against the scene's wind in nearly every storyboard (fp14, fp15). The first frame that needs no redraw is kept, else the one with the fewest conflicts; its reading is kept on
the board (`board.seen`) and the video pass uses it without reading the frame again. Storyboard frames and a take's
own keyframes are checked; a person's own prompt is not (`rideo_frame_reconciles_total{outcome: redraw}` counts the
frames drawn again). This is part of drawing a frame, like the identity check that also draws a frame again: the
storyboard the review sees is the first one presented, and no review round is spent on it.

Reading what each string or strap joins was measured on the plans of fp39 against a control drawn at the same time
(fp59, November 7, 2026, one run of four scenes):

| | Storyboard | Continuity | Frames drawn again for a string or strap | Major issues in the reviews (a string or its handle) | Attempts | Cost |
|---|---|---|---|---|---|---|
| Control | 7.18 | 5.58 | 1 | 10 (2) | 50 | $5.75 |
| Strings and straps read | 7.38 | 5.73 | 5 | 7 (0) | 45 | $5.25 |

The difference is +0.20 (95% CI −0.09 to +0.49 over the four scenes: kite 1 +0.4, kite 2 0, riding +0.3 and +0.1),
inside the noise between two drawings of the same plans (6.85 against 7.00 in fp52). Of the five frames it flagged, the
next drawing fixed three (kite 1's handle hanging in mid-air from the kite Sammy holds, two bridles drawn with reins the
plan does not have); kite 2's third frame passed its next reading with a string the review found stopping short of the
handle (minor); and kite 2's opening frame was drawn three times, its string from the wrong paw, then from the handle
into the sky beside a second string, and the one with the fewest conflicts was kept. The control's two major string
faults (kite 1's handle lying loose on the grass, in two frames) are not in the new run, whose two are minor. Kept, as a
wording of the reading that costs nothing: the check now sees what it passed in fp57, and what still leaves kite 2's
string wrong is the image model.

The storyboard review reads each shot as planned, while the video model gets the reading of a frame drawn unlike its
plan. So fp59's frames were reviewed again with the reading in place of the plan's description and action for each
frame whose reading lists conflicts (11 of 24), against the same frames reviewed as planned at the same time (fp60,
November 7, 2026; a probe image, not built):

| Scene | As planned | With the readings | Frames read |
|---|---|---|---|
| Kite 1 | 7.2 | 7.7 | 3 of 5 |
| Kite 2 | 6.9 | 7.3 | 2 of 5 |
| Riding 1 | 7.6 | 7.6 | 3 of 8 |
| Riding 2 | 7.3 | 7.4 | 3 of 6 |

The difference is +0.25 (95% CI −0.13 to +0.63), continuity +0.20 and feasibility +0.18: the kite scenes' composition and
storytelling rose where the review stopped marking a frame for text the video never gets, and the riding scenes'
majors stayed (the barn on the other side in Biscuit's close-up, the closing wide that undoes the touch on Biscuit's
neck). What holds the storyboards down is the frames disagreeing with each other, not with their text. Cost: 24 review
answers, $1.76.

A redraw is told what to correct. A new seed alone drew the same mistake again: the image model draws a kite flying
whatever the shot says, so after three attempts the kept frame still showed it flying. The reading answers `fix`, what
the next drawing must show, said positively ("the red kite lies flat on the grass at Sammy's feet, its yellow tail to
frame right"), and the next attempt's prompt says `Make sure: …`. The reference check does the same for a view drawn
again ("the backpack's top is closed"). A long correction is cut at 1500 characters rather than lost.

Correcting a frame by an edit of itself instead of drawing it again was tried and removed. The check catches what the
review later marks (in fp20's kite storyboard five of the review's six major issues were in the kept frames'
readings), and a new seed fixes about one frame in five, so an edit ("keep everything in it exactly as it is and change
only this") looked likely to converge. Measured on fp23 and fp24, it did not: continuity stayed at 4–5.5 (the kite
storyboard 7.1 and the riding ones 6.7 and 6.9, against 7.2 and 6.8 on average without edits), and the kite
storyboard's character fell to 6 (8–9 on every run before). Those runs [dropped every reference image](#the-image-model-never-saw-its-references),
so the "edit" never saw the frame it was to edit: they measured a sentence, not an edit.

With `consistency.frameEdits` (off by default; *Correct a flagged frame by editing it* in the project settings) an attempt after a reading that asks for a redraw edits the frame that reading
read (`compileFrameEditRequest`: the frame first, up to three of the cast's labelled references, "Edit the first image: keep
everything in it exactly as it is … and change only this: …"). It passes the same checks, the best attempt is still the one kept,
and an edit that fails them is followed by a drawing. `rideo_frame_edits_total{source}` counts them.

Measured with references delivered (fp48, the frozen plans of fp39, four scenes, one run of each):

| A frame the reading flags | Correction that fixed it | Never fixed in three attempts | Conflicts in the kept frames | Storyboard |
|---|---|---|---|---|
| Drawn again | 10 of 29 (34%) | 9 | 20 | 7.40 (7.27 in fp46) |
| Edited | 12 of 19 (63%) | 2 | 12 | 7.23 (continuity 5.8, character 8.6) |

An edit keeps the place, the light and the look, as the earlier runs could not show, and sometimes changes what it was told; often it
barely changes the picture ([below](#a-scene-read-whole-tried-removed)), so part of that fix rate is the reading changing its mind. It
clears what the reading flags and the review does not reward it: −0.11 against the two runs drawn again (95% CI −0.38 to +0.11), continuity level.
The reading looks at one frame; what the review still marks is mostly between frames (a handle that teleports, a string gone in the
next shot). So it stays off.

### A scene read whole (tried, removed)

The reading above looks at one frame at a time, and what the storyboard review still marks is mostly between frames: a handle that
teleports, a string gone in the next shot, a barn on the other side. So a scene's frames, once drawn and before the review, were read
together (`scene.reconcile`: every frame in story order with every shot's plan), and the frame each contradiction named was edited, up to
half of the scene, keeping a frame whose edit failed its checks. Measured with references delivered on the plans of fp39, four scenes:

| Edit | Storyboard | Continuity | Edited frames flagged again when the scene is read again | Likeness before to after (SSIM, median) |
|---|---|---|---|---|
| None (control, same time) | 7.20 | 5.6 | – | – |
| "Keep everything in it exactly as it is and change only this" | 7.15 and 7.03 | 5.5 and 5.0 | 4 of 7 | 0.73 |
| "Change the first image so that this is true", the rest after it | 7.23 | 5.5 | 5 of 7 | 0.81 |

The reading works: what it names is what the review goes on to mark ("stray kite handle ring", "the bucket floats at Rosie's waist", "the
paw on Rosie, not Biscuit's neck"). The edit does not: side by side, most edited frames are the same picture with the fault still in it,
with either wording, and frames nobody edited are flagged on the second reading too, so the reading itself varies. The image model
re-renders rather than moves an object. Finding the faults is no longer the problem: what would make this worth having is an image model
that can move things in a picture it is given.

### A scene read whole, edited by another model (tried, not merged)

The gateway's provider offers more image models than the one the frames are drawn with (November 2026): Seedream 4.5,
Qwen-Image 2.0 Pro and Wan 2.7 Image Pro among them. On four frames the review had faulted, each asked for the same change
with the same wording, Qwen-Image 2.0 Pro made three of the four changes and kept the rest of the picture (a scarf turned
into the wind, a step block moved back to the barn door, a paw moved from Rosie to the pony), Seedream 5.0 Pro one,
Seedream 4.5 two (one by reframing the shot) and Wan 2.7 Image Pro one; no model drew a missing kite string. So the scene
check was measured with Qwen-Image making its edits, the frames still drawn by Seedream 5.0 Pro (fp52, plans of fp39,
against frames drawn at the same time). It needed two gateway fixes first: a Qwen-Image request with input images goes to
DashScope's generation surface and synchronously, and it takes at most three input images.

| | Storyboard | Continuity |
|---|---|---|
| Control | 7.00 | 5.68 |
| Faulted frames edited by Qwen-Image | 6.75 | 5.17 |

The difference is −0.25 (95% CI −0.48 to −0.05), and all 7 edited frames were faulted again when the scene was read again.
Changes that look right beside the original do not clear what the reading and the review hold against the frame. A first
run whose edits all failed (the gateway took four input images, Qwen-Image three) was, in effect, two controls: 6.85
against 7.00, which shows the noise between two drawings of the same plans.

### A scene read whole, then a frame picked (tried, not merged)

Since an edit cannot fix what the reading finds, a frame the reading faulted was drawn twice more instead, told what to correct, and
the reading model chose among the three beside the scene's other frames (a candidate offered only when it passed the checks of any
frame). Measured against a control drawn at the same time (fp51, the same four scenes):

| | Storyboard | Continuity | Character | Composition | Coverage |
|---|---|---|---|---|---|
| Control | 7.28 | 5.5 | 8.1 | 7.35 | 7.75 |
| Faulted frames picked again | 7.17 | 5.9 | 8.25 | 7.18 | 7.42 |

The difference is −0.10 (95% CI −0.35 to +0.23); continuity rose in three scenes of four (+1.0, +0.3, +1.0, −0.7) and coverage
fell, as a choice of the frame that agrees most with the others is also a choice of the frame most like them. A new candidate was
chosen for 7 of 8 faulted frames, and 5 of the 8 were faulted again when the scene was read again, about as many as after an edit.

### A mirrored frame flipped (tried, not built)

About a quarter of the storyboards' continuity faults name a side: a barn or a tree on the other side, someone walking
or looking the wrong way, a scarf against the wind. A frame flipped left to right moves everything at once, which no edit
did, so the faulted frames of fp52's control storyboards were flipped by hand where today's review named a side
(kite 1 shot 5: the scarf against the wind; kite 2 shot 5: Rosie looking and pointing the wrong way) and the four scenes
reviewed again on the same frames otherwise (fp58, November 7, 2026):

| Scene | As drawn | Flipped | Continuity |
|---|---|---|---|
| Kite 1 (shot 5 flipped) | 7.3 | 6.9 | 5.3 → 5.0 |
| Kite 2 (shot 5 flipped) | 7.0 | 7.1 | 6.0 → 5.3 |
| Riding 1, 2 (none flipped: the review's own spread) | 7.4, 7.7 | 7.2, 7.3 | 6.0, 5.7 → 5.3, 5.7 |

Each flip turned Rosie the right way and put the lone tree and the lake on the wrong sides, and the raised paw on her
other side; the review marked both critical ("the flip breaks the 180-degree line"). In today's frames the side is wrong
for one character in a frame whose place is right, so a whole frame is not the unit to mirror; riding 2's pony, whose
head was on the wrong side, would have faced the wrong way. Not built. Cost: 24 review answers, about $1.40.

## Frames that agree with each other

Each frame followed its own shot and the storyboards' continuity stayed at 5–6: the frames disagreed with each other.
The carrot bucket was galvanized metal, orange plastic and wicker in one scene; the kite's tail was yellow, then red;
the lake rose into a wall behind a close-up. The scene's opening frame went to every later frame of the scene as its
last reference image, but its phrase asked only to "match its place, light, weather and colours, not its composition".

With prompt version 3 its phrase says what it is, the same place earlier in the scene: keep its landmarks where they
stand, the look of every prop (shape, size, colour, material), the ground, the weather and the light
(`SCENE_REFERENCE_PHRASE_V3`); who is in frame, where each one stands, what each holds and every prop's state and
place follow the shot, never the opening frame, because the story moves on between them. And the staging check reads
a frame beside that opening frame (`frame.reconcile` with `opening`), comparing only the place and the look of
things: a landmark that moved, changed or is new to the place (fp18's closing wide added a fence post its opening
wide does not have), a prop drawn with another shape, size, colour or material, another light is
a conflict, and a frame drawn again is told what to correct, as for the frame's own shot.

The first version (fp15) called the opening frame "the same moment" and kept every prop's state "unless this shot
changes it": the image model and the check then held later shots to the opening frame's states and people (a single
of Rosie flagged because "the opening frame shows Sammy"; a kite the plan had put down drawn overhead again because
it was overhead in the opening frame), the frames drifted from their shots and the kite storyboard scored 6.6
(continuity 4.5) against 7.6 the run before.

### What a frame does not show is not named

Every prompt of a scene's shots carries the scene's continuity, and the continuity names props that a shot does not
show: "The big sandwich on the red cloth is inside the closed backpack." Image models draw what a prompt names, hidden
or not. On a sheet of fp26's first kite scene (see [a scene drawn on one sheet](#a-scene-drawn-on-one-sheet)) a loaf
poked out of Rosie's closed backpack in every panel, and the storyboard review marked it major in each of them.

So with prompt version 3 the scene line leaves out each sentence of the continuity that names a prop of the project
the shot does not show, one that is not among its elements (`ShotContext.hiddenProps`, by the prop's whole name;
`sceneLine` with `hidden`). A sentence that also says something the shot does show goes with it: the shot's own
description and elements say what it shows. The checks and the reviewers still read the whole continuity, so a frame
that shows the hidden prop is still a conflict.

## A scene drawn on one sheet

Each frame drawn alone followed its shot, and the frames still disagreed with each other: the storyboards' continuity
stayed at 4–6 through fp4–fp27 while the cast scored 9. Generating a set together is the literature's cure for frames
that disagree: diffusion transformers draw coherent multi-panel sets from one prompt, and panels drawn jointly agree
more than panels drawn beside fixed neighbours ([IC-LoRA](https://arxiv.org/abs/2410.23775)); ByteDance credits
Seedream's multi-image output to "global planning and in-context consistency" and pitches it for storyboards
([Seedream 4.0](https://arxiv.org/abs/2509.20427)). Seedream 5.0 Pro, the gateway's only image model, has no group mode
([BytePlus](https://docs.byteplus.com/en/docs/ModelArk/1541523)), so one canvas is the only way its frames can see each
other, and its own showcase is a storyboard of panels in a single picture. (Seedream 4.5 has a group mode:
[a scene drawn as a group of frames](#a-scene-drawn-as-a-group-of-frames-tried-not-built) did not score higher.)

So with `storyboard.sheet` a scene drawn whole is drawn as one sheet and cut into its panels, and each panel is checked
as its shot's first attempt ([scene sheets](storyboard.md#scene-sheets)). The gateway caps the canvas at 4,624,220
pixels, so six panels come out about 1,050×590 each: enough for the reviewer, who reads frames at 512 pixels, and for
a take's first frame, which Wan scales to the take's own size.

**Measured on frozen plans.** fp26's first kite scene (six shots) was judged three times as fp26 drew it (each frame
alone, checked, the best of three attempts) and three times as the six panels of one sheet, drawn once from the shots'
own descriptions and not checked:

| | Score | Composition | Continuity | Character | Coverage | Storytelling | Feasibility | Pacing |
|---|---|---|---|---|---|---|---|---|
| Frames drawn alone | 7.27 | 7.0 | 5.0 | 8.7 | 8.3 | 7.0 | 6.3 | 8.7 |
| One sheet's panels | 7.53 | 8.0 | 4.7 | 8.7 | 8.0 | 7.7 | 7.3 | 8.3 |

The panels agreed on what the frames had disagreed about: the kite stayed in Sammy's arms in Rosie's close-up, where
fp26's frame had it already flying, and the lake, the tree and the grass kept their sides. Continuity did not rise,
for two reasons. The scene's continuity named the sandwich packed in the closed backpack, and the sheet drew a loaf
poking out of it in every one of Rosie's panels ([what a frame does not show](#what-a-frame-does-not-show-is-not-named)
now leaves that sentence out); and the kite's tail, a detail each panel's line asked for, streamed with Sammy's walk
rather than with the wind in two panels. In the pipeline each panel is read against its shot like any frame, and these
panels were not. **Measured with checks** (fp28, frozen plans): the storyboarded scenes of fp26's kite and fp27's riding projects, every
frame drawn again, either alone or from a sheet whose panels were checked and, when they failed, drawn again alone;
each scene reviewed as the mean of three judge answers:

| Scene | Drawn alone | Sheet, failed panels drawn alone | Panels kept |
|---|---|---|---|
| Kite 1 | 7.4 | 7.2 | 1 of 6 |
| Kite 2 | 6.6 | 7.9 (continuity 7.3, character 8.7) | 5 of 6 |
| Riding 1 | 7.1 | 6.7 | 5 of 8 |
| Riding 2 | 7.3 | 7.3 (character 8 against 6.7) | 4 of 7 |
| Mean | 7.10 (continuity 5.3, character 6.8) | 7.28 (continuity 5.7, character 7.9) | |

The scene whose panels survived their checks gained 1.3 points; the scene whose panels were nearly all drawn again
alone gained nothing, as those frames no longer saw each other. So a sheet with a failed panel is now drawn again
whole, told what that panel must show, and the best sheet's panels are kept (fp29: kite 7.6 and 7.7, every panel
kept; riding 6.5 and 6.9, its scenes of seven and eight shots split over two sheets that disagreed, Sammy's helmet
changing between them). So a scene is now drawn on one sheet of up to eight panels, or alone.

**One sheet against frames drawn alone** (fp28–fp31, frozen plans of four projects, eight scenes, each reviewed as the
mean of three judge answers):

| Scene | Drawn alone | One sheet | Panels kept |
|---|---|---|---|
| Kite fp25, 1 | 7.4 | 7.9 | 5 of 5 |
| Kite fp25, 2 | 7.1 | 7.5 | 5 of 5 |
| Kite fp26, 1 | 7.4 | 7.6 | 6 of 6 |
| Kite fp26, 2 | 6.6 | 7.7 | 6 of 6 |
| Riding fp25, 1 | 6.9 | 7.5 | 8 of 8 |
| Riding fp25, 2 | 7.3 | 7.5 | 5 of 5 |
| Riding fp27, 1 | 7.1 | 7.6 | 8 of 8 |
| Riding fp27, 2 | 7.3 | 7.4 | 7 of 7 |
| Mean | 7.14 | 7.59 | |

Every scene scored higher on its sheet (+0.45 on average; eight of eight is a chance of 1 in 256 if the sheet did
nothing): character 7.2 → 8.0, storytelling 7.2 → 8.0, continuity 5.5 → 6.2, pacing 7.9 → 8.0, feasibility 7.1 → 7.4,
composition and coverage level. Ten reference images instead of four (Seedream 5.0 Pro takes up to ten;
the gateway does not say so, and rideo's default for a model it does not know is four) did not help on the same
eight scenes (fp34): 7.45 against 7.59, two scenes better, two level, four worse, character no higher; reverted. The
staging check without its reasoning (fp36) drew each scene's sheets three times faster (about five minutes instead of
fifteen) and scored 0.3 lower on the same scenes, seven of eight worse: the check keeps reasoning. No scene had every dimension at 8 in
either arm: continuity is what is left, the sheets' panels agreeing with each other but not always with the plan (a
kite's tail streaming with a walk against the wind, a pony in an establishing panel before the ponies are found,
because the canvas's other panels show them).

What this does not show: fresh plans have not reproduced the gain. Storyboards on sheets drawn from new screenplays
scored kite 7.3 and 7.3 and riding 7.1 and 6.7 (fp32, fp39), against 7.2 and 6.8 before sheets; plans vary from run to run by
more than the sheet adds, and four runs cannot tell. The one-sheet rule was also made after seeing fp27's riding scenes, two
of the eight, so those two are not an independent test.

**Takes from panels lose to takes from frames, so new projects do not draw on sheets** (fp42, November 2026). On the frozen
plans of fp39 (four scenes, 24 shots, $64), each scene's frames were drawn alone or on a sheet, approved, and each shot made
once with no retries. The rule was set before the results: sheets stay the default unless takes from panels score at least 0.5
lower on the shots' watches or the scenes' reviews.

| Panels minus frames | Difference | |
|---|---|---|
| Shot's watch, overall | **−1.62** (95% CI −2.33 to −0.96) | 16 shots lower, 6 level, 2 higher; kite −1.60, riding −1.64 |
| Watch passed | 19 of 24 from frames, 10 of 24 from panels | at 8 or more: 8 and 2 |
| Watch camera, action, motion (0–1) | −0.20, −0.12, −0.09 | physics −0.03 and identity +0.01 level |
| Scene review, mean of three | −0.26 (95% CI −0.81 to +0.37) | kite −1.00, −0.43; riding +0.64, −0.24 |

The difference is not morphing (major morph or duplicate issues in 5 takes against 4) but framing (12 against 6) and missed
end states (7 against 3). The camera loss is all in closer framings (wide −0.01; medium to close −0.23 to −0.29), and the
smallest panels lost most (about 900 pixels wide −2.12, about 1,050 −1.38). A panel's conflicts with its shot do not explain it:
within each arm they barely track the take's score. Whether the cause was a panel's size or how a sheet composes it was then
unknown; frames at full size from panels answered it below (fp47): on the camera, the composition. The sheet stays a setting
(`storyboard.sheet`), for a storyboard that is only reviewed.

**Full-size frames from panels** (a setting built for this measurement, and [removed after it](storyboard.md#scene-sheets)): each panel drawn
again at the project's resolution as the very same picture, so that a take starts from a full frame that still agrees with the
scene's other frames. It needs a gateway that [delivers references](#the-image-model-never-saw-its-references). fp43 measured a
first prompt on a gateway that dropped them, so its arm was one more run of frames drawn from words, and with the two others it
gives this comparison its noise: takes 6.54, 6.33, 6.42; scene reviews 6.42, 6.49, 6.33; storyboards 7.15, 7.10, 7.08. It also
repeated fp42's result, takes from panels 1.42 under takes from frames (CI −2.08..−0.71, 18 of 24 lower).

The storyboards of the same four scenes with references delivered (fp46; three judge answers each):

| Frames | Storyboard | Continuity | Character | Composition |
|---|---|---|---|---|
| Drawn from words (three runs) | 7.08–7.15 | 5.3–5.4 | 7.3–7.7 | 7.0–7.2 |
| Alone, with their references | 7.27 | 5.6 | 8.1 | 7.2 |
| From panels, the panel alone | 7.40 | 5.8 | 8.5 | 7.6 |
| From panels, with the cast's images too | 7.35 | 5.8 | 8.3 | 7.4 |

On these plans references raise the character score (riding's first scene from 5–6 to 9) and move the rest a little: against
the three runs from words, +0.17, +0.29 and +0.24, every interval spanning zero; riding gains and kite does not. Continuity
stays the blocker, and what is left in it is staging and props, not looks. Fresh runs do not show even the character gain:
storyboards 7.0 and 6.6, character 6.3 and 7.0 (fp47), inside the range of the runs from words.

**Takes from frames at full size lose, so the setting was removed** (fp47; same plans and rule, one attempt a shot):

| Frames | Shots' watches | Passed | Camera (0–1) | Scene reviews |
|---|---|---|---|---|
| From words (three runs) | 6.54, 6.33, 6.42 | 19, 18, 17 of 24 | 0.82, 0.82, 0.80 | 6.42, 6.49, 6.33 |
| Alone, with their references | 6.50 | 18 | 0.84 | 6.32 |
| Panels (fp42) | 4.92 | 10 | 0.62 | 6.16 |
| At full size from panels | 5.08 | 9 | 0.57 | 6.22 |

Per shot against the three runs from words: full size **−1.35** (95% CI −1.96 to −0.78; kite −0.27, riding −2.12), alone with
references +0.07 (−0.42 to +0.57), with take identity +0.04 (0 to +0.08) and scene character 7.4 against 6.5–6.9. Scene reviews
stay within noise for all of them, continuity 4.2–4.7.

What breaks is the camera. On riding 9 of 14 takes from full-size frames pull back, widen or cut away from their first frame,
as 8 of 14 do from panels, against 1, 2, 2 and 3 of 14 from frames drawn alone (kite: 0 or 1 of 10 in every arm). Panels and their
full-size frames lose it alike by the shot's framing (medium close: camera 0.37 and 0.35; medium 0.59 and 0.56; wide 0.91 and 0.75),
so on the camera it is the composition and not the size, which retires the panel widths above as a cause. Size does matter on kite:
full size recovers what panels lost there (5.40 to 6.50), in action and motion and not in the camera. Why riding's panels break and
kite's do not is not known. The prompts do not explain it: the same shot's two prompts differ only in how the frame was read, with
the same camera line.

### A scene drawn as a group of frames (tried, not built)

Seedream 5.0 Pro draws one image a request. The provider's Seedream 4.5 also draws a group: up to 15 images in one
request, the references counted with them, each at least 2,560×1,440 pixels, the multi-image output ByteDance credits
with "in-context consistency" ([Seedream 4.0](https://arxiv.org/abs/2509.20427)). A group's frames are full size,
which a sheet's panels are not ([takes from panels lost](#a-scene-drawn-on-one-sheet)). So fp76 (November 8, 2026)
drew fp39's four scenes again with each scene asked for as one Seedream 4.5 group: its shots in order, each said as its
frame would be, and the cast's and the props' references once (five to seven). Each image was its shot's first
attempt, read and judged like any frame, and a frame that failed was drawn again alone by Seedream 5.0 Pro, up to
three attempts, as now. The gateway passes `parameters.extra` to the model only on a local branch (`image-extra`, run
as an eval gateway), and Volcengine's SDK takes the group options only as raw body fields (`extra_body`). The controls
are fp65's two runs of the same code on the same plans:

| Scene | fp65, check capped | fp65, check in full | Group | Group frames kept |
|---|---|---|---|---|
| Kite 1 | 7.5 | 7.3 | 7.0 | 2 of 5 |
| Kite 2 | 7.3 | 6.7 | 7.0 | 2 of 5 |
| Riding 1 | 6.7 | 7.5 | 7.2 | 1 of 8 |
| Riding 2 | 7.4 | 7.1 | 7.0 | 1 of 6 |
| Mean | 7.22 (continuity 5.83) | 7.15 (continuity 5.50) | 7.05 (continuity 5.00) | 6 of 24 |

Against the capped run, the one new projects get, the group scored −0.18 (95% CI −0.90 to +0.55); against the full run
−0.10. Continuity fell (5.00 against 5.66 for the two runs), and so did character (7.25 against 7.88): not built. A
group keeps the place for most of its frames (the lake, the path and the tree kept their sides through both kite
groups). What it breaks is what the checks look for: a kite drawn twice in kite 1's opening frame (one in Rosie's arms,
one in the sky), a second Rosie at the edge of that group's last frame, which also lost the hill to a white backdrop,
the kite's handle grown to the size of a life ring, and riding 2's last wide on a pale studio floor. The checks drew
18 of the 24 group frames again alone, so the boards were mostly frames drawn alone after all. Of the six group frames
kept, one passed its checks; five were kept as the best of three attempts with their faults named, three of them their
scenes' opening frames, the reference every later frame of a scene is drawn against. The reviews marked both faults
that stayed: kite 1's second kite and riding 2's studio floor (critical). Cost $3.46 as counted, plus the 24 group
images the gateway has no price for (about $1.10 at Seedream 5.0 Pro's $0.045 an image), against $3.75; 3.9 hours
against 3.3: each group took 3.5 to 5 minutes, and an instance draws two images at a time.

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

### The take knows where it ends

A video prompt said where a shot starts and what moves, never where it ends. In fp16's pilot the last shot's action
was "the wind lifts the yellow tail and white string toward the tree" and the video model launched the kite a scene
early (critical: "Kite launches a scene early"; its end state had the kite still held against Sammy's chest). With
prompt version 3 the action line of a take ends with the shot's planned end state, in the same sentence so that it
reads as where this one motion arrives rather than as another shot (Wan played a separate sentence about the previous
shot as a second shot): "Action: Sammy turns toward the lone tree while the wind lifts the tail, ending with: Sammy faces
the tree, the kite still held against his chest." A person's own prompt is left as it is.

### A take that misses its camera or its end is made again

The take watch scores the camera (0–1) and whether the planned action happens and reaches its end state, and the
verdict used the action only below 0.4 and never the camera. Every take the measured scenes found pulling back or
drifting had passed with camera 0.3–0.6 (fp16, fp18, fp19, fp23), and every take that "never reaches its end state"
with action 0.45–0.5, while the takes without those issues scored camera 0.85–1 and action 0.7–1. So a take now fails
its watch with `camera` below 0.7 (`WATCH_MIN_CAMERA`) or `action` below 0.6 (`WATCH_MIN_ACTION`), and is made again
within `consistency.maxAttempts` like any failed check; the best attempt is kept when none passes.

### A line in the wrong voice is made again

fp25's pilot passed a take of Sammy's close-up in which his line was spoken in Rosie's voice, and the scene review
marked it critical (dialogue 5). The take's sound check knew only the voices of who was in frame, so it could not name
Rosie's, and a line in another character's voice was advisory. The listener now gets every character's voice, marked
`inFrame`, and a line heard in another character's voice fails the take, which is made again
([quality checks](continuity.md#quality-checks-in-the-gate)).

### A take that fails is told what to correct

A take that failed its watch was made again from the same prompt with another seed, while a frame drawn again is told
what its reading found wrong ([frames that follow their shot](#frames-that-follow-their-shot)). Targeted feedback on
a failed video, the correct state said in the next prompt, is the training-free method with the best measured effect
on physical adherence ([PhyT2V](https://arxiv.org/abs/2412.00596): 2.3 times better adherence to physical rules),
where a generic rewrite does not help. So the take watch also answers
`fix`: when the take fails, what the next take must show instead, said positively ("the kite stays a flat red diamond
held against Sammy's chest; the camera holds its medium framing"), and with prompt version 3 the next attempt's video
prompt says `Make sure: …` after its action.

Measured, without a control arm: of the 17 takes made again with a correction in fp32 and fp39, 4 ended passing their
watch (riding 2 of 13, kite 2 of 4); of the 3 made again before corrections (fp25, fp26), 2. Nothing yet shows the
correction helps.

### The take holds its camera

The take watch's most frequent issue after fp16 was the camera: a static medium shot that pulls back, a dolly-in that
pulls out, a close-up that drifts to a medium full shot (four of fp16's and fp18's ten takes), although a static shot
already asks the model for a fixed camera (`camera_motion: fixed`). The camera was said after the style, the place and
the first frame, some 800 characters into the prompt. With prompt version 3 a take's camera comes first, right after
"One continuous shot, no cuts.", with what it must not do (`CAMERA_HOLDS`): a static shot "holds its framing from the
first frame to the last, no zoom, no pull back, no drift", a dolly-in "only moves closer, never pulls back", a tracking
shot "keeps the same distance and framing as it moves"; and the negative prompt names the drift ("zoom out, camera
pulling back" for a static shot or a dolly-in). A multi-shot request keeps each segment's camera with its segment, and
a move from the camera library keeps its own words.

### A scene rendered in one request (measured, not the default)

About half of the scene reviews' continuity issues are breaks across a cut (a prop that jumps, a second barn), which a
scene rendered by the video model in one request could hold together ([multi-shot](multi-shot.md)). fp53 rendered each
of the four scenes of fp39's plans that way from its opening frame, one render and no remakes, and reviewed each three
times, against six runs that made every shot alone from its own approved frame:

| Scene | One request | Its cuts | Shot by shot (six runs) |
|---|---|---|---|
| Kite 1 | 6.80 | detected | 5.87–6.87 |
| Kite 2 | 6.00 | planned | 6.27–6.83 |
| Riding 1 | 5.97 | planned | 5.53–6.17 |
| Riding 2 | **7.83** | detected | 6.30–6.90 |
| Mean | 6.65 | | about 6.4 |

Where the render's cuts were found, the scene scored as well as the best run shot by shot or better (riding 2: 7.83,
the best scene review of all these measurements); where they were not, the segments were cut at the planned times and
each held parts of two shots (kite 2's segments watched 3, 6, 2, 3 and 2). Scanned again, Wan's cuts score 0.32 to 0.57,
above the 0.3 the split scans at, but the split takes them only when it finds exactly one fewer than the shots: riding 1's
render has 6 of its 7 cuts, each within 1.3 s of its planned time, and was split at the planned times instead; kite 2's has
2 cuts where its plan has 4, so the model rendered fewer shots than it was asked for. A split that matches the cuts it
finds to the planned times and fills only a missing one from the plan would have cut riding 1 right; a render with far
fewer cuts than shots should be made again, not split. Whole scenes made shot by shot from keyframes, which an earlier attempt produced by
mistake, scored kite 7.07 and riding 6.53 (one scene each).

**The split now takes the cuts it finds** ([splitting](multi-shot.md#splitting-and-verification)). Riding 1's render, split
again that way (6 of its 7 cuts from the render, one at its planned time), was reviewed three times beside the old split
at the same time (fp55): the scene 6.67 against 5.97 (continuity 5.3 against 4), its takes' watches 6.25 against 5.63,
with 6 of 8 passing against 2. The same render and no new video: each take now holds one shot, and the review's strip of
each shot shows that shot. A take that fails is made again alone, so the old split would have made six of the eight
shots again and the new one two. With riding 1 at 6.67, fp53's four scenes average 6.83 against about 6.4 shot by shot.

**Fresh renders with the split** (fp56, November 2026, the plans of fp39 drawn and rendered again, one render a scene and no
remakes): every cut was found but one (riding 1's first, placed from the plan), 19 of the 24 takes passed their watch, and
the scenes reviewed kite 1 6.93, kite 2 5.90, riding 1 6.40 and riding 2 7.23, a mean of 6.62, above every one of the six
runs shot by shot (6.16 to 6.49). Three scenes gain 0.5 to 0.7 over the mean of those runs and kite 2 loses 0.6, as it did
in fp53. Its story is the kite's: lifted, dropped and flown, with a string and a tail. Made shot by shot, every take starts
from a frame whose kite was drawn and checked; rendered in one request, every shot after the first starts from what the
video model made of the one before, and its review names the kite (a string running into empty sky, a tail floating free:
physics 4.0 against 5.0 to 6.7) and a close-up that puts the lone tree on the other side. A scene can have both: a shot
with an approved frame starts a new group ([when](multi-shot.md#when)), so approving the frames where a prop must be
exactly right, and only those, would render the rest in one request from each of them (not measured).

Two of kite 1's three review answers had lost their picture scores: an unreadable scores object read as none and never
reached the repair call ([now it does](ai-gateway.md#structured-tasks)). Its 6.93 was the mean of 8, 5.7 and 7.1, the first
two scored on the scene's dialogue and sound alone. Reviewed again on the same render, every score checked, it scored
7.0, 7.1 and 6.7: 6.93 again, and the mean of the four scenes stays 6.62. Of every scene review recorded for these
comparisons one other had lost its picture (fp47, full size, riding 2: 6.67 without it 6.65).

**The prop's frames approved** (fp57, November 2026, the plans of fp39 drawn again with their checks; the opener and every
shot of the Red Kite approved, so each starts a group and the shots between render in one request from it; one render,
no remakes): kite 1 rendered as shots 1, 2–3, 4 and 5 (alone, from its own frame), kite 2 as 1–2, 3 and 4–5. Every cut
was found and 9 of 10 takes passed their watch. Kite 1 reviewed 7.07 (7.1, 6.7, 7.4), its best on these plans (one request
6.93; shot by shot 5.87 to 6.87). Kite 2 reviewed 6.23 (6.1, 6.5, 6.1): 0.33 above one request (5.90), short of the 0.5
the rule asks for, and still under every run shot by shot (6.27 to 6.83). Its physics stayed at 4.0, and approving frames
cannot help where the frames are wrong: in shots 1 and 3 Seedream drew the kite's string running from Sammy's handle up
into the sky, as if the kite flew, while the kite lies on the grass (shot 3 has a second string down to it). The frame
check passed both, and the scene review marked the string in both shots. Inside single takes the video model added the
rest: a second kite popping in, the tail floating free, the kite sliding through Rosie. Over the two kite scenes, approved
props 6.65, one request 6.42, shot by shot 6.47. A frame check that looks at what a string or a strap joins comes before
any rule that trusts such frames.

### A moving prop kept to one motion a shot (tried, not built)

In every shot-by-shot render of fp39's kite scenes the scene reviews named the kite hovering unsupported, sliding upwind
on its own and changing shape (kite 2's third and fourth shots, where Sammy walks while the kite lifts and falls, then
turns and slides to his boots), and a handle popping into a paw or doubling (kite 1's first two shots, where Sammy
reaches for the kite and draws it from under Rosie's arm: their takes passed their watch 3 and 4 times in 6, the scene's
other three 5 or 6 times). So the shot planner was told that a prop that moves on its own or in the wind is **the shot's
mover**: everyone else in its shot stands still or takes one slow step, and the prop makes one motion (it lifts, or it
falls, or it slides), never two in one shot; its next motion is the next shot, and between its motions it rests where
the last shot left it. Every attempt the scene asks for keeps its shots (a first wording cut kite 2's two failed
launches to one), each motion in its own short shot or a fall shown by its before and after across a cut, and a prop
**changes paws only across a cut**. The kite scenes were planned again with the rule, 6 and 7 shots for the same 20
seconds instead of 5 and 5, then drawn, checked, approved and rendered shot by shot with one attempt a take, as fp39's
plans were six times (fp61, November 8, 2026):

| Scene | fp39's plans, six runs | One motion a shot | Physics | Continuity | Takes passing |
|---|---|---|---|---|---|
| Kite 1 | 6.42 (5.87 to 6.87) | 6.97 (7.3, 6.9, 6.7) | 5.67 → 6.33 | 4.61 → 5.33 | 24 of 30 → 6 of 6 |
| Kite 2 | 6.52 (6.27 to 6.83) | 6.13 (6.0, 6.1, 6.3) | 6.00 → 5.00 | 4.89 → 4.33 | 25 of 30 → 6 of 7 |

The takes held: 12 of 13 passed their watch against 49 of 60 (watched 7.4 against 6.5, physics 0.84 against 0.79), and
kite 1, where the kite stays in paws, rose 0.54 (temporal 5.67 → 7.00). Kite 2, whose story is the kite's two failed
launches, fell 0.39 because its cuts skipped the kite's states: shot 4 ends with the kite flat on the grass at frame
right, and shot 6 opens with it in the air at frame left, upwind of Sammy, before it slides to his boots: the second
launch is never shown. All three reviews named a jump across that cut ("kite teleports from ground-right to
airborne-left", once critical) and the kite or its tail against the wind, and two the two-second lift hovering "like a
pasted decal". All three also heard Sammy's opening line while Rosie, nearer, moved her mouth: a new plan brings its own
faults. Over the two scenes +0.08 from one plan each, under the 0.5 the rule asks for: not built. Splitting a prop's
motions moves its faults from inside the takes to the cuts, unless every state between two motions is on screen. The
storyboards reviewed 7.5 and 6.8 (fp59's: 7.5 and 6.9). Cost: $16.02 (the plans $0.71, frames and storyboard reviews
$2.93, takes, watches and scene reviews $12.38).

### A prop kept where the last shot left it (tried, not built)

fp61's kite 2 lost its points at a cut that skipped the kite's states, so its rule gained the states between motions:
**a prop stays where the last shot that showed it left it**. The next shot that shows it, even after shots that do
not, starts it in that place and state (its description says so, from that shot's end state: flat on the grass to his
right, held up in both paws), and it reaches a new place or state (in the air, on the grass, upwind of him) only in a
shot whose action shows it getting there. **A cut never moves a prop**, except from one paw to another, which happens
only across a cut. A first wording left that last condition out, and its plan handed the kite over inside a shot. The
kite scenes were planned again with the full wording, 6 shots each for the same 20 seconds, then drawn, checked,
approved and rendered as fp61's were (fp62, November 8, 2026):

| Scene | fp39's plans, six runs | One motion a shot (fp61) | Kept where it was left | Physics | Continuity | Takes passing |
|---|---|---|---|---|---|---|
| Kite 1 | 6.42 (5.87 to 6.87) | 6.97 | 6.50 (6.8, 6.1, 6.6) | 5.67 → 5.67 | 4.61 → 4.67 | 24 of 30 → 5 of 6 |
| Kite 2 | 6.52 (6.27 to 6.83) | 6.13 | 6.77 (7.1, 6.8, 6.4) | 6.00 → 4.67 | 4.89 → 5.33 | 25 of 30 → 6 of 6 |

The plan did what the rule says. Kite 2's kite lies flat by Sammy's boots, lifts a little in a shot of its own, falls
flat in the next and slides to his boots in the next, where the last wide shot finds it. No review named it jumping
across a cut (all three of fp61's did), and against fp61's plan continuity rose 4.33 → 5.33 and temporal 5.67 → 6.33.
With the lift on screen, the video model drew it as a hover: all three reviews named the kite hanging in the air "like
a balloon" or "on a slack string" (two of fp61's had too), and all three its tail flipping upwind or coming loose
(physics 4.67 against 6.00). Kite 1 lost fp61's gain. A red handle doubled and popped onto the grass in its first take.
The kite's tail streamed against the wind in its first frame, which the frame check named and which was approved after
its redraws. The closing close-up was drawn with its background flipped, and its take pulled out to a full shot (its
watch failed it at camera 0.3; with one attempt a take it was not made again). The takes passed 11 of 12 (watched 6.9
against 6.5, physics 0.77 against 0.79), five of them with a major fault in the kite named by their own watch: a string
doubled or cut loose, the kite popping off the grass or through Sammy's leg, the handle doubled. Over the two scenes
+0.16, under the 0.5 the rule asks for: not built. fp61's and fp62's rules moved the kite's faults between the takes and
the cuts without lifting the scenes. What is left is how the video model moves a prop in the wind, and the faults the
take watch names but does not fail. The storyboards reviewed 7.1 and 7.7 (fp59's: 7.5 and 6.9). Cost: $15.36 (the
plans $0.65, the first wording's included; frames and storyboard reviews $2.36; takes, watches and scene reviews
$12.35).

### A take with a major fault made again (tried, not built)

A take fails its watch on a critical issue or a low score, and passes with a major one: five of fp62's 11 passing takes
had a major fault in the kite named by their own watch. So the verdict was given a way to fail a take on a major issue
too (a project setting), the watch wrote its `fix` for a major issue as for a failure, and of two attempts the checks
rank alike the one whose watch names fewer critical, then major issues was kept. fp62's renders were kept as they were,
and its five takes with a major fault were made again under that rule with up to two attempts each: the first was told
what the old take's watch had found, the second what its own watch found (fp64, November 8, 2026). Two of the five old
watches had written no fix, because a passing take's watch wrote none then, and a take already watched is not watched
again, so those two first attempts were made without a correction. Both scenes were reviewed three times, and fp62's
renders, unchanged, three more times at the same time:

| Scene | fp62's renders, unchanged (six reviews) | Its five major-fault takes made again | Physics | Continuity | Temporal |
|---|---|---|---|---|---|
| Kite 1 | 6.58 (6.8, 6.1, 6.6; 6.8, 6.8, 6.4) | 6.97 (7.0, 6.9, 7.0) | 5.83 → 6.00 | 4.67 → 5.00 | 5.83 → 6.67 |
| Kite 2 | 6.88 (7.1, 6.8, 6.4; 6.7, 7.2, 7.1) | 7.23 (7.5, 7.3, 6.9) | 4.67 → 6.33 | 5.67 → 6.00 | 6.50 → 6.33 |

The remakes removed the two faults that every review of the unchanged renders named: kite 1's red handle doubling and
popping onto the grass (named in six reviews of six, then in none of three, although the new take's own watch still
names it), and kite 2's kite hanging in the air like a balloon (six of six, then none). Only one of the five takes ended
passing: kite 2's lift, whose string had doubled, passed at physics 0.9. Two more kept a new take, one with fewer major
faults and one with as many. Two kept the old take because their new attempts had as many faults: in kite 2's fourth
shot the string came loose from the fallen kite in both attempts, although both were told to keep it joined. A new take brought a new fault (two reviews of three named Rosie's muzzle
smearing in kite 2). Over the two scenes the gain was +0.37 (95% CI +0.16 to +0.58), under the 0.5 the rule asks for:
not built. Built, it would make about four in ten passing takes again (72 of 180 passing takes in the measured runs had
a major fault named by their own watch), and most of them twice: four of the five here still had one after both
attempts. Cost: $10.47 for the 10 takes, their watches and six scene reviews, and $0.50 for the unchanged renders'
reviews.

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
- **A shorter staging check.** New projects cap the reasoning of the check that reads each frame against its shot:
  the same decisions in a third of the time, and storyboards that score the same in 43% less time
  ([below](#the-staging-checks-reasoning-capped)).

### The staging check's reasoning capped

The staging check (`frame.reconcile`) reads every attempt of every frame against its shot, and it reasoned in full:
2,000 to 12,000 tokens and one to eight minutes a reading on `qwen3.8-max`, about 45% of a scene's time in the
real-model suite. Without any reasoning (fp36) the storyboards scored 0.3 lower. A project now caps it
(`consistency.stagingReasoning`, *Checking each frame against its shot* in the project settings): `short` asks for at
most 2,048 tokens of reasoning (`STAGING_SHORT_REASONING_TOKENS`; [how the call says it](ai-gateway.md#reasoning)), and
the reading of a keyframe for its video's text takes the same cap. New projects use it; the schema's default, and so
every older project, keeps `full`.

Measured on the 24 frames fp59 drew for the four scenes of fp39's plans, each read four times by the check at the same
time, the readings of a frame in random order (fp63, November 8, 2026):

| Reading | Median time | Tokens written (median) | Frames sent back to be drawn again | Same decision as a full reading |
|---|---|---|---|---|
| Full reasoning | 174 s | 7,725 | 7 of 24 | 21 of 24 (the other full reading) |
| Full reasoning, again | 171 s | 8,185 | 8 of 24 | 21 of 24 |
| Capped at 2,048 tokens | 56 s | 2,350 | 6 of 24 | 21 and 22 of 24 |
| Capped at 1,024 tokens | 36 s | 1,342 | 10 of 24 | 19 and 20 of 24 |

At 2,048 tokens the check sends back the same frames as a full reading as often as two full readings agree with each
other, in a third of the time and for a third of the cost ($0.017 a reading against $0.050). It names more conflicts
(1.6 a frame against 0.7 to 0.9), and where the readings disagreed the frames bear most of them out: a kite string
running down to a handle lying on the grass, which one full reading and the reading kept since fp59 missed; a bucket
in the middle of the frame and a fence rail across its foreground where the plan has them aside and behind; a scarf
hanging still in the wind. One is wrong (a barn behind a character, where the place has one), and on one frame (riding
1, shot 1: Rosie in the middle rather than on the left) both capped readings named the conflict and kept the frame
where both full readings sent it back. At 1,024 tokens the check sends back more frames, for small things (a calm smile
where the shot has a worried look, a backpack's flap). Cost: 96 readings, $3.03.

Then drawn: the four scenes of fp39's plans were drawn again with their checks, one project with the check capped at
2,048 tokens and one with it in full, on the same build at the same time, and each storyboard was reviewed with three
judge answers (fp65, November 8, 2026):

| Scene | Full reasoning | Capped at 2,048 tokens | Continuity | Frames drawn | Storyboard job |
|---|---|---|---|---|---|
| Kite 1 | 7.3 | 7.5 | 5.0 → 6.3 | 11 → 10 | 45 → 37 min |
| Kite 2 | 6.7 | 7.3 | 5.0 → 6.0 | 9 → 10 | 63 → 30 min |
| Riding 1 | 7.5 | 6.7 | 6.3 → 5.7 | 16 → 14 | 107 → 57 min |
| Riding 2 | 7.1 | 7.4 | 5.7 → 5.3 | 10 → 12 | 132 → 73 min |

The capped storyboards scored 7.22 against 7.15 (+0.08, 95% CI −0.89 to +1.04): no loss measured. The storyboard jobs
took 43% less time (3.3 hours against 5.8) and cost 30% less ($3.75 against $5.34). The capped check read a frame in a
median 63 s against 199 s, writing 2,372 tokens against 7,789, and both projects drew 46 frames. Riding 1 lost 0.8. Its
fifth frame was drawn once and kept with four conflicts the capped check had named, among them Sammy seen from behind
where the medium close shot has him facing the camera, and its review found his deciding line "played to the back of
his head". fp63 saw the same once: a conflict named and the frame kept, where both full readings sent it back. A rule
that sends back a frame whose capped reading names three conflicts or more would have sent back 9 of fp63's 24 frames
instead of 6, and agreed with each full reading once less (20 and 21 times in 24): not built. New projects keep the
cap. Cost: $9.09.

## Measuring the first pass

`scripts/first-pass.mjs` measures a build on real models. It creates a project from a brief with every automatic
fix off (`review.maxRounds` 0, `review.sceneFixes` 0; `consistency.maxAttempts` 1 unless `--settings` says otherwise:
every run since fp8 passed 3, the default of new projects, so the checks that draw a frame or a view again could),
lets the autopilot run, and
continues past every gate that does not pass (*continue anyway*, as a person would), so that each step is made once
and reviewed once. A review whose job failed (the provider answering 502 or 504 for a while, as in fp32) is run again,
twice at most, as a person would press *review again*; the report lists those runs among its actions. It records each review's first round: the overall score, every dimension, and the issues, and
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
| fp8: the staging check (frames drawn again while they contradict their shot; 3 attempts) | riding 7.3; kite 8.1 | riding 8.6; kite 8.7 | riding 7.2 (7 of 16 frames drawn again); kite 7.2 (3 of 12) |
| fp9: references checked as drawn, one scene geography, the writer's last pass | riding 7.1; kite 8.0 | riding 8.7 (likeness 8.5); kite **8.9, every dimension 8 or more** | riding 6.9 (continuity 6); kite 7.0 (character 9) |
| fp10: one mover at a time, props at rest, forces and food in the screenplay | kite 7.5 | kite **8.9, every dimension 8 or more** | kite 7.3 (composition and coverage 8) |
| fp11, fp12: the brief adapted (camera words, then story words) | riding 6.4, then 7.8 and 7.4; kite 7.9, then 7.4 | kite **9.1, every dimension 8 or more** | – |
| fp14: redraws told what to correct; a moving shot starts in its motion | riding 6.8 (two scenes saved with no continuity: over 1000 characters); kite 7.5 | riding **8.9, every dimension 8 or more** (consistency 8.1); kite 8.6 (likeness 7.1) | riding 7.1; kite **7.6** (feasibility and pacing 8, character 8.5; continuity 6) |
| fp15: the opening frame kept as "the same moment" | riding 7.9; kite 7.4 | riding 8.9 (consistency 7.9); kite **9.0, every dimension 8 or more** | riding 6.9; kite 6.6 (continuity 5 and 4.5: later frames held to the opening frame's states and people) |
| fp16: the screenplay read for the video model (removed since); the opening frame for the place only | riding 7.0; kite 6.8 | riding 8.7 (consistency 7.6); kite **8.9, every dimension 8 or more** | riding 6.5; kite 7.3; kite pilot scene 6.3 (temporal and physics 5: the kite launched a scene early), first takes 6.0 |
| fp17: wrong-side landmarks and wind redrawn, nobody looks into the lens | riding 7.1; kite 7.4 | riding 8.9 (consistency 7.9); kite **9.0, every dimension 8 or more** | riding 6.7 (a frame lost to an empty image, fixed since); kite **7.4, one major issue** (storytelling and coverage 8, character 9) |
| fp49, fp50: a scene's frames read together and edited, with two wordings (storyboards only, plans of fp39) | – | – | 7.15, 7.03, 7.23 against 7.20 at the same time; [the reading finds the faults, the edit does not fix them](#a-scene-read-whole-tried-removed) |
| fp52: the faulted frames edited by Qwen-Image 2.0 Pro (storyboards only, plans of fp39) | – | – | 6.75 against 7.00 at the same time, continuity 5.17 against 5.68; [7 of 7 faulted again](#a-scene-read-whole-edited-by-another-model-tried-not-merged) |
| fp53: each scene rendered in one request (plans of fp39, one render, no remakes) | – | – | scene reviews 6.80, 6.00, 5.97, 7.83 (mean 6.65) against about 6.4 shot by shot; [the split decides it](#a-scene-rendered-in-one-request-measured-not-the-default) |
| fp56: each scene drawn and rendered again in one request with the split (plans of fp39, one render, no remakes) | – | – | scene reviews 6.93, 5.90, 6.40, 7.23 (mean 6.62) against 6.16–6.49 for six runs shot by shot; takes passing 19 of 24 |
| fp57: the kite scenes' opener and every shot of the kite approved, the rest rendered in one request from them (plans of fp39, one render, no remakes) | – | – | scene reviews kite 1 7.07, kite 2 6.23 against 6.93 and 5.90 in one request (fp56) and 6.42 and 6.52 shot by shot; takes passing 9 of 10; kite 2's approved frames draw the string into the sky |
| fp58: the frames a review faulted for a side flipped left to right (fp52's control storyboards, reviewed again) | – | – | kite 1 7.3 → 6.9, kite 2 7.0 → 7.1, unflipped riding scenes −0.2 and −0.4; [the place flips with the character](#a-mirrored-frame-flipped-tried-not-built) |
| fp59: the frame check reads what each string or strap joins (storyboards only, plans of fp39) | – | – | 7.38 against 7.18 at the same time (+0.20, 95% CI −0.09 to +0.49), continuity 5.73 against 5.58; 5 frames drawn again for a string or strap against 1, [kite 2's opening frame never drawn right](#frames-that-follow-their-shot) |
| fp60: fp59's frames reviewed with the readings of the frames drawn unlike their plan (storyboards only, a probe) | – | – | 7.50 against 7.25 reviewed as planned at the same time (+0.25, 95% CI −0.13 to +0.63), continuity +0.20; [the frames disagree with each other](#frames-that-follow-their-shot) |
| fp61: a prop that moves kept to one motion a shot, the kite scenes planned again (one plan, one render, shot by shot from approved frames) | – | – | scene reviews kite 1 6.97, kite 2 6.13 against 6.42 and 6.52 for six runs of fp39's plans (+0.08); takes passing 12 of 13 against 49 of 60; [the cuts skip the prop's states](#a-moving-prop-kept-to-one-motion-a-shot-tried-not-built) |
| fp62: fp61's rule with a prop kept where the last shot left it, the kite scenes planned again (one plan, one render, shot by shot from approved frames) | – | – | scene reviews kite 1 6.50, kite 2 6.77 against 6.42 and 6.52 for six runs of fp39's plans (+0.16); takes passing 11 of 12; [no cut skips a state, the lift is drawn as a hover](#a-prop-kept-where-the-last-shot-left-it-tried-not-built) |
| fp64: fp62's 5 takes that passed with a major fault made again, told what their watch found, up to two attempts each (fp62's renders, the rest unchanged) | – | – | scene reviews kite 1 6.97, kite 2 7.23 against 6.58 and 6.88 for the same renders unchanged (+0.37, 95% CI +0.16 to +0.58); 1 of 5 ended passing; [the doubled handle and the hover gone](#a-take-with-a-major-fault-made-again-tried-not-built) |
| fp63: the staging check's reasoning capped at 2,048 and 1,024 tokens (fp59's 24 frames read again, four readings each) | – | – | not drawn again: at 2,048 tokens the same redraws as a full reading 21 and 22 of 24 times (two full readings agree 21 times), 56 s a reading against 174 s; [new projects cap it](#the-staging-checks-reasoning-capped) |
| fp65: the four scenes of fp39's plans drawn again with the staging check capped at 2,048 tokens and in full (storyboards only, at the same time) | – | – | 7.22 against 7.15 (+0.08, 95% CI −0.89 to +1.04), continuity 5.83 against 5.50; storyboard jobs 43% shorter, 30% cheaper; riding 1 −0.8 from a frame kept with four conflicts named; [the cap stays](#the-staging-checks-reasoning-capped) |
| fp76: each scene of fp39's plans drawn as one Seedream 4.5 group, every image its shot's first attempt, failed frames drawn again alone (storyboards only) | – | – | 7.05 against 7.22 and 7.15 for fp65's two runs (−0.18, 95% CI −0.90 to +0.55), continuity 5.00 against 5.66; 6 of 24 group frames kept, 5 of them as the best of three; [doubled props, the place lost in late frames](#a-scene-drawn-as-a-group-of-frames-tried-not-built) |
| fp77: the planner told that paws hold and never handle, fp39's scenes planned again (storyboards only) | – | – | 7.35 against 7.22 and 7.15 (+0.12, 95% CI −0.48 to +0.73); feasibility 7.08 against 6.54, no fine paw work marked, storytelling −0.36; [the hand-off never staged](#paws-that-hold-never-handle-tried-not-built) |
| fp55: fp53's riding 1 render split again at the cuts found near the planned ones (same render, reviewed beside the old split) | – | – | scene 6.67 against 5.97; takes passing 6 of 8 against 2 |
| fp54: HappyHorse 1.1 instead of Wan 3.0, from the same 13 approved frames | – | – | shots' watch 5.0 against 6.1, passed 5 against 7; kite scene 5.7 |
| fp51: the faulted frames drawn twice more and one picked (storyboards only, plans of fp39) | – | – | 7.17 against 7.28 at the same time, continuity 5.9 against 5.5; [5 of 8 faulted again](#a-scene-read-whole-then-a-frame-picked-tried-not-merged) |
| fp48: frames corrected by an edit of themselves; negatives merged into still prompts by the gateway (storyboards only, plans of fp39) | – | – | 7.23 ([edits](#frames-that-follow-their-shot)); 7.35 (merged, +0.01 against frames without them, 95% CI −0.08 to +0.10) |
| fp47: fresh runs, references delivered, new projects' settings (to the storyboard) | riding 8.1 (continuity 7.3, feasibility 7.7, pacing 7.7); kite 8.2 (continuity 7.3, feasibility 7) | riding **8.9, every dimension 8 or more** (likeness 8.5); kite **9.1, every dimension 8 or more** | riding 6.6 (continuity 5.3, feasibility 6); kite 7.0 (continuity 5.7, character 6.3) |
| fp47: fp39's plans, takes with references delivered: frames alone; at full size from panels | – | – | shots' watches 6.50; 5.08; [above](#a-scene-drawn-on-one-sheet) |
| fp46: the desk with references delivered (storyboards only) | – | – | 7.00 (blocking 4.4, continuity 5.8); [the desk stays off](#the-desk-on-request) |
| fp46: the plans of fp39, references delivered: frames alone; from panels; from panels with the cast (storyboards only) | – | – | 7.27; **7.40**; 7.35 (continuity 5.6–5.8, character 8.1–8.5; [above](#a-scene-drawn-on-one-sheet)) |
| fp44, fp45: a frame drawn from its panel, [references dropped, then delivered](#the-image-model-never-saw-its-references) | – | – | unrelated pictures; the same picture (SSIM to 0.97, identity 13 of 13) |
| fp43: fp42's plans again: frames, and frames "from panels" on a gateway that dropped the panels (so frames from words again) | – | – | shots' watches 6.33 and 6.42; scene reviews 6.49 and 6.33; storyboards 7.10 and 7.08 |
| fp42: takes from frames against takes from panels, the frozen plans of fp39, one attempt a shot | – | – | shots' watches: frames 6.54, panels 4.92; scene reviews: frames 6.42, panels 6.16; sheets off for new projects |
| fp41: feasibility names the forms it accepts, with two drafts (screenplays only, three at a time) | riding **8.4**, 7.7, 7.9; kite **8.3, 8.4**, 7.8: mean 8.08; no run with every dimension at 8 (feasibility 6.7–7.3 in all six, continuity 7–8.7) | – | – |
| fp40: two screenplay drafts, the better reviewed kept (screenplays only, six at once) | riding 7.4, 7.7, 7.6; kite **8.4, 8.3, 8.1** (feasibility 7–7.3 the one dimension under 8 in each; continuity 7.7–8): 7.92 against 7.80 for one draft (fp35, fp39); three of the six runs lost a draft's review to the model pausing under twelve writers at once, which a draft's review now waits out | – | – |
| fp39: everything so far, new projects' settings (feasibility by staging, thin parts kept out, casts and scenes on sheets, reviews the mean of three answers) | riding 7.5 (continuity 6.7, feasibility 6.3); kite 7.4 (brief 7, feasibility 6.7) | riding 8.8 (likeness 7.9); kite **9.1, every dimension 8 or more** | riding 6.7 (continuity 4.4: Sammy's helmet gone from two panels, a brush and a bucket that move); kite 7.3 (continuity 6.4); pilot scenes riding 5.2 (continuity and temporal 3) and kite 6.0 (continuity 4), first takes riding 4.3 (1 of 8 at 8), kite 6.6; $53 for both |
| fp35: thin, loose parts never story points; a bag's contents unseen (screenplays only) | riding 7.9 (continuity 8, visual 9; pacing 7.3, feasibility 6.7), 7.8 (continuity 6.3, pacing and feasibility 7); kite **8.1** (feasibility 8; story, dialogue and continuity 7.7), **8.1** (continuity 7.3, feasibility 7) | – | – |
| fp34: ten reference images instead of four (reverted) | – | – | the eight frozen scenes on sheets: 7.45 against 7.59 with four |
| fp33: feasibility judges a brief's moments by how filmably they are staged, a person's decision (screenplays only) | riding 7.6, 7.5 (feasibility 6.3 in both, from 5); kite 7.5, **8.2** (every dimension 8 or more but feasibility 7) | – | – |
| fp32: each review the mean of three answers; a scene drawn on one sheet; props a shot hides unnamed; a failed take told what to correct | riding 7.3 (feasibility 5); kite 7.5 (continuity 6, feasibility 6.7) | riding 8.8 (consistency 7.9); kite 9.0 (consistency 7.9) | riding 7.1 (continuity 5.3, character 6); kite 7.3 (continuity 5.9, character 8.5); pilot scenes riding 6.1 and kite 6.1 (continuity 4 in both: Rosie passing through Sammy on all three attempts of one shot, each told what to correct; positions swapping mid-shot; a kite tail streaming into the wind), first takes riding 5.3 (none at 8), kite 6.6 (3 of 5 at 8); $41 for both |
| fp27: the desk on, its cameras fitted to each shot's planned layout | riding 7.3; kite 7.9 | riding **9.0, every dimension 8 or more**; kite **9.2, every dimension 8 or more** | riding 6.6 (blocking 3.5); kite 6.1 (blocking 4): worse than with the desk off, so it stays off |
| fp26: a line in the wrong voice is made again | kite **8.0** (story, visual and brief 9; continuity 7, feasibility 6) | kite 8.9 (consistency 7.6) | kite 7.1 (continuity 5.5); kite pilot scene 6.6 (dialogue 8, cinematography 7: no wrong voice and no drift left; continuity 5, temporal and physics 6: the kite morphing on every attempt of one shot), first takes 6.5 |
| fp25: a take that misses its camera or its end is made again | riding 6.5; kite **8.0** (dialogue and visual 9; continuity and feasibility 7) | riding **8.9, every dimension 8 or more**; kite **9.0, every dimension 8 or more** | riding 7.3 (coverage and pacing 8, continuity 5.4); kite 7.5 (continuity 5.5); kite pilot scene 6.1 (no camera drift left, cinematography 7; dialogue 5: a line in the wrong voice, gated since), first takes 6.6 (two shots made again) |
| fp23, fp24: a redraw is an edit (frames; reference views on fp24 only, removed since) | riding 7.4, 7.3; kite 7.8 | riding 9.0, **every dimension 8 or more** (fp23), 8.5 with view edits (fp24); kite **9.1, every dimension 8 or more** | kite 7.1 (composition, coverage, storytelling and pacing 8; continuity 5, character 6); riding 6.7 and 6.9 (continuity 4 and 5.5); kite pilot scene 6.6, first takes 6.2. Frame edits measured neutral on continuity (kite mean 7.2, riding 6.8 without them) and cost character: removed |
| fp21, fp22: a repeated brief event never cut to one; actions keep to the stated wind (screenplays only) | riding 7.1; kite 7.6, 7.4 (brief 8, feasibility 8 once), then 7.9 (continuity 8, brief 9) and 7.5 | – | – |
| fp20: prop transitions, landmarks new to the place, no pose jump at the cut, four-second walks | riding 7.8 (brief 9); kite 7.5 | riding 8.9 (consistency 7.9); kite **8.9, every dimension 8 or more** | riding 7.3 (storytelling 8, pacing 8.5, composition 8; continuity 4.5); kite 7.2 over three scenes (continuity 5.3: the kite flying or its string in the sky before it is lifted; five of the six majors were in the kept frames' readings); kite pilot scene 6.3 (continuity 4, character 5), first takes 7.2 (2 of 5 at 8) |
| fp19: the take's camera said first, a gesture aimed elsewhere redrawn | riding 7.6; kite **8.4** (story, character, dialogue, visual and brief 9; continuity and feasibility 7) | riding 9.0 (consistency 7.9); kite **9.1, every dimension 8 or more** | riding 6.9 (a "PONY SCHOOL" sign, trousers lost); kite **7.9** (character 9, storytelling and pacing 8.5, coverage and feasibility 8; composition 7.5, continuity 5.5: the wind on fur and the kite's tail); kite pilot scene 6.8 (dialogue and sound 10; two takes still pulled back), first takes 6.3 |
| fp18: a beat's pose in its first frame, the take told where it ends | kite 7.6 (brief 9) | kite **8.9, every dimension 8 or more** | kite **7.6** (composition, character, coverage, feasibility and pacing 8; continuity 7; storytelling 6: Rosie points uphill, not at the lake); kite pilot scene **7.3** (storytelling, character and physics 8; continuity 5, temporal 6), first takes 5.8 (the camera drifting) |

- **Screenplay.** A brief without built-in conflicts passes 8 overall on its first round (kite 8.3, 8.5, 8.0, 8.1; 7.6 twice),
  with every dimension at 8 or 9 except feasibility (7). The riding brief stays at 7.1–8.1: it asks for what the video
  model renders badly (two riders side by side are four characters, a bouncing trot, a slide off a pony), so the
  reviewer marks feasibility 5–6 whatever the writer does with it, and brief 5 when the writer leaves it out.
- **Cast.** Up from 7.9 to 8.3–9.1: whole figures lifted clarity from 8.3 to about 9.4, and consistency rose from 5.2
  to 7.5–8.6. With the reference check (fp9–fp11) every kite cast passed every dimension at 8 (8.9, 8.9, 9.1); the
  riding cast's consistency stayed at 7.5 (the ponies' tack and stirrups). It is
  strict and costs images: 44 of its 65 checks found a difference (a cuff trim, a boot's tread, a fleece lining), so
  most views were drawn two or three times and the best was kept.
- **Video** (the pilot scene, every take made once): 5.8 for the riding demo's pilot; 5.9 (riding) and 6.0 (kite) on
  fp6; **6.8** on fp10's kite pilot (temporal 7, character 8, dialogue 10, sound 8 now that a heard scene counts them;
  continuity 5, physics, realism, cinematography and editing 6). First takes watched whole: 6.3 on the riding demo,
  6.4 and 7.3 on fp6, 7.4 on fp10 (3 of 5 at 8). A run to the pilot cost $8–13.
- **Storyboard.** Up from about 6.5 (five runs with the desk on) to 6.5–7.3 with the desk off (eight runs, mean 7.0):
  coverage, storytelling, feasibility and pacing reach 7–8; continuity between frames stays at 5. With prompt version
  2 every run drew some close framings whole (fp6: four of nine); with version 3 (fp7) none of seven was, and
  composition's remaining issues were an eyeline and a tree drawn floating on a patch of grass in the sky.

## What is left

Every run from fp4 to fp24, first round only (one build and brief move by up to a point between runs):

| Stage | Kite brief | Riding brief | Runs with every dimension at 8 |
|---|---|---|---|
| Screenplay | 7.7 (6.8–8.5, 23 runs) | 7.3 (6.4–7.9, 18) | none: feasibility stays under 8 (8 once, fp21) |
| Cast | 8.9 (8.4–9.1, 18) | 8.8 (8.5–9.0, 15) | kite 12 of 18, riding 3 of 15 |
| Storyboard | 7.2 (6.6–7.9, 17) | 6.8 (5.6–7.3, 14) | none (fp19: 7.9, five of seven at 8) |
| Pilot scene (video) | 6.6 (6.0–7.3, 7) | 5.9 (1) | none (fp18: 7.3, five of ten at 8) |

The demo server's gateway offers one image model (`doubao-seedream-5.0-pro`) and one video model (`wan3.0-video-prime`)
(November 1, 2026): every run above used them, so "a stronger model" below means adding a provider to the gateway.

Each screenplay, cast and storyboard review of new projects is now the mean of three judge answers
([judge samples](ai-review.md#the-verdict)): the numbers above are single answers, and a minimum over seven noisy
dimensions fails work that truly clears the bar.

Where each stood on November 2, 2026 with new projects' settings, first round: screenplays 8.08 over six runs (fp41; no run
with every dimension at 8: feasibility 6.7–7.3), casts 9.1 and 8.8 (fp39; kite every dimension at 8, riding likeness 7.9),
storyboards 7.3 and 6.7 (fp39, on sheets; continuity 6.4 and 4.4), pilot scenes 6.0 and 5.2 (fp39, from panels; continuity
4 and 3). New projects have since gone back to frames drawn alone (fp42).

With references delivered on an eval gateway (November 3; fp47, one run of each brief): screenplays 8.2 and 8.1 (continuity 7.3; feasibility 7 and 7.7), casts 9.1 and 8.9 with every
dimension at 8 (riding did that 3 runs in 15 before, so one run proves little), storyboards 7.0 and 6.6 (continuity 5.7 and 5.3).
Scene reviews on frozen plans, one attempt a shot: 6.32 (continuity 4.5). A pilot of these fresh runs has not been made. Those
screenplays were written with two drafts; new projects have since gone back to one ([two drafts](#two-drafts-the-better-kept)).

All of it [drawn from words](#the-image-model-never-saw-its-references): what was tried with images below needs measuring again.

What keeps each under 8, what was tried, and what to try next:

1. **A brief that asks for what the video model cannot film** (screenplay feasibility 5–7 on every run). The reviewer
   judges the event itself (a fall, a run again and again, four characters together, food handled), and a screenplay
   that keeps the brief keeps the event. Tried: the brief adapted before writing (neutral, off unless a person turns
   it on) and a second reader rewriting hard moments (it took story out; removed). *Next:* a person's decision,
   because it changes what the review measures: judge a moment the brief demands by its filmable form; or plan such
   moments at the shot level and let the storyboard and video reviews, which see what is filmed, judge them. *Decided*
   (November 1, 2026): the filmable form ([one rubric](#one-rubric-for-the-maker-and-the-reviewer)).
2. **Views that drift** (riding cast consistency 7.6–8.1): a pony's blaze and build, a helmet that grows a brim in
   profile, an ear drawn through a helmet, paws that change colour. *Next:* a turnaround sheet (the three views in one
   picture, which an image model keeps consistent) split into the three references.
3. **Frames that disagree with each other** (storyboard continuity 4.5–6 on every run). The plans' text agrees with
   itself (fp14–fp17, read shot by shot); the drawings break it: a prop in a paw that the shot leaves on the grass,
   the lake on the other side in a close-up, a scarf hanging still in a gale. Tried: the staging check with
   corrections, the opening frame for the place only (as "the same moment" it cost a point, fp15), landmark sides and
   the wind as reasons to redraw (fp17: one major issue left on the kite storyboard). Then: a scene drawn on one
   sheet ([a scene drawn on one sheet](#a-scene-drawn-on-one-sheet)): on eight scenes of frozen plans 7.14 → 7.59,
   continuity 5.5 → 6.2, character 7.2 → 8.0, every scene better, but takes from its panels scored 1.62 lower, so it is off
   for new projects until a full-size frame can keep what the panel agreed on. Then: a scene's frames read together, and the
   frames it faults edited or drawn again and picked (fp49–fp51): the reading finds what the review marks, and neither way
   clears it (4 to 5 of 7 or 8 faulted again). The staging check, which reasoned in full (one panel's reading in fp29
   took 217 s and wrote 9,069 tokens), is capped at 2,048 tokens of reasoning for new projects: the same decisions in a
   third of the time ([fp63](#the-staging-checks-reasoning-capped)), and storyboards drawn with it scored 7.22 against
   7.15 (fp65). A scene's frames drawn together as separate full-size images by Seedream 4.5's group mode scored 7.05
   (fp76): the group keeps the place but doubles props and loses it in late frames, and the checks drew three in four of
   its frames again alone ([tried, not built](#a-scene-drawn-as-a-group-of-frames-tried-not-built)). The storyboards'
   other low score, feasibility (6.5), is the plans' fine paw work; a planner rule that cuts around it (fp77) raised
   feasibility to 7.1 and lost storytelling for it, 7.35 overall
   ([tried, not built](#paws-that-hold-never-handle-tried-not-built)).
4. **Stills that tell the beat** (storytelling 6–8): a frame is the start of its shot, so a beat inside the take was
   missing from the storyboard; the planner now starts a shot on its beat's pose (fp18, being measured).
5. **The video** (scene 6.0–7.3, first takes 5.8–7.4): the video model adds its own failures (a kite that morphs and
   pops into the sky, a close-up drifting wide, a head turning to the camera). Tried: the first frame read before
   the take, nobody looks into the lens, the take told where it ends (fp18: 7.3, storytelling and physics 8), the
   take's camera said first with what it must not do (fp19: two of six takes still pulled back, so the drift is the
model's; a take watch that finds it could have the take made again). Wan's own prompt rewriter is already off
   (`enhance_prompt: false`, which the gateway sends as `prompt_extend`). A take whose watch fails is made again
   (fp25: drift and wrong voices gone) and now told what to correct
   ([a take that fails](#a-take-that-fails-is-told-what-to-correct)). HappyHorse 1.1, the provider's other image-to-video
   model, scored lower from the same frames (fp54). A scene rendered in one request scored up to 7.83 where its cuts were
   found ([one request](#a-scene-rendered-in-one-request-measured-not-the-default)), and the split now takes the cuts it
   finds (fp55: riding 1 from 5.97 to 6.67 on the same render); fresh renders reproduced it (fp56: mean 6.62 against 6.16 to
   6.49 shot by shot) except in the scene whose story is a prop (kite 2). Approving the prop's frames (fp57) kept kite 1's
   gain (7.07) but lifted kite 2 only to 6.23, under every run shot by shot: two of its approved frames drew the string
   into the sky, and the frame check passed them. *Decided* (November 7, 2026): a storyboarded scene stays shot by shot
   from its approved frames; one request is a person's choice ([when](multi-shot.md#when)). The frame check now reads
   what each string or strap joins (fp59): it flagged kite 2's opening frame and four others, and the image model drew
   that frame's string wrong three times over ([measured](#frames-that-follow-their-shot)). A prop kept to one motion a
   shot (fp61) held its takes (12 of 13 passing) but its cuts skipped the kite's states: +0.08 over the two kite scenes
   ([tried, not built](#a-moving-prop-kept-to-one-motion-a-shot-tried-not-built)). Kept also where the last shot left
   it (fp62), the kite skipped no state, and the video model drew its lift as a hover: +0.16
   ([tried, not built](#a-prop-kept-where-the-last-shot-left-it-tried-not-built)). Five of fp62's 11 passing takes passed
   with a major fault in the kite named by their own watch (a string doubled or cut loose, the kite through a leg).
   Made again with what their watch found (fp64), they lost the doubled handle and the hover, but only one ended passing,
   and the scenes gained +0.37 for about four in ten takes made again
   ([tried, not built](#a-take-with-a-major-fault-made-again-tried-not-built)). What the remakes kept (a string coming
   loose from the kite, a handle doubled, the kite propped up off the grass) the video model drew wrong even when told
   what to show. *Next:* a render with too few cuts made again.
6. **Close framings drawn whole** (fixed, fp7) and **the AI blocking**: its cameras now follow each shot's planned
   layout where its marks allow ([following the shot plan](director-desk.md#following-the-shot-plan)), yet with the
   desk on the storyboards scored 6.1 and 6.6 (fp27) against 7.2 and 6.8 without it: the image model does not draw
   from the mannequins' camera views better, and the desk stays off. Riders and four-legged figures are not built.
