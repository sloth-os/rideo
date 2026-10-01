import {
  appendScenes,
  approvedElementReferences,
  approvedReferences,
  type Character,
  type Consent,
  compileElementReferenceRequest,
  compileReferenceRequest,
  docPath,
  type Element,
  type ElementReferenceView,
  identityFromLlm,
  newId,
  nextUnwrittenBeats,
  type ReferenceView,
  type Resource,
  type Screenplay,
  screenplayFromLlm,
  slugify,
} from '@rideo/shared';
import type { LabelledImage } from '../../ai/tasks';
import { AppError, notFound } from '../../errors';
import { sampleFrames } from '../../media/frames';
import { throwIfAborted } from '../../util/abort';
import type { JobContext } from '../queue';
import { commitAs, docsFor, gatewayOptions, type HandlerDeps } from './common';

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
  ctx.progress(0.3, 1, 'writing the screenplay');
  const out = await deps.llm.generateScreenplay(
    {
      prompt: p.brief.prompt,
      targetDurationSec: p.settings.targetDurationSec,
      pilotDurationSec: p.settings.pilotDurationSec,
      language: p.settings.language,
      aspectRatio: p.settings.aspectRatio,
      attachments,
    },
    ctx.signal,
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
      for (const c of characters) tx.set(docPath.character(c.id), c);
      // Locations and props the writer introduced become draft elements (docs/design/elements.md).
      for (const e of elements) tx.set(docPath.element(e.id), e);
      return {
        title: screenplay.title,
        scenes: screenplay.scenes.length,
        beats: screenplay.outline.length,
        characters: characters.length,
        elements: elements.length,
      };
    },
    (r) =>
      `Generate screenplay “${r.title}” (${r.beats} beats, ${r.scenes} scenes, ${r.characters} characters, ${r.elements} locations and props)`,
  );
  return result;
}

export async function screenplayExtend(deps: HandlerDeps, ctx: JobContext) {
  const docs = await docsFor(deps, ctx);
  const sp = docs.screenplay;
  if (!sp) throw new AppError('validation_error', 'no screenplay to extend');
  const beats = nextUnwrittenBeats(sp, Number(ctx.job.params.beats ?? 3));
  if (!beats.length) return { added: 0 };
  const characters = Object.values(docs.characters);
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
      })),
    },
    ctx.signal,
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
  const views = (ctx.job.params.views as ReferenceView[] | undefined) ?? [
    'front',
    'three_quarter',
    'profile',
    'full_body',
  ];
  const projectId = ctx.job.projectId;
  let done = 0;
  for (const view of views) {
    throwIfAborted(ctx.signal);
    const docs = await docsFor(deps, ctx);
    const c = docs.characters[characterId];
    if (!c) throw notFound(`character ${characterId}`);
    if (c.lock.locked)
      throw new AppError('character_locked', `${c.name} was locked while references were generating`);
    const anchor = approvedReferences(c)[0] ?? c.references[0];
    const baseImageUri = anchor ? await deps.media.pngDataUri(projectId, anchor.media, 1024) : undefined;
    const req = compileReferenceRequest(c, view, {
      screenplay: docs.screenplay,
      settings: docs.project.settings,
      baseImageUri,
      model: docs.project.settings.models.image,
    });
    ctx.progress(done, views.length, `${c.name}: ${view.replace('_', ' ')} view`);
    const task = await deps.gateway.generateImage(req, gatewayOptions(ctx, 'image', `ref-${view}`));
    const media = await deps.media.importUri(projectId, task.outputs![0]!.uri, {
      kind: 'refs',
      name: `${slugify(c.name)}-${view}`,
      signal: ctx.signal,
    });
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
  return { generated: done };
}

/** Reference views of a location, prop or style (docs/design/elements.md#jobs). */
export async function elementRefs(deps: HandlerDeps, ctx: JobContext) {
  const { elementId } = ctx.job.params as { elementId: string };
  const views = (ctx.job.params.views as ElementReferenceView[] | undefined) ?? [];
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
    const req = compileElementReferenceRequest(e, view, {
      screenplay: docs.screenplay,
      settings: docs.project.settings,
      baseImageUri,
      model: docs.project.settings.models.image,
    });
    ctx.progress(done, views.length, `${e.name}: ${view} view`);
    const task = await deps.gateway.generateImage(req, gatewayOptions(ctx, 'image', `element-ref-${view}`));
    const media = await deps.media.importUri(projectId, task.outputs![0]!.uri, {
      kind: 'refs',
      name: `element-${slugify(e.name)}-${view}`,
      signal: ctx.signal,
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
  return { generated: done };
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
