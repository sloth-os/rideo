import {
  type Actor,
  approvedReferences,
  type Character,
  type CharacterInput,
  type CharacterUpdateInput,
  type Consent,
  type ConsentInput,
  canonicalJson,
  characterSeed,
  docPath,
  type Job,
  kindFromMime,
  missingConsentFields,
  newId,
  newVoice,
  type OutlineBeat,
  type Probe,
  type Project,
  type ReferenceView,
  type Resource,
  type ResourceInput,
  type Scene,
  type Screenplay,
  type ScreenplayPatchInput,
  ScreenplaySchema,
  type Voice,
  voiceOf,
} from '@rideo/shared';
import { AppError, invalid, notFound } from '../errors';
import type { MediaStore } from '../media/store';
import { sha256 } from '../util/crypto';
import { Service } from './base';

const IDENTITY_KEYS = ['name', 'identity', 'wardrobe'] as const;

export function identityHash(c: Character): string {
  return sha256(
    canonicalJson({
      name: c.name,
      identity: c.identity,
      wardrobe: c.wardrobe.map(({ name, description }) => ({ name, description })),
      references: approvedReferences(c)
        .map((r) => r.media.hash)
        .sort(),
    }),
  );
}

export type UploadSource = { uri: string } | { file: string; filename: string; mime?: string };

/**
 * The consent record of an uploaded likeness (docs/design/provenance.md#consent-records): the uploader must state
 * whether it shows a real person, and a real person needs the subject, who consented and when.
 */
export function consentRecord(actor: Actor, input: ConsentInput | undefined, what: string): Consent {
  if (!input) {
    throw new AppError(
      'consent_required',
      `State whether the ${what} depicts a real person (consent.depictsRealPerson)`,
      ['depictsRealPerson'],
    );
  }
  const missing = missingConsentFields(input);
  if (missing.length) {
    throw new AppError(
      'consent_required',
      `The ${what} depicts a real person: record the consent (${missing.join(', ')})`,
      missing,
    );
  }
  return { ...input, recordedBy: actor, recordedAt: new Date().toISOString() };
}

/** Rule V2: a locked voice keeps its description (docs/design/dialogue.md#rules). */
function describeVoice(c: Character, description: string): Voice {
  const v = voiceOf(c);
  if (v.description === description) return v;
  if (v.lock.locked)
    throw new AppError(
      'voice_locked',
      `${c.name}'s voice is locked; unlock the voice before changing its description (rule V2)`,
    );
  return { ...v, description };
}

export class StoryService extends Service {
  /** Sets the brief (optional), passes the brief gate and enqueues screenplay generation. */
  async generateScreenplay(
    actor: Actor,
    projectId: string,
    input: { prompt?: string; attachmentResourceIds?: string[] } = {},
  ): Promise<Job> {
    await this.mutate(
      actor,
      projectId,
      (tx) => {
        const p = tx.require<Project>('project.json', 'project');
        if (p.kind !== 'story') throw invalid('screenplays belong to story projects');
        const brief = {
          prompt: input.prompt ?? p.brief.prompt,
          attachmentResourceIds: input.attachmentResourceIds ?? p.brief.attachmentResourceIds,
        };
        if (brief.prompt.trim().length < 3)
          throw new AppError('gate_unmet', 'Write a short prompt describing the movie first');
        for (const rid of brief.attachmentResourceIds)
          if (!tx.get(docPath.resource(rid))) throw notFound(`resource ${rid}`);
        const next: Project = { ...p, brief };
        if (p.workflow.stage === 'brief') {
          next.workflow = {
            stage: 'screenplay',
            approvals: { ...p.workflow.approvals, brief_submitted: { at: new Date().toISOString(), actor } },
          };
        }
        tx.set('project.json', next);
      },
      { message: 'Submit brief and generate screenplay' },
    );
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'screenplay.generate',
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: 'screenplay.generate',
      priority: 5,
    });
  }

  async patchScreenplay(
    actor: Actor,
    projectId: string,
    input: ScreenplayPatchInput,
    coalesce?: string,
  ): Promise<Screenplay> {
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const project = tx.require<Project>('project.json', 'project');
        const current =
          tx.get<Screenplay>('screenplay.json') ??
          ScreenplaySchema.parse({ title: project.title, style: {}, language: project.settings.language });
        const sp: Screenplay = {
          ...current,
          ...input.fields,
          style: { ...current.style, ...input.fields?.style },
        };
        let scenes = [...sp.scenes];
        if (input.removeSceneIds?.length) {
          const removed = new Set(input.removeSceneIds);
          scenes = scenes.filter((s) => !removed.has(s.id));
          sp.outline = sp.outline.map((b) =>
            b.sceneId && removed.has(b.sceneId) ? { ...b, sceneId: null } : b,
          );
        }
        for (const up of input.upsertScenes ?? []) {
          const existing = up.id ? scenes.find((s) => s.id === up.id) : undefined;
          if (up.id && !existing) throw notFound(`scene ${up.id}`);
          const characters = tx.list<Character>('characters/');
          const scene: Scene = {
            ...(existing ?? {
              id: newId('scene'),
              index: scenes.length,
              beatId: null,
              location: '',
              timeOfDay: '',
              summary: '',
              action: '',
              dialogue: [],
              characterIds: [],
              locationId: null,
              elementIds: [],
              estDurationSec: 60,
            }),
            ...Object.fromEntries(Object.entries(up).filter(([, v]) => v !== undefined)),
            dialogue: (up.dialogue ?? existing?.dialogue ?? []).map((d) => ({
              characterId:
                d.characterId ??
                characters.find((c) => c.name.toLowerCase() === d.character.toLowerCase())?.id ??
                null,
              character: d.character,
              line: d.line,
              ...(d.parenthetical ? { parenthetical: d.parenthetical } : {}),
            })),
          } as Scene;
          for (const cid of scene.characterIds)
            if (!tx.get(docPath.character(cid))) throw notFound(`character ${cid}`);
          for (const eid of [...(scene.locationId ? [scene.locationId] : []), ...scene.elementIds])
            if (!tx.get(docPath.element(eid))) throw notFound(`element ${eid}`);
          if (existing) scenes = scenes.map((s) => (s.id === scene.id ? scene : s));
          else scenes.push(scene);
        }
        scenes
          .sort((a, b) => a.index - b.index)
          .forEach((s, i) => {
            s.index = i;
          });
        sp.scenes = scenes;
        if (input.outline) {
          sp.outline = input.outline.map(
            (b, i): OutlineBeat => ({
              id: b.id ?? newId('beat'),
              index: i,
              title: b.title ?? '',
              summary: b.summary,
              estDurationSec: b.estDurationSec,
              sceneId: b.sceneId ?? sp.outline.find((o) => o.id === b.id)?.sceneId ?? null,
            }),
          );
        }
        tx.set('screenplay.json', sp);
        return sp;
      },
      {
        message:
          input.upsertScenes?.length === 1 && !input.fields
            ? `Edit scene “${input.upsertScenes[0]!.heading}”`
            : 'Edit screenplay',
        coalesce: coalesce ? { key: coalesce } : undefined,
      },
    );
    return result;
  }

  async extendScreenplay(actor: Actor, projectId: string, beats = 3): Promise<Job> {
    const docs = await this.deps.projects.docs(projectId);
    if (!docs.screenplay) throw invalid('generate a screenplay first');
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'screenplay.extend',
      params: { beats },
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: 'screenplay.extend',
    });
  }

  async createCharacter(actor: Actor, projectId: string, input: CharacterInput): Promise<Character> {
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const existing = tx.list<Character>('characters/');
        if (existing.some((c) => c.name.toLowerCase() === input.name.trim().toLowerCase()))
          throw invalid(`a character named ${input.name} exists`);
        const id = newId('character');
        const c: Character = {
          id,
          name: input.name.trim(),
          role: input.role ?? 'supporting',
          summary: input.summary ?? '',
          identity: {
            age: '',
            gender: '',
            build: '',
            face: '',
            hair: '',
            eyes: '',
            skin: '',
            ...input.identity,
          },
          wardrobe: (input.wardrobe ?? []).map((w, i) => ({
            id: w.id ?? newId('wardrobe'),
            name: w.name,
            description: w.description,
            ...(w.default || i === 0 ? { default: true } : {}),
          })),
          ...(input.personality ? { personality: input.personality } : {}),
          ...(input.voice ? { voice: newVoice(input.voice.description) } : {}),
          references: [],
          seed: characterSeed(id),
          lock: { locked: false, version: 0 },
        };
        tx.set(docPath.character(id), c);
        return c;
      },
      { message: (c) => `Add character ${c.name}` },
    );
    return result;
  }

  private async updateCharacterDoc(
    actor: Actor,
    projectId: string,
    id: string,
    message: string | ((c: Character) => string),
    fn: (c: Character) => Character,
    coalesce?: string,
  ): Promise<Character> {
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const c = tx.require<Character>(docPath.character(id), `character ${id}`);
        const next = fn(structuredClone(c));
        tx.set(docPath.character(id), next);
        return next;
      },
      {
        message,
        coalesce: coalesce ? { key: coalesce } : undefined,
      },
    );
    return result;
  }

  async updateCharacter(
    actor: Actor,
    projectId: string,
    id: string,
    input: CharacterUpdateInput,
    coalesce?: string,
  ): Promise<Character> {
    return this.updateCharacterDoc(
      actor,
      projectId,
      id,
      (c) => `Edit character ${c.name}`,
      (c) => {
        const touchesIdentity = IDENTITY_KEYS.some((k) => input[k] !== undefined);
        if (c.lock.locked && touchesIdentity) {
          throw new AppError(
            'character_locked',
            `${c.name} is locked; unlock the character before changing identity, name or wardrobe (rule R2)`,
          );
        }
        return {
          ...c,
          ...(input.name ? { name: input.name.trim() } : {}),
          ...(input.role ? { role: input.role } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          ...(input.identity ? { identity: { ...c.identity, ...input.identity } } : {}),
          ...(input.wardrobe
            ? {
                wardrobe: input.wardrobe.map((w, i) => ({
                  id: w.id ?? newId('wardrobe'),
                  name: w.name,
                  description: w.description,
                  ...(w.default || (i === 0 && !input.wardrobe!.some((x) => x.default))
                    ? { default: true }
                    : {}),
                })),
              }
            : {}),
          ...(input.personality !== undefined ? { personality: input.personality } : {}),
          ...(input.voice !== undefined ? { voice: describeVoice(c, input.voice.description) } : {}),
        };
      },
      coalesce,
    );
  }

  async deleteCharacter(actor: Actor, projectId: string, id: string): Promise<void> {
    await this.mutate(
      actor,
      projectId,
      (tx) => {
        const c = tx.require<Character>(docPath.character(id), `character ${id}`);
        if (c.lock.locked)
          throw new AppError('character_locked', `${c.name} is locked; unlock it before deleting`);
        tx.delete(docPath.character(id));
        return c;
      },
      { message: (c) => `Remove character ${c.name}` },
    );
  }

  /** Lock (R1/R2): needs an approved reference; relocking an unchanged identity keeps the version (no stale takes). */
  async lockCharacter(actor: Actor, projectId: string, id: string): Promise<Character> {
    return this.updateCharacterDoc(
      actor,
      projectId,
      id,
      (c) => `Lock character ${c.name}`,
      (c) => {
        if (c.lock.locked) return c;
        if (approvedReferences(c).length === 0)
          throw new AppError(
            'validation_error',
            `Approve at least one reference of ${c.name} before locking`,
          );
        const hash = identityHash(c);
        const version =
          c.lock.identityHash === hash && c.lock.version > 0 ? c.lock.version : c.lock.version + 1;
        return {
          ...c,
          lock: {
            locked: true,
            version,
            lockedAt: new Date().toISOString(),
            lockedBy: actor,
            identityHash: hash,
          },
        };
      },
    ).then(async (c) => {
      this.activity(projectId, actor, 'character.lock', `Locked ${c.name} (v${c.lock.version})`);
      return c;
    });
  }

  async unlockCharacter(actor: Actor, projectId: string, id: string): Promise<Character> {
    return this.updateCharacterDoc(
      actor,
      projectId,
      id,
      (c) => `Unlock character ${c.name}`,
      (c) => ({
        ...c,
        lock: { ...c.lock, locked: false },
      }),
    );
  }

  async importMedia(
    projectId: string,
    source: UploadSource,
    opts: {
      kind: Parameters<MediaStore['putFile']>[2]['kind'];
      name: string;
      maxBytes?: number;
      probe?: Parameters<MediaStore['putFile']>[2]['probe'];
    },
  ) {
    if ('uri' in source)
      return this.deps.media.importUri(projectId, source.uri, {
        kind: opts.kind,
        name: opts.name,
        maxBytes: opts.maxBytes,
        probe: opts.probe,
      });
    return this.deps.media.putFile(projectId, source.file, {
      kind: opts.kind,
      name: opts.name,
      mime: source.mime,
      probe: opts.probe,
    });
  }

  async addReference(
    actor: Actor,
    projectId: string,
    id: string,
    source: UploadSource,
    opts: { view?: ReferenceView; approved?: boolean; consent?: ConsentInput } = {},
  ): Promise<Character> {
    const docs = await this.deps.projects.docs(projectId);
    const c = docs.characters[id];
    if (!c) throw notFound(`character ${id}`);
    if (c.lock.locked)
      throw new AppError('character_locked', `${c.name} is locked; unlock before changing references`);
    const consent = consentRecord(actor, opts.consent, 'reference image');
    const media = await this.importMedia(projectId, source, {
      kind: 'refs',
      name: `${c.name}-${opts.view ?? 'custom'}`,
      maxBytes: 50 * 1024 * 1024,
    });
    if (!media.mime.startsWith('image/')) throw invalid('references must be images');
    return this.updateCharacterDoc(
      actor,
      projectId,
      id,
      `Add ${opts.view ?? 'custom'} reference to ${c.name}`,
      (ch) => {
        if (ch.lock.locked) throw new AppError('character_locked', `${ch.name} is locked`);
        return {
          ...ch,
          references: [
            ...ch.references,
            {
              id: newId('reference'),
              view: opts.view ?? 'custom',
              media,
              source: 'uploaded',
              approved: opts.approved ?? true,
              createdAt: new Date().toISOString(),
              consent,
            },
          ],
        };
      },
    );
  }

  async setReferenceApproval(
    actor: Actor,
    projectId: string,
    id: string,
    refId: string,
    approved: boolean,
  ): Promise<Character> {
    return this.updateCharacterDoc(
      actor,
      projectId,
      id,
      (c) => `${approved ? 'Approve' : 'Unapprove'} reference of ${c.name}`,
      (c) => {
        if (c.lock.locked) throw new AppError('character_locked', `${c.name} is locked`);
        if (!c.references.some((r) => r.id === refId)) throw notFound(`reference ${refId}`);
        return { ...c, references: c.references.map((r) => (r.id === refId ? { ...r, approved } : r)) };
      },
    );
  }

  async deleteReference(actor: Actor, projectId: string, id: string, refId: string): Promise<Character> {
    return this.updateCharacterDoc(
      actor,
      projectId,
      id,
      (c) => `Remove reference of ${c.name}`,
      (c) => {
        if (c.lock.locked) throw new AppError('character_locked', `${c.name} is locked`);
        if (!c.references.some((r) => r.id === refId)) throw notFound(`reference ${refId}`);
        return { ...c, references: c.references.filter((r) => r.id !== refId) };
      },
    );
  }

  async generateReferences(
    actor: Actor,
    projectId: string,
    id: string,
    views?: ReferenceView[],
  ): Promise<Job> {
    const docs = await this.deps.projects.docs(projectId);
    const c = docs.characters[id];
    if (!c) throw notFound(`character ${id}`);
    if (c.lock.locked)
      throw new AppError('character_locked', `${c.name} is locked; unlock before generating new references`);
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'character.refs',
      params: { characterId: id, views: views ?? ['front', 'three_quarter', 'profile', 'full_body'] },
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: `refs:${id}`,
      priority: 5,
    });
  }

  async describeCharacter(
    actor: Actor,
    projectId: string,
    id: string,
    resourceId: string,
    consentInput?: ConsentInput,
  ): Promise<Job> {
    const docs = await this.deps.projects.docs(projectId);
    const c = docs.characters[id];
    if (!c) throw notFound(`character ${id}`);
    if (c.lock.locked) throw new AppError('character_locked', `${c.name} is locked`);
    const r = docs.resources[resourceId];
    if (r?.kind !== 'image') throw invalid('describe needs an image resource');
    // The photo becomes an uploaded reference of the character, so it needs a consent record too.
    const consent = consentRecord(actor, consentInput, 'photo');
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'character.describe',
      params: { characterId: id, resourceId, consent },
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: `describe:${id}`,
    });
  }

  /**
   * Adds a resource. A browser upload carries its own probe (and poster), so it is ready at once; audio and
   * video from anywhere else (MCP, URLs) get a `media.process` editor job (docs/design/editor.md#media-preparation-uploads).
   * Images are probed here: they are generation inputs as much as media.
   */
  async addResource(
    actor: Actor,
    projectId: string,
    source: UploadSource,
    input: Omit<ResourceInput, 'uri'> = {},
    prepared: { probe?: Probe; poster?: string } = {},
  ): Promise<Resource> {
    const docs = await this.deps.projects.docs(projectId);
    const name =
      input.name ??
      ('filename' in source
        ? source.filename
        : (source.uri.startsWith('data:') ? 'upload' : new URL(source.uri).pathname.split('/').pop()) ||
          'resource');
    let media = await this.importMedia(projectId, source, {
      kind: 'uploads',
      name: name.replace(/\.[^.]+$/, ''),
      maxBytes: 4 * 1024 ** 3,
      probe: prepared.probe ?? false,
    });
    const kind = input.kind ?? kindFromMime(media.mime);
    if (!kind) throw invalid(`unsupported media type ${media.mime}`);
    if (kind === 'image' && !prepared.probe)
      media = {
        ...media,
        ...(await this.deps.media.probeRef(await this.deps.media.localPath(projectId, media), media.mime)),
      };
    if (prepared.poster && kind !== 'audio') {
      const poster = await this.deps.media.putFile(projectId, prepared.poster, {
        kind: 'posters',
        name: 'poster',
        stem: media.hash.slice(0, 12),
        mime: 'image/jpeg',
        probe: false,
      });
      media = { ...media, poster: { path: poster.path, mime: poster.mime } };
    }
    const role =
      input.role ??
      (kind === 'video'
        ? docs.project.kind === 'edit'
          ? 'source'
          : 'reference'
        : kind === 'audio'
          ? 'music'
          : 'reference');
    const needsEditor = kind !== 'image' && !prepared.probe;
    const mismatch =
      !!prepared.probe &&
      ((kind === 'video' && !prepared.probe.hasVideo) || (kind === 'audio' && !prepared.probe.hasAudio));
    if (mismatch) throw invalid(`the file has no ${kind} stream`);
    const resource: Resource = {
      id: newId('resource'),
      kind,
      role,
      name,
      media,
      createdAt: new Date().toISOString(),
      origin: 'uri' in source ? (source.uri.startsWith('data:') ? 'upload' : 'url') : 'upload',
      status: needsEditor ? 'processing' : 'ready',
    };
    await this.mutate(actor, projectId, (tx) => tx.set(docPath.resource(resource.id), resource), {
      message: `Add ${kind} resource ${name}`,
    });
    if (needsEditor) await this.processInEditor(actor, projectId, resource.id);
    return resource;
  }

  /** Probe + poster of a resource by a studio tab (`media.process` editor job). */
  async processInEditor(actor: Actor, projectId: string, resourceId: string): Promise<Job> {
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'media.process',
      params: { resourceId },
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: `process:${resourceId}`,
      maxAttempts: 5,
    });
  }

  async generateMusic(
    actor: Actor,
    projectId: string,
    input: { prompt: string; durationSec?: number; instrumental?: boolean },
  ): Promise<Job> {
    await this.deps.projects.existing(projectId);
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'music.generate',
      params: {
        prompt: input.prompt,
        durationSec: input.durationSec ?? 60,
        instrumental: input.instrumental ?? true,
      },
      actor,
      branch: await this.branchOf(projectId),
    });
  }
}
