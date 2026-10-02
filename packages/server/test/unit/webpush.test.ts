import { createECDH, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptPush, encryptPush, generateVapidKeys, vapidAuthorization } from '../../src/push/webpush';

const b = (s: string) => Buffer.from(s, 'base64url');

describe('Web Push (docs/design/pwa.md#notifications-on-the-phone-web-push)', () => {
  // RFC 8291, Appendix A
  const rfc = {
    plaintext: 'When I grow up, I want to be a watermelon',
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  };

  it('encrypts as RFC 8291 Appendix A, and decrypts it back', () => {
    const body = encryptPush(
      Buffer.from(rfc.plaintext),
      { p256dh: rfc.uaPublic, auth: rfc.auth },
      { salt: b(rfc.salt), serverPrivateKey: b(rfc.asPrivate) },
    );
    expect(body.toString('base64url')).toBe(rfc.body);
    expect(
      decryptPush(b(rfc.body), b(rfc.uaPrivate), { p256dh: rfc.uaPublic, auth: rfc.auth }).toString(),
    ).toBe(rfc.plaintext);
  });

  it('round-trips with fresh keys and salts, and refuses bad keys and large payloads', () => {
    const device = createECDH('prime256v1');
    device.generateKeys();
    const keys = {
      p256dh: device.getPublicKey().toString('base64url'),
      auth: Buffer.alloc(16, 7).toString('base64url'),
    };
    const message = Buffer.from(JSON.stringify({ title: 'Export ready', link: '/p/prj_1/exports' }));
    const one = encryptPush(message, keys);
    const two = encryptPush(message, keys);
    expect(one.equals(two)).toBe(false);
    expect(decryptPush(one, device.getPrivateKey(), keys).equals(message)).toBe(true);
    expect(() => encryptPush(message, { ...keys, auth: 'AAAA' })).toThrow('auth');
    expect(() => encryptPush(Buffer.alloc(4000), keys)).toThrow('too large');
  });

  it('signs a VAPID token for the push service origin', () => {
    const vapid = { ...generateVapidKeys(), subject: 'mailto:ops@example.com' };
    expect(b(vapid.publicKey)).toHaveLength(65);
    expect(b(vapid.privateKey)).toHaveLength(32);
    const header = vapidAuthorization('https://push.example.net/send/abc', vapid, 1_790_000_000_000);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(m[4]).toBe(vapid.publicKey);
    expect(JSON.parse(b(m[1]!).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(b(m[2]!).toString())).toEqual({
      aud: 'https://push.example.net',
      exp: 1_790_000_000 + 12 * 3600,
      sub: 'mailto:ops@example.com',
    });
    const pub = b(vapid.publicKey);
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    const ok = verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, b(m[3]!));
    expect(ok).toBe(true);
  });
});
