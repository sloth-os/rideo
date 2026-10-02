import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Actor,
  assembleAnimatic,
  boardApprovable,
  boardState,
  type Character,
  type Clip,
  detectScriptFormat,
  docPath,
  type Element,
  fountainFromPdfLines,
  importedToScreenplayOutput,
  type Job,
  type ParsedScript,
  type Project,
  type ProjectDocs,
  parseFdx,
  parseFountain,
  type Screenplay,
  type ScriptFormat,
  sceneSeconds,
  screenplayFromLlm,
  shotListCsv,
  shotListRows,
  sortedClips,
  storyboardClips,
  type Timeline,
} from '@rideo/shared';
import { AppError, conflict, invalid, notFound } from '../errors';
import { PdfDocument, pdfTextLines, wrapText } from '../media/pdf';
import type { Tx } from '../vcs/repo';
import { Service } from './base';
import { assertCastReady, clipStatusOf } from './clips';
import type { UploadSource } from './story';

export type ScriptSource = UploadSource | { text: string; format?: ScriptFormat; filename?: string };

/** The storyboard stage (docs/design/storyboard.md): frames, approval, order, the animatic, import, shot list. */
export class StoryboardService extends Service {
  private async docs(projectId: string): Promise<ProjectDocs> {
    return this.deps.projects.docs(projectId);
  }

  private requireShot(clip: Clip, shotId: string) {
    const shot = clip.shots.find((s) => s.id === shotId);
    if (!shot) throw notFound(`shot ${shotId}`);
    return shot;
  }

  /** Plans and draws the storyboarded scenes (`storyboard.generate`). */
  async generate(actor: Actor, projectId: string, sceneIds?: string[]): Promise<Job> {
    const docs = await this.docs(projectId);
    if (!docs.screenplay?.scenes.length) throw invalid('write or import the screenplay first');
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'storyboard.generate',
      params: sceneIds?.length ? { sceneIds } : {},
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: 'storyboard',
      priority: 4,
    });
  }

  /** Draws (or redraws) one frame (`shot.board`). */
  async generateBoard(actor: Actor, projectId: string, clipId: string, shotId: string): Promise<Job> {
    const docs = await this.docs(projectId);
    const clip = docs.clips[clipId];
    if (!clip) throw notFound(`clip ${clipId}`);
    const shot = this.requireShot(clip, shotId);
    assertCastReady([shot], docs.characters, docs.elements);
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'shot.board',
      params: { clipId, shotId },
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: `board:${shotId}`,
      priority: 5,
    });
  }

  private txDocs(tx: Tx): ProjectDocs {
    return {
      project: tx.require<Project>('project.json', 'project'),
      screenplay: tx.get<Screenplay>('screenplay.json') ?? null,
      timeline: null,
      animatic: null,
      characters: Object.fromEntries(tx.list<Character>('characters/').map((c) => [c.id, c])),
      elements: Object.fromEntries(tx.list<Element>('elements/').map((e) => [e.id, e])),
      clips: Object.fromEntries(tx.list<Clip>('clips/').map((c) => [c.id, c])),
      resources: {},
      analyses: {},
      exports: {},
      localizations: {},
      comments: {},
      reviews: {},
    };
  }

  /** Approves or unapproves a frame; only current frames that did not fail can be approved. */
  async approve(
    actor: Actor,
    projectId: string,
    clipId: string,
    shotId: string,
    approved: boolean,
  ): Promise<Clip> {
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const docs = this.txDocs(tx);
        this.assertAgentMay(docs.project, actor, 'approve');
        const clip = structuredClone(docs.clips[clipId]);
        if (!clip) throw notFound(`clip ${clipId}`);
        const shot = this.requireShot(clip, shotId);
        if (approved) {
          const state = boardState(shot, docs);
          if (!boardApprovable(state))
            throw new AppError(
              'board_unapprovable',
              `The frame of shot c${clip.index + 1}-s${shot.index + 1} is ${state}; regenerate it first`,
              [state],
            );
        }
        if (!shot.board) throw notFound(`storyboard frame of shot ${shotId}`);
        shot.board = {
          ...shot.board,
          approved,
          approvedAt: approved ? new Date().toISOString() : null,
          approvedBy: approved ? actor : null,
        };
        tx.set(docPath.clip(clipId), clip);
        return clip;
      },
      {
        message: (c) =>
          `${approved ? 'Approve' : 'Unapprove'} storyboard frame c${c.index + 1}-s${(c.shots.find((s) => s.id === shotId)?.index ?? 0) + 1}`,
      },
    );
    return result;
  }

  /** Approves every current, unapproved frame of the storyboarded scenes. */
  async approveAll(actor: Actor, projectId: string): Promise<{ approved: number }> {
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const docs = this.txDocs(tx);
        this.assertAgentMay(docs.project, actor, 'approve');
        let approved = 0;
        const at = new Date().toISOString();
        for (const clip of storyboardClips(docs)) {
          const next = structuredClone(clip);
          let changed = false;
          for (const shot of next.shots) {
            if (shot.board && boardState(shot, docs) === 'unapproved') {
              shot.board = { ...shot.board, approved: true, approvedAt: at, approvedBy: actor };
              approved++;
              changed = true;
            }
          }
          if (changed) tx.set(docPath.clip(clip.id), next);
        }
        return { approved };
      },
      { message: (r) => `Approve ${r.approved} storyboard frame(s)` },
    );
    return result;
  }

  /**
   * Reorders the shots of a clip. The first shot is a cut, and a continuous shot whose predecessor changed becomes a
   * cut (it no longer continues the same frame).
   */
  async reorder(actor: Actor, projectId: string, clipId: string, shotIds: string[]): Promise<Clip> {
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const clip = structuredClone(tx.require<Clip>(docPath.clip(clipId), `clip ${clipId}`));
        const before = [...clip.shots].sort((a, b) => a.index - b.index);
        if (shotIds.length !== before.length || !before.every((s) => shotIds.includes(s.id)))
          throw invalid('shotIds must list every shot of the clip exactly once');
        const prevOf = new Map(before.map((s, i) => [s.id, before[i - 1]?.id ?? null]));
        clip.shots = shotIds.map((id, index) => {
          const shot = before.find((s) => s.id === id)!;
          const prev = shotIds[index - 1] ?? null;
          const continuity = index === 0 || prevOf.get(id) !== prev ? 'cut' : shot.continuity;
          return { ...shot, index, continuity };
        });
        clip.status = clipStatusOf(clip);
        tx.set(docPath.clip(clipId), clip);
        return clip;
      },
      { message: (c) => `Reorder the shots of clip ${c.index + 1}` },
    );
    return result;
  }

  /** Builds `animatic.json` from the storyboard frames (docs/design/storyboard.md#animatic). */
  async buildAnimatic(
    actor: Actor,
    projectId: string,
    opts: { musicResourceId?: string; captions?: boolean } = {},
  ): Promise<Timeline> {
    const docs = await this.docs(projectId);
    const music = opts.musicResourceId ? docs.resources[opts.musicResourceId] : undefined;
    if (opts.musicResourceId && music?.kind !== 'audio')
      throw invalid(`resource ${opts.musicResourceId} is not an audio resource`);
    const s = docs.project.settings;
    const timeline = assembleAnimatic({
      clips: storyboardClips(docs),
      fps: s.fps,
      width: s.resolution.width,
      height: s.resolution.height,
      characters: docs.characters,
      captions: opts.captions ?? true,
      ...(music ? { music: { media: music.media, resourceId: music.id } } : {}),
    });
    if (!timeline.tracks.some((t) => t.kind === 'video' && t.items.length))
      throw invalid('there are no storyboard frames yet; generate the storyboard first');
    await this.mutate(actor, projectId, (tx) => tx.set(docPath.animatic(), timeline), {
      message: `Build the animatic (${timeline.tracks.find((t) => t.kind === 'video')!.items.length} frames)`,
    });
    return timeline;
  }

  /** Fountain, Final Draft or PDF → the screenplay, draft characters and locations (docs/design/storyboard.md). */
  async importScreenplay(
    actor: Actor,
    projectId: string,
    source: ScriptSource,
    opts: { replace?: boolean } = {},
  ): Promise<{ title: string; scenes: number; characters: number; elements: number; durationSec: number }> {
    const docs = await this.docs(projectId);
    if (docs.project.kind !== 'story') throw invalid('screenplays are imported into story projects');
    if (docs.project.workflow.approvals.screenplay_approved)
      throw conflict('the screenplay is approved; reopen the screenplay stage to replace it');
    if (docs.screenplay && !opts.replace)
      throw conflict('the project has a screenplay; import with replace: true to replace it');
    const script = await this.readScript(source);
    if (!script.scenes.length) throw invalid('no scene found in the screenplay');
    const out = importedToScreenplayOutput(script, docs.project.title);
    const durationSec = script.scenes.reduce((sum, sc) => sum + sceneSeconds(sc), 0);
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const project = structuredClone(tx.require<Project>('project.json', 'project'));
        const { screenplay, characters, elements } = screenplayFromLlm(out, {
          targetDurationSec: durationSec,
          language: project.settings.language,
          existing: tx.list<Character>('characters/'),
          existingElements: tx.list<Element>('elements/'),
        });
        if (opts.replace) for (const c of tx.list<Clip>('clips/')) tx.delete(docPath.clip(c.id));
        tx.set('screenplay.json', screenplay);
        for (const c of characters) tx.set(docPath.character(c.id), c);
        for (const e of elements) tx.set(docPath.element(e.id), e);
        // The film is as long as the script; a brief still names it so the brief gate can be submitted.
        project.settings.targetDurationSec = Math.min(10800, Math.max(10, durationSec));
        project.settings.pilotDurationSec = Math.min(
          project.settings.pilotDurationSec,
          project.settings.targetDurationSec,
        );
        if (!project.brief.prompt.trim()) project.brief.prompt = `Imported screenplay “${screenplay.title}”`;
        tx.set('project.json', project);
        return {
          title: screenplay.title,
          scenes: screenplay.scenes.length,
          characters: characters.length,
          elements: elements.length,
          durationSec,
        };
      },
      {
        message: (r) =>
          `Import screenplay “${r.title}” (${r.scenes} scenes, ${r.characters} characters, ${r.elements} locations)`,
      },
    );
    this.activity(
      projectId,
      actor,
      'screenplay.import',
      `Imported “${result.title}” (${result.scenes} scenes)`,
    );
    return result;
  }

  private async readScript(source: ScriptSource): Promise<ParsedScript> {
    let data: Buffer;
    let name = '';
    let mime = '';
    let format: ScriptFormat | undefined;
    if ('text' in source) {
      data = Buffer.from(source.text, 'utf8');
      name = source.filename ?? '';
      format = source.format;
    } else if ('file' in source) {
      data = await readFile(source.file);
      name = source.filename;
      mime = source.mime ?? '';
    } else {
      data = await this.deps.media.withTmpDir(async (dir) => {
        const path = join(dir, 'script');
        const got = await this.deps.media.downloadTo(source.uri, path);
        mime = got.mime;
        return readFile(path);
      });
      name = source.uri.split('?')[0]!.split('/').pop() ?? '';
    }
    if (data.length > 20 * 1024 * 1024) throw invalid('screenplay files are limited to 20 MB');
    format ??= detectScriptFormat(name, mime, data.subarray(0, 512).toString('latin1'));
    try {
      if (format === 'pdf')
        return parseFountain(fountainFromPdfLines(await pdfTextLines(new Uint8Array(data))));
      const text = data.toString('utf8');
      return format === 'fdx' ? parseFdx(text) : parseFountain(text);
    } catch (err) {
      throw invalid(`could not read the ${format} screenplay: ${(err as Error).message}`);
    }
  }

  async shotListCsv(projectId: string): Promise<string> {
    return shotListCsv(await this.docs(projectId));
  }

  /** The shot list as a PDF: A4 landscape, one row per shot with its storyboard frame. */
  async shotListPdf(projectId: string): Promise<Buffer> {
    const docs = await this.docs(projectId);
    const rows = shotListRows(docs);
    const frames = new Map<string, { data: Buffer; width: number; height: number }>();
    const shots = sortedClips(docs).flatMap((c) => [...c.shots].sort((a, b) => a.index - b.index));
    await this.deps.media.withTmpDir(async (dir) => {
      for (const shot of shots) {
        if (!shot.board) continue;
        const src = await this.deps.media.localPath(projectId, shot.board.keyframe);
        const out = join(dir, `${shot.id}.jpg`);
        await this.deps.ff.run(['-i', src, '-vf', 'scale=320:-2', '-q:v', '4', '-frames:v', '1', out]);
        const probe = await this.deps.ff.probe(out);
        frames.set(shot.id, {
          data: await readFile(out),
          width: probe.width ?? 320,
          height: probe.height ?? 180,
        });
      }
    });
    const pdf = new PdfDocument();
    const W = 842;
    const H = 595;
    const M = 36;
    const cols = { frame: M, shot: M + 132, text: M + 222, dialogue: M + 520, state: W - M - 70 };
    let y = 0;
    const header = (first: boolean) => {
      pdf.addPage(W, H);
      pdf.text(M, M + 6, docs.screenplay?.title ?? docs.project.title, { size: first ? 16 : 11, bold: true });
      pdf.text(W - M - 120, M + 6, `Shot list · ${new Date().toISOString().slice(0, 10)}`, {
        size: 9,
        gray: 0.4,
      });
      y = M + 28;
      for (const [x, label] of [
        [cols.frame, 'Frame'],
        [cols.shot, 'Shot'],
        [cols.text, 'Description'],
        [cols.dialogue, 'Dialogue'],
        [cols.state, 'Board / take'],
      ] as const)
        pdf.text(x, y, label, { size: 8, bold: true, gray: 0.3 });
      y += 6;
      pdf.line(M, y, W - M, y, 0.5);
      y += 6;
    };
    header(true);
    rows.forEach((row, i) => {
      const rowH = 80;
      if (y + rowH > H - M) header(false);
      const frame = frames.get(shots[i]!.id);
      if (frame) {
        const h = Math.min(68, (120 * frame.height) / frame.width);
        pdf.jpeg(frame, cols.frame, y + 2, (h * frame.width) / frame.height, h);
      } else pdf.text(cols.frame, y + 14, 'no frame', { size: 8, gray: 0.5 });
      pdf.text(cols.shot, y + 12, `C${row.clip} · S${row.shot}`, { size: 10, bold: true });
      pdf.text(cols.shot, y + 25, `${row.duration_sec} s · ${row.continuity}`, { size: 8 });
      pdf.text(cols.shot, y + 36, `${row.framing.replace(/_/g, ' ')}`, { size: 8 });
      pdf.text(cols.shot, y + 47, `${row.movement.replace(/_/g, ' ')}`, { size: 8 });
      const scene = wrapText(row.scene, 7, 290, 1, true);
      pdf.text(cols.text, y + 10, scene[0] ?? '', { size: 7, bold: true, gray: 0.35 });
      wrapText([row.description, row.action].filter(Boolean).join(' — '), 8, 290, 5).forEach((l, k) => {
        pdf.text(cols.text, y + 22 + k * 10, l, { size: 8 });
      });
      const who = [row.characters, row.location, row.props].filter(Boolean).join(' · ');
      if (who) pdf.text(cols.text, y + 74, wrapText(who, 7, 290, 1)[0]!, { size: 7, gray: 0.4 });
      wrapText(row.dialogue, 8, 190, 6).forEach((l, k) => {
        pdf.text(cols.dialogue, y + 12 + k * 10, l, { size: 8 });
      });
      pdf.text(cols.state, y + 12, row.board, { size: 8 });
      pdf.text(cols.state, y + 24, row.take, { size: 8, gray: 0.4 });
      y += rowH;
      pdf.line(M, y, W - M, y);
    });
    if (!rows.length) pdf.text(M, y + 14, 'No shots are planned yet.', { size: 10, gray: 0.4 });
    return pdf.toBuffer();
  }
}
