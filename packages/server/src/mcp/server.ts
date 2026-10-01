import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  type Actor,
  CameraSchema,
  CharacterInputSchema,
  ConsentInputSchema,
  CreateProjectInputSchema,
  clipBlockers,
  ElementInputSchema,
  ElementReferenceViewSchema,
  ExportQualitySchema,
  elementsInUse,
  FocusKindSchema,
  IdentitySchema,
  isTerminalJob,
  ProjectSettingsPatchSchema,
  ReferenceViewSchema,
  RenderEngineChoiceSchema,
  ResourceKindSchema,
  ResourceRoleSchema,
  renderScreenplayMarkdown,
  SceneInputSchema,
  slugify,
  sortedClips,
  TimelineOpSchema,
  timelineDuration,
  ViewSchema,
  voiceOf,
  voiceStatus,
  WardrobeInputSchema,
} from '@rideo/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProjectState } from '../domain/projects';
import type { Studio } from '../domain/studio';
import { toAppError } from '../errors';
import { VERSION } from '../http/app';

const PROJECT = z.string().describe('Project id (prj_…)');

/** Compact, agent-friendly project snapshot (full documents via doc_get). */
export function summarizeState(state: ProjectState) {
  const d = state.docs;
  const characters = Object.values(d.characters);
  return {
    project: {
      id: d.project.id,
      kind: d.project.kind,
      title: d.project.title,
      brief: d.project.brief,
      settings: d.project.settings,
    },
    head: state.head,
    workflow: {
      stage: state.workflow.stage,
      done: state.workflow.done,
      plannedDurationSec: state.workflow.plannedDurationSec,
      approvedDurationSec: state.workflow.approvedDurationSec,
      targetDurationSec: state.workflow.targetDurationSec,
      gates: state.workflow.stages
        .filter((s) => s.gate)
        .map((s) => ({
          stage: s.id,
          gate: s.gate!.id,
          status: s.status,
          approved: s.gate!.approved,
          unmet: s.gate!.requirements.filter((r) => !r.ok).map((r) => r.message),
        })),
    },
    screenplay: d.screenplay
      ? {
          title: d.screenplay.title,
          logline: d.screenplay.logline,
          outlineBeats: d.screenplay.outline.length,
          unwrittenBeats: d.screenplay.outline.filter((b) => !b.sceneId).length,
          scenes: d.screenplay.scenes.map((s) => ({
            id: s.id,
            index: s.index,
            heading: s.heading,
            estDurationSec: s.estDurationSec,
            characterIds: s.characterIds,
            locationId: s.locationId,
            elementIds: s.elementIds,
          })),
        }
      : null,
    characters: characters.map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      locked: c.lock.locked,
      lockVersion: c.lock.version,
      references: c.references.map((r) => ({
        id: r.id,
        view: r.view,
        approved: r.approved,
        source: r.source,
      })),
      voice: (() => {
        const v = voiceOf(c);
        return {
          status: voiceStatus(c),
          description: v.description,
          source: v.source,
          locked: v.lock.locked,
          lockVersion: v.lock.version,
          candidates: v.candidates.map((x) => ({ id: x.id, durationSec: x.sample.durationSec })),
        };
      })(),
    })),
    elements: Object.values(d.elements).map((e) => ({
      id: e.id,
      kind: e.kind,
      name: e.name,
      locked: e.lock.locked,
      lockVersion: e.lock.version,
      inUse: elementsInUse(d).some((x) => x.id === e.id),
      references: e.references.map((r) => ({ id: r.id, view: r.view, approved: r.approved })),
    })),
    clips: sortedClips(d).map((c) => ({
      id: c.id,
      index: c.index,
      title: c.title,
      status: c.status,
      sceneId: c.sceneId,
      durationSec: c.shots.reduce((s, x) => s + x.durationSec, 0),
      shots: c.shots.map((s) => {
        const take = s.takes.find((t) => t.id === s.selectedTakeId);
        return {
          id: s.id,
          index: s.index,
          status: s.status,
          description: s.description.slice(0, 160),
          characterIds: s.characterIds,
          elementIds: s.elementIds,
          takes: s.takes.length,
          selectedTake: take
            ? {
                id: take.id,
                consistency: take.consistency.status,
                score: take.consistency.score,
                overridden: !!take.override,
              }
            : null,
          lastError: s.lastError,
        };
      }),
      blockers: clipBlockers(c, d.characters, d.elements).map((b) => b.message),
    })),
    timeline: d.timeline
      ? {
          durationSec: timelineDuration(d.timeline),
          tracks: d.timeline.tracks.map((t) => ({ id: t.id, kind: t.kind, items: t.items.length })),
        }
      : null,
    resources: Object.values(d.resources).map((r) => ({
      id: r.id,
      kind: r.kind,
      role: r.role,
      name: r.name,
      status: r.status,
      durationSec: r.media.durationSec,
    })),
    analyses: Object.values(d.analyses).map((a) => ({
      id: a.id,
      resourceId: a.resourceId,
      status: a.status,
      suggestions: a.suggestions.length,
      summary: a.summary.slice(0, 400),
    })),
    exports: Object.values(d.exports).map((e) => ({
      id: e.id,
      status: e.status,
      method: e.method,
      mediaPath: e.media?.path,
      watermarkId: e.watermarkId,
    })),
    activeJobs: state.jobs
      .filter((j) => !isTerminalJob(j))
      .map((j) => ({ id: j.id, kind: j.kind, status: j.status, progress: j.progress })),
    syncIssues: state.syncIssues,
  };
}

type ToolArgs<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;

function buildServer(studio: Studio): McpServer {
  const server = new McpServer(
    { name: 'rideo', version: VERSION },
    {
      instructions:
        'Rideo AI film studio. Start with project_list or project_create, read workflow_status for the next gate, and use ui_* tools to show the user what you are doing. Long-running tools return a job; use job_wait.',
    },
  );
  const actorOf = (): Actor => {
    const info = server.server.getClientVersion();
    const name = info?.name ?? 'MCP client';
    return { kind: 'agent', id: slugify(name, 64) || 'mcp-client', name };
  };
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (args: ToolArgs<S>, actor: Actor) => Promise<unknown>,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } = {},
  ) => {
    server.registerTool(name, { description, inputSchema: shape, annotations }, (async (
      args: ToolArgs<S>,
    ) => {
      const actor = actorOf();
      const projectId = (args as { projectId?: string }).projectId;
      if (projectId && !annotations.readOnlyHint && /^prj_/.test(projectId)) {
        studio.deps.hub.activity(projectId, actor, `tool:${name}`, `${actor.name} → ${name}`);
      }
      try {
        const result = await run(args, actor);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result ?? { ok: true }, null, 2) }],
        };
      } catch (err) {
        const e = toAppError(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ code: e.code, message: e.message, errors: e.errors }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }) as never);
  };
  const ro = { readOnlyHint: true };

  // Projects, documents, workflow
  tool(
    'project_list',
    'List projects with kind, workflow stage and planned/approved length.',
    {},
    () => studio.projects.list(),
    ro,
  );
  tool(
    'project_create',
    'Create a story (generated movie) or edit (footage edit) project.',
    {
      kind: CreateProjectInputSchema.shape.kind,
      title: z.string().min(1).max(200),
      prompt: z.string().max(20000).optional().describe('Story idea (story projects)'),
      targetDurationSec: z
        .number()
        .min(10)
        .max(10800)
        .optional()
        .describe('Full film length (default 2700 = 45 min)'),
      pilotDurationSec: z.number().min(10).max(180).optional(),
      aspectRatio: z.enum(['16:9', '9:16', '1:1', '4:3', '21:9']).optional(),
      language: z.string().optional(),
      autopilot: z.boolean().optional(),
    },
    (a, actor) =>
      studio.projects.create(actor, {
        kind: a.kind,
        title: a.title,
        brief: a.prompt ? { prompt: a.prompt } : undefined,
        settings: {
          ...(a.targetDurationSec ? { targetDurationSec: a.targetDurationSec } : {}),
          ...(a.pilotDurationSec ? { pilotDurationSec: a.pilotDurationSec } : {}),
          ...(a.aspectRatio ? { aspectRatio: a.aspectRatio } : {}),
          ...(a.language ? { language: a.language } : {}),
          ...(a.autopilot !== undefined ? { autopilot: a.autopilot } : {}),
        },
      }),
  );
  tool(
    'project_get',
    'Compact project snapshot: workflow gates, screenplay, cast, clips/shots with consistency, timeline, resources, jobs.',
    { projectId: PROJECT },
    async (a) => summarizeState(await studio.projects.state(a.projectId)),
    ro,
  );
  tool(
    'project_update',
    'Update title, brief or settings (settings are deep-merged).',
    {
      projectId: PROJECT,
      title: z.string().min(1).max(200).optional(),
      prompt: z.string().max(20000).optional(),
      settings: ProjectSettingsPatchSchema.optional(),
    },
    (a, actor) =>
      studio.projects.update(actor, a.projectId, {
        title: a.title,
        brief: a.prompt !== undefined ? { prompt: a.prompt } : undefined,
        settings: a.settings,
      }),
  );
  tool(
    'project_sync',
    'Apply external WebDAV edits and import the WebDAV inbox now.',
    { projectId: PROJECT, discardInvalid: z.boolean().optional() },
    (a) => studio.projects.sync(a.projectId, { discardInvalid: a.discardInvalid }),
  );
  tool(
    'doc_get',
    'Read a versioned document (project.json, screenplay.json, characters/<id>.json, clips/<id>.json, timeline.json, …), optionally at a commit.',
    { projectId: PROJECT, path: z.string(), at: z.string().optional() },
    (a) => studio.projects.getDoc(a.projectId, a.path, a.at),
    ro,
  );
  tool(
    'workflow_status',
    'Current stage, gates and unmet requirements.',
    { projectId: PROJECT },
    (a) => studio.workflow.evaluate(a.projectId),
    ro,
  );
  tool(
    'workflow_approve',
    'Approve the current stage gate (fails with gate_unmet listing what is missing).',
    { projectId: PROJECT, gate: z.string() },
    (a, actor) => studio.workflow.approve(actor, a.projectId, a.gate),
  );
  tool(
    'workflow_reopen',
    'Move back to an earlier stage.',
    { projectId: PROJECT, stage: z.string() },
    (a, actor) => studio.workflow.reopen(actor, a.projectId, a.stage),
  );

  // Story, cast, resources
  tool(
    'screenplay_generate',
    'Write the screenplay, full-length outline and draft cast from the brief (job).',
    {
      projectId: PROJECT,
      prompt: z.string().max(20000).optional(),
      attachmentResourceIds: z.array(z.string()).optional(),
    },
    (a, actor) => studio.story.generateScreenplay(actor, a.projectId, a),
  );
  tool(
    'screenplay_update',
    'Edit screenplay fields, upsert scenes (by id) or remove scenes, or replace the outline.',
    {
      projectId: PROJECT,
      fields: z
        .object({
          title: z.string(),
          logline: z.string(),
          synopsis: z.string(),
          genre: z.string(),
          tone: z.string(),
          style: z
            .object({ visual: z.string(), palette: z.string(), camera: z.string(), lighting: z.string() })
            .partial(),
          ended: z.boolean(),
        })
        .partial()
        .optional(),
      upsertScenes: z.array(SceneInputSchema).optional(),
      removeSceneIds: z.array(z.string()).optional(),
      outline: z
        .array(
          z.object({
            id: z.string().optional(),
            title: z.string().optional(),
            summary: z.string(),
            estDurationSec: z.number().positive(),
          }),
        )
        .optional(),
    },
    (a, actor) => studio.story.patchScreenplay(actor, a.projectId, a),
  );
  tool(
    'screenplay_extend',
    'Write the next outline beats as full scenes (job).',
    { projectId: PROJECT, beats: z.number().int().min(1).max(20).optional() },
    (a, actor) => studio.story.extendScreenplay(actor, a.projectId, a.beats),
  );
  tool(
    'character_create',
    'Add a character with a visual identity.',
    { projectId: PROJECT, ...CharacterInputSchema.shape },
    (a, actor) => studio.story.createCharacter(actor, a.projectId, a),
  );
  tool(
    'character_update',
    'Update a character (identity, name and wardrobe are frozen while locked).',
    {
      projectId: PROJECT,
      characterId: z.string(),
      name: z.string().optional(),
      role: CharacterInputSchema.shape.role,
      summary: z.string().optional(),
      identity: IdentitySchema.partial().optional(),
      wardrobe: z.array(WardrobeInputSchema).optional(),
      personality: z.string().optional(),
      voice: z
        .object({ description: z.string().max(1000) })
        .optional()
        .describe('The voice description used to design voices (frozen while the voice is locked)'),
    },
    (a, actor) => studio.story.updateCharacter(actor, a.projectId, a.characterId, a),
  );
  tool(
    'character_generate_refs',
    'Generate reference sheet images for a character (job).',
    { projectId: PROJECT, characterId: z.string(), views: z.array(ReferenceViewSchema).optional() },
    (a, actor) => studio.story.generateReferences(actor, a.projectId, a.characterId, a.views),
  );
  tool(
    'character_add_reference',
    'Add a reference image from an https or data URI. consent states whether it shows a real person (then subject, grantedBy and grantedAt are required, docs/design/provenance.md#consent-records).',
    {
      projectId: PROJECT,
      characterId: z.string(),
      uri: z.string(),
      view: ReferenceViewSchema.optional(),
      consent: ConsentInputSchema,
    },
    (a, actor) =>
      studio.story.addReference(
        actor,
        a.projectId,
        a.characterId,
        { uri: a.uri },
        { view: a.view, consent: a.consent },
      ),
  );
  tool(
    'character_set_reference_approval',
    'Approve or unapprove a reference image.',
    { projectId: PROJECT, characterId: z.string(), referenceId: z.string(), approved: z.boolean() },
    (a, actor) =>
      studio.story.setReferenceApproval(actor, a.projectId, a.characterId, a.referenceId, a.approved),
  );
  tool(
    'character_describe_from_image',
    'Fill identity fields from an image resource; the photo becomes a reference, so consent states whether it shows a real person (job).',
    { projectId: PROJECT, characterId: z.string(), resourceId: z.string(), consent: ConsentInputSchema },
    (a, actor) => studio.story.describeCharacter(actor, a.projectId, a.characterId, a.resourceId, a.consent),
  );
  tool(
    'character_lock',
    'Lock a character (needs an approved reference) — required before generating shots with it.',
    { projectId: PROJECT, characterId: z.string() },
    (a, actor) => studio.story.lockCharacter(actor, a.projectId, a.characterId),
  );
  tool(
    'character_unlock',
    'Unlock a character to edit its identity (relocking with changes marks older takes stale).',
    { projectId: PROJECT, characterId: z.string() },
    (a, actor) => studio.story.unlockCharacter(actor, a.projectId, a.characterId),
  );
  // Voices (docs/design/dialogue.md)
  tool(
    'character_voice_design',
    'Design voices for a character from its voice description (job): three previews speaking its lines, to pick with character_voice_select.',
    { projectId: PROJECT, characterId: z.string() },
    (a, actor) => studio.voices.design(actor, a.projectId, a.characterId),
  );
  tool(
    'character_voice_select',
    'Use a designed voice preview as the character voice.',
    { projectId: PROJECT, characterId: z.string(), candidateId: z.string() },
    (a, actor) => studio.voices.select(actor, a.projectId, a.characterId, a.candidateId),
  );
  tool(
    'character_voice_clone',
    'Clone a voice from a recording (https or data URI). consent states whether it is a real person (then subject, grantedBy and grantedAt are required, docs/design/provenance.md#consent-records).',
    { projectId: PROJECT, characterId: z.string(), uri: z.string(), consent: ConsentInputSchema },
    (a, actor) => studio.voices.clone(actor, a.projectId, a.characterId, { uri: a.uri }, a.consent),
  );
  tool(
    'character_voice_lock',
    'Lock a character voice — required before generating shots where the character speaks (rule V1).',
    { projectId: PROJECT, characterId: z.string() },
    (a, actor) => studio.voices.lock(actor, a.projectId, a.characterId),
  );
  tool(
    'character_voice_unlock',
    'Unlock a character voice to change it (relocking with changes marks takes where it speaks stale).',
    { projectId: PROJECT, characterId: z.string() },
    (a, actor) => studio.voices.unlock(actor, a.projectId, a.characterId),
  );
  // Elements: locations, props, styles (docs/design/elements.md)
  tool(
    'element_list',
    'List locations, props and styles with lock state, references and whether a scene or shot uses them.',
    { projectId: PROJECT },
    async (a) => summarizeState(await studio.projects.state(a.projectId)).elements,
    ro,
  );
  tool(
    'element_create',
    'Add a location, prop or style element (a recurring place or object kept consistent like a character).',
    { projectId: PROJECT, ...ElementInputSchema.shape },
    (a, actor) => studio.elements.create(actor, a.projectId, a),
  );
  tool(
    'element_update',
    'Edit an element (name and description are frozen while locked; aliases are not).',
    {
      projectId: PROJECT,
      elementId: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      aliases: z.array(z.string()).optional(),
    },
    (a, actor) => studio.elements.update(actor, a.projectId, a.elementId, a),
  );
  tool(
    'element_delete',
    'Remove an unlocked element (scenes using it are unlinked).',
    { projectId: PROJECT, elementId: z.string() },
    async (a, actor) => {
      await studio.elements.remove(actor, a.projectId, a.elementId);
      return { ok: true };
    },
    { destructiveHint: true },
  );
  tool(
    'element_generate_refs',
    'Generate reference images for an element (job): establishing/angle for locations, detail/angle for props.',
    { projectId: PROJECT, elementId: z.string(), views: z.array(ElementReferenceViewSchema).optional() },
    (a, actor) => studio.elements.generateReferences(actor, a.projectId, a.elementId, a.views),
  );
  tool(
    'element_add_reference',
    'Add a reference image of an element from an https or data URI.',
    {
      projectId: PROJECT,
      elementId: z.string(),
      uri: z.string(),
      view: ElementReferenceViewSchema.optional(),
    },
    (a, actor) =>
      studio.elements.addReference(actor, a.projectId, a.elementId, { uri: a.uri }, { view: a.view }),
  );
  tool(
    'element_set_reference_approval',
    'Approve or unapprove an element reference image.',
    { projectId: PROJECT, elementId: z.string(), referenceId: z.string(), approved: z.boolean() },
    (a, actor) =>
      studio.elements.setReferenceApproval(actor, a.projectId, a.elementId, a.referenceId, a.approved),
  );
  tool(
    'element_lock',
    'Lock an element (needs an approved reference) — required before generating shots that use it (rule E1).',
    { projectId: PROJECT, elementId: z.string() },
    (a, actor) => studio.elements.lock(actor, a.projectId, a.elementId),
  );
  tool(
    'element_unlock',
    'Unlock an element to edit it (relocking with changes marks older takes stale).',
    { projectId: PROJECT, elementId: z.string() },
    (a, actor) => studio.elements.unlock(actor, a.projectId, a.elementId),
  );
  tool(
    'resource_add',
    'Add an image, video or audio resource from an https or data URI. Audio and video are probed by an open studio tab of the project (editor job).',
    {
      projectId: PROJECT,
      uri: z.string(),
      kind: ResourceKindSchema.optional(),
      role: ResourceRoleSchema.optional(),
      name: z.string().optional(),
    },
    async (a, actor) => {
      const resource = await studio.story.addResource(actor, a.projectId, { uri: a.uri }, a);
      return resource.status === 'processing'
        ? { resource, ...studio.editor.editorHint(a.projectId) }
        : { resource };
    },
  );
  tool(
    'resource_list',
    'List project resources.',
    { projectId: PROJECT },
    async (a) => Object.values((await studio.projects.state(a.projectId)).docs.resources),
    ro,
  );
  tool(
    'music_generate',
    'Generate music through mm-gateway (job).',
    {
      projectId: PROJECT,
      prompt: z.string().min(3),
      durationSec: z.number().min(5).max(600).optional(),
      instrumental: z.boolean().optional(),
    },
    (a, actor) => studio.story.generateMusic(actor, a.projectId, a),
  );

  // Clips, shots, takes
  tool(
    'clip_plan',
    'Break a scene into model-sized shots (job). generate=true then generates the clip.',
    { projectId: PROJECT, sceneId: z.string(), generate: z.boolean().optional() },
    (a, actor) => studio.clips.planClip(actor, a.projectId, a.sceneId, { thenGenerate: a.generate }),
  );
  tool(
    'clip_generate',
    'Generate every shot of a clip through the consistency gate (job).',
    { projectId: PROJECT, clipId: z.string() },
    (a, actor) => studio.clips.generateClip(actor, a.projectId, a.clipId),
  );
  tool(
    'shot_update',
    'Edit a shot (description, action, camera, characters, duration, continuity, prompt override).',
    {
      projectId: PROJECT,
      clipId: z.string(),
      shotId: z.string(),
      description: z.string().optional(),
      action: z.string().optional(),
      camera: CameraSchema.partial().optional(),
      characterIds: z.array(z.string()).optional(),
      elementIds: z.array(z.string()).optional().describe('The location and the props/styles in the shot'),
      durationSec: z.number().positive().max(60).optional(),
      continuity: z.enum(['cut', 'continuous']).optional(),
      promptOverride: z.string().nullable().optional(),
      negativePrompt: z.string().nullable().optional(),
    },
    (a, actor) => {
      const { projectId, clipId, shotId, ...fields } = a;
      return studio.clips.updateShot(actor, projectId, clipId, shotId, fields);
    },
  );
  tool(
    'shot_regenerate',
    'Generate a new take for a shot (job).',
    { projectId: PROJECT, clipId: z.string(), shotId: z.string() },
    (a, actor) => studio.clips.regenerateShot(actor, a.projectId, a.clipId, a.shotId),
  );
  tool(
    'take_select',
    'Select a take for a shot.',
    { projectId: PROJECT, clipId: z.string(), shotId: z.string(), takeId: z.string() },
    (a, actor) => studio.clips.selectTake(actor, a.projectId, a.clipId, a.shotId, a.takeId),
  );
  tool(
    'take_override',
    'Accept a take that failed or was not verified, with an audited reason (agents need settings.approvals.allowAgentOverrides).',
    {
      projectId: PROJECT,
      clipId: z.string(),
      shotId: z.string(),
      takeId: z.string(),
      reason: z.string().min(3),
    },
    (a, actor) => studio.clips.overrideTake(actor, a.projectId, a.clipId, a.shotId, a.takeId, a.reason),
  );
  tool(
    'clip_approve',
    'Approve a clip (every selected take must pass the consistency gate).',
    { projectId: PROJECT, clipId: z.string() },
    (a, actor) => studio.clips.approveClip(actor, a.projectId, a.clipId),
  );
  tool(
    'batch_generate',
    'Generate the remaining clips up to the target length (job).',
    { projectId: PROJECT, maxGenerations: z.number().int().min(1).optional() },
    (a, actor) => studio.clips.startBatch(actor, a.projectId, a),
  );
  tool('batch_pause', 'Stop the batch (in-flight shots finish).', { projectId: PROJECT }, (a, actor) =>
    studio.clips.pauseBatch(actor, a.projectId),
  );

  // Editing, analysis, export
  tool(
    'timeline_get',
    'The editing timeline.',
    { projectId: PROJECT },
    (a) => studio.edit.timeline(a.projectId),
    ro,
  );
  tool(
    'timeline_apply',
    'Apply timeline operations atomically (insert, remove, move, trim, split, set_transition, set_speed, set_volume, set_fades, set_effects, add_text, update_text, add_track, remove_track, set_track, replace_source, set_output).',
    { projectId: PROJECT, ops: z.array(TimelineOpSchema).min(1) },
    (a, actor) => studio.edit.applyOps(actor, a.projectId, a.ops),
  );
  tool(
    'timeline_assemble',
    'Build the timeline from approved clips (optional captions and music bed).',
    { projectId: PROJECT, captions: z.boolean().optional(), musicResourceId: z.string().optional() },
    (a, actor) => studio.edit.assemble(actor, a.projectId, a),
  );
  tool(
    'footage_analyze',
    'Analyze an uploaded video and propose edit suggestions. The signals are computed by an open studio tab of the project (editor job), then the AI suggestions run on the server.',
    { projectId: PROJECT, resourceId: z.string() },
    async (a, actor) => ({
      ...(await studio.edit.analyze(actor, a.projectId, a.resourceId)),
      ...studio.editor.editorHint(a.projectId),
    }),
  );
  tool(
    'suggestions_review',
    'Accept or reject edit suggestions.',
    {
      projectId: PROJECT,
      analysisId: z.string(),
      decisions: z
        .array(z.object({ id: z.string(), status: z.enum(['pending', 'accepted', 'rejected']) }))
        .min(1),
    },
    (a, actor) => studio.edit.reviewSuggestions(actor, a.projectId, a.analysisId, a.decisions),
  );
  tool(
    'edit_auto',
    'Build the timeline from the accepted suggestions.',
    { projectId: PROJECT, analysisId: z.string() },
    (a, actor) => studio.edit.autoEdit(actor, a.projectId, a.analysisId),
  );
  tool(
    'export_render',
    'Export the timeline: an open studio tab of the project renders it (ffmpeg.wasm or WebCodecs, editor job), then the server adds the invisible watermark. Returns {export, job}; use job_wait.',
    {
      projectId: PROJECT,
      quality: ExportQualitySchema.optional(),
      engine: RenderEngineChoiceSchema.optional(),
    },
    async (a, actor) => ({
      ...(await studio.edit.createExport(actor, a.projectId, a)),
      ...studio.editor.editorHint(a.projectId),
    }),
  );
  tool('export_list', 'List exports.', { projectId: PROJECT }, (a) => studio.edit.exports(a.projectId), ro);
  tool(
    'watermark_detect',
    'Detect the invisible watermark and read the C2PA Content Credentials of a video (https/data URI, or a project media path).',
    { uri: z.string().optional(), projectId: z.string().optional(), mediaPath: z.string().optional() },
    async (a) => {
      const tmp = studio.deps.media.tmp('mp4');
      try {
        if (a.uri) await studio.deps.media.downloadTo(a.uri, tmp);
        else if (a.projectId && a.mediaPath) {
          const res = await studio.deps.media.stream(a.projectId, a.mediaPath);
          if (!res) throw new Error('media not found');
          const { createWriteStream } = await import('node:fs');
          const { pipeline } = await import('node:stream/promises');
          await pipeline(res.stream, createWriteStream(tmp));
        } else throw new Error('pass uri, or projectId and mediaPath');
        return await studio.detectWatermark(tmp);
      } finally {
        await rm(tmp, { force: true });
      }
    },
    ro,
  );

  // History and jobs
  tool(
    'history_log',
    'Commit history (optionally for one document path).',
    {
      projectId: PROJECT,
      path: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      before: z.string().optional(),
    },
    (a) => studio.history.log(a.projectId, a),
    ro,
  );
  tool(
    'history_show',
    'One commit.',
    { projectId: PROJECT, commit: z.string() },
    (a) => studio.history.show(a.projectId, a.commit),
    ro,
  );
  tool(
    'history_diff',
    'Diff two commits (JSON-pointer operations per document).',
    { projectId: PROJECT, from: z.string().optional(), to: z.string() },
    (a) => studio.history.diff(a.projectId, a.from ?? null, a.to),
    ro,
  );
  tool(
    'history_restore',
    'Restore the project or some documents from a commit (creates a new commit).',
    { projectId: PROJECT, commit: z.string(), paths: z.array(z.string()).optional() },
    (a, actor) => studio.history.restore(actor, a.projectId, a.commit, a.paths),
  );
  tool(
    'branch_list',
    'List branches.',
    { projectId: PROJECT },
    (a) => studio.history.branches(a.projectId),
    ro,
  );
  tool(
    'branch_create',
    'Create a branch (from HEAD or a commit).',
    { projectId: PROJECT, name: z.string(), from: z.string().optional() },
    (a, actor) => studio.history.createBranch(actor, a.projectId, a.name, a.from),
  );
  tool(
    'branch_switch',
    'Switch the checked-out branch.',
    { projectId: PROJECT, name: z.string() },
    (a, actor) => studio.history.switchBranch(actor, a.projectId, a.name),
  );
  tool(
    'tag_create',
    'Tag a commit as a milestone.',
    { projectId: PROJECT, name: z.string(), commit: z.string().optional(), message: z.string().optional() },
    (a, actor) => studio.history.createTag(actor, a.projectId, a.name, a.commit, a.message),
  );
  tool(
    'job_list',
    'List jobs.',
    {
      projectId: PROJECT,
      status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']).optional(),
    },
    async (a) => studio.deps.jobs.list(a.projectId, { status: a.status }),
    ro,
  );
  tool(
    'job_get',
    'One job.',
    { projectId: PROJECT, jobId: z.string() },
    async (a) => studio.deps.jobs.get(a.projectId, a.jobId),
    ro,
  );
  tool('job_cancel', 'Cancel a job and its children.', { projectId: PROJECT, jobId: z.string() }, (a) =>
    studio.deps.jobs.cancel(a.projectId, a.jobId),
  );
  tool(
    'job_wait',
    'Wait until a job finishes (or the timeout passes) and return it.',
    { projectId: PROJECT, jobId: z.string(), timeoutSec: z.number().min(1).max(120).optional() },
    async (a) => {
      studio.deps.jobs.get(a.projectId, a.jobId);
      return studio.deps.jobs.wait(a.jobId, (a.timeoutSec ?? 60) * 1000);
    },
    ro,
  );

  // Frontend control
  tool(
    'ui_sessions',
    'Open browser sessions with what each user is looking at.',
    { projectId: z.string().optional() },
    async (a) => studio.ui.sessions(a.projectId),
    ro,
  );
  tool(
    'ui_navigate',
    "Navigate the user's browser to a project view.",
    {
      projectId: PROJECT,
      view: ViewSchema,
      params: z.record(z.string(), z.string()).optional(),
      sessionId: z.string().optional(),
    },
    (a, actor) => studio.ui.navigate(actor, a.projectId, a.view, a.params, a.sessionId),
  );
  tool(
    'ui_focus',
    'Scroll to and highlight an entity in the browser.',
    { projectId: PROJECT, kind: FocusKindSchema, id: z.string(), sessionId: z.string().optional() },
    (a, actor) => studio.ui.focus(actor, a.projectId, { kind: a.kind, id: a.id }, a.sessionId),
  );
  tool(
    'ui_notify',
    'Show a toast in the browser.',
    {
      message: z.string().max(2000),
      level: z.enum(['info', 'success', 'warning', 'error']).optional(),
      projectId: z.string().optional(),
      sessionId: z.string().optional(),
    },
    (a, actor) => studio.ui.notify(actor, a.message, a.level, a.projectId, a.sessionId),
  );
  tool(
    'ui_player',
    'Control the editor preview player.',
    {
      projectId: PROJECT,
      action: z.enum(['play', 'pause', 'seek']),
      time: z.number().min(0).optional(),
      sessionId: z.string().optional(),
    },
    (a, actor) => studio.ui.player(actor, a.projectId, a.action, a.time, a.sessionId),
  );

  // Resources
  server.registerResource(
    'projects',
    'rideo://projects',
    { mimeType: 'application/json', description: 'All projects' },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await studio.projects.list(), null, 2),
        },
      ],
    }),
  );
  server.registerResource(
    'project-state',
    new ResourceTemplate('rideo://projects/{projectId}/state', { list: undefined }),
    { mimeType: 'application/json', description: 'Project snapshot' },
    async (uri, vars) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(summarizeState(await studio.projects.state(String(vars.projectId))), null, 2),
        },
      ],
    }),
  );
  server.registerResource(
    'screenplay',
    new ResourceTemplate('rideo://projects/{projectId}/screenplay.md', { list: undefined }),
    { mimeType: 'text/markdown', description: 'Screenplay as Markdown' },
    async (uri, vars) => {
      const docs = (await studio.projects.state(String(vars.projectId))).docs;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: docs.screenplay
              ? renderScreenplayMarkdown(docs.screenplay, docs.characters)
              : '# (no screenplay yet)\n',
          },
        ],
      };
    },
  );
  return server;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
}

/** Streamable HTTP MCP endpoint at /mcp with stateful sessions (docs/design/mcp.md). */
export function registerMcp(app: FastifyInstance, studio: Studio): void {
  const sessions = new Map<string, Session>();
  const reaper = setInterval(() => {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [id, s] of sessions) {
      if (s.lastSeen < cutoff) {
        void s.transport.close();
        sessions.delete(id);
      }
    }
  }, 60_000);
  reaper.unref();
  app.addHook('onClose', async () => {
    clearInterval(reaper);
    for (const s of sessions.values()) await s.transport.close().catch(() => undefined);
    sessions.clear();
  });

  const jsonRpcError = (code: number, message: string) => ({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });

  app.post('/mcp', async (req, reply) => {
    const sid = req.headers['mcp-session-id'];
    let session = typeof sid === 'string' ? sessions.get(sid) : undefined;
    if (!session) {
      if (typeof sid === 'string') return reply.code(404).send(jsonRpcError(-32001, 'Unknown MCP session'));
      if (!isInitializeRequest(req.body))
        return reply.code(400).send(jsonRpcError(-32000, 'Send an initialize request first'));
      const server = buildServer(studio);
      const created: Session = {
        server,
        lastSeen: Date.now(),
        transport: new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, created);
          },
        }),
      };
      created.transport.onclose = () => {
        if (created.transport.sessionId) sessions.delete(created.transport.sessionId);
      };
      await server.connect(created.transport);
      session = created;
    }
    session.lastSeen = Date.now();
    reply.hijack();
    await session.transport.handleRequest(req.raw, reply.raw, req.body);
  });

  const streamOrEnd = async (
    req: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
  ) => {
    const sid = req.headers['mcp-session-id'];
    const session = typeof sid === 'string' ? sessions.get(sid) : undefined;
    if (!session) return reply.code(404).send(jsonRpcError(-32001, 'Unknown MCP session'));
    session.lastSeen = Date.now();
    reply.hijack();
    await session.transport.handleRequest(req.raw, reply.raw);
  };
  app.get('/mcp', streamOrEnd);
  app.delete('/mcp', streamOrEnd);
}
