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
trousers and boots in two frames). Details (the clouds, a texture) are listed as conflicts without a redraw. The
sides came last: the planner writes into every shot what is behind the characters on which side and which way the
wind blows, and the reviews still found a close-up with the lake on the wrong side and scarves and tails blowing
against the scene's wind in nearly every storyboard (fp14, fp15). The first frame that needs no redraw is kept, else the one with the fewest conflicts; its reading is kept on
the board (`board.seen`) and the video pass uses it without reading the frame again. Storyboard frames and a take's
own keyframes are checked; a person's own prompt is not (`rideo_frame_reconciles_total{outcome: redraw}` counts the
frames drawn again). This is part of drawing a frame, like the identity check that also draws a frame again: the
storyboard the review sees is the first one presented, and no review round is spent on it.

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
storyboard's character fell to 6 (8–9 on every run before).

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
fix off (`review.maxRounds` 0, `review.sceneFixes` 0; `consistency.maxAttempts` 1 unless `--settings` says otherwise:
every run since fp8 passed 3, the default of new projects, so the checks that draw a frame or a view again could),
lets the autopilot run, and
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
| fp8: the staging check (frames drawn again while they contradict their shot; 3 attempts) | riding 7.3; kite 8.1 | riding 8.6; kite 8.7 | riding 7.2 (7 of 16 frames drawn again); kite 7.2 (3 of 12) |
| fp9: references checked as drawn, one scene geography, the writer's last pass | riding 7.1; kite 8.0 | riding 8.7 (likeness 8.5); kite **8.9, every dimension 8 or more** | riding 6.9 (continuity 6); kite 7.0 (character 9) |
| fp10: one mover at a time, props at rest, forces and food in the screenplay | kite 7.5 | kite **8.9, every dimension 8 or more** | kite 7.3 (composition and coverage 8) |
| fp11, fp12: the brief adapted (camera words, then story words) | riding 6.4, then 7.8 and 7.4; kite 7.9, then 7.4 | kite **9.1, every dimension 8 or more** | – |
| fp14: redraws told what to correct; a moving shot starts in its motion | riding 6.8 (two scenes saved with no continuity: over 1000 characters); kite 7.5 | riding **8.9, every dimension 8 or more** (consistency 8.1); kite 8.6 (likeness 7.1) | riding 7.1; kite **7.6** (feasibility and pacing 8, character 8.5; continuity 6) |
| fp15: the opening frame kept as "the same moment" | riding 7.9; kite 7.4 | riding 8.9 (consistency 7.9); kite **9.0, every dimension 8 or more** | riding 6.9; kite 6.6 (continuity 5 and 4.5: later frames held to the opening frame's states and people) |
| fp16: the screenplay read for the video model (removed since); the opening frame for the place only | riding 7.0; kite 6.8 | riding 8.7 (consistency 7.6); kite **8.9, every dimension 8 or more** | riding 6.5; kite 7.3; kite pilot scene 6.3 (temporal and physics 5: the kite launched a scene early), first takes 6.0 |
| fp17: wrong-side landmarks and wind redrawn, nobody looks into the lens | riding 7.1; kite 7.4 | riding 8.9 (consistency 7.9); kite **9.0, every dimension 8 or more** | riding 6.7 (a frame lost to an empty image, fixed since); kite **7.4, one major issue** (storytelling and coverage 8, character 9) |
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

What keeps each under 8, what was tried, and what to try next:

1. **A brief that asks for what the video model cannot film** (screenplay feasibility 5–7 on every run). The reviewer
   judges the event itself (a fall, a run again and again, four characters together, food handled), and a screenplay
   that keeps the brief keeps the event. Tried: the brief adapted before writing (neutral, off unless a person turns
   it on) and a second reader rewriting hard moments (it took story out; removed). *Next:* a person's decision,
   because it changes what the review measures: judge a moment the brief demands by its filmable form; or plan such
   moments at the shot level and let the storyboard and video reviews, which see what is filmed, judge them.
2. **Views that drift** (riding cast consistency 7.6–8.1): a pony's blaze and build, a helmet that grows a brim in
   profile, an ear drawn through a helmet, paws that change colour. *Next:* a turnaround sheet (the three views in one
   picture, which an image model keeps consistent) split into the three references.
3. **Frames that disagree with each other** (storyboard continuity 4.5–6 on every run). The plans' text agrees with
   itself (fp14–fp17, read shot by shot); the drawings break it: a prop in a paw that the shot leaves on the grass,
   the lake on the other side in a close-up, a scarf hanging still in a gale. Tried: the staging check with
   corrections, the opening frame for the place only (as "the same moment" it cost a point, fp15), landmark sides and
   the wind as reasons to redraw (fp17: one major issue left on the kite storyboard). *Next:* draw a frame as an edit
   of the previous frame of the same camera setup, and measure it against frames drawn from references.
4. **Stills that tell the beat** (storytelling 6–8): a frame is the start of its shot, so a beat inside the take was
   missing from the storyboard; the planner now starts a shot on its beat's pose (fp18, being measured).
5. **The video** (scene 6.0–7.3, first takes 5.8–7.4): the video model adds its own failures (a kite that morphs and
   pops into the sky, a close-up drifting wide, a head turning to the camera). Tried: the first frame read before
   the take, nobody looks into the lens, the take told where it ends (fp18: 7.3, storytelling and physics 8), the
   take's camera said first with what it must not do (fp19: two of six takes still pulled back, so the drift is the
model's; a take watch that finds it could have the take made again). *Next:* a take whose watch finds its planned end
   state missed is made again before the scene review, and props the model handles badly (a kite in the wind) kept
   still or out of the moving part of a shot.
6. **Close framings drawn whole** (fixed, fp7) and **the AI blocking** (off for new projects; its cameras must follow
   the plan and it has no riders, docs/improvements.md item 55).
