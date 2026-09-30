import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function sha256(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export function hmac(key: string, message: string): Buffer {
  return createHmac('sha256', key).update(message).digest();
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}
