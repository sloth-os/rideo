import type { z } from 'zod';
import { type Analysis, AnalysisSchema } from './analysis';
import { type Character, CharacterSchema } from './character';
import { type Clip, ClipSchema } from './clip';
import { type Element, ElementSchema } from './element';
import { type Export, ExportSchema } from './job';
import { type Localization, LocalizationSchema } from './localization';
import { type Project, ProjectSchema } from './project';
import { type Resource, ResourceSchema } from './resource';
import { type Screenplay, ScreenplaySchema } from './screenplay';
import { type Timeline, TimelineSchema } from './timeline';

/**
 * Versioned document registry: every path in a project's tree maps to exactly one schema.
 * This table is the single definition of what can be stored, validated and materialized.
 */
export type DocKind =
  | 'project'
  | 'screenplay'
  | 'character'
  | 'element'
  | 'clip'
  | 'timeline'
  | 'animatic'
  | 'resource'
  | 'analysis'
  | 'export'
  | 'localization'
  | 'render';

interface DocSpec {
  kind: DocKind;
  pattern: RegExp;
  schema: z.ZodType;
  dir?: string;
  /** The document carries its path's id as `id` (default true). */
  embedsId?: boolean;
}

const ID = '([a-z]{3}_[0-9a-z]{10,32})';

export const DOC_SPECS: DocSpec[] = [
  { kind: 'project', pattern: /^project\.json$/, schema: ProjectSchema },
  { kind: 'screenplay', pattern: /^screenplay\.json$/, schema: ScreenplaySchema },
  { kind: 'timeline', pattern: /^timeline\.json$/, schema: TimelineSchema },
  /** The storyboard's animatic: a timeline of stills (docs/design/storyboard.md#animatic). */
  { kind: 'animatic', pattern: /^animatic\.json$/, schema: TimelineSchema },
  {
    kind: 'character',
    pattern: new RegExp(`^characters/${ID}\\.json$`),
    schema: CharacterSchema,
    dir: 'characters',
  },
  {
    kind: 'element',
    pattern: new RegExp(`^elements/${ID}\\.json$`),
    schema: ElementSchema,
    dir: 'elements',
  },
  { kind: 'clip', pattern: new RegExp(`^clips/${ID}\\.json$`), schema: ClipSchema, dir: 'clips' },
  {
    kind: 'resource',
    pattern: new RegExp(`^resources/${ID}\\.json$`),
    schema: ResourceSchema,
    dir: 'resources',
  },
  {
    kind: 'analysis',
    pattern: new RegExp(`^analyses/${ID}\\.json$`),
    schema: AnalysisSchema,
    dir: 'analyses',
  },
  { kind: 'export', pattern: new RegExp(`^exports/${ID}\\.json$`), schema: ExportSchema, dir: 'exports' },
  /** A language of the cut (docs/design/localization.md#translation). */
  {
    kind: 'localization',
    pattern: /^localizations\/([a-z]{2,3}(?:-[A-Z]{2})?)\.json$/,
    schema: LocalizationSchema,
    dir: 'localizations',
  },
  /** The timeline an export rendered when it differs from the cut (a language variant, sidecar captions). */
  {
    kind: 'render',
    pattern: new RegExp(`^renders/${ID}\\.json$`),
    schema: TimelineSchema,
    dir: 'renders',
    embedsId: false,
  },
];

export const DOC_DIRS = DOC_SPECS.filter((s) => s.dir).map((s) => s.dir!) as string[];

export function docSpecForPath(
  path: string,
): { kind: DocKind; id?: string; schema: z.ZodType; embedsId: boolean } | null {
  for (const spec of DOC_SPECS) {
    const m = spec.pattern.exec(path);
    if (m) return { kind: spec.kind, id: m[1], schema: spec.schema, embedsId: spec.embedsId !== false };
  }
  return null;
}

export function isDocPath(path: string): boolean {
  return docSpecForPath(path) !== null;
}

export const docPath = {
  project: () => 'project.json',
  screenplay: () => 'screenplay.json',
  timeline: () => 'timeline.json',
  animatic: () => 'animatic.json',
  character: (id: string) => `characters/${id}.json`,
  element: (id: string) => `elements/${id}.json`,
  clip: (id: string) => `clips/${id}.json`,
  resource: (id: string) => `resources/${id}.json`,
  analysis: (id: string) => `analyses/${id}.json`,
  export: (id: string) => `exports/${id}.json`,
  localization: (language: string) => `localizations/${language}.json`,
  render: (exportId: string) => `renders/${exportId}.json`,
};

export class DocValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly issues: { path: string; message: string }[],
  ) {
    super(`invalid document ${path}: ${issues.map((i) => `${i.path || '(root)'} ${i.message}`).join('; ')}`);
    this.name = 'DocValidationError';
  }
}

/** Validates (and normalizes defaults of) a document for its path; the embedded id must match the path. */
export function validateDoc(path: string, doc: unknown): unknown {
  const spec = docSpecForPath(path);
  if (!spec) throw new DocValidationError(path, [{ path: '', message: 'unknown document path' }]);
  const result = spec.schema.safeParse(doc);
  if (!result.success) {
    throw new DocValidationError(
      path,
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  const value = result.data as { id?: string };
  if (spec.id && spec.embedsId && value.id !== spec.id) {
    throw new DocValidationError(path, [{ path: 'id', message: `id ${value.id} does not match path` }]);
  }
  return result.data;
}

export interface ProjectDocs {
  project: Project;
  screenplay: Screenplay | null;
  timeline: Timeline | null;
  animatic: Timeline | null;
  characters: Record<string, Character>;
  elements: Record<string, Element>;
  clips: Record<string, Clip>;
  resources: Record<string, Resource>;
  analyses: Record<string, Analysis>;
  exports: Record<string, Export>;
  /** By language code. */
  localizations: Record<string, Localization>;
}

const COLLECTION: Partial<Record<DocKind, keyof ProjectDocs>> = {
  character: 'characters',
  element: 'elements',
  clip: 'clips',
  resource: 'resources',
  analysis: 'analyses',
  export: 'exports',
  localization: 'localizations',
};

/** Applies document changes (path → doc | null) to a ProjectDocs projection immutably. */
export function applyDocChanges(docs: ProjectDocs, changes: Record<string, unknown | null>): ProjectDocs {
  const next: ProjectDocs = { ...docs };
  const touched = new Set<keyof ProjectDocs>();
  for (const [path, doc] of Object.entries(changes)) {
    const spec = docSpecForPath(path);
    if (!spec) continue;
    const coll = COLLECTION[spec.kind];
    if (coll && spec.id) {
      if (!touched.has(coll)) {
        (next as any)[coll] = { ...(docs as any)[coll] };
        touched.add(coll);
      }
      const map = (next as any)[coll] as Record<string, unknown>;
      if (doc === null) delete map[spec.id];
      else map[spec.id] = doc;
    } else if (spec.kind === 'project') {
      if (doc !== null) next.project = doc as Project;
    } else if (spec.kind === 'screenplay') {
      next.screenplay = (doc as Screenplay | null) ?? null;
    } else if (spec.kind === 'timeline') {
      next.timeline = (doc as Timeline | null) ?? null;
    } else if (spec.kind === 'animatic') {
      next.animatic = (doc as Timeline | null) ?? null;
    }
  }
  return next;
}

export function docsFromEntries(entries: Iterable<[string, unknown]>): ProjectDocs {
  let project: Project | null = null;
  const changes: Record<string, unknown> = {};
  for (const [path, doc] of entries) {
    if (path === 'project.json') project = doc as Project;
    else changes[path] = doc;
  }
  if (!project) throw new Error('project.json missing');
  return applyDocChanges(
    {
      project,
      screenplay: null,
      timeline: null,
      animatic: null,
      characters: {},
      elements: {},
      clips: {},
      resources: {},
      analyses: {},
      exports: {},
      localizations: {},
    },
    changes,
  );
}

export function sortedClips(docs: Pick<ProjectDocs, 'clips'>): Clip[] {
  return Object.values(docs.clips).sort((a, b) => a.index - b.index);
}
