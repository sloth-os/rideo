# Continuity, storytelling and realism

A film made shot by shot drifts in ways an identity check does not see: the sun jumps across the sky between two
cuts, snow stops falling, a character walks out left and comes back from the left, a ski passes through a leg, a
line is cut off because it did not fit the shot, the second half of the film forgets what the user asked for. This
page describes how Idea → movie keeps a film **continuous** (from cut to cut), **temporally consistent** (inside a
shot), **well told**, **physically plausible** and **believable**. It builds on the identity rules of
[character consistency](character-consistency.md) and [elements](elements.md); what the finished film still gets
wrong is caught by [feedback](feedback.md).

## Prompt version

Every rule below that changes a generation request is part of **prompt version 2**:
`settings.generation.promptVersion` (`1` or `2`). Projects created before it keep version 1 (the schema default), so
their prompts stay byte-identical (rule R3) and their storyboard frames stay current; new projects are created with
version 2. The project settings switch it ("Continuity-aware prompts"); switching makes current storyboard frames
*outdated* because their prompt changed ([storyboard](storyboard.md#board-frames)).

| Part | Version 1 | Version 2 |
|---|---|---|
| Writing (`screenplay.generate`, `screenplay.extend`) | title, outline, scenes | + story structure, beat purposes, each scene's continuity state, the brief and the dialogue level in every extension |
| Planning (`clip.plan`) | shots sized to the model | + coverage rules, lens, end state, the previous shot, dialogue sized to the shot |
| Keyframe prompt | style, description, camera, cast, elements | + the scene line, the previous shot's end state, the scene reference image, exclusions |
| Video prompt | style, description, action, camera, cast, elements, dialogue | blocks: scene, shot, camera, cast, dialogue with voices (or "No dialogue."), sound, style, physics, exclusions |
| Negative prompt | `BASE_NEGATIVE` | `BASE_NEGATIVE` + motion artefacts, at most 500 characters |
| Gate | identity (R4) | + temporal check and physics, continuity judged with the identity (when `consistency.qualityChecks`) |

## Storytelling

**Structure.** `screenplay.generate` plans the outline as a story, not a list of events: setup, inciting incident,
rising complications, midpoint, crisis, climax and resolution, each outline beat with its `purpose` (one of those
words, kept on the beat). Every scene has a goal, an obstacle and a turn; what a scene sets up is paid off later;
scenes follow from each other (therefore, but), not just after each other (and then). The story is told visually:
action a camera can see, short dialogue.

**Continuity state.** Every written scene carries `continuity`: the time of day, the weather, the light (where the
sun is), what each character wears and carries, and where they are, at the start of the scene. The planner and the
prompts read it, and the next extension continues from it.

**Outfits.** A character's wardrobe entries are complete outfits, everything worn at once, and the first is the one
worn most of the film: references, keyframes and video prompts show one entry (`Wearing: …`), so an entry that is a
single piece (a scarf) leaves the rest out of every picture. The panda demo's writer split each outfit into a scarf, a
jacket and goggles with the scarf as the default, and the references came out without the jackets the scenes
describe; version 2 asks for whole outfits. Locations and props are described as they look, with no character in
them (their references show them empty, [elements](elements.md)).

**Extensions remember.** `screenplay.extend` used to see only the title, logline, synopsis and scene summaries, so
later scenes lost the user's brief. With version 2 it also gets the brief, the dialogue level, the last written scene
in full (action, dialogue, continuity) and the outline beats after the ones it writes (so it can set up what comes).

**Dialogue level.** `settings.dialogue.level` (`any` by default, or a CEFR level `A1` … `C2`) is sent to every task
that writes or plans dialogue. The table `DIALOGUE_LEVELS` (shared) holds what each level means for a writer:

| Level | Guidance given to the writer |
|---|---|
| `A1` | the most common words only, sentences of 3–6 words, present simple, no idioms |
| `A2` | everyday words, sentences of up to 8 words, present and past simple, `going to`, no idioms |
| `B1` | everyday words and common phrasal verbs, sentences of up to 12 words, present, past and future forms, simple linking words (because, so, but, when), no rare idioms or slang |
| `B2` | natural conversational English, some idioms, sentences of up to 16 words |
| `C1`, `C2` | no restriction beyond the character's voice |

Language learners are an audience for generated films ([the demo](#the-panda-demo) is one): a level keeps every scene,
including those written hours later by an extension, at the words the audience knows.

## Shot planning

`clip.plan` (version 2) follows film grammar so cuts read as one continuous scene:

- **Coverage.** A scene (or a new place) opens on an establishing wide shot; a conversation alternates shot and
  reverse shot with matching eyelines; reactions follow important lines; props get inserts.
- **Screen direction.** The 180° rule holds within a scene, and a character leaving frame right enters the next shot
  from the left.
- **Variety.** No more than two consecutive cuts with the same framing; one camera move per shot, motivated by the
  action.
- **Lens.** Each shot gets a focal length (`camera.lensMm`: 18–28 mm wide, 35–50 mm medium, 85–135 mm close), which
  the [directing](directing.md) lens fragment turns into words.
- **Physical action.** `action` describes motion as cause and effect with direction and contact ("carves left,
  spraying snow from the uphill edge"), not counts or vague verbs.
- **What the model can render.** The planner avoids shots video models break: a tight insert the camera must hold
  (it widens: show the prop in use in a medium shot instead), hands handling small objects, mechanical handling
  (boarding a lift, putting on equipment), crowds and readable text. In the panda demo's feedback these were the
  shots that failed again and again: ski inserts that widened to a full figure, skis in the pandas' paws, the
  chairlift boarding.
- **End state.** Each shot says what its last frame shows (`endState`: positions, poses, what is in hand). The next
  shot's prompts continue from it.
- **Across scenes.** The planner gets the previous scene's last shot (description and end state), so a new scene
  starts where the film is.

**Dialogue fits the shot.** A line must be speakable in its shot: at most `durationSec × WORDS_PER_SECOND` words
(`WORDS_PER_SECOND = 2.2`, about 11 words in 5 s) across the shot's lines. The planner is told the limit;
`fitDialogue` (shared, part of `normalizePlannedShots`) enforces it deterministically: a shot whose lines need more
time is lengthened up to the model's maximum, and lines that still do not fit move to a continuous shot inserted after
it (same description and camera, `continuity: continuous`). Nothing is cut from a line.

**Shot length.** Shots are planned within the model's range, capped at `PLANNED_SHOT_MAX_SEC` (10 s): Wan 3.0
renders 2–30 s, but a long take drifts and cuts itself ("longer runs make drift and unwanted cuts more likely"), and
one 10-second take beats two 5-second ones. `plannedShotRange(limits)` (shared) gives the range to the planner, the
dialogue fit and the writer's longest line. The planner varies the lengths with what happens: 2–3 s for reactions
and inserts, 4–6 s for most shots, up to the cap for establishing shots and longer lines. In the panda demo every
shot lasted exactly 5 s because the gateway's catalogue pinned the model to 5 s, and the feedback named the
"mechanical 5.04-second cadence".

## Prompts (version 2)

All of it is compiled by the pure functions of `shared/prompt` from the documents (rule R3), so the same inputs give
the same text.

**The scene line.** Every shot of a scene starts with the same line built from the scene: `Scene: <location>,
<time of day>; <continuity>.` The location and the light no longer depend on each shot's description remembering
them. The video prompt of a shot that shows only part of the cast keeps the place and the time (`Scene: <location>,
<time of day>.`): the continuity names every character's clothes and props, and Wan put the absent one into the shot.

**Continuing the previous shot.** A keyframe of a cut inside a scene whose previous shot has an end state adds
`Continues from the previous shot: <end state>.`; a continuous shot starts from the previous last frame as before
(R5). The video prompt leaves it out: its first frame already starts there, and Wan 3.0 played the line as a second
shot (see [what the video model reads](#what-the-video-model-reads)).

**Who is in frame.** A shot that shows only part of its clip's cast says so after its characters. The keyframe names
who is not there: `In frame: only Rosie; Sammy is out of frame.` (or `No characters in frame.` for a shot of none).
The scene reference frame shows the whole cast, and a single often names the one it looks at ("her eyeline is toward
Sammy"): in the panda demo the image model put Sammy into Rosie's close-up twice before the line was added. The video
prompt names nobody else: `In frame: only Rosie; nobody else.` Like the scene reference, the line comes from the
shot's neighbours, so the board's prompt hash leaves it out. The video prompt also leaves the absent characters' names
out of the shot's own description and action, where they become `someone off-screen` (`withoutOffscreenNames`): in
the swimming pilot Rosie's close-up said "turns her eyes to Sammy on the right" and Sammy walked into all three
attempts, though the line said nobody else. The planner names only who is in frame and writes where an unseen
character is ("looks off-screen right").

**What the video model reads.** Wan 2.7 and later take the structure of a video from its prompt: "if you do not
explicitly specify the shot structure, the model infers it from the prompt" ([Alibaba's Wan image-to-video
guide](https://www.alibabacloud.com/help/en/model-studio/wan-image-to-video-guide)). In the panda demo's second pass
13 of 27 regenerated shots failed all three attempts, most of them on a cut or a widening near the end of the take
to whatever else the prompt described: Rosie's snowplow stop cut to "Sammy sits in the soft snow" (the previous
shot's end state), her close-up cut to Sammy "in a low wedge", and Sammy's close-ups gained Rosie, drawn as a human
girl in her pink jacket, from the scene line. So a single shot's video prompt opens with its structure (`One
continuous shot, no cuts.`), leaves out the style's camera line (it lists wide, medium and tracking shots, a plan of
several shots), the previous shot's end state and, when part of the cast is out of frame, the scene's continuity, and
names only who is in frame. A multi-shot request keeps its own header and its cuts. A video that starts from a frame
(`generation.keyframes`, the default) also leaves out the style's palette and lighting, single or multi-shot: the frame
shows them and the scene line says the time of day, while the film's style may name other scenes' light. The swimming
film's said "a warm orange sunset glow in the final scenes", and 4 of the 8 morning takes of its pilot ended at sunset.
The writer keeps a time of day out of the style.

**Video prompt blocks.** Following the prompt guides of current video models (Wan 3.0, Veo, Kling), the video prompt
is a sequence of short blocks; a model given a first frame needs motion, story and sound more than a description of
what it already sees:

```
One continuous shot, no cuts. <style header without the camera style> <scene line>
<description>. Action: <action>.
Camera: <framing>, <move>; <lens>.
Characters: <compact identity: name, who they are, what they wear> …  In frame: only <names>; nobody else.
Dialogue: Sammy says, in a warm, bright young male voice: "We did it!" Lip sync.      | No dialogue.
Sound: only the voices and the natural sounds of the place and the action; no music, no song, no humming.
Physics: real weight, gravity and momentum; bodies, feet and equipment keep contact with the ground; objects keep their shape and number.
Avoid: <exclusions>.
```

- **Voices.** A line names its speaker and the speaker's voice (`voice.description`, else "a <age> <gender> voice"
  from the identity), the same words every time, so a model that voices the lines itself (`include_audio` without
  reference audio, [dialogue](dialogue.md#from-lines-to-audio)) keeps each character sounding alike.
- **No dialogue.** A shot without lines says `No dialogue.`, otherwise models that render sound invent speech, and its
  sound line says `only the ambient and action sounds of the place; nobody speaks.` instead of naming the characters'
  voices: with `the characters' voices` in the sound line, 5 of the 8 attempts at the swimming pilot's silent shots
  had speech nobody wrote ("Sammy: Hmm, nothing over there.", "Hello, what's that?").
- **Music.** Unless `settings.generation.modelMusic` is on, the sound is `the characters' voices and the ambient and
  action sounds of the place. No BGM, no music, no song, no humming.`: a shot with its own music makes the cut jump
  from song to song; the score is laid on the Music track ([post audio](post-audio.md)). Wan 3.0's guide disables
  music with "No BGM, generate only ambient and action sounds"; saying what the sound is, not only what it is not,
  follows it. With the earlier `no background music` 2 of the panda demo's 6 pilot takes had music, and with `only
  the voices and the natural sounds of the place and the action; no music, no song, no humming` about 19 of 104.
- **A static camera** is `fixed shot, camera static, position unchanged`, the guide's words for a frame that must
  not move (an insert that widened, a close-up that pulled back).
- **Exclusions in the text.** Some models (Wan 3.0) have no negative prompt field, so the last block lists the
  exclusions; the `negative_prompt` parameter carries them only for models that have one (`supports_negative_prompt`
  is not `false`).
- **Frames or references.** A model whose limits say `exclusive_frames_and_references` (Wan 3.0) takes a first or
  last frame, or references, never both: a request with a start frame sends no references (the frame already shows
  the cast and the place, and the gateway would drop them after carrying megabytes of images).

**Keyframe prompt.** The still keeps the full identity fragments (they condition the face) and adds the scene line,
the continuation and the exclusions; it has no dialogue, sound or physics blocks. It names its reference images in
the order they are sent (`Reference images, in order: 1 Rosie (front view); 2 Sammy (front view); 3 Beginner Slope,
the place.`, from `referenceLabels`), since guides of image models put a defined role for each reference above the
wording of the prompt; the board's prompt hash leaves the labels out.

**Negative prompt.** `BASE_NEGATIVE_V2` = `BASE_NEGATIVE` + `morphing, warping, flicker, extra or missing limbs,
floating objects, sliding feet, objects passing through each other, sudden lighting change, jump cut`, plus the shot's
own negative prompt, cut at 500 characters (the limit of Wan models).

**Prompt rewriting.** Some providers rewrite prompts with their own LLM (Wan's `prompt_extend`, on by default), which
can change a line of dialogue, drop a continuity detail or plan more shots (Wan 2.6 made multi-shot videos only with
it on; a tested guide found it adds invented detail and recommends it off for structured prompts over about sixty
words). Version 2 prompts are long and structured, so with `settings.generation.enhancePrompt: null` (the default)
they send `enhance_prompt: false`; `true` asks for the rewriting, and version 1 keeps the provider's default. The
panda demo's third pass ran with it off: 8 of 13 shots that had failed every attempt passed at the first.

## Scene reference frame

Shots of a scene are generated in parallel, so a shot cannot wait for its neighbour. With version 2,
`clip.generate` generates the **first shot of a clip first** and the others after it, in parallel; each later
shot's keyframe gets the first shot's selected, acceptable keyframe (or its first frame) as one more image input,
named in the prompt: *"The last image is the scene reference: match its place, light, weather and colours, not its
composition or people."* It is added when the image model accepts at least three input images and the shot's
references leave a slot (or the model's limit is unknown). Video requests do not get it: the keyframe is their first
frame already. Storyboard frames get the scene's first frame the same way
([storyboard](storyboard.md#jobs)).

## Quality checks in the gate

With `settings.consistency.qualityChecks` (on for new projects), every video attempt is also checked for what an
identity check misses. The checks retry an attempt like an identity failure, but they never block a clip: when every
attempt fails them, the best take that passed identity is kept, marked with what failed.

| Check | How | Fails the attempt when |
|---|---|---|
| **Temporal** (inside the shot) | ffmpeg scene scores of the raw take (`select='gt(scene,0.25)'` + `metadata=print`), 320 px wide | a frame changes with a scene score of at least `TEMPORAL_JUMP_SCORE` (0.45): a single shot that jumps has a stray cut, a pop or a morph |
| **Physics** | the judge call already made for identity also scores each frame for physical plausibility (0–1: anatomy, contact with the ground, gravity, objects keeping shape and number) with issues | the lowest frame score is below `consistency.qualityThreshold` (0.5) |
| **Continuity** | the same call compares the frames with the scene reference frame (place, light, weather, palette) | never (advisory: shown on the take, read by feedback) |
| **Cast in frame** | the same call is told who must not be in the shot (`absent`: the clip's cast who are not in it, with how they look) and lists any it sees (`extras`), and any other person or animal that is not in the cast (`others`) | a cast member who is not in the shot is in a frame; with `consistency.castOnly` (a film with only its cast, off by default) any other person or animal too. Otherwise other figures are reported |
| **Shown twice** | the same call lists anyone or anything shown twice in a frame that should appear once, a see-through ghost of a figure included (`duplicates`: "a second Rosie", "two beach balls") | anything is shown twice. The swimming film's first export passed takes with a second Rosie popping in, two swim boards and ghost double exposures: the judge saw those frames (its three samples are the feedback's), but had nowhere to say so |
| **Sound** (takes with a sound track, when an [audio-visual model](settings.md) is set) | the `sound.check` task watches the take with its sound (360p, mono) and writes down what is said (the words, which character, the voice, lip sync), whether music plays and what else is heard; `soundVerdict` (shared) compares the words with the shot's lines | a line of the shot is not heard: fewer than `LINE_HEARD_RATIO` (0.6) of its words. Music in a take when `consistency.rejectMusic` is on (each retry is a paid take). Advisory: a line in another character's voice, speech in a shot without lines, music in a take otherwise (the film's score comes later), lips out of sync, a sound score below 0.5 |

**Cast only.** The panda demo's brief said "only these two characters appear", yet Wan widened late in a take and a
red-haired girl, a bear and a dog creature walked in (the judge saw them at 85 % and reported them). With
`consistency.castOnly` such a frame fails like an extra cast member, so the take is made again. The project settings
show it under *Continuity and quality* ("Only the cast may appear"); feedback may recommend it (`settings` action).
The writer turns it on when the brief asks for it: `screenplay.generate` answers `castOnly: true` when the brief says
nobody but its characters appears on screen (in any language), and the job sets the setting with the screenplay (it
never turns it off; the settings toggle does). The screenplay review, the storyboard and every take are then judged
with it.

**Keyframes too.** With quality checks, a keyframe (and a storyboard frame) is judged for physics and the cast in
frame as well, in the call that checks its identity, and is drawn again when it fails: an extra character or a
broken paw is cheaper to catch in a picture than in the video made from it.

The sound check runs at the same time as the judge, so it adds no time to an attempt. A shot's lines count when the
take carries the voices: dialogue mode `off` with `generation.includeAudio` (the video model voices the lines from the
prompt) and `native`. TTS takes get their lines from the mix, so only music and stray speech are checked there. Without
an audio-visual model, or when its call fails, the take is not held back (`sound: null`).

The take's consistency report records them:

```ts
report.quality = {
  passed: boolean;                         // temporal, physics and sound
  temporal: { jumps: number[]; maxScore: number } | null;   // seconds of the take; null when not measured
  physics: number | null;                  // lowest frame score
  continuity: number | null;               // mean frame score against the scene reference
  extras: string[];                        // cast members seen though the shot is not theirs
  duplicates: string[];                    // anyone or anything shown twice that should appear once
  others: string[];                        // other people or animals seen
  sound: {
    lines: { character: string; line: string; heard: number; speaker: string | null }[];  // heard: share of words
    transcript: string;                    // everything said, as heard
    music: boolean;
    unexpectedSpeech: boolean;             // speech in a shot without lines
    score: number | null;                  // the model's 0–1 for the sound as a whole
  } | null;                                // null: not checked
  issues: string[];
} | null;                                  // null: checks off, or a take from before them
```

Candidates are ranked: identity passed, then quality passed, then score. Metrics:
`rideo_quality_checks_total{check, result}` (`check`: `temporal`, `physics`, `sound`); a quality retry is logged
(`video failed the quality checks`, with the check and the score).

## The panda demo

The October 2026 demo exercises all of it: a ten-minute film of two pandas, Sammy and Rosie, skiing near Mount Fuji,
with dialogue at level `B1` voiced by the video model itself (`generation.includeAudio` on, `dialogue.mode` off: the
lines are in the prompt with their voices, no TTS and no reference audio), version 2 prompts and quality checks, then
[feedback](feedback.md) on the export and a second pass on what it found. What it taught is in
[improvements](../improvements.md).
