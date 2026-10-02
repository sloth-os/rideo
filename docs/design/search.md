# Semantic media search

"Close-ups of Mira at night", "the harbour at dawn", "anyone holding a letter": people and agents find takes,
footage, stills and references by what they show, in words. Rideo describes sampled frames with the vision model and
searches those descriptions by meaning, through the gateway's proxy like every other AI call.

## The index

Per project, a derived index on the server's data dir (`<dataDir>/search/<projectId>.json`, kept while the project is
in the trash): rebuilt when lost, never versioned, written atomically, one change at a time.

```ts
type SearchIndex = {
  version: 1;
  projectId: string;
  embeddingModel: string | null;  // the model of the vectors; another model's vectors are embedded again
  entries: SearchEntry[];
  failed: string[];               // frames the vision model could not caption: not tried again until their media changes
  usedAt: string | null;          // the last search: from then on, new frames are indexed on their own
  updatedAt: string | null;
};

type SearchEntry = {
  key: string;                    // <media hash>@<seconds>: one caption per frame, whichever sources show it
  source: { kind: 'take'; clipId: string; shotId: string; takeId: string }
        | { kind: 'resource'; resourceId: string }
        | { kind: 'reference'; characterId?: string; elementId?: string; referenceId: string };
  media: MediaRef;                // what to show and play
  at: number;                     // seconds into the media (0 for stills)
  caption: string;                // the vision model's description of the frame (≤ 300 characters)
  names: string[];                // who and what the source is known to show: a take's shot cast and elements, a reference's owner
  vector: number[] | null;        // the caption's embedding (stored as base64 float32)
};
```

**What is indexed** (`searchTargets`): every take of every shot (3 frames: 15 %, 50 %, 85 % of the take); ready video
and image resources (footage: a frame in the middle of every 4 s, at most 60 per file; a still once); approved
character and element references (once). Two sources showing the same file share its captions: the second copies
them without asking the model again.

**Captions** (the `frame.caption` task, [AI gateway](ai-gateway.md#structured-tasks)): each frame, scaled to 512 px
wide, goes to the vision model through `/proxy/{RIDEO_VISION_PROXY_DOMAIN}` with what its source is (`take`,
`footage`, `still` or `reference`), who and what it is known to show with how they look (`known`: a take's shot cast
and elements, a reference's owner), and everyone in the project (`cast`, named only when sure). The model writes one
sentence: who, where, what is happening, the shot size and the light, notable colours and objects. Captions are
validated (zod, non-empty, cut to 300 characters).

**Embeddings.** With `RIDEO_EMBEDDINGS_PROXY_DOMAIN` (and `RIDEO_EMBEDDINGS_MODEL`, default
`text-embedding-3-small`), captions and queries are embedded through `/proxy/{domain}/v1/embeddings` (OpenAI-style,
batches of 64) and ranked by cosine similarity. Without it, Rideo ranks by words, and every response says which.

## Indexing

`search.index` (an `llm`-lane job, one per project at a time) brings the index up to date:

1. Drop entries whose source left the project (an unapproved reference, a removed take); copy captions of frames
   another source already has.
2. Sample the new frames of each file with ffmpeg on the server, caption them three at a time, and save every six,
   so a retried or interrupted run resumes where it stopped. A frame the model cannot caption (invalid output, a
   refused image) is recorded in `failed`; a busy or failing provider stops the job, which retries.
3. With embeddings, embed every caption without a vector (all of them when the configured model changed).
4. Look again: frames that arrived meanwhile are indexed in the same job (at most three rounds).

It starts from *Index for search* (or `search_index`), and on its own: once a project's search has been used, a
commit on its checked-out branch that changes clips, resources, characters or elements starts a run three seconds
after commits settle, when there is something to index or drop. Progress counts frames. Logs carry `projectId` and
the job; `rideo_search_frames_total{outcome}` counts frames `captioned`, `copied` and `failed`.

## Searching

`GET /api/projects/:id/search?q=&kinds=take,resource,reference&limit=` (default 24, at most 100) returns the best
matches, one per source and file (its best frame), each with its source, `at`, caption, the names its source shows,
a score (0–1) and a label (the clip and shot of a take, a resource's name, a reference's owner):

- **By meaning**: the cosine similarity of the query's and the captions' embeddings, from 0.2 up. Query embeddings are
  cached; if the embeddings model fails, the search runs by words and says so.
- **By words**: BM25 over the captions and the names (stemmed, stop words dropped), as a share of the best match.
- **Names first**: the cast's and elements' names (and the elements' aliases) are single terms. A query naming one
  (`Mira at night`) puts the frames whose caption or source names them first, then the rest by score.

An empty index returns nothing and says how many frames wait. `rideo_searches_total{mode}` counts searches.

| Surface | REST | MCP |
|---|---|---|
| search | `GET /api/projects/:id/search` | `media_search` (`projectId`, `query`, `kinds?`, `limit?`) |
| index | `POST /api/projects/:id/search/index` → `202 {job}` | `search_index` |
| status | `GET /api/projects/:id/search/status` → `{mode, indexed, pending, failed, files, updatedAt, usedAt, job}` | `search_status` |

Searching needs `project.read`, indexing `project.edit`.

## In the studio

- The **Search** view: the index's state (frames indexed and waiting, by meaning or by words, the running job) with
  *Index for search*; a query box; filters by kind (takes, footage and stills, references); results as a grid of
  frames (the video opens at the matched frame and plays while hovered, or after a tap) with their captions, time and
  score; *Show* opens the take in Clips, the resource in Resources, or the character or element, and points at it.
- The editor's **overlay picker** searches too (takes and footage): a match goes onto the top overlay track at the
  playhead, starting a second before the matched frame ([multitrack](editor.md#multitrack-transforms-and-keyframes)).

## Mock gateway

`frame.caption` answers from the frame's mean colour and brightness (dark frames are "at night", bright ones "in bright
daylight") and the `known` names: "Mira in a blue scene at night, medium shot." `/proxy/{domain}/v1/embeddings` returns
deterministic 128-dimension vectors from the words of each text, with synonyms sharing a concept (crimson and red,
ocean and harbour, dark and night), so tests can tell meaning from words.
