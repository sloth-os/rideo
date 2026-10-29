# The 3D Director's Desk

A film made shot by shot loses its geography between cuts. The swimming demo's storyboard review scored the
continuity of its frames 5 in all three rounds, and its feedback scored continuity across cuts 4 of 10: the
watermelon halves wandered from one side of the beach to the other, the shoreline and the sun swapped sides, and
Rosie and Sammy changed places in a shot and its reverse shot. Each frame was drawn from words, and words do not say
where the camera stands. Previs tools block a scene in 3D first: the open-source
[3D Director Desk](https://github.com/jiguang132/storyai-3d-director-desk) (three.js, mannequins with poses, a
director's view over the set and a view through each camera, a capture per camera, July 2026), Morphic's
[3D Scene](https://morphic.com/3d) (an agent lays the scene out; it warns when a camera crosses the line between two
characters or sits inside a wall), Autodesk Flow Studio's 3D Editor, and [PrevizWhiz](https://arxiv.org/abs/2602.03838)
(CHI '26: rough 3D frames restyled into previz, with a "faithful" resemblance that 7 of 10 filmmakers preferred).
They lock the camera and the staging, and let the image and video models paint.

Rideo blocks every storyboarded scene in a small 3D set before its frames are drawn:

1. **The blocking.** One set per scene (its size, the ground, landmarks such as the sea or a lodge, the sun), every
   character as a coloured mannequin on a mark (position, facing, pose, where they move to in each shot), the props,
   and a **camera per shot** (position, target, lens, an end position for a move). It is stored on the clip.
2. **AI blocking.** On autopilot (and on request) the text model lays the scene out as a floor plan: marks and
   landmarks in metres, and for each shot a camera *described* (who it frames, from which side, how high). A pure
   **solver** turns each description into an exact camera from the shot's framing and lens, and enforces the
   **180° rule**: a cut whose camera crossed the line between the scene's two main characters is mirrored back.
3. **The desk.** The Storyboard view opens each scene on the desk: a director's view of the floor plan (drag the
   mannequins, props and cameras, turn them), and the view through the selected shot's camera with a thirds grid, the
   same picture the image model is given. Checks list what breaks the scene (a crossed line, a character out of
   frame, a camera inside a wall).
4. **Generation.** A shot's frame is drawn with the blocking: its keyframe prompt says where everyone stands and faces
   and where the light comes from (`Blocking: …`, computed from the camera), and its **camera view** (the mannequins
   seen through the shot's camera) is one more reference image, so the image model keeps the composition. The video
   starts from that frame; a blocked camera move becomes the shot's named move.
5. **Review.** The storyboard reviewer sees each frame next to its camera view and scores whether the frame keeps the
   blocking.

Everything that decides a picture is computed by pure shared functions (rule R3): the same blocking gives the same
solved cameras, the same prompt lines and the same pixels in the server and in the browser.

## The document

`clip.blocking` (null until the scene is blocked), validated by `SceneBlockingSchema` (shared):

```ts
type SceneBlocking = {
  version: 1;
  source: 'ai' | 'user';                 // who placed it last
  updatedAt: string;
  set: {
    width: number; depth: number;        // metres, 2–200; the floor is centred on the origin
    ground: string;                      // "sand", "snow", "wooden floor": its colour in the render
    interior: boolean;                   // a room: grey walls of light, no sky
    sun: { azimuthDeg: number; elevationDeg: number };   // where the key light comes from
    landmarks: { id; label; shape: 'box' | 'cylinder' | 'water' | 'wall'; x; z; width; depth; height;
                 rotationDeg; color: string; elementId: string | null }[];   // ≤ 24
  };
  actors: { id; characterId; color: string; heightM: number;                   // ≤ 8
            x; z; facingDeg; pose: Pose }[];                                   // the scene's opening marks
  props: { id; elementId: string | null; label; x; z; size; color; heldBy: string | null }[];   // ≤ 16
  shots: Record<shotId, {
    marks: Record<characterId, { x; z; facingDeg; pose: Pose; toX: number | null; toZ: number | null }>;
    camera: { x; y; z; targetX; targetY; targetZ; lensMm: number;
              end: { x; y; z; targetX; targetY; targetZ } | null };            // a move: where it ends
    spec: CameraSpec | null;             // how the camera was described, kept for the solver
  }>;
};
type Pose = 'stand' | 'walk' | 'run' | 'sit' | 'crouch' | 'kneel' | 'lie' | 'reach' | 'point' | 'wave';
type CameraSpec = { subjects: string[];                  // character ids it frames (the shot's cast by default)
                    angle: 'front' | 'three_quarter_left' | 'three_quarter_right' | 'profile_left'
                         | 'profile_right' | 'back' | 'over_shoulder' | 'pov';
                    height: 'eye' | 'low' | 'high' | 'overhead'; move: 'none' | 'push_in' | 'pull_out'
                         | 'dolly_left' | 'dolly_right' | 'orbit_left' | 'orbit_right' | 'crane_up' };
```

**Coordinates.** Metres; the floor is `y = 0`; `x` runs to the right and `z` towards the front of the set (the
audience's side), so a camera at the front looks towards `-z` and sees `+x` on its right. A facing of 0° looks at the
front, 90° to the right (`+x`), 180° to the back. Each shot's marks override the opening marks for the characters in
it (a character with no mark in a shot stands where the opening marks put them); `toX`/`toZ` is where they walk to
during the shot. Each actor gets a colour of the desk palette in cast order (orange, blue, green, purple, yellow,
pink, teal, red), which the prompt names (`orange figure = Rosie`).

Re-planning a scene keeps its set, actors and props; shots that no longer exist lose their marks and cameras, and new
shots get solved cameras. A blocking whose shots do not match the clip's (a shot added, removed, re-cast) is
**incomplete**: `blockingState(blocking, shots)` is `missing`, `incomplete` or `ready`, and the desk and the jobs
complete it (`normalizeBlocking`: an actor for every character of the scene, a solved camera for every shot without
one, from the shot's framing).

## The solver

`solveCamera(blocking, shot, spec, aspect)` (shared) places the camera of a shot:

| Step | Rule |
|---|---|
| Subjects | the spec's characters (the shot's cast when empty; a shot without characters frames the set's centre or its first prop) at their marks for the shot |
| Coverage | the frame height at the subjects, by framing, for a 1.7 m figure (scaled by the tallest subject): extreme wide 10 m, wide 4.2, medium 1.25, medium close 0.85, close-up 0.45, extreme close-up 0.22, over the shoulder 1.1, POV 2.5, insert 0.35 |
| Lens | the shot's `camera.lensMm`, else 24 mm (wide), 35 (medium), 50 (medium close), 85 (close-up and closer) |
| Distance | `(coverage / 2) / tan(fovV / 2)` with a 36 mm wide sensor and the project's aspect ratio |
| Target | the subjects' centre at the height the framing looks at: half the figure (wide), the chest (medium), the eyes (close-up); a prop for an insert |
| Direction | around the subjects: `front` faces the subject's facing (a group: the side of the line between the two main characters that faces the set's front), three-quarters ±35°, profile ±90°, `back` 180°; `over_shoulder` stands 0.9 m behind the first subject's shoulder looking at the second; `pov` is the first subject's eyes looking where they face |
| Height | `eye` (the subject's eyes; 1.5 m for wide shots), `low` 0.35 m, `high` the head plus 1.2 m, `overhead` the head plus 4 m |
| Move | the end position: `push_in` and `pull_out` 35% closer or farther, dollies 1.5 m sideways, orbits 30° around the target, `crane_up` 2 m higher |
| Inside the set | a camera inside a landmark is moved out along its direction (a wall at the edge of an interior is the exception it may stand at) |

**The line.** The scene's main pair are the two characters who share the most shots. The first shot that shows them
both sets the side of the line the camera stays on. `enforceLine` mirrors across the line any later camera of a cut
that frames either of them from the other side (position and target reflected in the floor plane). A camera move that
crosses the line during its shot (an orbit) is motivated and kept. Singles of a shot and reverse shot are on the same
side as their two-shot, so eyelines match.

**Normalization.** `normalizeBlocking(raw, ctx)` makes any blocking safe to render: names become character ids
(unknown ones are dropped), positions are clamped into the set, actors closer than 0.35 m are pushed apart, missing
cameras are solved, cameras of cuts are kept on the line, sizes and colours are clamped to their ranges. AI blocking
always goes through it; the desk runs it when a person asks the desk to **Fix the blocking**.

## Checks

`blockingIssues(blocking, clip, ctx)` (shared) lists what breaks the scene, shown on the desk, sent to the storyboard
reviewer and logged by the jobs:

| Code | Severity | When |
|---|---|---|
| `line_crossed` | error | a cut's camera frames the main pair, or one of them, from the other side of the line than the scene set |
| `subject_out_of_frame` | error | a character of the shot is not in its camera's frame (behind it or outside the picture) |
| `camera_inside` | error | a camera stands inside a landmark |
| `screen_direction` | warning | a character walks across the frame one way in a shot and the other way in the next cut |
| `absent_in_frame` | warning | a character of the scene who is not in the shot stands in its frame (the render leaves them out, the frame would not) |
| `actors_overlap` | warning | two characters closer than 0.35 m |
| `outside_set` | warning | a mark or a camera outside the set |

## What the image and video models get

**The blocking line** (prompt version 2, a shot with a blocking): `shotLayout` projects every character of the shot
through its camera, and `blockingLine` writes it after the camera line of the keyframe prompt:

```
Blocking: Rosie is left of frame in the foreground, facing right; Sammy is right of frame, facing the camera.
Behind them: the sea. Light: the sun is behind the camera, on the left.
```

- *Where*: the third of the frame (`left of frame`, `in the centre`, `right of frame`) and the depth among the
  subjects (`in the foreground`, `in the background`).
- *Facing*: towards the camera, with the back to it, or to the frame's left or right (three-quarters between).
- *Behind them*: landmarks in the frame farther than the subjects.
- *Light*: the sun against the camera's direction: behind the camera (faces lit), ahead (backlight), or from the left
  or right.
- *Moves*: a mark with a destination adds `Rosie walks from left of frame to the centre.` to the video prompt's action.

The board's prompt hash includes the line and a signature of what the shot's camera view is drawn from (the set, the
shot's characters, the props, the shot's marks and camera), so moving a mannequin or the shot's camera makes its frame
*outdated*: it is drawn again with the new blocking. Moving another shot's camera leaves it current.

**The camera view** (`settings.blocking.layoutImage`, on by default): `renderShotBlocking` draws the shot's camera
view (flat-shaded mannequins in their colours on the ground, the landmarks, the props and the sky, lit from the sun)
at 1024 px wide. It goes to the image model after the cast's and the elements' references and before the scene
reference (whose phrase says it is the last image) when the model's `max_input_images` leaves a slot, and the prompt
names it: `Reference images, in order: … 4 the blocking (orange figure
= Rosie, blue figure = Sammy).` and `Keep the camera angle, the framing and where each figure stands and faces from the
blocking; draw the real characters and place, never the mannequins.` Only the shot's characters are drawn: a
mannequin in the picture is a person in the frame.

**The camera move.** A blocked camera with an end position whose shot has no move of its own gets the move of the
library it matches (`cameraMoveOf`: closer is `push_in`, farther `pull_out`, sideways `dolly_left`/`dolly_right`,
around the target `orbit_left`/`orbit_right`, up `crane_up`), so the video request's `camera_motion` and the prompt's
camera line follow the blocking.

## Jobs

| Kind | Lane | Does |
|---|---|---|
| `scene.block` | llm | the text model's floor plan of one clip's scene (`scene.block` task: the scene, its place and props, the cast with their heights, every shot with its framing, lens, description, action, cast and end state); normalized, the cameras solved and kept on the line; committed as `clip.blocking` (`source: ai`) with its issues logged |

`storyboard.generate` (and a production scene's `clip.storyboard`, [AI review](ai-review.md#production-storyboards))
blocks every clip it draws whose blocking is `missing` before drawing, and completes an `incomplete` one, when
`settings.blocking.enabled` is on. `shot.board` and the keyframe step of `shot.generate` read the blocking.

`settings.blocking = { enabled: boolean, layoutImage: boolean }`: off in the schema, so projects from before the desk
keep their prompts byte-identical (R3) and their frames current; new projects are created with it on.

## The desk

`/p/:id/storyboard` opens each scene's desk from its row (**Director's desk**). On wide screens the plan and the camera
view sit side by side, on phones one above the other; every control works with a finger.

- **Director's view**: the floor plan as SVG, the set's outline and ground, landmarks as their shapes, each character
  as a coloured disc with a nose for its facing and its name, props as squares, the line between the main pair, and
  each shot's camera as a wedge of its field of view (numbered `S1`, `S2`…). Drag to move, drag a nose or a camera's
  aim to turn; the selected shot's marks are edited, or the opening marks with *All shots*.
- **Camera view**: the selected shot's camera view (`renderShotBlocking`, the picture the image model gets) with a
  thirds grid and each character's name at its head; the shot strip below picks the shot.
- **Inspector**: the selected character's pose and facing; the camera's lens, height and move, and **Auto camera**
  (solve the shot's camera from its framing); the set's size, ground and sun.
- **Checks**: the issues with the shot they are about; **Fix the blocking** normalizes it (solver and line).
- **Save** commits the blocking (`source: user`); **Block with AI** runs `scene.block`; **Redraw frames** draws the
  scene's frames that the new blocking made outdated.

## Surfaces

| REST | MCP |
|---|---|
| `GET /api/projects/:id/clips/:clipId/blocking` → `{blocking, state, issues, lines}` (`lines`: each shot's blocking line) | `blocking_get` |
| `PUT /api/projects/:id/clips/:clipId/blocking` `{blocking, fix?}` → the same | `blocking_set` |
| `POST /api/projects/:id/clips/:clipId/blocking/generate` → job (`scene.block`) | `blocking_generate` |
| `GET /api/projects/:id/clips/:clipId/shots/:shotId/blocking.png` → the shot's camera view (PNG, `?width=` 160–1920) | `blocking_render` (the PNG as image content) |

REST and MCP call the same `StoryboardService` methods. A blocking that does not validate is a `validation_error`
(422); one for a clip that is approved is a `conflict` (409): unapprove the clip to change its blocking.

## Observability

`rideo_blocking_total{source, outcome}` counts blockings saved (`source`: `ai`, `user`; `outcome`: `clean`,
`issues`), `rideo_blocking_issues_total{code}` the issues found when one is saved, and
`rideo_blocking_line_fixes_total` the cameras the solver brought back over the line. The job logs the project, the
clip, the shots solved and the issues.

## Mock gateway

`scene.block` answers a floor plan from rules over its input: the cast in a row across the set facing each other
(two characters) or the front, a landmark for the place, each prop beside the first character, and for each shot a
camera spec from its framing (`front`, alternating three-quarters for singles of a conversation, `over_shoulder` for
over-the-shoulder shots). A shot whose description says "cross the line" gets its camera on the other side, so
tests see the solver bring it back.
