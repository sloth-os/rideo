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
- **End state.** Each shot says what its last frame shows (`endState`: positions, poses, what is in hand). The next
  shot's prompts continue from it.
- **Across scenes.** The planner gets the previous scene's last shot (description and end state), so a new scene
  starts where the film is.

**Dialogue fits the shot.** A line must be speakable in its shot: at most `durationSec × WORDS_PER_SECOND` words
(`WORDS_PER_SECOND = 2.2`, about 11 words in 5 s) across the shot's lines. The planner is told the limit;
`fitDialogue` (shared, part of `normalizePlannedShots`) enforces it deterministically: a shot whose lines need more
time is lengthened up to the model's maximum, and lines that still do not fit move to a continuous shot inserted after
it (same description and camera, `continuity: continuous`). Nothing is cut from a line.

## Prompts (version 2)

All of it is compiled by the pure functions of `shared/prompt` from the documents (rule R3), so the same inputs give
the same text.

**The scene line.** Every shot of a scene starts with the same line built from the scene: `Scene: <location>,
<time of day>; <continuity>.` The location and the light no longer depend on each shot's description remembering
them.

**Continuing the previous shot.** A cut inside a scene whose previous shot has an end state adds `Continues from the
previous shot: <end state>.`; a continuous shot starts from the previous last frame as before (R5).

**Who is in frame.** A shot that shows only part of its clip's cast says so after its characters: `In frame: only
Rosie; Sammy is out of frame.` (or `No characters in frame.` for a shot of none). The scene reference frame shows the
whole cast, and a single often names the one it looks at ("her eyeline is toward Sammy"): in the panda demo the image
model put Sammy into Rosie's close-up twice before the line was added. Like the scene reference, the line comes from
the shot's neighbours, so the board's prompt hash leaves it out.

**Video prompt blocks.** Following the prompt guides of current video models (Wan 3.0, Veo, Kling), the video prompt
is a sequence of short blocks; a model given a first frame needs motion, story and sound more than a description of
what it already sees:

```
<style header> <scene line>
One continuous shot, no cuts. <description>. Action: <action>. <continues from …>
Camera: <framing>, <move>; <lens>.
Characters: <compact identity: name, who they are, what they wear> …  In frame: only <names>; <others> out of frame.
Dialogue: Sammy says, in a warm, bright young male voice: "We did it!" Lip sync.      | No dialogue.
Sound: only the voices and the natural sounds of the place and the action; no music, no song, no humming.
Physics: real weight, gravity and momentum; bodies, feet and equipment keep contact with the ground; objects keep their shape and number.
Avoid: <exclusions>.
```

- **Voices.** A line names its speaker and the speaker's voice (`voice.description`, else "a <age> <gender> voice"
  from the identity), the same words every time, so a model that voices the lines itself (`include_audio` without
  reference audio, [dialogue](dialogue.md#from-lines-to-audio)) keeps each character sounding alike.
- **No dialogue.** A shot without lines says `No dialogue.`, otherwise models that render sound invent speech.
- **Music.** Unless `settings.generation.modelMusic` is on, the sound is `only the voices and the natural sounds of the
  place and the action; no music, no song, no humming`: a 5-second shot with its own music makes the cut jump from
  song to song; the score is laid on the Music track ([post audio](post-audio.md)). With the earlier `no background
  music`, Wan 3.0 still put music under 2 of the panda demo's 6 pilot takes (the sound check hears it); saying what
  the sound is, not only what it is not, follows its prompt guide.
- **Exclusions in the text.** Some models (Wan 3.0) have no negative prompt field, so the last block lists the
  exclusions; the `negative_prompt` parameter still carries them for models that do.

**Keyframe prompt.** The still keeps the full identity fragments (they condition the face) and adds the scene line,
the continuation and the exclusions; it has no dialogue, sound or physics blocks.

**Negative prompt.** `BASE_NEGATIVE_V2` = `BASE_NEGATIVE` + `morphing, warping, flicker, extra or missing limbs,
floating objects, sliding feet, objects passing through each other, sudden lighting change, jump cut`, plus the shot's
own negative prompt, cut at 500 characters (the limit of Wan models).

**Prompt rewriting.** Some providers rewrite prompts with their own LLM (Wan's `prompt_extend`, on by default), which
can change a line of dialogue or drop a continuity detail. `settings.generation.enhancePrompt` sends the gateway's
`enhance_prompt` (`null`, the default, leaves the provider's default).

## Scene reference frame

Shots of a scene are generated in parallel, so a shot cannot wait for its neighbour. With version 2,
`clip.generate` generates the **first shot of a clip first** and the others after it, in parallel; each later
shot's keyframe gets the first shot's selected, acceptable keyframe (or its first frame) as one more image input,
named in the prompt: *"The last image is the scene reference: match its place, light, weather and colours, not its
composition or people."* It is added when the image model accepts at least three input images and the shot's
references leave a slot (or the model's limit is unknown). Video requests do not get it: the keyframe is their first
frame already.

## Quality checks in the gate

With `settings.consistency.qualityChecks` (on for new projects), every video attempt is also checked for what an
identity check misses. The checks retry an attempt like an identity failure, but they never block a clip: when every
attempt fails them, the best take that passed identity is kept, marked with what failed.

| Check | How | Fails the attempt when |
|---|---|---|
| **Temporal** (inside the shot) | ffmpeg scene scores of the raw take (`select='gt(scene,0.25)'` + `metadata=print`), 320 px wide | a frame changes with a scene score of at least `TEMPORAL_JUMP_SCORE` (0.45): a single shot that jumps has a stray cut, a pop or a morph |
| **Physics** | the judge call already made for identity also scores each frame for physical plausibility (0–1: anatomy, contact with the ground, gravity, objects keeping shape and number) with issues | the lowest frame score is below `consistency.qualityThreshold` (0.5) |
| **Continuity** | the same call compares the frames with the scene reference frame (place, light, weather, palette) | never (advisory: shown on the take, read by feedback) |
| **Cast in frame** | the same call is told who must not be in the shot (`absent`: the clip's cast who are not in it, with how they look) and lists any it sees (`extras`), and any other person or animal that is not in the cast (`others`) | a cast member who is not in the shot is in a frame. Other figures are reported |
| **Sound** (takes with a sound track, when an [audio-visual model](settings.md) is set) | the `sound.check` task watches the take with its sound (360p, mono) and writes down what is said (the words, which character, the voice, lip sync), whether music plays and what else is heard; `soundVerdict` (shared) compares the words with the shot's lines | a line of the shot is not heard: fewer than `LINE_HEARD_RATIO` (0.6) of its words. Advisory: a line in another character's voice, speech in a shot without lines, music in a take (the film's score comes later), lips out of sync, a sound score below 0.5 |

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
