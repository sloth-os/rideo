# Agents: prompts, resources, recipes

Agents drive Rideo through MCP ([mcp](mcp.md)). Beyond the tool catalogue, they get **prompts** that frame common
jobs with the project's own material, **resources** that answer the questions those jobs ask, **recipes** (named,
parameterized sequences of tool calls that run on the server, for any project of the studio) and tools that work on
many things at once: variations of many shots and casting every voice.

## Prompts

MCP prompts (`prompts/list`, `prompts/get`) are templates the client offers its user ("/rideo:direct_scene" in Claude
Code). Rideo fills them with the project's material when they are fetched:

| Prompt | Arguments | What it gives the agent |
|---|---|---|
| `direct_scene` | `projectId`, `sceneId` | the scene (heading, action, dialogue), its characters and elements with their lock state, the shots planned for it with their directing, the camera moves; the steps: plan or adjust shots (`shot_update`: camera, lens, end frames, motion references), generate (`clip_generate`, `shot_regenerate`), compare variations, select, approve, and show each step in the studio (`ui_focus`) |
| `address_review_notes` | `projectId`, `reviewId?` | the open threads ([review](review.md)) on takes and the export, with times, drawings and replies; the steps: decide per note (a take edit, a regeneration, a timeline op), do it, reply with what changed (`comment_reply`), resolve (`comment_resolve`), then ask for a decision again |
| `cast_voices` | `projectId` | the speaking characters and their voices; the steps: `voices_cast`, audition the candidates, pick and lock |
| `dub_film` | `projectId`, `language` | the cut's lines and existing languages; the steps: `localize` with dubbing, check and correct translations, export the language variant |
| `make_variations` | `projectId`, `clipId` | the clip's shots and takes; the steps: `batch_variations`, compare, `take_select` |

Each prompt is one user message: the material as Markdown, then the steps, naming the tools. Arguments are validated;
an unknown project or scene is an MCP error.

## Resources

| URI | Content |
|---|---|
| `rideo://recipes` | the studio's recipes, built-in ones first (JSON) |
| `rideo://projects/{projectId}/review-notes` | open review threads, grouped by take and export (JSON) |
| `rideo://projects/{projectId}/scenes/{sceneId}` | a scene with its clips, shots, selected takes and their consistency (JSON) |
| `rideo://projects/{projectId}/timeline` | the cut: tracks and items with their source, timing and effects (JSON) |

## Recipes

A recipe is a named sequence of **tool calls** with parameters, like a skill or a tool of other studios, that any
member can run on any project:

```ts
type Recipe = {
  id: string;                 // rcp_…, or builtin:<name>
  name: string;               // "Storyboard to animatic"
  description: string;
  params: { name: string; type: 'string' | 'number' | 'boolean' | 'id' | 'ids';
            description?: string; default?: unknown; required?: boolean }[];
  steps: {
    tool: string;             // an MCP tool, e.g. "storyboard_generate"
    args: Record<string, unknown>;   // "{{param}}", "{{item}}", "{{steps.0.id}}" placeholders
    forEach?: string;         // "{{param}}" of a list: the step runs once per element ({{item}})
    wait?: boolean;           // the step's jobs must finish before the next step
    label?: string;
  }[];
  createdBy: Author; createdAt: string;
};
```

- **Placeholders.** A string that is only a placeholder takes the value as it is (a number, a list); inside a
  longer string it is interpolated. `{{projectId}}` is always set; `{{steps.<k>.<path>}}` reads an earlier step's
  result (`steps.0.id` is the job id a step returned).
- **Built-in recipes** ship with Rideo (read-only): *Storyboard to animatic* (`storyboard_generate` → wait →
  `storyboard_approve_all` → `animatic_build`), *Cast every voice* (`voices_cast` with pick and lock → wait),
  *Dub and export a language* (`localize` with dubbing → wait → `export_render` of the dubbed variant), *Variations
  of a clip* (`batch_variations` → wait).
- **Studio recipes** are JSON documents on the storage backend (`<root>/recipes/<id>.json`), created by people and
  agents (`recipe_create`, `POST /api/recipes`), validated (every step names a known tool; its static arguments
  pass the tool's schema where no placeholder stands), and deleted by their author or an admin.
- **Running** (`recipe_run`, `POST /api/projects/:id/recipes/:recipeId/run {params}`) checks the parameters, and the
  caller's role against the strongest permission of the steps' tools (an approval step needs `project.approve`),
  then starts a `recipe.run` job (control lane). The job runs the steps in order through the same tool handlers as
  MCP (one registry), as every job does: Rideo on behalf of who started it, with progress per step; a step that fails stops the recipe with that step's
  error, and the job's result lists every step's outcome. Recipe runs are audited like the tools they call (approval
  steps record `project.approval`).

## Many things at once

| Tool | REST | What it does |
|---|---|---|
| `batch_variations` | `POST /api/projects/:id/clips/:clipId/variations` `{shotIds?, count}` | 2–4 variations of every shot of a clip (or the listed shots): one `shot.generate` job per take, as `shot_variations` does for one shot |
| `voices_cast` | `POST /api/projects/:id/voices/cast` `{characterIds?, pick?, lock?}` | a `voices.cast` job: voice candidates for every speaking character without a voice ([dialogue](dialogue.md)), then (with `pick`) the first candidate selected and (with `lock`) the voice locked |

## Surfaces

The overview's agent card lists the prompts an agent can use and the **Recipes**: each with its steps, *Run* (a form
for its parameters) and, for studio recipes, *Delete*. Running a recipe shows its job in the jobs panel.

| Surface | REST | MCP |
|---|---|---|
| recipes | `GET /api/recipes`, `POST /api/recipes`, `DELETE /api/recipes/:id` | `recipes_list`, `recipe_create`, `recipe_delete` |
| run | `POST /api/projects/:id/recipes/:recipeId/run` | `recipe_run` |
| prompts | – | `prompts/list`, `prompts/get` |

Logs carry `projectId`, the recipe and the step; `rideo_recipe_steps_total{tool, outcome}` counts the steps run.
