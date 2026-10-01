import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

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
  const h = Buffer.alloc(512);
  // Names up to 255 bytes: a prefix (155) and a name (100) split at a slash.
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100)
      throw new Error(`tar: name too long: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  const put = (s: string, at: number, len: number) => h.write(s, at, len, 'utf8');
  const octal = (v: number, len: number) => v.toString(8).padStart(len - 1, '0');
  put(base, 0, 100);
  put('0000644\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(`${octal(size, 12)}\0`, 124, 12);
  put(`${octal(mtime, 12)}\0`, 136, 12);
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put('rideo', 265, 32);
  put('rideo', 297, 32);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}
