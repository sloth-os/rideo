import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { tarHeader } from '@rideo/shared';

/**
 * A ustar archive of local files (image-sequence masters, docs/design/finishing.md#formats): a 512-byte header per
 * file, the bytes padded to 512, two empty blocks at the end. Streams, so masters of any length fit.
 */
export async function writeTar(out: string, entries: { name: string; path: string }[]): Promise<void> {
  const file = createWriteStream(out);
  const write = (b: Buffer) =>
    new Promise<void>((resolve, reject) => file.write(b, (err) => (err ? reject(err) : resolve())));
  try {
    for (const e of entries) {
      const { size, mtimeMs } = await stat(e.path);
      await write(header(e.name, size, Math.floor(mtimeMs / 1000)));
      await pipeline(createReadStream(e.path), file, { end: false });
      if (size % 512) await write(Buffer.alloc(512 - (size % 512)));
    }
    await write(Buffer.alloc(1024));
  } finally {
    await new Promise<void>((resolve) => file.end(resolve));
  }
}

function header(name: string, size: number, mtime: number): Buffer {
  return Buffer.from(tarHeader(name, size, mtime));
}
