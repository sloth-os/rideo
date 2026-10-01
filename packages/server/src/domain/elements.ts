import {
  type Actor,
  approvedElementReferences,
  canonicalJson,
  docPath,
  ELEMENT_VIEWS,
  type Element,
  type ElementInput,
  type ElementReferenceView,
  type ElementUpdateInput,
  elementSeed,
  type Job,
  newId,
  type Screenplay,
} from '@rideo/shared';
import { AppError, invalid, notFound } from '../errors';
import { sha256 } from '../util/crypto';
import { Service } from './base';
import type { UploadSource } from './story';

/** Name, description and approved reference hashes: relocking an unchanged element keeps its version. */
export function elementIdentityHash(e: Element): string {
  return sha256(
    canonicalJson({
      name: e.name,
      description: e.description,
      references: approvedElementReferences(e)
        .map((r) => r.media.hash)
        .sort(),
    }),
  );
}

const locked = (e: Element) =>
  new AppError(
    'element_locked',
    `${e.name} is locked; unlock it before changing its name, description or references (rule E2)`,
  );

/** Locations, props and styles with the character lifecycle (docs/design/elements.md). */
export class ElementService extends Service {
  async create(actor: Actor, projectId: string, input: ElementInput): Promise<Element> {
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const name = input.name.trim();
        if (
          tx
            .list<Element>('elements/')
            .some((e) => e.kind === input.kind && e.name.toLowerCase() === name.toLowerCase())
        )
          throw invalid(`a ${input.kind} named ${name} exists`);
        const id = newId('element');
        const e: Element = {
          id,
          kind: input.kind,
          name,
          description: input.description ?? '',
          aliases: input.aliases ?? [],
          references: [],
          seed: elementSeed(id),
          lock: { locked: false, version: 0 },
        };
        tx.set(docPath.element(id), e);
        return e;
      },
      { message: (e) => `Add ${e.kind} ${e.name}` },
    );
    return result;
  }

  private async updateDoc(
    actor: Actor,
    projectId: string,
    id: string,
    message: string | ((e: Element) => string),
    fn: (e: Element) => Element,
    coalesce?: string,
  ): Promise<Element> {
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const e = tx.require<Element>(docPath.element(id), `element ${id}`);
        const next = fn(structuredClone(e));
        tx.set(docPath.element(id), next);
        return next;
      },
      { message, coalesce: coalesce ? { key: coalesce } : undefined },
    );
    return result;
  }

  async update(
    actor: Actor,
    projectId: string,
    id: string,
    input: ElementUpdateInput,
    coalesce?: string,
  ): Promise<Element> {
    return this.updateDoc(
      actor,
      projectId,
      id,
      (e) => `Edit ${e.kind} ${e.name}`,
      (e) => {
        if (e.lock.locked && (input.name !== undefined || input.description !== undefined)) throw locked(e);
        return {
          ...e,
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
        };
      },
      coalesce,
    );
  }

  /** Deleting unlinks the element from scenes and shots (their takes become stale only on relock). */
  async remove(actor: Actor, projectId: string, id: string): Promise<void> {
    await this.mutate(
      actor,
      projectId,
      (tx) => {
        const e = tx.require<Element>(docPath.element(id), `element ${id}`);
        if (e.lock.locked)
          throw new AppError('element_locked', `${e.name} is locked; unlock it before deleting`);
        tx.delete(docPath.element(id));
        const sp = tx.get<Screenplay>('screenplay.json');
        if (sp?.scenes.some((s) => s.locationId === id || s.elementIds.includes(id))) {
          tx.set('screenplay.json', {
            ...sp,
            scenes: sp.scenes.map((s) => ({
              ...s,
              locationId: s.locationId === id ? null : s.locationId,
              elementIds: s.elementIds.filter((x) => x !== id),
            })),
          });
        }
        return e;
      },
      { message: (e) => `Remove ${e.kind} ${e.name}` },
    );
  }

  /** Lock (E1/E2): needs an approved reference; relocking unchanged keeps the version (no stale takes). */
  async lock(actor: Actor, projectId: string, id: string): Promise<Element> {
    const e = await this.updateDoc(
      actor,
      projectId,
      id,
      (x) => `Lock ${x.kind} ${x.name}`,
      (x) => {
        if (x.lock.locked) return x;
        if (approvedElementReferences(x).length === 0)
          throw invalid(`Approve at least one reference of ${x.name} before locking`);
        const hash = elementIdentityHash(x);
        const version =
          x.lock.identityHash === hash && x.lock.version > 0 ? x.lock.version : x.lock.version + 1;
        return {
          ...x,
          lock: {
            locked: true,
            version,
            lockedAt: new Date().toISOString(),
            lockedBy: actor,
            identityHash: hash,
          },
        };
      },
    );
    this.activity(projectId, actor, 'element.lock', `Locked ${e.name} (v${e.lock.version})`);
    return e;
  }

  async unlock(actor: Actor, projectId: string, id: string): Promise<Element> {
    return this.updateDoc(
      actor,
      projectId,
      id,
      (e) => `Unlock ${e.kind} ${e.name}`,
      (e) => ({ ...e, lock: { ...e.lock, locked: false } }),
    );
  }

  async addReference(
    actor: Actor,
    projectId: string,
    id: string,
    source: UploadSource,
    opts: { view?: ElementReferenceView; approved?: boolean } = {},
  ): Promise<Element> {
    const docs = await this.deps.projects.docs(projectId);
    const e = docs.elements[id];
    if (!e) throw notFound(`element ${id}`);
    if (e.lock.locked) throw locked(e);
    const view = opts.view ?? ELEMENT_VIEWS[e.kind][0]!;
    const name = `element-${e.name}-${view}`;
    const media =
      'uri' in source
        ? await this.deps.media.importUri(projectId, source.uri, {
            kind: 'refs',
            name,
            maxBytes: 50 * 1024 * 1024,
          })
        : await this.deps.media.putFile(projectId, source.file, { kind: 'refs', name, mime: source.mime });
    if (!media.mime.startsWith('image/')) throw invalid('references must be images');
    return this.updateDoc(actor, projectId, id, `Add ${view} reference to ${e.name}`, (x) => {
      if (x.lock.locked) throw locked(x);
      return {
        ...x,
        references: [
          ...x.references,
          {
            id: newId('reference'),
            view,
            media,
            source: 'uploaded',
            approved: opts.approved ?? true,
            createdAt: new Date().toISOString(),
          },
        ],
      };
    });
  }

  async setReferenceApproval(
    actor: Actor,
    projectId: string,
    id: string,
    refId: string,
    approved: boolean,
  ): Promise<Element> {
    return this.updateDoc(
      actor,
      projectId,
      id,
      (e) => `${approved ? 'Approve' : 'Unapprove'} reference of ${e.name}`,
      (e) => {
        if (e.lock.locked) throw locked(e);
        if (!e.references.some((r) => r.id === refId)) throw notFound(`reference ${refId}`);
        return { ...e, references: e.references.map((r) => (r.id === refId ? { ...r, approved } : r)) };
      },
    );
  }

  async deleteReference(actor: Actor, projectId: string, id: string, refId: string): Promise<Element> {
    return this.updateDoc(
      actor,
      projectId,
      id,
      (e) => `Remove reference of ${e.name}`,
      (e) => {
        if (e.lock.locked) throw locked(e);
        if (!e.references.some((r) => r.id === refId)) throw notFound(`reference ${refId}`);
        return { ...e, references: e.references.filter((r) => r.id !== refId) };
      },
    );
  }

  async generateReferences(
    actor: Actor,
    projectId: string,
    id: string,
    views?: ElementReferenceView[],
  ): Promise<Job> {
    const docs = await this.deps.projects.docs(projectId);
    const e = docs.elements[id];
    if (!e) throw notFound(`element ${id}`);
    if (e.lock.locked) throw locked(e);
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'element.refs',
      params: { elementId: id, views: views ?? ELEMENT_VIEWS[e.kind] },
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: `element-refs:${id}`,
      priority: 5,
    });
  }
}
