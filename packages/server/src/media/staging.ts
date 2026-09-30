import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StagedNameSchema } from '@rideo/shared';
import { AppError, invalid } from '../errors';
import { randomHex } from '../util/crypto';

/**
 * Files uploaded by editor jobs live on the server's disk until their follow-up job consumes them
 * (docs/design/storage-webdav.md#local-cache-and-staging). Nothing here is published or versioned.
 */
export class Staging {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, 'staging');
  }

  dir(jobId: string): string {
    if (!/^job_[0-9a-z]+$/.test(jobId)) throw invalid('invalid job id');
    return join(this.root, jobId);
  }

  path(jobId: string, name: string): string {
    const parsed = StagedNameSchema.safeParse(name);
    if (!parsed.success) throw invalid(`invalid staged file name ${JSON.stringify(name)}`);
    return join(this.dir(jobId), parsed.data);
  }

  /** Streams a file in (atomically: `.part` then rename), enforcing the size limit. */
  async write(jobId: string, name: string, body: NodeJS.ReadableStream, maxBytes: number): Promise<number> {
    const target = this.path(jobId, name);
    await mkdir(this.dir(jobId), { recursive: true });
    const tmp = `${target}.part-${randomHex(4)}`;
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) cb(new AppError('validation_error', `staged file exceeds ${maxBytes} bytes`));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(body, counter, createWriteStream(tmp));
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return size;
  }

  async exists(jobId: string, name: string): Promise<boolean> {
    return (await stat(this.path(jobId, name)).catch(() => null))?.isFile() ?? false;
  }

  async remove(jobId: string): Promise<void> {
    await rm(this.dir(jobId), { recursive: true, force: true });
  }

  /** Removes staging folders of jobs that are no longer active and older than `maxAgeMs`. */
  async sweep(isActive: (jobId: string) => boolean, maxAgeMs = 24 * 3600_000): Promise<number> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    let removed = 0;
    for (const e of entries) {
      if (!e.isDirectory() || isActive(e.name)) continue;
      const st = await stat(join(this.root, e.name)).catch(() => null);
      if (st && Date.now() - st.mtimeMs > maxAgeMs) {
        await rm(join(this.root, e.name), { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }
}
