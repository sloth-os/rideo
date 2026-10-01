import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';

/**
 * A development C2PA signer (docs/design/provenance.md#signing-credentials): a P-256 CA and a leaf certificate
 * built with a minimal DER encoder on node:crypto, so no X.509 library is needed. C2PA validators accept the
 * chain (the leaf is CA-issued with digitalSignature and the emailProtection EKU) but report it as untrusted
 * unless the CA is added to their trust list.
 */

const tlv = (tag: number, body: Buffer): Buffer => {
  const len = body.length;
  let header: Buffer;
  if (len < 0x80) header = Buffer.from([tag, len]);
  else {
    const bytes: number[] = [];
    for (let n = len; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
    header = Buffer.from([tag, 0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([header, body]);
};
const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));
const integer = (value: Buffer): Buffer => {
  let b = value;
  while (b.length > 1 && b[0] === 0 && !(b[1]! & 0x80)) b = b.subarray(1);
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
};
const oid = (dotted: string): Buffer => {
  const arcs = dotted.split('.').map(Number);
  const out = [40 * arcs[0]! + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const chunk: number[] = [];
    let v = arc;
    do {
      chunk.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i]! |= 0x80;
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const boolean = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const octets = (b: Buffer) => tlv(0x04, b);
const bitString = (b: Buffer, unusedBits = 0) => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), b]));
const time = (d: Date): Buffer => {
  const z = (n: number) => String(n).padStart(2, '0');
  const rest = `${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`;
  const year = d.getUTCFullYear();
  // RFC 5280: UTCTime through 2049, GeneralizedTime from 2050
  return year < 2050
    ? tlv(0x17, Buffer.from(`${String(year).slice(2)}${rest}`))
    : tlv(0x18, Buffer.from(`${year}${rest}`));
};
const name = (commonName: string, organization: string) =>
  seq(set(seq(oid('2.5.4.10'), utf8(organization))), set(seq(oid('2.5.4.3'), utf8(commonName))));
const extension = (id: string, critical: boolean, value: Buffer) =>
  seq(oid(id), ...(critical ? [boolean(true)] : []), octets(value));
const ECDSA_WITH_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const keyId = (spki: Buffer) => createHash('sha1').update(spki).digest();
const pem = (der: Buffer, label: string) =>
  `-----BEGIN ${label}-----\n${der
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n')}\n-----END ${label}-----\n`;

interface CertSpec {
  subject: Buffer;
  issuer: Buffer;
  notBefore: Date;
  notAfter: Date;
  spki: Buffer;
  ca: boolean;
  issuerSpki?: Buffer;
  signingKey: KeyObject;
}

function certificate(spec: CertSpec): Buffer {
  const extensions = [
    extension('2.5.29.19', true, spec.ca ? seq(boolean(true)) : seq()), // basicConstraints
    // keyUsage: CA = keyCertSign|cRLSign, leaf = digitalSignature
    extension(
      '2.5.29.15',
      true,
      spec.ca ? bitString(Buffer.from([0x06]), 1) : bitString(Buffer.from([0x80]), 7),
    ),
    ...(spec.ca ? [] : [extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.4')))]), // EKU emailProtection
    extension('2.5.29.14', false, octets(keyId(spec.spki))), // subjectKeyIdentifier
    ...(spec.issuerSpki ? [extension('2.5.29.35', false, seq(tlv(0x80, keyId(spec.issuerSpki))))] : []),
  ];
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(randomBytes(16)),
    ECDSA_WITH_SHA256,
    spec.issuer,
    seq(time(spec.notBefore), time(spec.notAfter)),
    spec.subject,
    spec.spki,
    tlv(0xa3, seq(...extensions)),
  );
  return seq(tbs, ECDSA_WITH_SHA256, bitString(sign('sha256', tbs, spec.signingKey)));
}

export interface DevSigner {
  /** Leaf then CA, PEM. */
  chainPem: string;
  caPem: string;
  /** PKCS#8 PEM of the leaf key. */
  keyPem: string;
}

/** A fresh CA (10 years) and leaf (2 years) for `organization`. */
export function createDevSigner(organization: string, now = new Date()): DevSigner {
  const years = (n: number) => new Date(now.getTime() + n * 365 * 86_400_000);
  const ca = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const caSpki = ca.publicKey.export({ type: 'spki', format: 'der' });
  const caName = name(`${organization} Development CA`, organization);
  const caDer = certificate({
    subject: caName,
    issuer: caName,
    notBefore: now,
    notAfter: years(10),
    spki: caSpki,
    ca: true,
    signingKey: ca.privateKey,
  });
  const leaf = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const leafDer = certificate({
    subject: name(`${organization} Studio (development)`, organization),
    issuer: caName,
    notBefore: now,
    notAfter: years(2),
    spki: leaf.publicKey.export({ type: 'spki', format: 'der' }),
    ca: false,
    issuerSpki: caSpki,
    signingKey: ca.privateKey,
  });
  const caPem = pem(caDer, 'CERTIFICATE');
  return {
    chainPem: pem(leafDer, 'CERTIFICATE') + caPem,
    caPem,
    keyPem: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
