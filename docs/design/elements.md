# Elements: locations, props and styles

Continuity in a long film is as much about places and objects as about faces: the lighthouse lamp room
must look the same in scene 3 and scene 40, and the brass key must not change shape between close-ups.
**Elements** extend Rideo's consistency guarantee ([character consistency](character-consistency.md)) from
characters to everything else that recurs: locations, props and visual styles. An element has a written
anchor, reference images, and the same approve → lock → verify lifecycle as a character.

## Element document

`elements/<id>.json` (versioned, materialized on WebDAV like every document):

```ts
type Element = {
  id: string;                          // ele_…
  kind: 'location' | 'prop' | 'style';
  name: string;                        // "Lamp room"
  description: string;                 // the anchor text: what it looks like, in a fixed sentence
  aliases: string[];                   // other names the screenplay uses ("lighthouse lamp room", "the lantern")
  references: {
    id: string; view: 'establishing' | 'angle' | 'detail' | 'custom';
    media: MediaRef; source: 'generated' | 'uploaded'; approved: boolean; createdAt: string;
  }[];
  seed: number;                        // uint32, fixed at creation
  lock: { locked: boolean; version: number; lockedAt?: string; lockedBy?: Actor; identityHash?: string };
};
```

`identityHash` covers the name, description and the approved reference hashes, so relocking an unchanged
element keeps its version (no stale takes).

| Kind | Meaning | Reference views generated |
|---|---|---|
| `location` | a place: set, landscape, interior | `establishing` (wide, empty of people), `angle` (the reverse angle) |
| `prop` | an object that must stay the same: a key, a car, a letter | `detail` (isolated on neutral ground), `angle` |
| `style` | a look: a painting style, a film stock, a palette board | `custom` (a style frame) |

## Where elements are used

| Field | Meaning |
|---|---|
| `Scene.locationId` | the scene's location element (one per scene) |
| `Scene.elementIds` | props and styles present in the scene |
| `Shot.elementIds` | props and styles visible in the shot (chosen by the planner from the scene's) |

A shot's **elements** are its scene's location plus its own `elementIds`. Like the cast, the element library is
defined up front: `screenplay.generate` asks the writer for **every location and prop of the whole film** (the
full outline, not only the written scenes) and creates draft (unlocked) elements for them; scenes link to
them by name or alias (case-insensitive). `screenplay.extend` reuses those names; a name it still introduces
becomes a new draft element. The shot planner (`clip.plan`) receives the scene's props and returns, per
shot, the props visible in it.

## Rules

They mirror the character rules (R1–R9) and are enforced in the same places:

| # | Rule | Where |
|---|---|---|
| E1 | **Lock before use.** Generating a shot fails with `element_not_locked` if its location or one of its elements is unlocked or has no approved reference. | `ShotPipeline` precondition, `clip.generate`, `batch.generate` |
| E2 | **Locked is immutable.** Updating the name, description or references of a locked element fails with `element_locked`. Unlock → edit → lock increments `lock.version`. | `ElementService.update` |
| E3 | **Deterministic conditioning.** The prompt compiler adds a fixed sentence per element (`Location: …`, `Props: …`, `Style: …`) and its approved references in fixed priority, after the characters, within the model's `max_input_images`. | shared prompt compiler |
| E4 | **Verification when configured.** With `settings.consistency.judgeElements` (default off), the judge also scores each element in the keyframe and the video frames against its references; a missing or changed element fails the gate like a character. | `ConsistencyGate` |
| E6 | **Drift detection.** A take stores `elementLocks: {elementId: version}`; relocking an element with changes marks older takes stale. | shared `takeState()` |

Rules R7 (approval gate), R8 (audited override) and R9 (fail closed) apply unchanged: a stale or failed take
blocks clip approval and export whether a character or an element caused it.

## Prompt and references

```
… Camera: medium shot, slow pan. Characters (…): Mira: … Location (keep exactly as in the reference
images): Lamp room — circular brass-framed lantern room, salt-crusted windows, a huge Fresnel lens at the
centre. Props (keep exactly as in the reference images): Brass key — long antique brass key with a
lighthouse-shaped bow.
```

Reference selection gives elements a quarter of the model's image budget (at least one image) when the cast
leaves room, and the characters the rest (unchanged, including the cast-sheet fallback). Each element
contributes its best approved reference (location first); when there are more elements than element slots,
they are composed into one labelled **element sheet** (like the cast sheet) that takes a single slot. When the
characters need the whole budget, elements are described in text only. With `judgeElements`, the judge gets
every element's reference, whether or not it fit the budget.

## Workflow

The `cast` stage (titled *Cast & elements*) locks the elements too:

| Requirement | Satisfied when |
|---|---|
| `elements.inUseLocked` | every element referenced by a written scene (`locationId`, `elementIds`) or a planned shot is locked |
| `elements.inUseHaveApprovedRefs` | every such element has an approved reference |

Before production, the rest of the library must be locked too, so the batch never stops for an element:

| Requirement (pilot gate) | Satisfied when |
|---|---|
| `elements.allLocked` | every element in the library is locked (delete the ones the film does not need) |

The auto action `elements.generateRefs` (autopilot, on entering `cast`) generates references for every
unlocked element in use that has none.

**Safety net in production.** If a screenplay extension still introduces a new location or prop, the batch
does not generate the clip that needs it: it starts `element.refs` for the new elements that have no
references and stops with `stopReason: "new locations or props need approval: …"`. Lock them and start the
batch again; it continues where it stopped.

## Jobs

| Kind | Lane | Does |
|---|---|---|
| `element.refs` | image | generate reference views for one element (the first approved view is the image input of the next) |

## Surfaces

| REST | MCP |
|---|---|
| `POST /api/projects/:id/elements` | `element_create` |
| `PATCH /api/projects/:id/elements/:eid` | `element_update` |
| `DELETE /api/projects/:id/elements/:eid` | `element_delete` |
| `POST /api/projects/:id/elements/:eid/references/generate` | `element_generate_refs` |
| `POST /api/projects/:id/elements/:eid/references` (multipart or `{uri}`) | `element_add_reference` |
| `PATCH` / `DELETE /api/projects/:id/elements/:eid/references/:rid` | `element_set_reference_approval` |
| `POST /api/projects/:id/elements/:eid/lock` / `unlock` | `element_lock` / `element_unlock` |

Scenes link elements through `PATCH /screenplay` (`upsertScenes[].locationId`, `elementIds`) and shots through
`PATCH …/shots/:shotId` (`elementIds`). The UI has an **Elements** view (locations, props and styles with
their references, approval and locks); scene cards pick their location and shot editors their props.
Agents can `ui_navigate` to `elements` and `ui_focus` an `element`.

## Mock gateway

Element reference sheets follow the mock's consistency model: an "Element reference sheet" paints a
signature colour derived from the element's name, generations copy the signatures of the reference images
they receive, and the mock judge looks for each element's signature in the frames when asked to judge
elements.
