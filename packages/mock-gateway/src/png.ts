import { PNG } from 'pngjs';

export interface Rgba {
  width: number;
  height: number;
  data: Buffer;
}

export function encodePng(img: Rgba): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  return PNG.sync.write(png);
}

export function decodePng(buf: Buffer): Rgba {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: png.data };
}

export function parseDataUri(uri: string): { mime: string; data: Buffer } | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(uri);
  if (!m) return null;
  return { mime: m[1]!, data: m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!)) };
}

export function isPng(buf: Buffer): boolean {
  return buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
}
