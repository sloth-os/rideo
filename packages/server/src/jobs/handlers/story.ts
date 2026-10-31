import {
  appendScenes,
  approvedElementReferences,
  approvedReferences,
  briefAdaptation,
  briefHash,
  CHARACTER_VIEWS,
  type Character,
  type Consent,
  compileElementReferenceRequest,
  compileReferenceEditRequest,
  compileReferenceRequest,
  dialogueDirection,
  docPath,
  type Element,
  type ElementReferenceView,
  type GatewayImageRequest,
  identityFragment,
  identityFromLlm,
  MAX_ANCHOR_IMAGES,
  type MediaRef,
  newId,
  nextUnwrittenBeats,
  type Project,
  type ProjectSettings,
  promptVersionOf,
  REFERENCE_EDIT_MAX_EARLIER,
  type ReferenceCheckInput,
  type ReferenceCheckOutput,
  type ReferenceView,
  type Resource,
  type Screenplay,
  screenplayFromLlm,
  shotRangeFor,
  slugify,
  type VideoModelFacts,
  videoFacts,
  workingBrief,
} from '@rideo/shared';
import type { LabelledImage } from '../../ai/tasks';
import { AppError, notFound } from '../../errors';
import { sampleFrames } from '../../media/frames';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { commitAs, docsFor, gatewayOptions, type HandlerDeps } from './common';

/**
 * Prompt version 2 of the writing tasks (docs/design/continuity.md#storytelling): the dialogue level and the longest
 * line a shot of the video model can speak; what the video model films well and badly, and whether only the cast may
 * appear, as the screenplay's reviewer is told (docs/design/first-pass.md#one-rubric-for-the-maker-and-the-reviewer).
 */
async function writingDirection(deps: HandlerDeps, settings: ProjectSettings) {
  if (promptVersionOf(settings) < 2) return { version: 1 as const, direction: {} };
  const { limits } = await deps.gateway.limitsFor('video', settings.models.video);
  // A sequence's shots last at most 5 s, and so do the lines (docs/design/multi-shot.md#planning-for-sequences)
  const maxShot = shotRangeFor(settings, limits).max;
  return {
    version: 2 as const,
    direction: {
      ...dialogueDirection(settings.dialogue?.level ?? 'any', maxShot),
      video: videoFacts(limits, settings),
      castOnly: settings.consistency.castOnly === true,
    },
  };
}

export async function screenplayGenerate(deps: HandlerDeps, ctx: JobContext) {
  const docs = await docsFor(deps, ctx);
  const p = docs.project;
  const projectId = p.id;
  const images: LabelledImage[] = [];
  let videoFrames = 0;
  ctx.progress(0.05, 1, 'reading attachments');
  for (const rid of p.brief.attachmentResourceIds) {
    const r = docs.resources[rid];
    if (!r) continue;
    if (r.kind === 'image')
      images.push({
        label: `Attachment image “${r.name}”:`,
        data: await deps.media.pngBuffer(projectId, r.media, 768),
        mime: 'image/png',
      });
    if (r.kind === 'video') {
      const local = await deps.media.localPath(projectId, r.media);
      await deps.media.withTmpDir(async (dir) => {
        const frames = await sampleFrames(deps.ff, local, r.media.durationSec ?? 3, dir, 'att', {
          fractions: [0.2, 0.5, 0.8],
          maxWidth: 512,
          signal: ctx.signal,
        });
        for (const [i, f] of frames.entries()) {
          images.push({
            label: i === 0 ? `Attachment video “${r.name}” frames:` : undefined,
            data: await deps.media.filePng(f, 512),
            mime: 'image/png',
          });
          videoFrames++;
        }
      });
    }
  }
  const attachments: { kind: 'image' | 'video'; description: string }[] = [];
  if (images.length) {
    ctx.progress(0.15, 1, 'describing attachments');
    const d = await deps.llm.describeMedia(
      { imageCount: images.length - videoFrames, videoFrameCount: videoFrames, prompt: p.brief.prompt },
      images,
      ctx.signal,
    );
    const people = d.people.map((x) => `${x.label}: ${x.description}`).join('; ');
    attachments.push({
      kind: videoFrames ? 'video' : 'image',
      description: `${d.summary} Style: ${d.style}. Setting: ${d.setting}.${people ? ` People: ${people}.` : ''}`,
    });
  }
  const writing = await writingDirection(deps, p.settings);
  // The brief adapted for the video model before it is written (docs/design/first-pass.md#the-brief-adapted-for-the-video-model)
  const prompt = await adaptBrief(
    deps,
    ctx,
    p,
    'video' in writing.direction ? writing.direction.video : undefined,
  );
  ctx.progress(0.3, 1, 'writing the screenplay');
  const out = await deps.llm.generateScreenplay(
    {
      prompt,
      targetDurationSec: p.settings.targetDurationSec,
      pilotDurationSec: p.settings.pilotDurationSec,
      language: p.settings.language,
      aspectRatio: p.settings.aspectRatio,
      attachments,
      ...writing.direction,
    },
    ctx.signal,
    writing.version,
  );
  throwIfAborted(ctx.signal);
  ctx.progress(0.9, 1, 'saving');
  const { result } = await commitAs(
    deps,
    ctx,
    (tx) => {
      const existing = tx.list<Character>('characters/');
      const existingElements = tx.list<Element>('elements/');
      const { screenplay, characters, elements } = screenplayFromLlm(out, {
        targetDurationSec: p.settings.targetDurationSec,
        language: p.settings.language,
        existing,
        existingElements,
      });
      tx.set('screenplay.json', screenplay);
      // A brief that allows only its cast turns the check on (docs/design/continuity.md#quality-checks-in-the-gate)
      const project = tx.require<Project>(docPath.project(), 'project');
      const castOnly = out.castOnly && !project.settings.consistency.castOnly;
      if (castOnly)
        tx.set(docPath.project(), {
          ...project,
          settings: { ...project.settings, consistency: { ...project.settings.consistency, castOnly: true } },
        });
      for (const c of characters) tx.set(docPath.character(c.id), c);
      // Locations and props the writer introduced become draft elements (docs/design/elements.md).
      for (const e of elements) tx.set(docPath.element(e.id), e);
      return {
        title: screenplay.title,
        scenes: screenplay.scenes.length,
        beats: screenplay.outline.length,
        characters: characters.length,
        elements: elements.length,
        castOnly,
      };
    },
    (r) =>
      `Generate screenplay “${r.title}” (${r.beats} beats, ${r.scenes} scenes, ${r.characters} characters, ${r.elements} locations and props)${r.castOnly ? '; only the cast may appear' : ''}`,
  );
  // The screenplay is reviewed before the cast is made (docs/design/ai-review.md#how-a-review-runs)
  await deps.services.aiReviews
    .followUp(ctx.actor, projectId, 'screenplay')
    .catch((err) => ctx.log.warn({ err: (err as Error).message }, 'could not queue the screenplay review'));
  return result;
}

/**
 * The brief the screenplay is written from (docs/design/first-pass.md#the-brief-adapted-for-the-video-model): with
 * `settings.brief.adapt`, the moments the video model renders badly in their filmable form, kept on the project
 * (`brief.adapted`) beside the brief as written, and adapted again only when the brief changed. Any failure writes from
 * the brief as it is.
 */
async function adaptBrief(
  deps: HandlerDeps,
  ctx: JobContext,
  project: Project,
  video: VideoModelFacts | undefined,
): Promise<string> {
  if (!project.settings.brief?.adapt || !video) return project.brief.prompt;
  const kept = briefAdaptation(project);
  if (kept) return kept.prompt;
  ctx.progress(0.25, 1, 'adapting the brief for the video model');
  try {
    const out = await deps.llm.adaptBrief(
      { prompt: project.brief.prompt, targetDurationSec: project.settings.targetDurationSec, video },
      ctx.signal,
    );
    const prompt = out.moments.length && out.prompt.trim() ? out.prompt.trim() : project.brief.prompt;
    deps.metrics.briefAdaptations.inc({ outcome: out.moments.length ? 'adapted' : 'unchanged' });
    ctx.log.info(
      { projectId: project.id, moments: out.moments.map((m) => m.asked) },
      'brief adapted for the video model',
    );
    await commitAs(
      deps,
      ctx,
      (tx) => {
        const cur = tx.require<Project>(docPath.project(), 'project');
        tx.set(docPath.project(), {
          ...cur,
          brief: {
            ...cur.brief,
            adapted: {
              of: briefHash(project.brief.prompt),
              prompt,
              moments: out.moments.slice(0, 20),
              model: deps.llm.text.model,
              at: new Date().toISOString(),
            },
          },
        });
      },
      `Adapt the brief for the video model (${out.moments.length} moment(s))`,
    );
    return prompt;
  } catch (err) {
    throwIfAborted(ctx.signal);
    deps.metrics.briefAdaptations.inc({ outcome: 'error' });
    ctx.log.warn(
      { projectId: project.id, err: (err as Error).message },
      'could not adapt the brief; writing from it as it is',
    );
    return project.brief.prompt;
  }
}

export async function screenplayExtend(deps: HandlerDeps, ctx: JobContext) {
  const docs = await docsFor(deps, ctx);
  const sp = docs.screenplay;
  if (!sp) throw new AppError('validation_error', 'no screenplay to extend');
  const beats = nextUnwrittenBeats(sp, Number(ctx.job.params.beats ?? 3));
  if (!beats.length) return { added: 0 };
  const characters = Object.values(docs.characters);
  const writing = await writingDirection(deps, docs.project.settings);
  // Version 2: the brief, the last written scene in full and the beats after these (docs/design/continuity.md).
  const written = sp.scenes.slice().sort((a, b) => a.index - b.index);
  const last = written[written.length - 1];
  const after = nextUnwrittenBeats(sp, beats.length + 3).slice(beats.length);
  const v2 =
    writing.version === 2
      ? {
          brief: workingBrief(docs.project),
          ...(last
            ? {
                lastScene: {
                  heading: last.heading,
                  timeOfDay: last.timeOfDay,
                  continuity: last.continuity ?? '',
                  summary: last.summary,
                  action: last.action.slice(0, 4000),
                  dialogue: last.dialogue.map((d) => ({ character: d.character, line: d.line })),
                },
              }
            : {}),
          upcomingBeats: after.map((b) => ({
            index: b.index,
            title: b.title,
            summary: b.summary,
            purpose: b.purpose ?? '',
          })),
          ...writing.direction,
        }
      : {};
  const out = await deps.llm.extendScreenplay(
    {
      title: sp.title,
      logline: sp.logline,
      synopsis: sp.synopsis,
      language: sp.language,
      characters: characters.map((c) => ({ name: c.name, summary: c.summary })),
      locations: Object.values(docs.elements)
        .filter((e) => e.kind === 'location')
        .map((e) => ({ name: e.name, description: e.description })),
      props: Object.values(docs.elements)
        .filter((e) => e.kind === 'prop')
        .map((e) => ({ name: e.name, description: e.description })),
      previousScenes: sp.scenes
        .slice(-6)
        .map((s) => ({ index: s.index, heading: s.heading, summary: s.summary || s.action.slice(0, 300) })),
      beats: beats.map((b) => ({
        index: b.index,
        title: b.title,
        summary: b.summary,
        estDurationSec: b.estDurationSec,
        ...(writing.version === 2 ? { purpose: b.purpose ?? '' } : {}),
      })),
      ...v2,
    },
    ctx.signal,
    writing.version,
  );
  const wanted = new Set(beats.map((b) => b.index));
  const scenes = out.scenes
    .filter((s, i) => wanted.has(s.beatIndex ?? beats[i]?.index ?? -1))
    .map((s, i) => ({ ...s, beatIndex: s.beatIndex ?? beats[i]?.index }));
  const { result } = await commitAs(
    deps,
    ctx,
    (tx) => {
      const current = tx.require<Screenplay>('screenplay.json', 'screenplay');
      const existingElements = tx.list<Element>('elements/');
      const { screenplay, added, elements } = appendScenes(
        current,
        scenes,
        tx.list<Character>('characters/'),
        {
          existing: existingElements,
          introduced: { locations: out.locations, props: out.props },
        },
      );
      tx.set('screenplay.json', screenplay);
      for (const e of elements)
        if (
          !existingElements.some((x) => x.id === e.id) ||
          e.description !== existingElements.find((x) => x.id === e.id)?.description
        )
          tx.set(docPath.element(e.id), e);
      return added.length;
    },
    (n) => `Write ${n} more scene(s) from the outline`,
  );
  return { added: result };
}

export async function characterRefs(deps: HandlerDeps, ctx: JobContext) {
  const { characterId } = ctx.job.params as { characterId: string };
  const views = (ctx.job.params.views as ReferenceView[] | undefined) ?? CHARACTER_VIEWS;
  // A redraw the cast review asked for: what it must fix, and the references it replaces once its views are drawn
  const { direction, replaces = [] } = ctx.job.params as { direction?: string; replaces?: string[] };
  const projectId = ctx.job.projectId;
  let done = 0;
  // The views this job drew, sent with each next view beside the anchor (docs/design/first-pass.md#references-drawn-from-a-whole-figure)
  const drawn: MediaRef[] = [];
  for (const view of views) {
    throwIfAborted(ctx.signal);
    const docs = await docsFor(deps, ctx);
    const c = docs.characters[characterId];
    if (!c) throw notFound(`character ${characterId}`);
    if (c.lock.locked)
      throw new AppError('character_locked', `${c.name} was locked while references were generating`);
    const anchor = approvedReferences(c)[0] ?? c.references[0];
    const baseImageUri = anchor ? await deps.media.pngDataUri(projectId, anchor.media, 1024) : undefined;
    const baseImageUris = await Promise.all(
      drawn
        .filter((m) => m.hash !== anchor?.media.hash)
        .map((m) => deps.media.pngDataUri(projectId, m, 1024)),
    );
    ctx.progress(done, views.length, `${c.name}: ${view.replace('_', ' ')} view`);
    const media = await drawReference(deps, ctx, {
      request: (attempt, correction) =>
        compileReferenceRequest(c, view, {
          screenplay: docs.screenplay,
          settings: docs.project.settings,
          baseImageUri,
          baseImageUris,
          model: docs.project.settings.models.image,
          direction,
          attempt,
          correction,
        }),
      step: `ref-${view}`,
      name: `${slugify(c.name)}-${view}`,
      check: {
        subject: { kind: 'character', name: c.name, description: identityFragment(c) },
        view,
        earlier: 0,
      },
      earlier: [...(anchor ? [anchor.media] : []), ...drawn.filter((m) => m.hash !== anchor?.media.hash)],
      settings: docs.project.settings,
    });
    drawn.push(media);
    await commitAs(
      deps,
      ctx,
      (tx) => {
        const cur = tx.require<Character>(docPath.character(characterId), `character ${characterId}`);
        if (cur.lock.locked) throw new AppError('character_locked', `${cur.name} is locked`);
        tx.set(docPath.character(characterId), {
          ...cur,
          references: [
            ...cur.references,
            {
              id: newId('reference'),
              view,
              media,
              source: 'generated',
              approved: false,
              createdAt: new Date().toISOString(),
            },
          ],
        });
      },
      `Generate ${view.replace('_', ' ')} reference for ${c.name}`,
    );
    done++;
  }
  ctx.progress(done, views.length, 'done');
  const dismissed = await dismissReplaced(
    ctx,
    replaces,
    async (id) => (await docsFor(deps, ctx)).characters[characterId]?.references.find((x) => x.id === id),
    (id) => deps.services.story.deleteReference(ctx.actor, projectId, characterId, id),
  );
  await castFollowUp(deps, ctx);
  return { generated: done, ...(dismissed ? { dismissed } : {}) };
}

/**
 * Draws one reference view (docs/design/first-pass.md#references-that-match-their-subject): with prompt version 3 it
 * is checked against its subject and the views before it (`reference.check`) and drawn again, within
 * `consistency.maxAttempts`, while it adds, drops or changes something; the first that matches is kept, else the one
 * with the fewest issues. A check that cannot run keeps the view.
 */
async function drawReference(
  deps: HandlerDeps,
  ctx: JobContext,
  opts: {
    /** The request of an attempt; after a failed check, with what it found wrong to correct. */
    request: (attempt: number, correction?: string) => GatewayImageRequest;
    /** The gateway idempotency step of the view. */
    step: string;
    name: string;
    check: ReferenceCheckInput;
    /** The anchor and the views drawn before, which the new view must agree with. */
    earlier: MediaRef[];
    settings: ProjectSettings;
  },
): Promise<MediaRef> {
  const projectId = ctx.job.projectId;
  const checked = promptVersionOf(opts.settings) >= 3 && opts.settings.consistency.maxAttempts > 1;
  const attempts = checked ? opts.settings.consistency.maxAttempts : 1;
  const earlier = checked
    ? await Promise.all(
        opts.earlier.slice(0, MAX_ANCHOR_IMAGES).map((m) => deps.media.pngBuffer(projectId, m, 512)),
      )
    : [];
  let best: { media: MediaRef; issues: number } | null = null;
  let correction: string | undefined;
  // The view the last check found wrong, which the next attempt edits
  // (docs/design/first-pass.md#references-that-match-their-subject)
  let toEdit: { media: MediaRef; fix: string } | null = null;
  const kind = opts.check.subject.kind === 'character' ? 'character' : 'element';
  for (let attempt = 0; attempt < attempts; attempt++) {
    throwIfAborted(ctx.signal);
    const request = toEdit
      ? compileReferenceEditRequest(opts.request(attempt), {
          viewUri: await deps.media.dataUri(projectId, toEdit.media),
          fix: toEdit.fix,
          earlierUris: await Promise.all(
            opts.earlier
              .slice(0, REFERENCE_EDIT_MAX_EARLIER)
              .map((m) => deps.media.pngDataUri(projectId, m, 1024)),
          ),
        })
      : opts.request(attempt, correction);
    if (toEdit) deps.metrics.referenceEdits.inc({ kind });
    toEdit = null;
    const task = await deps.gateway.generateImage(request, gatewayOptions(ctx, 'image', opts.step, attempt));
    const media = await deps.media.importUri(projectId, task.outputs![0]!.uri, {
      kind: 'refs',
      name: attempt ? `${opts.name}-a${attempt + 1}` : opts.name,
      signal: ctx.signal,
    });
    if (!checked) return media;
    let out: ReferenceCheckOutput;
    try {
      out = await deps.llm.checkReference(
        { ...opts.check, earlier: earlier.length },
        earlier,
        await deps.media.pngBuffer(projectId, media, 768),
        ctx.signal,
      );
    } catch (err) {
      throwIfAborted(ctx.signal);
      deps.metrics.referenceChecks.inc({ kind, outcome: 'error' });
      ctx.log.warn({ projectId, err: (err as Error).message }, 'could not check the reference; keeping it');
      return media;
    }
    deps.metrics.referenceChecks.inc({ kind, outcome: out.matches ? 'matched' : 'mismatched' });
    if (out.matches) return media;
    ctx.log.info(
      { projectId, subject: opts.check.subject.name, view: opts.check.view, attempt, issues: out.issues },
      'the reference does not match its subject; drawing it again',
    );
    if (!best || out.issues.length < best.issues) best = { media, issues: out.issues.length };
    correction = out.fix.trim() || out.issues.join('; ') || undefined;
    if (out.fix.trim()) toEdit = { media, fix: out.fix.trim() };
  }
  return best!.media;
}

/**
 * Dismisses the references a redraw replaced once its views are drawn (docs/design/ai-review.md#how-a-review-runs):
 * those still generated and not approved since; a person who approved one meanwhile keeps it.
 */
async function dismissReplaced(
  ctx: JobContext,
  replaces: string[],
  find: (id: string) => Promise<{ source: string; approved: boolean } | undefined>,
  remove: (id: string) => Promise<unknown>,
): Promise<number> {
  let n = 0;
  for (const id of replaces) {
    throwIfAborted(ctx.signal);
    const r = await find(id);
    if (r?.source !== 'generated' || r.approved) continue;
    await remove(id);
    n++;
  }
  return n;
}

/**
 * The cast is reviewed once every character and element in use has a reference (docs/design/ai-review.md), by the
 * last reference job to finish: a review made while views are still being drawn would be outdated at once.
 */
async function castFollowUp(deps: HandlerDeps, ctx: JobContext): Promise<void> {
  // A cast review drawing references again (a round's fix) reviews them itself when they are drawn
  if (ctx.job.parentId && deps.jobs.find(ctx.job.parentId)?.kind === 'cast.review') return;
  const docs = await docsFor(deps, ctx);
  if (docs.project.workflow.stage !== 'cast') return;
  if (activeReferenceJobs(deps, ctx).length) return;
  await deps.services.aiReviews
    .followUp(ctx.actor, ctx.job.projectId, 'cast')
    .catch((err) => ctx.log.warn({ err: (err as Error).message }, 'could not queue the cast review'));
}

/** The reference jobs of the project still queued or running, besides this one. */
export function activeReferenceJobs(deps: HandlerDeps, ctx: JobContext) {
  return deps.jobs
    .list(ctx.job.projectId)
    .filter(
      (j) =>
        (j.kind === 'character.refs' || j.kind === 'element.refs') &&
        j.id !== ctx.job.id &&
        (j.status === 'queued' || j.status === 'running'),
    );
}

/** Reference views of a location, prop or style (docs/design/elements.md#jobs). */
export async function elementRefs(deps: HandlerDeps, ctx: JobContext) {
  const { elementId } = ctx.job.params as { elementId: string };
  const views = (ctx.job.params.views as ElementReferenceView[] | undefined) ?? [];
  const { direction, replaces = [] } = ctx.job.params as { direction?: string; replaces?: string[] };
  const projectId = ctx.job.projectId;
  let done = 0;
  for (const view of views) {
    throwIfAborted(ctx.signal);
    const docs = await docsFor(deps, ctx);
    const e = docs.elements[elementId];
    if (!e) throw notFound(`element ${elementId}`);
    if (e.lock.locked)
      throw new AppError('element_locked', `${e.name} was locked while references were generating`);
    const anchor = approvedElementReferences(e)[0] ?? e.references[0];
    const baseImageUri = anchor ? await deps.media.pngDataUri(projectId, anchor.media, 1024) : undefined;
    ctx.progress(done, views.length, `${e.name}: ${view} view`);
    const media = await drawReference(deps, ctx, {
      request: (attempt, correction) =>
        compileElementReferenceRequest(e, view, {
          screenplay: docs.screenplay,
          settings: docs.project.settings,
          baseImageUri,
          model: docs.project.settings.models.image,
          direction,
          attempt,
          correction,
        }),
      step: `element-ref-${view}`,
      name: `element-${slugify(e.name)}-${view}`,
      check: {
        subject: { kind: e.kind, name: e.name, description: e.description || e.name },
        view,
        earlier: 0,
      },
      earlier: anchor ? [anchor.media] : [],
      settings: docs.project.settings,
    });
    await commitAs(
      deps,
      ctx,
      (tx) => {
        const cur = tx.require<Element>(docPath.element(elementId), `element ${elementId}`);
        if (cur.lock.locked) throw new AppError('element_locked', `${cur.name} is locked`);
        tx.set(docPath.element(elementId), {
          ...cur,
          references: [
            ...cur.references,
            {
              id: newId('reference'),
              view,
              media,
              source: 'generated',
              approved: false,
              createdAt: new Date().toISOString(),
            },
          ],
        });
      },
      `Generate ${view} reference for ${e.name}`,
    );
    done++;
  }
  ctx.progress(done, views.length, 'done');
  const dismissed = await dismissReplaced(
    ctx,
    replaces,
    async (id) => (await docsFor(deps, ctx)).elements[elementId]?.references.find((x) => x.id === id),
    (id) => deps.services.elements.deleteReference(ctx.actor, projectId, elementId, id),
  );
  await castFollowUp(deps, ctx);
  return { generated: done, ...(dismissed ? { dismissed } : {}) };
}

export async function characterDescribe(deps: HandlerDeps, ctx: JobContext) {
  const { characterId, resourceId, consent } = ctx.job.params as {
    characterId: string;
    resourceId: string;
    consent?: Consent;
  };
  const docs = await docsFor(deps, ctx);
  const c = docs.characters[characterId];
  const r = docs.resources[resourceId] as Resource | undefined;
  if (!c) throw notFound(`character ${characterId}`);
  if (!r) throw notFound(`resource ${resourceId}`);
  const png = await deps.media.pngBuffer(ctx.job.projectId, r.media, 1024);
  const out = await deps.llm.describeCharacter(
    { name: c.name },
    { label: 'Photo:', data: png, mime: 'image/png' },
    ctx.signal,
  );
  await commitAs(
    deps,
    ctx,
    (tx) => {
      const cur = tx.require<Character>(docPath.character(characterId), `character ${characterId}`);
      if (cur.lock.locked) throw new AppError('character_locked', `${cur.name} is locked`);
      const hasRef = cur.references.some((x) => x.media.hash === r.media.hash);
      tx.set(docPath.character(characterId), {
        ...cur,
        summary: out.summary || cur.summary,
        identity: identityFromLlm(out.identity),
        wardrobe: out.wardrobe.length
          ? out.wardrobe.map((w, i) => ({
              id: newId('wardrobe'),
              name: w.name,
              description: w.description,
              ...(i === 0 ? { default: true } : {}),
            }))
          : cur.wardrobe,
        references: hasRef
          ? cur.references
          : [
              ...cur.references,
              {
                id: newId('reference'),
                view: 'front',
                media: r.media,
                source: 'uploaded',
                approved: true,
                createdAt: new Date().toISOString(),
                ...(consent ? { consent } : {}),
              },
            ],
      });
    },
    `Describe ${c.name} from photo ${r.name}`,
  );
  return { characterId };
}

export async function musicGenerate(deps: HandlerDeps, ctx: JobContext) {
  const { prompt, durationSec, instrumental } = ctx.job.params as {
    prompt: string;
    durationSec: number;
    instrumental: boolean;
  };
  const docs = await docsFor(deps, ctx);
  const model = docs.project.settings.models.music;
  ctx.progress(0.1, 1, 'composing');
  const task = await deps.gateway.generateMusic(
    {
      ...(model && model !== 'auto' ? { model } : {}),
      input: [{ type: 'text', text: prompt }],
      parameters: { duration_seconds: durationSec, instrumental, file_format: 'mp3' },
    },
    gatewayOptions(ctx, 'music', 'music'),
  );
  const media = await deps.media.importUri(ctx.job.projectId, task.outputs![0]!.uri, {
    kind: 'music',
    name: slugify(prompt, 32),
    signal: ctx.signal,
  });
  const resource: Resource = {
    id: newId('resource'),
    kind: 'audio',
    role: 'music',
    name: prompt.slice(0, 80),
    media,
    createdAt: new Date().toISOString(),
    origin: 'generated',
    status: 'ready',
    generation: { prompt, model: task.model || undefined, taskId: task.id },
  };
  await commitAs(
    deps,
    ctx,
    (tx) => tx.set(docPath.resource(resource.id), resource),
    `Generate music “${resource.name}”`,
  );
  return { resourceId: resource.id };
}
