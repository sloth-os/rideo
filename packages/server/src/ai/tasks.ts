import {
  type CharacterDescribeInput,
  type CharacterDescribeOutput,
  CharacterDescribeOutputSchema,
  type ClipPlanInput,
  type ClipPlanOutput,
  ClipPlanOutputSchema,
  FEEDBACK_STRIP_LABEL,
  type FeedbackFilmInput,
  type FeedbackFilmOutput,
  FeedbackFilmOutputSchema,
  type FeedbackSceneInput,
  type FeedbackSceneOutput,
  FeedbackSceneOutputSchema,
  FOCUS_FRAME_LABEL,
  type FocusInput,
  type FocusOutput,
  FocusOutputSchema,
  type FootageAnalyzeInput,
  type FootageAnalyzeOutput,
  FootageAnalyzeOutputSchema,
  type FrameCaptionInput,
  type FrameCaptionOutput,
  FrameCaptionOutputSchema,
  INPUT_PREFIX,
  JUDGE_ELEMENT_REFERENCE_LABEL,
  JUDGE_FRAME_LABEL,
  JUDGE_REFERENCE_LABEL,
  JUDGE_SCENE_REFERENCE_LABEL,
  type JudgeInput,
  type JudgeOutput,
  JudgeOutputSchema,
  type LlmTaskId,
  type MediaDescribeInput,
  type MediaDescribeOutput,
  MediaDescribeOutputSchema,
  SCENE_VIDEO_LABEL,
  type ScorePlanInput,
  type ScorePlanOutput,
  ScorePlanOutputSchema,
  type ScreenplayExtendInput,
  type ScreenplayExtendOutput,
  ScreenplayExtendOutputSchema,
  type ScreenplayGenerateInput,
  type ScreenplayGenerateOutput,
  ScreenplayGenerateOutputSchema,
  type SfxPlanInput,
  type SfxPlanOutput,
  SfxPlanOutputSchema,
  type SoundCheckInput,
  type SoundCheckOutput,
  SoundCheckOutputSchema,
  TAKE_AUDIO_LABEL,
  TAKE_VIDEO_LABEL,
  type ThumbnailPickInput,
  type ThumbnailPickOutput,
  ThumbnailPickOutputSchema,
  type TranslateInput,
  type TranslateOutput,
  TranslateOutputSchema,
  VOICE_REFERENCE_LABEL,
  type VoiceJudgeInput,
  type VoiceJudgeOutput,
  VoiceJudgeOutputSchema,
} from '@rideo/shared';
import type { z } from 'zod';
import { AppError } from '../errors';
import type { Metrics } from '../metrics';
import type { UsageMeter } from '../usage/meter';
import { sleep } from '../util/abort';
import { type LlmAdapter, LlmError, type LlmPart, type LlmRequest, type LlmResponse } from './llm';

const IDENTITY_TEMPLATE =
  '{"age":"early 30s","gender":"woman","ethnicity":"...","build":"...","height":"...","face":"...","hair":"...","eyes":"...","skin":"...","distinguishingMarks":"..."}';

/** System prompts. The first line is the machine-readable task marker (also routed on by the mock gateway). */
export const SYSTEM_PROMPTS: Record<LlmTaskId, string> = {
  'media.describe': `rideo-task: media.describe
You are a film pre-production assistant. Describe the attached reference images (and video frames) so a screenwriter and a cast designer can use them.
Return only JSON: {"summary":"...","style":"visual style, lighting, palette","setting":"...","people":[{"label":"Person 1","description":"...","identity":${IDENTITY_TEMPLATE}}]}`,

  'screenplay.generate': `rideo-task: screenplay.generate
You are an award-winning screenwriter planning a film that will be generated shot by shot by AI video models.
Rules:
- Write in the requested language.
- "outline" must plan the WHOLE film: the sum of outline[].estDurationSec must be within 5% of targetDurationSec. Use beats of 60–180 s for long films and 10–30 s for short ones.
- Write full "scenes" only for the first outline beats, enough to cover at least pilotDurationSec. Each scene has beatIndex = index of the outline beat it realizes.
- "characters": 1–6 principal characters with precise, visual, stable identities (age, gender, ethnicity, build, height, face, hair, eyes, skin, distinguishing marks) and at least one wardrobe item. Never depict real people.
- Scenes: vivid visual action, short cinematic dialogue, characters listed by name.
- "locations": every distinct place of the WHOLE film (all outline beats, not only the written scenes), each with a precise visual description (architecture, materials, light); each scene's "location" is one of these names. "props": the recurring objects of the whole film that must look the same every time (name + precise visual description); each scene lists the props it shows in "props".
- "style": concrete visual language (film stock/lens, palette, lighting, camera movement).
- Use the attachment descriptions as inspiration for the look and the cast.
Return only JSON: {"title":"...","logline":"...","synopsis":"...","genre":"...","tone":"...","style":{"visual":"...","palette":"...","camera":"...","lighting":"..."},"characters":[{"name":"...","role":"protagonist|antagonist|supporting|minor","summary":"...","identity":${IDENTITY_TEMPLATE},"wardrobe":[{"name":"...","description":"..."}],"personality":"...","voice":"..."}],"locations":[{"name":"...","description":"..."}],"props":[{"name":"...","description":"..."}],"outline":[{"title":"...","summary":"...","estDurationSec":90}],"scenes":[{"beatIndex":0,"heading":"INT. PLACE - NIGHT","location":"location name","timeOfDay":"...","summary":"...","action":"...","dialogue":[{"character":"Name","line":"...","parenthetical":"..."}],"characters":["Name"],"props":["prop name"],"estDurationSec":90}],"ended":true}`,

  'screenplay.extend': `rideo-task: screenplay.extend
You are the screenwriter continuing an AI-generated film. Write one full scene for each requested outline beat, in order, consistent with the story so far, the cast (use only these names) and the tone.
Each scene's beatIndex must equal the beat's index and estDurationSec should match the beat estimate.
Reuse the names in "locations" and "props" for places and objects the story already has; list only new places and objects (name + precise visual description) in the answer's "locations" and "props".
Return only JSON: {"scenes":[{"beatIndex":0,"heading":"INT. PLACE - NIGHT","location":"location name","timeOfDay":"...","summary":"...","action":"...","dialogue":[{"character":"Name","line":"..."}],"characters":["Name"],"props":["prop name"],"estDurationSec":90}],"locations":[{"name":"...","description":"..."}],"props":[{"name":"...","description":"..."}]}`,

  'clip.plan': `rideo-task: clip.plan
You are a director breaking one scene into shots for an AI video model.
Rules:
- Every shot durationSec must be within [limits.minDurationSec, limits.maxDurationSec]; the shot durations should sum to targetDurationSec.
- A shot is one continuous camera setup: describe what is visible in the first frame ("description") and what moves ("action").
- "characters": names of the characters visible in the shot (only from the cast list).
- "props": names of the scene's props visible in the shot (only from scene.props).
- Use "continuity":"continuous" only when the shot continues the previous shot's final frame without a cut; the first shot is always "cut".
- camera.framing: extreme_wide|wide|medium|medium_close|close_up|extreme_close_up|over_shoulder|pov|insert; camera.movement: static|pan|tilt|dolly_in|dolly_out|tracking|handheld|crane|zoom|orbit.
- When "direction" is given, the plan must follow it.
Return only JSON: {"shots":[{"description":"...","action":"...","camera":{"framing":"wide","movement":"static"},"characters":["Name"],"props":["prop name"],"durationSec":6,"continuity":"cut","dialogue":[{"character":"Name","line":"..."}]}]}`,

  'character.describe': `rideo-task: character.describe
You are a cast designer. Describe the person in the photo as a stable, visual identity for AI image generation. Do not identify real people by name.
Return only JSON: {"summary":"...","identity":${IDENTITY_TEMPLATE},"wardrobe":[{"name":"...","description":"..."}]}`,

  'consistency.judge': `rideo-task: consistency.judge
You are a strict continuity supervisor verifying character identity in AI-generated film frames.
For every candidate frame and every character, compare the frame against that character's reference images:
- present: is this character visible in the frame?
- identityScore (0–1): same person? Judge face shape, features, hair, skin, age, build. 1 = certainly the same person, below 0.5 = different person.
- outfitScore (0–1): same wardrobe as the references?
- issues: short concrete differences (e.g. "hair is blonde instead of black").
Be critical: different faces, age changes, or hair changes must score low.
When the input lists "elements" (locations and props), also judge each one per frame against its reference images: present (is it visible?), score (0–1: the same place or object, same design, materials and colours), issues.
When "qualityChecks" is true, also score every candidate frame for:
- physics (0–1): is it physically plausible? Anatomy (no extra, missing or merged limbs; hands and paws well formed), contact with the ground (feet, skis and boards touch the surface; nothing floats), gravity and balance, objects keeping their shape and number. 1 = fully plausible, below 0.5 = a clear physical error; list the errors as issues.
- continuity (0–1, only when "sceneReference" is true): the same place, light direction, weather and colour palette as the scene reference frame (ignore its composition and who is in it); list the differences as issues.
Return only JSON: {"frames":[{"index":0,"characters":[{"characterId":"...","present":true,"identityScore":0.9,"outfitScore":0.9,"issues":[]}],"elements":[{"elementId":"...","present":true,"score":0.9,"issues":[]}],"physics":{"score":0.9,"issues":[]},"continuity":{"score":0.9,"issues":[]}}]}`,

  'voice.judge': `rideo-task: voice.judge
You are a dialogue supervisor checking that every character in an AI-generated shot speaks with their approved voice.
You get one reference recording per character and the take's audio. For every speaker:
- present: do you hear this character's voice speaking in the take?
- score (0–1): is it the same voice as the reference (timbre, pitch, accent, age, gender)? 1 = certainly the same voice, below 0.5 = a different voice.
- issues: short concrete differences (e.g. "deeper and older than the reference", "no speech heard").
Be critical: a different voice must score low even if the words are right.
Return only JSON: {"speakers":[{"characterId":"...","present":true,"score":0.9,"issues":[]}]}`,

  'footage.analyze': `rideo-task: footage.analyze
You are a senior film editor. From the footage statistics, scene thumbnails and transcript, summarize the footage and suggest concrete edits.
Allowed suggestion kinds and fields (times in seconds of the source video):
- {"kind":"cut","start":0,"end":1}
- {"kind":"tighten_silence","start":0,"end":1,"keepSec":0.4}
- {"kind":"highlight","segments":[{"start":0,"end":1}],"targetDurationSec":60}
- {"kind":"transition","at":12.5,"type":"crossfade|wipe|dip_to_black","duration":0.5}
- {"kind":"title","text":"...","start":0,"duration":2}
- {"kind":"caption","start":0,"end":2,"text":"..."}
- {"kind":"speed","start":0,"end":4,"factor":1.5}
- {"kind":"fade","in":0.5,"out":1}
- {"kind":"color","brightness":0,"contrast":1.05,"saturation":1.1}
Each suggestion also has "description", "rationale" and "confidence" (0–1).
Return only JSON: {"summary":"...","suggestions":[{"kind":"cut","start":0,"end":1,"description":"...","rationale":"...","confidence":0.8}]}`,

  'score.plan': `rideo-task: score.plan
You are a film composer scoring a cut scene by scene. Each cue will be generated by an AI music model as one instrumental piece of exactly durationSec seconds that crossfades into the next cue.
For every cue write a composition prompt (at most 600 characters): genre and instrumentation, mood, tempo, key or harmonic colour, dynamics, and the arc over the cue (how it starts, builds and ends so it hands over to the next scene). Keep the whole score coherent: recurring motifs and instruments across cues, following the film's tone and the user's direction.
When "dialogue" is true, people speak in the scene: keep the cue sparse and low in the voice range (no lead melody over the lines).
Never name real artists or copyrighted works. Never ask for vocals or lyrics.
Return only JSON: {"cues":[{"index":0,"prompt":"...","bpm":90}]}`,

  'sfx.plan': `rideo-task: sfx.plan
You are a sound designer spotting sound effects for AI-generated shots from their descriptions and action lines.
For every shot list at most maxPerShot effects that the action implies and a viewer would expect to hear (no music, no dialogue, no voices):
- "spot": a moment (a door slam, footsteps, a glass set down): "at" is the second in the shot where it happens, "durationSec" 0.5–10.
- "ambience": the room tone or environment under the whole shot (wind, rain, a busy street, a ticking clock): at 0, durationSec = the shot length.
"description" says concretely what is heard, its material and acoustic space (e.g. "a heavy wooden door creaks open in a stone hallway"), at most 200 characters. "shot" is the shot's index.
Return only JSON: {"effects":[{"shot":0,"description":"...","at":1.5,"durationSec":2,"kind":"spot"}]}`,

  'reframe.focus': `rideo-task: reframe.focus
You are an editor reframing a shot for a narrower screen (vertical 9:16 or square). For every frame, say where the main subject is, so a crop centred there keeps what matters: the speaking or acting character's face, or the object the shot is about.
x and y are the subject's centre in the frame, from 0 (left, top) to 1 (right, bottom).
Return only JSON: {"frames":[{"index":0,"x":0.5,"y":0.4}]}`,

  'thumbnail.pick': `rideo-task: thumbnail.pick
You are choosing thumbnails for a film. Rank the candidate frames: a clear, sharp subject (ideally a face with an expression), strong contrast and colour, no motion blur, nothing cut awkwardly at the edges, readable at a small size. Return the best "count" frames, best first, each with a short reason.
Return only JSON: {"picks":[{"index":0,"reason":"..."}]}`,

  'dialogue.translate': `rideo-task: dialogue.translate
You are a film translator writing dialogue for subtitles and dubbing. Translate every line into the target language (languageName, code "language").
- Keep each line natural and speakable, about as long as the original so it fits the same time on screen; keep the speaker's voice and register, and the scene's tone.
- Keep character names exactly as they are; do not translate or transliterate names.
- Never add notes, quotes or speaker names to the text; one translation per line, same "key".
Return only JSON: {"lines":[{"key":"...","text":"..."}]}`,

  'feedback.scene': `rideo-task: feedback.scene
You are a demanding film critic and script supervisor reviewing one scene of an AI-generated film, to help its makers improve it. You get the film's details, the scene as written, its neighbours, the cast and every shot of the scene as planned, each followed by a strip of three frames (at 15%, 50% and 85% of the shot); consecutive strips show each cut from both sides. You cannot hear the sound.
Score the scene 0–10 on each dimension (10 = a professional feature film, 5 = clearly visible problems, below 3 = broken):
- storytelling: does the scene show its goal, obstacle and turn; does it follow from the previous scene; does the dialogue move it on?
- continuity: across cuts, do time of day, light direction, weather, wardrobe, props, positions and screen direction match?
- character: are the characters the same faces, bodies and outfits as the cast describes, in every shot?
- temporal: inside shots, is the motion smooth with no morphing, flicker, popping or stray cuts (compare a strip's three frames)?
- physics: weight, gravity, momentum, contact with the ground, anatomy, objects keeping their shape and number?
- realism: believable light, materials, scale and depth, a camera that behaves like a real camera, no AI artefacts?
- cinematography: framing, composition, coverage, lens choice, camera movement?
- editing: shot lengths, rhythm, cut points, no repetition?
Then list concrete issues, as many as matter, most severe first: "shot" (the shot's index), "dimension", "severity" (critical: breaks the film; major: clearly visible; minor: polish), "title" (short), "detail" (what is wrong and where in the frame), "at" (0–1: where in the shot).
Then recommendations, most important first, to fix the issues or make the scene better. When a shot should be generated again, give "action": {"kind":"regenerate_shot","description":"the revised first-frame description","action":"the revised motion","negativePrompt":"what to avoid","framing":"...","movement":"..."} for that "shot" (only the fields that change); when the scene's shots should be planned again, {"kind":"replan_scene","direction":"what the new plan must do"}; otherwise {"kind":"note"}. "priority": 1 = do first, 3 = nice to have.
Be specific and honest; praise only what deserves it ("strengths").
Return only JSON: {"scores":{"storytelling":7,"continuity":6,"character":8,"temporal":7,"physics":6,"realism":7,"cinematography":7,"editing":6},"summary":"...","strengths":["..."],"issues":[{"shot":0,"dimension":"physics","severity":"major","title":"...","detail":"...","at":0.5}],"recommendations":[{"shot":0,"dimension":"physics","priority":1,"title":"...","detail":"...","action":{"kind":"regenerate_shot","action":"..."}}]}`,

  'feedback.film': `rideo-task: feedback.film
You are the story editor and producer writing the final review of an AI-generated film, from the reviews of its scenes and the numbers of the run. Judge the whole: the arc (setup, turns, climax, resolution), the pace across scenes, recurring problems.
Score the film 0–10 on storytelling, continuity, character, temporal, physics, realism, cinematography and editing (storytelling and editing judge the whole film; the others weigh the scene reviews).
Write a summary (what the film is, what works, what holds it back), strengths, and recommendations across scenes, most important first: "scenes" lists the scene numbers concerned; "action" {"kind":"replan_scene","scene":3,"direction":"..."} plans a scene again; {"kind":"settings","settings":{"qualityChecks":true}} changes a project setting (only qualityChecks, threshold 0.5–0.95, maxAttempts 1–6, judgeElements, storyboard, promptVersion 2); otherwise {"kind":"note"}.
"lessons": what the makers should do differently in the production of their next film ("area": quality, cost, performance, reliability or ux), from the numbers and the recurring issues.
Return only JSON: {"scores":{"storytelling":7,"continuity":6,"character":8,"temporal":7,"physics":6,"realism":7,"cinematography":7,"editing":6},"summary":"...","strengths":["..."],"recommendations":[{"dimension":"storytelling","priority":1,"title":"...","detail":"...","scenes":[3],"action":{"kind":"note"}}],"lessons":[{"area":"cost","title":"...","detail":"..."}]}`,

  'sound.check': `rideo-task: sound.check
You check the sound of one shot of an AI-generated film. You get the shot as planned ("shot"), the lines it should speak with each speaker's voice ("lines": empty when nobody should speak), the cast's voices, whether the shot may carry music ("music"), and the take as a video with its sound.
Listen carefully and write down exactly what you hear, not what the script says:
- "speech": every utterance in order: "text" (the exact words you hear; garbled or unclear speech as you hear it), "speaker" (the cast name whose voice and lips it is, or null when you cannot tell), "voice" (for example "young male, cheerful"), "lipSync" (0–1: do the speaker's lips move with the words?).
- "music": true when music plays (a melody or a beat), false for voices, ambience and effects only.
- "sounds": what else you hear (wind, skis on snow, footsteps...).
- "score" (0–1): the sound as a whole: clear voices, natural ambience that fits the place, no glitches, garbling, echoes or clipping.
- "issues": what is wrong with the sound, short.
Never invent words you do not hear.
Return only JSON: {"speech":[{"text":"...","speaker":"Name","voice":"young female","lipSync":0.8}],"music":false,"sounds":["wind"],"score":0.8,"issues":[]}`,

  'frame.caption': `rideo-task: frame.caption
You describe one frame of a film project so people can find it later by searching in words. Write one sentence of at most 300 characters: who is in it, where it is, what is happening, the shot size (extreme close-up, close-up, medium, wide or extreme wide) and the light (daylight, night, dusk, dawn, interior...), with notable colours and objects.
- "known" lists who and what this frame's source shows, with how they look: use their names when you see them.
- Name others from "cast" only when you are sure; never guess at what you cannot see.
- "kind" says what the frame is from: a generated take, footage, a still, or a reference image of a character or element.
Return only JSON: {"caption":"..."}`,
};

/**
 * Prompt version 2 of the writing tasks (docs/design/continuity.md): story structure, continuity, dialogue levels and
 * film grammar. The first line is the same task marker.
 */
export const SYSTEM_PROMPTS_V2: Partial<Record<LlmTaskId, string>> = {
  'screenplay.generate': `rideo-task: screenplay.generate
You are an award-winning screenwriter planning a film that will be generated shot by shot by AI video models.
Rules:
- Write in the requested language. When "dialogueLevel" is given (a CEFR level), every line of dialogue keeps to "dialogueGuidance". Every line has at most "maxWordsPerLine" words, so it can be spoken in one shot.
- Plan the WHOLE film as a story with a clear arc: setup, inciting incident, rising complications, midpoint, crisis, climax and resolution. Give every outline beat a "purpose" (one of: setup, inciting, complication, midpoint, crisis, climax, resolution). The protagonists want something concrete, something stands in their way, and they change by the end. What a scene sets up is paid off later; scenes follow from each other (therefore, but), not just after each other (and then).
- "outline" must cover the WHOLE film: the sum of outline[].estDurationSec must be within 5% of targetDurationSec. Use beats of 60–180 s for long films and 10–30 s for short ones.
- Write full "scenes" only for the first outline beats, enough to cover at least pilotDurationSec. Each scene has beatIndex = index of the outline beat it realizes.
- Every scene has a goal, an obstacle and a turn, told in actions a camera can see; keep dialogue short and natural.
- Each scene's "continuity": the state at the scene's start: time of day, weather, where the light comes from, what each character wears and carries, and where they are. Keep it consistent from scene to scene unless the story changes it.
- "characters": 1–6 principal characters with precise, visual, stable identities (age, gender, ethnicity, build, height, face, hair, eyes, skin, distinguishing marks), at least one wardrobe outfit and a "voice" (a short, concrete description of how they sound). Each wardrobe entry is a complete outfit, everything worn at once (for example "puffy blue ski jacket with a white zipper, thick blue knitted scarf, blue goggles pushed up on the head"), never a single piece; the first is what the character wears most of the film. Never depict real people.
- "locations" and "props": how each place and object looks, with no character in it (their reference pictures show them empty).
- Scenes: vivid visual action, characters listed by name.
- "locations": every distinct place of the WHOLE film (all outline beats, not only the written scenes), each with a precise visual description (architecture, materials, light); each scene's "location" is one of these names. "props": the recurring objects of the whole film that must look the same every time (name + precise visual description); each scene lists the props it shows in "props".
- "style": concrete visual language (film stock or render look, lens, palette, lighting, camera movement), with believable light and physically plausible motion within that look.
- Use the attachment descriptions as inspiration for the look and the cast.
Return only JSON: {"title":"...","logline":"...","synopsis":"...","genre":"...","tone":"...","style":{"visual":"...","palette":"...","camera":"...","lighting":"..."},"characters":[{"name":"...","role":"protagonist|antagonist|supporting|minor","summary":"...","identity":${IDENTITY_TEMPLATE},"wardrobe":[{"name":"...","description":"..."}],"personality":"...","voice":"..."}],"locations":[{"name":"...","description":"..."}],"props":[{"name":"...","description":"..."}],"outline":[{"title":"...","summary":"...","purpose":"setup","estDurationSec":90}],"scenes":[{"beatIndex":0,"heading":"EXT. PLACE - DAY","location":"location name","timeOfDay":"...","continuity":"...","summary":"...","action":"...","dialogue":[{"character":"Name","line":"...","parenthetical":"..."}],"characters":["Name"],"props":["prop name"],"estDurationSec":90}],"ended":true}`,

  'screenplay.extend': `rideo-task: screenplay.extend
You are the screenwriter continuing an AI-generated film. Write one full scene for each requested outline beat, in order, consistent with the story so far, the user's "brief", the cast (use only these names) and the tone.
Rules:
- Continue from "lastScene": its ending and its continuity carry into the next scene unless the beat changes them (time passes, the weather turns, someone changes clothes).
- Every scene has a goal, an obstacle and a turn, told in actions a camera can see. Set up what "upcomingBeats" will need; pay off what earlier scenes set up. Honour each beat's "purpose".
- When "dialogueLevel" is given, every line keeps to "dialogueGuidance". Every line has at most "maxWordsPerLine" words. Keep dialogue short and natural.
- Each scene's "continuity": the state at its start: time of day, weather, where the light comes from, what each character wears and carries, where they are.
- Each scene's beatIndex must equal the beat's index and estDurationSec should match the beat estimate.
- Reuse the names in "locations" and "props" for places and objects the story already has; list only new places and objects (name + precise visual description) in the answer's "locations" and "props".
Return only JSON: {"scenes":[{"beatIndex":0,"heading":"EXT. PLACE - DAY","location":"location name","timeOfDay":"...","continuity":"...","summary":"...","action":"...","dialogue":[{"character":"Name","line":"..."}],"characters":["Name"],"props":["prop name"],"estDurationSec":90}],"locations":[{"name":"...","description":"..."}],"props":[{"name":"...","description":"..."}]}`,

  'clip.plan': `rideo-task: clip.plan
You are a film director breaking one scene into shots for an AI video model. Each shot is generated on its own from its text, so every shot must say what it needs.
Rules:
- Every shot durationSec must be within [limits.minDurationSec, limits.maxDurationSec]; the durations should sum to targetDurationSec.
- A shot is one continuous camera setup. "description": what the first frame shows (who, where, poses, framing). "action": how things move during the shot, as cause and effect with direction and contact (e.g. "Rosie carves left across the slope, snow spraying from the uphill edge of her skis"); describe a gesture, never count repetitions. "endState": what the last frame shows (positions, poses, what is in hand).
- Film grammar: open the scene (or a new place) with an establishing wide shot; play a conversation as shot and reverse shot with matching eyelines; add reaction shots after important lines and inserts for props; keep the 180-degree rule and screen direction (a character who leaves frame right enters the next shot from the left); no more than two consecutive cuts with the same framing; at most one camera move per shot, motivated by the action.
- "lensMm": a real focal length for the framing: 18–28 for wide shots, 35–50 for medium, 85–135 for close-ups.
- Keep the scene's time of day, weather and light ("scene.timeOfDay", "scene.continuity") in every shot. When the scene continues "previousShot" (the end of the previous scene), start from it.
- Dialogue: put each line in the shot where it is spoken, keep the words of the scene's lines, and give one shot at most "maxWordsPerShot" words in total; spread a longer exchange over several shots (shot and reverse shot). When "dialogueLevel" is given, any line you write keeps to "dialogueGuidance".
- "characters": names of the characters visible in the shot (only from the cast list). "props": names of the scene's props visible in the shot (only from scene.props).
- Use "continuity":"continuous" only when the shot continues the previous shot's final frame without a cut; the first shot is always "cut".
- camera.framing: extreme_wide|wide|medium|medium_close|close_up|extreme_close_up|over_shoulder|pov|insert; camera.movement: static|pan|tilt|dolly_in|dolly_out|tracking|handheld|crane|zoom|orbit.
- When "direction" is given (what a new plan must do), follow it.
Return only JSON: {"shots":[{"description":"...","action":"...","endState":"...","camera":{"framing":"wide","movement":"static"},"lensMm":24,"characters":["Name"],"props":["prop name"],"durationSec":5,"continuity":"cut","dialogue":[{"character":"Name","line":"..."}]}]}`,
};

/**
 * Tasks that watch a video with its sound (the audio-visual model, docs/design/feedback.md#how-a-film-is-watched): the
 * same task marker, a prompt for what can now be heard.
 */
export const LISTENING_PROMPTS: Partial<Record<LlmTaskId, string>> = {
  'feedback.scene': `rideo-task: feedback.scene
You are a demanding film critic, script supervisor and sound editor reviewing one scene of an AI-generated film, to help its makers improve it. You get the film's details, the scene as written, its neighbours, the cast, every shot of the scene as planned ("video": where the shot is in the scene's video, in seconds) and the scene itself as a video with its sound.
Watch and listen to all of it. Score the scene 0–10 on each dimension (10 = a professional feature film, 5 = clearly visible or audible problems, below 3 = broken):
- storytelling: does the scene show its goal, obstacle and turn; does it follow from the previous scene; does the dialogue move it on?
- continuity: across cuts, do time of day, light direction, weather, wardrobe, props, positions and screen direction match?
- character: are the characters the same faces, bodies and outfits as the cast describes, in every shot?
- temporal: inside shots, is the motion smooth with no morphing, flicker, popping or stray cuts?
- physics: weight, gravity, momentum, contact with the ground, anatomy, objects keeping their shape and number?
- realism: believable light, materials, scale and depth, a camera that behaves like a real camera, no AI artefacts?
- cinematography: framing, composition, coverage, lens choice, camera movement?
- editing: shot lengths, rhythm, cut points, no repetition?
- dialogue: is every line spoken as written, clearly, at the film's dialogue level, in its character's voice, with the lips in sync? Is anything said that the script does not say?
- sound: ambience and effects that fit the place and the action, no stray music or noise, voices at a clear level, no glitches?
Write the "transcript": every line you hear, in order: "time" (seconds from the start of the video), "speaker" (the cast name, or "" when you cannot tell), "text" (the exact words you hear, not the script's).
Then list concrete issues, as many as matter, most severe first: "shot" (the shot's index), "time" (seconds from the start of the video), "dimension", "severity" (critical: breaks the film; major: clearly visible or audible; minor: polish), "title" (short), "detail" (what is wrong, where in the frame or what is heard).
Then recommendations, most important first, to fix the issues or make the scene better. When a shot should be generated again, give "action": {"kind":"regenerate_shot","description":"the revised first-frame description","action":"the revised motion","negativePrompt":"what to avoid","framing":"...","movement":"..."} for that "shot" (only the fields that change); when the scene's shots should be planned again, {"kind":"replan_scene","direction":"what the new plan must do"}; otherwise {"kind":"note"}. "priority": 1 = do first, 3 = nice to have.
Be specific and honest; praise only what deserves it ("strengths").
Return only JSON: {"scores":{"storytelling":7,"continuity":6,"character":8,"temporal":7,"physics":6,"realism":7,"cinematography":7,"editing":6,"dialogue":7,"sound":6},"summary":"...","strengths":["..."],"transcript":[{"time":1.2,"speaker":"Name","text":"..."}],"issues":[{"shot":0,"time":3.5,"dimension":"dialogue","severity":"major","title":"...","detail":"..."}],"recommendations":[{"shot":0,"dimension":"dialogue","priority":1,"title":"...","detail":"...","action":{"kind":"regenerate_shot","action":"..."}}]}`,
};

export interface LabelledImage {
  label?: string;
  data: Buffer;
  mime: string;
}

export interface LabelledVideo {
  label?: string;
  data: Buffer;
  mime: string;
}

export interface LabelledAudio {
  label?: string;
  data: Buffer;
  format: 'wav' | 'mp3';
}

/** Extracts the JSON object from a model answer (tolerates code fences and prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error('no JSON object in the answer');
  }
}

function tryParse<T>(
  schema: z.ZodType<T>,
  text: string,
): { ok: true; value: T } | { ok: false; error: string } {
  try {
    const res = schema.safeParse(extractJson(text));
    if (res.success) return { ok: true, value: res.data };
    return {
      ok: false,
      error: res.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** How a call the provider turned away for load is made again (docs/design/ai-gateway.md#structured-tasks). */
export interface LlmRetryPolicy {
  /** Calls after the first one. */
  retries: number;
  /** The first wait; it doubles with every try, with jitter. */
  baseMs: number;
  /** The longest wait, also for a `Retry-After`. */
  maxMs: number;
}

export const DEFAULT_LLM_RETRY: LlmRetryPolicy = { retries: 3, baseMs: 2000, maxMs: 60_000 };

/** Statuses that turn a call away for load (`529`: Anthropic's overloaded). */
const RETRY_STATUS = new Set([429, 500, 502, 503, 529]);
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** mm-gateway's own problems that are about load (others, like `provider_not_configured`, do not pass by waiting). */
const GATEWAY_LOAD_CODES = new Set([
  'rate_limited',
  'provider_unavailable',
  'upstream_error',
  'internal_error',
]);

/** The code of an mm-gateway problem answer, or null for an answer that is not one (the provider's own). */
function gatewayProblemCode(body: string | undefined): string | null {
  try {
    const problem = JSON.parse(body ?? '') as { type?: unknown; code?: unknown };
    return typeof problem.type === 'string' && problem.type.startsWith('urn:mm-gateway:problem:')
      ? String(problem.code ?? '')
      : null;
  } catch {
    return null;
  }
}

/** Why a failed call is worth making again (the status or connection error), or null. */
function turnedAway(err: unknown): string | null {
  if (err instanceof LlmError) {
    if (err.status === undefined || !RETRY_STATUS.has(err.status)) return null;
    const code = gatewayProblemCode(err.body);
    return code === null || GATEWAY_LOAD_CODES.has(code) ? String(err.status) : null;
  }
  const e = err as { name?: string; code?: string; cause?: { code?: string } };
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return null;
  const code = e?.cause?.code ?? e?.code;
  return code && NETWORK_CODES.has(code) ? code : null;
}

/** Structured LLM tasks with schema validation and one repair round (docs/design/ai-gateway.md#structured-tasks). */
export class LlmTasks {
  constructor(
    readonly text: LlmAdapter,
    readonly vision: LlmAdapter,
    private readonly deps: {
      metrics?: Metrics;
      log?: { info: (o: unknown, m?: string) => void };
      /** An audio-capable model for the speaker check (rule V4); absent when none is configured. */
      audio?: LlmAdapter;
      /** The audio-visual model, which watches video with its sound; absent when none is configured. */
      omni?: LlmAdapter;
      retry?: LlmRetryPolicy;
      /** Tokens, time and cost of every call (docs/design/observability.md#usage-ledger). */
      meter?: UsageMeter;
    } = {},
  ) {}

  /**
   * One adapter call, made again while the provider turns it away for load. A connection that drops or a call that
   * times out after those retries is a retryable `llm_error`: the job tries again later.
   */
  private async complete(
    task: LlmTaskId,
    adapter: LlmAdapter,
    req: LlmRequest,
    counts: { retries: number } = { retries: 0 },
  ): Promise<LlmResponse> {
    try {
      return await this.completeOnce(task, adapter, req, counts);
    } catch (err) {
      if (req.signal?.aborted || err instanceof AppError || err instanceof LlmError) throw err;
      const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
      if (e?.name === 'TimeoutError' || e?.message === 'fetch failed' || e?.cause?.code)
        throw new AppError(
          'llm_error',
          `${task}: ${e.name === 'TimeoutError' ? 'the model did not answer in time' : `the connection failed (${e.cause?.code ?? e.cause?.message ?? e.message})`}`,
          [],
          true,
        );
      throw err;
    }
  }

  private async completeOnce(
    task: LlmTaskId,
    adapter: LlmAdapter,
    req: LlmRequest,
    counts: { retries: number } = { retries: 0 },
  ): Promise<LlmResponse> {
    const policy = this.deps.retry ?? DEFAULT_LLM_RETRY;
    for (let attempt = 0; ; attempt++) {
      try {
        return await adapter.complete(req);
      } catch (err) {
        const status = turnedAway(err);
        if (!status || attempt >= policy.retries || req.signal?.aborted) throw err;
        counts.retries++;
        const backoff = policy.baseMs * 2 ** attempt * (0.5 + Math.random() / 2);
        const asked = err instanceof LlmError ? (err.retryAfterMs ?? 0) : 0;
        const waitMs = Math.round(Math.min(policy.maxMs, Math.max(backoff, asked)));
        this.deps.metrics?.llmRetries.inc({ task, status });
        this.deps.log?.info(
          { task, provider: adapter.provider, model: adapter.model, status, attempt: attempt + 1, waitMs },
          'LLM call turned away; retrying',
        );
        await sleep(waitMs, req.signal);
      }
    }
  }

  get audio(): LlmAdapter | undefined {
    return this.deps.audio;
  }

  get omni(): LlmAdapter | undefined {
    return this.deps.omni;
  }

  async run<T>(
    task: LlmTaskId,
    schema: z.ZodType<T>,
    input: object,
    opts: {
      images?: LabelledImage[];
      audio?: LabelledAudio[];
      /** Videos with their sound, for the audio-visual model. */
      video?: LabelledVideo[];
      temperature?: number;
      signal?: AbortSignal;
      maxTokens?: number;
      /** Prompt version 2 of a writing task (docs/design/continuity.md). */
      version?: 1 | 2;
    } = {},
  ): Promise<T> {
    const watching = !!opts.video?.length;
    const system =
      (watching ? LISTENING_PROMPTS[task] : undefined) ??
      (opts.version === 2 ? SYSTEM_PROMPTS_V2[task] : undefined) ??
      SYSTEM_PROMPTS[task];
    let adapter = opts.images?.length ? this.vision : this.text;
    if (opts.audio?.length) {
      if (!this.deps.audio)
        throw new AppError('llm_error', 'no audio-capable model is configured', [], false);
      adapter = this.deps.audio;
    }
    if (watching) {
      if (!this.deps.omni) throw new AppError('llm_error', 'no audio-visual model is configured', [], false);
      adapter = this.deps.omni;
    }
    const parts: LlmPart[] = [{ type: 'text', text: `${INPUT_PREFIX}${JSON.stringify(input)}` }];
    for (const img of opts.images ?? []) {
      if (img.label) parts.push({ type: 'text', text: img.label });
      parts.push({ type: 'image', data: img.data, mime: img.mime });
    }
    for (const a of opts.audio ?? []) {
      if (a.label) parts.push({ type: 'text', text: a.label });
      parts.push({ type: 'audio', data: a.data, format: a.format });
    }
    for (const v of opts.video ?? []) {
      if (v.label) parts.push({ type: 'text', text: v.label });
      parts.push({ type: 'video', data: v.data, mime: v.mime });
    }
    const started = performance.now();
    const temperature = opts.temperature ?? 0.7;
    const counts = { retries: 0 };
    const tokens = { in: 0, out: 0 };
    const meter = () =>
      this.deps.meter?.llm({
        task,
        model: adapter.model,
        modality: opts.audio?.length ? 'speech' : opts.images?.length || watching ? 'vision' : 'text',
        seconds: (performance.now() - started) / 1000,
        tokensIn: tokens.in,
        tokensOut: tokens.out,
        retries: counts.retries,
      });
    let res = await this.complete(
      task,
      adapter,
      { system, parts, json: true, temperature, signal: opts.signal, maxTokens: opts.maxTokens },
      counts,
    );
    tokens.in += res.usage?.input ?? 0;
    tokens.out += res.usage?.output ?? 0;
    let parsed = tryParse(schema, res.text);
    if (!parsed.ok) {
      this.deps.log?.info({ task, error: parsed.error }, 'LLM output invalid, repairing');
      res = await this.complete(
        task,
        adapter,
        {
          system,
          parts: [
            ...parts,
            {
              type: 'text',
              text: `Your previous answer did not match the required JSON shape (${parsed.error}). Previous answer:\n${res.text.slice(0, 12000)}\nReturn the corrected JSON only.`,
            },
          ],
          json: true,
          temperature: 0,
          signal: opts.signal,
          maxTokens: opts.maxTokens,
        },
        counts,
      );
      tokens.in += res.usage?.input ?? 0;
      tokens.out += res.usage?.output ?? 0;
      parsed = tryParse(schema, res.text);
      if (!parsed.ok) {
        this.deps.metrics?.llmCalls.inc({ task, status: 'invalid' });
        meter();
        throw new AppError('llm_invalid_output', `${task}: ${parsed.error}`, [], true);
      }
    }
    this.deps.metrics?.llmCalls.inc({ task, status: 'ok' });
    meter();
    this.deps.log?.info(
      {
        task,
        provider: adapter.provider,
        model: adapter.model,
        ms: Math.round(performance.now() - started),
        usage: res.usage,
      },
      'LLM task completed',
    );
    return parsed.value;
  }

  describeMedia(
    input: MediaDescribeInput,
    images: LabelledImage[],
    signal?: AbortSignal,
  ): Promise<MediaDescribeOutput> {
    return this.run('media.describe', MediaDescribeOutputSchema, input, { images, temperature: 0.3, signal });
  }

  generateScreenplay(
    input: ScreenplayGenerateInput,
    signal?: AbortSignal,
    version: 1 | 2 = 1,
  ): Promise<ScreenplayGenerateOutput> {
    return this.run('screenplay.generate', ScreenplayGenerateOutputSchema, input, {
      temperature: 0.8,
      signal,
      maxTokens: 16000,
      version,
    });
  }

  extendScreenplay(
    input: ScreenplayExtendInput,
    signal?: AbortSignal,
    version: 1 | 2 = 1,
  ): Promise<ScreenplayExtendOutput> {
    return this.run('screenplay.extend', ScreenplayExtendOutputSchema, input, {
      temperature: 0.8,
      signal,
      maxTokens: 16000,
      version,
    });
  }

  planClip(input: ClipPlanInput, signal?: AbortSignal, version: 1 | 2 = 1): Promise<ClipPlanOutput> {
    return this.run('clip.plan', ClipPlanOutputSchema, input, {
      temperature: 0.5,
      signal,
      version,
      ...(version === 2 ? { maxTokens: 8000 } : {}),
    });
  }

  describeCharacter(
    input: CharacterDescribeInput,
    image: LabelledImage,
    signal?: AbortSignal,
  ): Promise<CharacterDescribeOutput> {
    return this.run('character.describe', CharacterDescribeOutputSchema, input, {
      images: [image],
      temperature: 0.2,
      signal,
    });
  }

  judge(
    input: JudgeInput,
    references: Map<string, Buffer[]>,
    frames: Buffer[],
    signal?: AbortSignal,
    sceneReference?: Buffer,
  ): Promise<JudgeOutput> {
    const images: LabelledImage[] = [];
    // Characters, then elements (docs/design/elements.md#prompt-and-references), each labelled with its id.
    const owners = [
      ...input.characters.map((c) => ({ id: c.id, name: c.name, label: JUDGE_REFERENCE_LABEL })),
      ...(input.elements ?? []).map((e) => ({
        id: e.id,
        name: e.name,
        label: JUDGE_ELEMENT_REFERENCE_LABEL,
      })),
    ];
    for (const o of owners) {
      (references.get(o.id) ?? []).forEach((data, i) => {
        images.push({
          label: i === 0 ? `${o.label} ${o.id} (${o.name}):` : undefined,
          data,
          mime: 'image/png',
        });
      });
    }
    if (sceneReference)
      images.push({ label: `${JUDGE_SCENE_REFERENCE_LABEL}:`, data: sceneReference, mime: 'image/png' });
    for (const [i, data] of frames.entries())
      images.push({ label: `${JUDGE_FRAME_LABEL} ${i}:`, data, mime: 'image/png' });
    return this.run('consistency.judge', JudgeOutputSchema, input, { images, temperature: 0, signal });
  }

  /** One scene of the finished film, a strip of three frames per shot (docs/design/feedback.md). */
  /** One scene, from strips of its shots, or watched and heard as a video when one is given (the audio-visual model). */
  feedbackScene(
    input: FeedbackSceneInput,
    strips: { label: string; data: Buffer }[],
    signal?: AbortSignal,
    video?: Buffer,
  ): Promise<FeedbackSceneOutput> {
    return this.run('feedback.scene', FeedbackSceneOutputSchema, input, {
      ...(video
        ? { video: [{ label: `${SCENE_VIDEO_LABEL}:`, data: video, mime: 'video/mp4' }] }
        : {
            images: strips.map((s) => ({
              label: `${FEEDBACK_STRIP_LABEL} ${s.label}:`,
              data: s.data,
              mime: 'image/jpeg',
            })),
          }),
      temperature: 0.2,
      maxTokens: video ? 8000 : 6000,
      signal,
    });
  }

  /** What a take sounds like (docs/design/continuity.md#quality-checks-in-the-gate), watched by the audio-visual model. */
  checkSound(input: SoundCheckInput, video: Buffer, signal?: AbortSignal): Promise<SoundCheckOutput> {
    return this.run('sound.check', SoundCheckOutputSchema, input, {
      video: [{ label: `${TAKE_VIDEO_LABEL}:`, data: video, mime: 'video/mp4' }],
      temperature: 0,
      maxTokens: 2000,
      signal,
    });
  }

  /** The whole film, from its scene reviews and the run's numbers (text only). */
  feedbackFilm(input: FeedbackFilmInput, signal?: AbortSignal): Promise<FeedbackFilmOutput> {
    return this.run('feedback.film', FeedbackFilmOutputSchema, input, {
      temperature: 0.3,
      maxTokens: 6000,
      signal,
    });
  }

  /** Rule V4: each speaker's reference voice, then the take's audio. */
  judgeVoices(
    input: VoiceJudgeInput,
    references: Map<string, Buffer>,
    takeAudio: Buffer,
    signal?: AbortSignal,
  ): Promise<VoiceJudgeOutput> {
    const audio: LabelledAudio[] = [];
    for (const s of input.speakers) {
      const ref = references.get(s.characterId);
      if (ref)
        audio.push({
          label: `${VOICE_REFERENCE_LABEL} ${s.characterId} (${s.name}):`,
          data: ref,
          format: 'wav',
        });
    }
    audio.push({ label: `${TAKE_AUDIO_LABEL}:`, data: takeAudio, format: 'wav' });
    return this.run('voice.judge', VoiceJudgeOutputSchema, input, { audio, temperature: 0, signal });
  }

  planScore(input: ScorePlanInput, signal?: AbortSignal): Promise<ScorePlanOutput> {
    return this.run('score.plan', ScorePlanOutputSchema, input, { temperature: 0.6, signal });
  }

  planSfx(input: SfxPlanInput, signal?: AbortSignal): Promise<SfxPlanOutput> {
    return this.run('sfx.plan', SfxPlanOutputSchema, input, { temperature: 0.4, signal });
  }

  /** Where the subject is in each frame (docs/design/finishing.md#auto-reframe-and-cut-downs). */
  focus(input: FocusInput, frames: Buffer[], signal?: AbortSignal): Promise<FocusOutput> {
    return this.run('reframe.focus', FocusOutputSchema, input, {
      images: frames.map((data, i) => ({ label: `${FOCUS_FRAME_LABEL} ${i}:`, data, mime: 'image/png' })),
      temperature: 0,
      signal,
    });
  }

  /** The best thumbnails among candidate frames (docs/design/finishing.md#thumbnails). */
  pickThumbnails(
    input: ThumbnailPickInput,
    frames: Buffer[],
    signal?: AbortSignal,
  ): Promise<ThumbnailPickOutput> {
    return this.run('thumbnail.pick', ThumbnailPickOutputSchema, input, {
      images: frames.map((data, i) => ({ label: `${FOCUS_FRAME_LABEL} ${i}:`, data, mime: 'image/png' })),
      temperature: 0,
      signal,
    });
  }

  /** One frame described for search (docs/design/search.md#captions). */
  captionFrame(input: FrameCaptionInput, frame: Buffer, signal?: AbortSignal): Promise<FrameCaptionOutput> {
    return this.run('frame.caption', FrameCaptionOutputSchema, input, {
      images: [{ label: `${FOCUS_FRAME_LABEL} 0:`, data: frame, mime: 'image/png' }],
      temperature: 0.2,
      maxTokens: 300,
      signal,
    });
  }

  translate(input: TranslateInput, signal?: AbortSignal): Promise<TranslateOutput> {
    return this.run('dialogue.translate', TranslateOutputSchema, input, { temperature: 0.3, signal });
  }

  analyzeFootage(
    input: FootageAnalyzeInput,
    thumbnails: LabelledImage[],
    signal?: AbortSignal,
  ): Promise<FootageAnalyzeOutput> {
    return this.run('footage.analyze', FootageAnalyzeOutputSchema, input, {
      images: thumbnails,
      temperature: 0.4,
      signal,
    });
  }
}
