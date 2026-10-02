import {
  CAMERA_MOVES,
  type Clip,
  type CommentThread,
  languageName,
  type ProjectDocs,
  sortedClips,
  speakingCharacters,
  threadsFor,
  voiceOf,
  voiceStatus,
} from '@rideo/shared';

/**
 * MCP prompts (docs/design/agents.md#prompts): the project's material as Markdown, then the steps, naming the
 * tools. Pure functions of the documents, so tests read the same text an agent gets.
 */

const bullet = (lines: string[]) => lines.map((l) => `- ${l}`).join('\n');
const sec = (s: number) => `${s.toFixed(1)} s`;

function shotLines(clip: Clip, docs: ProjectDocs): string[] {
  return [...clip.shots]
    .sort((a, b) => a.index - b.index)
    .map((s) => {
      const take = s.takes.find((t) => t.id === s.selectedTakeId);
      const cam = [
        s.camera.framing,
        s.camera.movement,
        s.camera.move,
        s.camera.lensMm ? `${s.camera.lensMm} mm` : null,
      ]
        .filter(Boolean)
        .join(', ');
      const who = s.characterIds.map((id) => docs.characters[id]?.name ?? id).join(', ');
      return `shot ${s.index + 1} (\`${s.id}\`, ${sec(s.durationSec)}): ${s.description} — camera: ${cam}${who ? `; with ${who}` : ''}; ${s.takes.length} take(s)${take ? `, selected \`${take.id}\` (${take.consistency.status})` : ''}`;
    });
}

export function directScenePrompt(docs: ProjectDocs, sceneId: string): string {
  const scene = docs.screenplay?.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`scene ${sceneId} not found`);
  const cast = scene.characterIds.map((id) => docs.characters[id]).filter((c) => !!c);
  const elements = [scene.locationId, ...scene.elementIds]
    .map((id) => (id ? docs.elements[id] : undefined))
    .filter((e) => !!e);
  const clips = sortedClips(docs).filter((c) => c.sceneId === scene.id);
  const dialogue = scene.dialogue.map(
    (d) => `**${d.character}**${d.parenthetical ? ` (${d.parenthetical})` : ''}: ${d.line}`,
  );
  return `# Direct scene ${scene.index + 1} of “${docs.project.title}”

Project \`${docs.project.id}\`, scene \`${scene.id}\`.

## The scene

**${scene.heading}** (${sec(scene.estDurationSec)})

${scene.action || scene.summary}

${dialogue.length ? dialogue.join('\n\n') : '_No dialogue._'}

## Cast and elements

${
  bullet([
    ...cast.map(
      (c) => `${c.name} (\`${c.id}\`): ${c.lock.locked ? 'locked' : 'NOT locked — lock before generating'}`,
    ),
    ...elements.map(
      (e) => `${e!.name} (${e!.kind}, \`${e!.id}\`): ${e!.lock.locked ? 'locked' : 'NOT locked'}`,
    ),
  ]) || '_Nobody yet._'
}

## Shots

${clips.length ? clips.map((c) => `Clip ${c.index + 1} \`${c.id}\` (${c.status}):\n${bullet(shotLines(c, docs))}`).join('\n\n') : '_No clip planned for this scene yet: plan one with `clip_plan`._'}

Camera moves: ${CAMERA_MOVES.slice(0, 12)
    .map((m) => `\`${m.id}\``)
    .join(', ')}… (\`camera_moves\` lists them all).

## Steps

1. Read the shots against the scene. Adjust what does not serve it with \`shot_update\`: framing, a camera move,
   a lens, an end frame, a motion reference (docs: directing).
2. Generate the clip (\`clip_generate\`) or the shots you changed (\`shot_regenerate\`); wait with \`job_wait\`.
3. Where a shot is not right yet, make variations (\`shot_variations\` or \`batch_variations\`), compare them and pick
   one (\`take_select\`).
4. Show the user each step in the studio (\`ui_focus\` on the shot, \`ui_notify\`), and ask before approving
   (\`clip_approve\`).
`;
}

function noteLine(c: CommentThread, docs: ProjectDocs): string {
  const where =
    c.target.kind === 'export'
      ? `export \`${c.target.exportId}\``
      : (() => {
          const t = c.target;
          const clip = docs.clips[t.clipId];
          const shot = clip?.shots.find((s) => s.id === t.shotId);
          return `take \`${t.takeId}\` of clip ${clip ? clip.index + 1 : '?'} shot ${shot ? shot.index + 1 : '?'} (clipId \`${t.clipId}\`, shotId \`${t.shotId}\`)`;
        })();
  const drawing = c.annotation
    ? ` [drawing: ${c.annotation.shapes.map((s) => (s.kind === 'stroke' ? 'stroke' : `${s.kind} ${s.from.map((v) => v.toFixed(2)).join(',')}→${s.to.map((v) => v.toFixed(2)).join(',')}`)).join('; ')}]`
    : '';
  const replies = c.replies.map((r) => `\n  - ${r.author.name}: ${r.body}`).join('');
  return `\`${c.id}\` on ${where}${c.at !== null ? ` at ${sec(c.at)}` : ''}, by ${c.author.name}: “${c.body}”${drawing}${replies}`;
}

export function reviewNotesPrompt(docs: ProjectDocs, reviewId?: string): string {
  const review = reviewId ? docs.reviews[reviewId] : undefined;
  if (reviewId && !review) throw new Error(`review ${reviewId} not found`);
  const open = Object.values(docs.comments).filter((c) => c.status === 'open');
  const notes = review
    ? open.filter(
        (c) =>
          c.reviewId === review.id ||
          threadsFor(docs.comments, c.target).some((t) => t.reviewId === review.id),
      )
    : open;
  return `# Address the review notes of “${docs.project.title}”

Project \`${docs.project.id}\`${review ? `, review “${review.title}” (\`${review.id}\`, ${review.status})` : ''}.

## Open notes (${notes.length})

${notes.length ? bullet(notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((c) => noteLine(c, docs))) : '_None: everything is addressed._'}

## Steps

For each note, in order:

1. Decide what answers it: a take edit (\`take_edit\`: relight, restyle, replace, remove), a new take
   (\`shot_regenerate\`, \`shot_variations\`), a change of directing (\`shot_update\`), or a change of the cut
   (\`timeline_apply\`: trims, transitions, titles).
2. Do it, and wait for its jobs (\`job_wait\`).
3. Reply on the thread with what changed (\`comment_reply\`), then resolve it (\`comment_resolve\`). When a note
   asks for something you should not decide, reply with the question instead and leave it open.

${review ? 'When every note is answered, tell the user the review can be decided again (`review_decide` is theirs or the client’s).' : 'Then tell the user what you changed.'}
`;
}

export function castVoicesPrompt(docs: ProjectDocs): string {
  const speaking = speakingCharacters(docs);
  return `# Cast the voices of “${docs.project.title}”

Project \`${docs.project.id}\`.

## Speaking characters

${
  bullet(
    speaking.map((c) => {
      const v = voiceOf(c);
      return `${c.name} (\`${c.id}\`): ${voiceStatus(c)}${v.description ? ` — “${v.description}”` : ''}${v.candidates.length ? `; ${v.candidates.length} candidate(s)` : ''}`;
    }),
  ) || '_Nobody speaks yet._'
}

## Steps

1. \`voices_cast\` designs candidates for everyone without a voice (or \`character_voice_design\` one by one, with a
   description that fits the character).
2. Let the user audition them in the Cast view (\`ui_navigate\` to \`cast\`), then select (\`character_voice_select\`)
   or clone a recording with consent (\`character_voice_clone\`).
3. Lock every voice (\`character_voice_lock\`): shots with dialogue need locked voices.
`;
}

export function dubPrompt(docs: ProjectDocs, language: string): string {
  const existing = Object.values(docs.localizations ?? {}).map((l) => languageName(l.id));
  const lines = (docs.timeline?.tracks ?? [])
    .flatMap((t) => t.items)
    .filter((i) => i.kind === 'text' && i.style.preset === 'caption').length;
  return `# Dub “${docs.project.title}” into ${languageName(language)} (\`${language}\`)

Project \`${docs.project.id}\`. ${lines} caption line(s) in the cut; languages so far: ${existing.length ? existing.join(', ') : 'none'}.

## Steps

1. \`localize\` with \`language: "${language}"\`, \`dub: true\` (and \`lipSync: true\` for close-ups); wait for the job.
2. Read the translations (\`localization_get\`) and correct what is off (\`translation_update\`); dub again where a line
   changed.
3. Export the variant (\`export_render\` with \`language\`, \`dubbed: true\`, captions as files), and tell the user
   where to find it (\`ui_navigate\` to \`exports\`).
`;
}

export function variationsPrompt(docs: ProjectDocs, clipId: string): string {
  const clip = docs.clips[clipId];
  if (!clip) throw new Error(`clip ${clipId} not found`);
  return `# Variations of clip ${clip.index + 1} of “${docs.project.title}”

Project \`${docs.project.id}\`, clip \`${clip.id}\` (${clip.status}).

## Shots

${bullet(shotLines(clip, docs))}

## Steps

1. \`batch_variations\` with \`clipId: "${clip.id}"\` (2–4 per shot), or only the shots that need them (\`shotIds\`).
2. Compare the takes of each shot (the Clips view's A/B comparison; \`ui_focus\` on a shot).
3. Select the best take of each shot (\`take_select\`), and ask the user before approving the clip.
`;
}
