import { createReadStream } from 'node:fs';
import { open, stat, writeFile } from 'node:fs/promises';
import {
  type Actor,
  authorOf,
  type BrandAsset,
  type BrandKit,
  type BrandKitInput,
  BrandKitSchema,
  type BrandSlot,
  docPath,
  isFontFile,
  type MediaRef,
  newId,
  type Project,
  type ProjectBrand,
  ProjectBrandSchema,
  slugify,
} from '@rideo/shared';
import { currentPrincipal } from '../auth/context';
import { AppError, invalid, notFound } from '../errors';
import { extFor } from '../media/store';
import { sha256File } from '../util/crypto';
import { Service } from './base';

const FONT_MAX = 20 * 1024 ** 2;
const MEDIA_MAX = 500 * 1024 ** 2;
const BUMPER_MAX_SEC = 30;
const IMAGE = /^image\/(png|jpeg|webp)$/;
const VIDEO = /^video\/(mp4|quicktime|webm)$/;

/**
 * Brand kits (docs/design/brand-kits.md): kept on the storage backend for the whole studio, applied to a project by
 * copying their files into its media.
 */
export class BrandService extends Service {
  private readonly kits = new Map<string, BrandKit>();
  private loaded: Promise<void> | null = null;

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const dir = this.deps.layout.brandKitsDir();
      for (const e of await this.deps.storage.list(dir).catch(() => [])) {
        if (!e.name.endsWith('.json')) continue;
        const buf = await this.deps.storage.read(`${dir}/${e.name}`).catch(() => null);
        if (!buf) continue;
        try {
          const kit = BrandKitSchema.parse(JSON.parse(buf.toString('utf8')));
          this.kits.set(kit.id, kit);
        } catch (err) {
          this.deps.log.warn({ file: e.name, err: (err as Error).message }, 'skipping an invalid brand kit');
        }
      }
    })();
    return this.loaded;
  }

  async list(): Promise<BrandKit[]> {
    await this.load();
    return [...this.kits.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<BrandKit> {
    await this.load();
    const kit = this.kits.get(id);
    if (!kit) throw notFound(`brand kit ${id}`);
    return kit;
  }

  private async save(kit: BrandKit): Promise<BrandKit> {
    const valid = BrandKitSchema.parse(kit);
    await this.deps.storage.write(this.deps.layout.brandKit(valid.id), JSON.stringify(valid, null, 2), {
      contentType: 'application/json',
    });
    this.kits.set(valid.id, valid);
    return valid;
  }

  private mayChange(actor: Actor, kit: BrandKit): void {
    const p = currentPrincipal();
    if (!p || p.kind === 'studio' || p.admin) return;
    if (kit.createdBy.id === actor.id || kit.createdBy.id === p.user.id) return;
    throw new AppError('forbidden', 'Only its author or an admin changes a brand kit');
  }

  async create(actor: Actor, input: BrandKitInput): Promise<BrandKit> {
    await this.load();
    const now = new Date().toISOString();
    const kit = await this.save(
      BrandKitSchema.parse({
        id: newId('brandKit'),
        name: input.name,
        ...(input.colors ? { colors: input.colors } : {}),
        ...(input.bug ? { bug: input.bug } : {}),
        ...(input.lowerThirds ? { lowerThirds: input.lowerThirds } : {}),
        createdBy: authorOf(actor),
        createdAt: now,
        updatedAt: now,
      }),
    );
    this.deps.metrics.brand.inc({ event: 'created' });
    this.deps.log.info({ kitId: kit.id }, 'brand kit created');
    return kit;
  }

  async update(actor: Actor, id: string, input: Partial<BrandKitInput>): Promise<BrandKit> {
    const kit = await this.get(id);
    this.mayChange(actor, kit);
    return this.save({
      ...kit,
      ...(input.name ? { name: input.name } : {}),
      colors: { ...kit.colors, ...input.colors },
      bug: { ...kit.bug, ...input.bug },
      ...(input.lowerThirds ? { lowerThirds: input.lowerThirds } : {}),
      intro:
        kit.intro && input.intro?.durationSec
          ? { ...kit.intro, durationSec: input.intro.durationSec }
          : kit.intro,
      outro:
        kit.outro && input.outro?.durationSec
          ? { ...kit.outro, durationSec: input.outro.durationSec }
          : kit.outro,
      updatedAt: new Date().toISOString(),
    });
  }

  async remove(actor: Actor, id: string): Promise<void> {
    const kit = await this.get(id);
    this.mayChange(actor, kit);
    for (const a of assetsOf(kit))
      await this.deps.storage.delete(this.deps.layout.brandKitFile(id, a.file)).catch(() => undefined);
    await this.deps.storage.delete(this.deps.layout.brandKit(id));
    this.kits.delete(id);
  }

  /** A file into a slot of a kit: validated (font signature, image or video probe, sizes, bumper length). */
  async putFile(
    actor: Actor,
    id: string,
    slot: BrandSlot,
    upload: { path: string; filename: string; mime: string },
  ): Promise<BrandKit> {
    const kit = await this.get(id);
    this.mayChange(actor, kit);
    const size = (await stat(upload.path)).size;
    const font = slot === 'title_font' || slot === 'body_font';
    let mime = upload.mime;
    let probe: Partial<MediaRef> = {};
    if (font) {
      if (size > FONT_MAX) throw invalid('fonts are at most 20 MB');
      const head = Buffer.alloc(4);
      const fh = await open(upload.path, 'r');
      try {
        await fh.read(head, 0, 4, 0);
      } finally {
        await fh.close();
      }
      if (!isFontFile(head)) throw invalid('not a TrueType or OpenType font');
      mime = head.toString('latin1') === 'OTTO' ? 'font/otf' : 'font/ttf';
    } else {
      if (size > MEDIA_MAX) throw invalid('brand files are at most 500 MB');
      const image = IMAGE.test(mime);
      const video = VIDEO.test(mime);
      if (slot === 'logo' && !image) throw invalid('the logo is a PNG, JPEG or WebP image');
      if (slot !== 'logo' && !image && !video)
        throw invalid('a bumper is a video (MP4, MOV, WebM) or a still image');
      probe = await this.deps.media.probeRef(upload.path, mime);
      if (!probe.width || !probe.height) throw invalid('the file could not be read as an image or a video');
      if (video && (probe.durationSec ?? 0) > BUMPER_MAX_SEC) throw invalid('bumpers are at most 30 seconds');
    }
    const hash = await sha256File(upload.path);
    const file = `${slugify(upload.filename.replace(/\.[^.]+$/, ''), 40) || slot}-${hash.slice(0, 12)}.${extFor(mime, upload.filename)}`;
    await this.deps.storage.write(this.deps.layout.brandKitFile(id, file), createReadStream(upload.path), {
      contentType: mime,
      size,
    });
    const asset: BrandAsset = {
      name: upload.filename.slice(0, 200),
      file,
      hash,
      mime,
      size,
      ...(probe.width ? { width: probe.width } : {}),
      ...(probe.height ? { height: probe.height } : {}),
      ...(probe.durationSec !== undefined && VIDEO.test(mime) ? { durationSec: probe.durationSec } : {}),
      ...(probe.hasAudio !== undefined ? { hasAudio: probe.hasAudio } : {}),
    };
    const bumper = (cur: BrandKit['intro']) => ({
      asset,
      durationSec: VIDEO.test(mime)
        ? Math.min(BUMPER_MAX_SEC, Math.max(0.5, probe.durationSec ?? 3))
        : (cur?.durationSec ?? 3),
    });
    const next: BrandKit = {
      ...kit,
      fonts: {
        title: slot === 'title_font' ? asset : kit.fonts.title,
        body: slot === 'body_font' ? asset : kit.fonts.body,
      },
      logo: slot === 'logo' ? asset : kit.logo,
      intro: slot === 'intro' ? bumper(kit.intro) : kit.intro,
      outro: slot === 'outro' ? bumper(kit.outro) : kit.outro,
      updatedAt: new Date().toISOString(),
    };
    this.deps.metrics.brand.inc({ event: 'file' });
    return this.save(next);
  }

  /** A kit's file, for the Brand kits page. */
  async file(id: string, file: string, range?: { start: number; end?: number }) {
    const kit = await this.get(id);
    const asset = assetsOf(kit).find((a) => a.file === file);
    if (!asset) throw notFound(`brand file ${file}`);
    const res = await this.deps.storage.readStream(this.deps.layout.brandKitFile(id, file), range);
    if (!res) throw notFound(`brand file ${file}`);
    return { ...res, mime: asset.mime };
  }

  /** Applies a kit to a project: its files copied into the project's media, the resolved brand in its settings. */
  async apply(actor: Actor, projectId: string, kitId: string | null): Promise<ProjectBrand | null> {
    let brand: ProjectBrand | null = null;
    if (kitId) {
      const kit = await this.get(kitId);
      const copy = async (a: BrandAsset | null | undefined): Promise<MediaRef | null> => {
        if (!a) return null;
        const buf = await this.deps.storage.read(this.deps.layout.brandKitFile(kit.id, a.file));
        if (!buf) throw notFound(`brand file ${a.file}`);
        return this.deps.media.withTmpDir(async (dir) => {
          const tmp = `${dir}/${a.file}`;
          await writeFile(tmp, buf);
          return this.deps.media.putFile(projectId, tmp, {
            kind: 'brand',
            name: a.file.replace(/-[0-9a-f]{12}\.[^.]+$/, ''),
            mime: a.mime,
            probe: a.mime.startsWith('font/') ? false : undefined,
          });
        });
      };
      const intro = await copy(kit.intro?.asset);
      const outro = await copy(kit.outro?.asset);
      brand = ProjectBrandSchema.parse({
        kitId: kit.id,
        name: kit.name,
        colors: kit.colors,
        fonts: { title: await copy(kit.fonts.title), body: await copy(kit.fonts.body) },
        logo: await copy(kit.logo),
        bug: kit.bug,
        intro: intro ? { media: intro, durationSec: kit.intro!.durationSec } : null,
        outro: outro ? { media: outro, durationSec: kit.outro!.durationSec } : null,
        lowerThirds: kit.lowerThirds,
        appliedAt: new Date().toISOString(),
      });
    }
    await this.mutate(
      actor,
      projectId,
      (tx) => {
        const project = tx.require<Project>(docPath.project(), 'project');
        tx.set(docPath.project(), { ...project, settings: { ...project.settings, brand } });
      },
      { message: brand ? `Apply the brand kit “${brand.name}”` : 'Remove the brand kit' },
    );
    this.deps.metrics.brand.inc({ event: brand ? 'applied' : 'removed' });
    this.deps.log.info({ projectId, kitId }, brand ? 'brand applied' : 'brand removed');
    return brand;
  }
}

function assetsOf(kit: BrandKit): BrandAsset[] {
  return [kit.fonts.title, kit.fonts.body, kit.logo, kit.intro?.asset, kit.outro?.asset].filter(
    (a): a is BrandAsset => !!a,
  );
}
