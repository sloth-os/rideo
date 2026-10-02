import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign,
} from 'node:crypto';

/**
 * Web Push messages (docs/design/pwa.md#notifications-on-the-phone-web-push): RFC 8291 message encryption
 * (`aes128gcm`: ECDH P-256, HKDF-SHA-256, AES-128-GCM, one record) and RFC 8292 VAPID authorization (an ES256 JWT).
 */

const fromB64u = (s: string) => Buffer.from(s, 'base64url');

/** HKDF-SHA-256 (RFC 5869) with one output block, enough for keys up to 32 bytes. */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  return createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, length);
}

/** A subscription's keys, as the browser gives them (base64url). */
export interface PushKeys {
  /** The device's P-256 public key, uncompressed (65 bytes). */
  p256dh: string;
  /** The 16-byte authentication secret. */
  auth: string;
}

/** The content key and nonce of a message (RFC 8291 §3.4, §2.2 of RFC 8188). */
function keys(salt: Buffer, ecdhSecret: Buffer, authSecret: Buffer, uaPublic: Buffer, asPublic: Buffer) {
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  return {
    cek: hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
    nonce: hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12),
  };
}

/** The record size advertised in the header (one record carries the whole message). */
const RECORD_SIZE = 4096;

/**
 * Encrypts a message for one device: `salt (16) | rs (4) | idlen (1) | the server's public key (65)` and the
 * ciphertext of `payload | 0x02`. `salt` and `serverPrivateKey` are fixed only by tests (RFC 8291 Appendix A).
 */
export function encryptPush(
  payload: Buffer,
  keysOf: PushKeys,
  opts: { salt?: Buffer; serverPrivateKey?: Buffer } = {},
): Buffer {
  const uaPublic = fromB64u(keysOf.p256dh);
  const authSecret = fromB64u(keysOf.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4)
    throw new Error('p256dh must be an uncompressed P-256 key');
  if (authSecret.length !== 16) throw new Error('auth must be 16 bytes');
  if (payload.length > RECORD_SIZE - 17 - 86) throw new Error('push payload too large');
  const ecdh = createECDH('prime256v1');
  if (opts.serverPrivateKey) ecdh.setPrivateKey(opts.serverPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = opts.salt ?? randomBytes(16);
  const { cek, nonce } = keys(salt, ecdh.computeSecret(uaPublic), authSecret, uaPublic, asPublic);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([payload, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** Decrypts a message as the device does (tests, and the e2e push sink). */
export function decryptPush(body: Buffer, devicePrivateKey: Buffer, keysOf: PushKeys): Buffer {
  const uaPublic = fromB64u(keysOf.p256dh);
  const authSecret = fromB64u(keysOf.auth);
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(devicePrivateKey);
  const { cek, nonce } = keys(salt, ecdh.computeSecret(asPublic), authSecret, uaPublic, asPublic);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error('not the last record');
  return plain.subarray(0, end);
}

/** A VAPID key pair (base64url: the uncompressed public key and the 32-byte private scalar). */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: Buffer.concat([Buffer.alloc(32), ecdh.getPrivateKey()])
      .subarray(-32)
      .toString('base64url'),
  };
}

/**
 * The `Authorization` header of a push request (RFC 8292): `vapid t=<ES256 JWT for the push service's origin>,
 * k=<public key>`, valid 12 hours.
 */
export function vapidAuthorization(
  endpoint: string,
  vapid: VapidKeys & { subject: string },
  now = Date.now(),
): string {
  const pub = fromB64u(vapid.publicKey);
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: vapid.privateKey,
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: vapid.subject,
  })}`;
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${vapid.publicKey}`;
}
