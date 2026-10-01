# Editing and extending takes

A take that is almost right should be fixed, not regenerated from scratch: restyled, relit, an object replaced or
removed, seen from a new angle, or held a little longer. Rideo edits takes with video-to-video models and extends
them with continuation generations. Every result is a **derived take**: verified by the judge like any take (R4),
watermarked and signed (its C2PA manifest names the parent take as its ingredient), and linked to its parent.
The editor's **generative extend** fills a trim gap with generated frames.

## Derived takes

```ts
take.derivedFrom = {
  takeId: string;                       // the parent take of the same shot
  op: 'edit' | 'extend';
  kind?: 'restyle' | 'relight' | 'replace' | 'angle' | 'remove';   // edits
  instruction?: string;                 // what to change, in the user's words
  seconds?: number;                     // extensions
} | null;
```

A derived take joins the shot's takes and is selected when it passes, like a new take. Its lock versions are the
current ones (it is verified against the current references); its dialogue is the parent's (`take.audio` is
copied: the timing is unchanged for edits and the lines still start at 0 for extensions).

## Edits (`take.edit`)

| Kind | Instruction compiled into the prompt |
|---|---|
| `restyle` | `Restyle the video: {instruction}. Keep the people, their faces, the action and the camera move unchanged.` |
| `relight` | `Relight the video: {instruction}. Keep the people, their faces, the action and the camera move unchanged.` |
| `replace` | `Replace {instruction}. Keep the people, their faces, the action and the camera move unchanged.` |
| `angle` | `Show the same moment from a new camera angle: {instruction}. Keep the people, their faces and the action.` |
| `remove` | `Remove {instruction} from the video and fill the background naturally. Keep everything else unchanged.` |

The request carries the parent take as `reference_video`, the characters' references as `reference_image` (within
`max_input_images`, so the model keeps the faces), the instruction, the take's dimensions, and the model
`settings.models.edit` (`RIDEO_EDIT_MODEL`, default `auto`: mm-gateway routes requests with a reference video to
models that accept it). The result keeps the parent's sound. Sampled frames are judged (R4) with retries; when
every attempt fails, the best attempt is kept as a failed derived take for review.

## Extensions (`take.extend`)

`+N s` (1–10): the parent's **last frame** is the `first_frame` of a continuation generated with the shot's prompt and
`Continue the action seamlessly from the first frame: {prompt}`, with the shot's references, seed offset and
model. The continuation is judged; the derived take is the parent followed by the continuation (one re-encode;
the parent's sound continues and the extension is silent unless the model rendered sound), so it is `N` seconds
longer.

## Generative extend in the editor (`timeline.extend`)

On a video item of the cut, **Extend start** or **Extend end** by 1–5 s:

- `end`: the frame at the item's out point is the `first_frame` of a generated clip of `N` s;
- `start`: the frame at the item's in point is the `last_frame` of a generated clip of `N` s (the model must accept
  last frames).

The prompt is the item's shot prompt for takes, or `Continue the shot seamlessly` (plus the user's prompt) for
footage. Shots with characters are judged. The generated clip becomes a **resource** (`origin: generated`, role
`extension`), watermarked and signed, and is inserted on the primary track right after (end) or before (start) the
item, so the cut grows by `N` s; later items move with the magnetic track. The editor shows the job until the item
appears.

## Provenance

`signTake` records `c2pa.edited` (edits and extensions) with the gateway models and the instruction, and adds the
parent take (with its own manifest) as a `parentOf` ingredient; extension resources are `c2pa.created` with the
source frame's media as an `inputTo` ingredient. Exports list derived takes and extensions as AI-generated
ingredients like other takes.

## Surfaces

| REST | MCP |
|---|---|
| `POST /api/projects/:id/clips/:clipId/shots/:shotId/takes/:takeId/edit` `{kind, instruction}` → job | `take_edit` |
| `POST /api/projects/:id/clips/:clipId/shots/:shotId/takes/:takeId/extend` `{seconds, prompt?}` → job | `take_extend` |
| `POST /api/projects/:id/timeline/items/:itemId/extend` `{edge, seconds, prompt?}` → job | `timeline_extend` |

The clip review's take tiles have **Edit** (kind and instruction) and **Extend** (seconds and what happens next);
derived takes show their lineage. The editor's inspector has **Generative extend** for the selected video item.

| Job | Lane | Errors |
|---|---|---|
| `take.edit`, `take.extend`, `timeline.extend` | video | `validation_error` (no video, a missing parent, a start extension with a model without last frames), the gateway's errors |
