/**
 * This machine's TLS identity: an ECDSA P-256 key pair and a self-signed certificate whose SHA-256
 * fingerprint IS the machine's identity on the wire (the Syncthing model — no CA, no accounts).
 *
 * Why a hand-written DER encoder instead of a dependency:
 *
 *  - Node exposes `crypto.X509Certificate` for READING certificates only; there is no create API, so
 *    a certificate means either a package or these ~120 lines.
 *  - This is deliberately NOT security-critical code. Every cryptographic operation — key generation,
 *    the signature, the handshake — is done by node:crypto and TLS. What is written here is the
 *    container those live in, and a bug in it produces a certificate that fails to load, loudly, on
 *    the first connection. That is a completely different risk class from hand-rolling a handshake,
 *    which is why the handshake is not hand-rolled.
 *
 * Ed25519 is NOT used: Electron ships BoringSSL, which rejects Ed25519 certificates with
 * NO_COMMON_SIGNATURE_ALGORITHMS (measured on Electron 43). P-256 is accepted by both BoringSSL and
 * OpenSSL, so it is what both the app and the tests run on.
 */
import { createHash, generateKeyPairSync, sign, X509Certificate } from 'node:crypto';

// ---- minimal DER ----
function derLength(byteCount: number): Buffer {
  if (byteCount < 0x80) return Buffer.from([byteCount]);
  const parts: number[] = [];
  let remaining = byteCount;
  while (remaining > 0) { parts.unshift(remaining & 0xff); remaining >>>= 8; }
  return Buffer.from([0x80 | parts.length, ...parts]);
}

function tlv(tag: number, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const SEQUENCE = (...p: Buffer[]): Buffer => tlv(0x30, ...p);
const SET = (...p: Buffer[]): Buffer => tlv(0x31, ...p);
const INTEGER = (b: Buffer): Buffer => tlv(0x02, b);
const BIT_STRING = (b: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), b])); // 0 unused bits
const OCTET_STRING = (b: Buffer): Buffer => tlv(0x04, b);
const OID = (hex: string): Buffer => tlv(0x06, Buffer.from(hex, 'hex'));
const UTF8_STRING = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'));
const UTC_TIME = (s: string): Buffer => tlv(0x17, Buffer.from(s, 'ascii'));
const BOOLEAN = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const CONTEXT = (n: number, ...p: Buffer[]): Buffer => tlv(0xa0 | n, ...p);

const OID_COMMON_NAME = '550403';
const OID_BASIC_CONSTRAINTS = '551d13';
const OID_KEY_USAGE = '551d0f';
const OID_EXT_KEY_USAGE = '551d25';
const OID_SUBJECT_ALT_NAME = '551d11';
const OID_SERVER_AUTH = '2b06010505070301';
const OID_CLIENT_AUTH = '2b06010505070302';
const OID_ECDSA_WITH_SHA256 = '2a8648ce3d040302';

/** UTCTime is `YYMMDDHHMMSSZ`; valid through 2049, far past any certificate this app issues. */
function utcTime(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return [
    pad(date.getUTCFullYear() % 100), pad(date.getUTCMonth() + 1), pad(date.getUTCDate()),
    pad(date.getUTCHours()), pad(date.getUTCMinutes()), pad(date.getUTCSeconds()),
  ].join('') + 'Z';
}

function pem(label: string, der: Buffer): string {
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** Uppercase colon-separated SHA-256 — the exact shape `tls.TLSSocket#getPeerX509Certificate()` reports,
 *  so a pinned value can be compared to a live peer's without reformatting either side. */
export function certificateFingerprint(der: Buffer): string {
  const hex = createHash('sha256').update(der).digest('hex').toUpperCase();
  return (hex.match(/../g) ?? []).join(':');
}

/** Compare two fingerprints without caring about case or separators. Never use `===` on user-pasted text. */
export function fingerprintsMatch(a: unknown, b: unknown): boolean {
  const normalize = (v: unknown): string => (typeof v === 'string' ? v.replace(/[^0-9a-fA-F]/g, '').toUpperCase() : '');
  const left = normalize(a);
  // A hash is 64 hex characters; anything shorter must never compare equal (an empty peer value did).
  return left.length === 64 && left === normalize(b);
}

export interface MachineCertificate {
  /** PEM certificate, for `tls.createServer({ cert })` / `tls.connect({ cert })`. */
  certPem: string;
  /** PKCS#8 PEM private key. Never leaves this machine; store it encrypted (identity.ts). */
  keyPem: string;
  /** SHA-256 of the DER — the machine's identity, printed at pairing and pinned by the peer. */
  fingerprint: string;
  notAfter: Date;
}

export interface CertificateOptions {
  /** Goes in CN/SAN. Cosmetic: identity is the fingerprint, and hostname checking is disabled. */
  commonName?: string;
  now?: Date;
  validDays?: number;
}

/**
 * Ten years. These certificates are pinned by fingerprint, not trusted by expiry, and an expiry that
 * silently breaks every pairing while the user is away from that machine would be a worse failure
 * than a long-lived key that can be re-paired in ten seconds.
 */
const DEFAULT_VALID_DAYS = 3650;

export function generateMachineCertificate(options: CertificateOptions = {}): MachineCertificate {
  const commonName = (options.commonName ?? 'devdeck-link').replace(/[^\w.-]/g, '-').slice(0, 60) || 'devdeck-link';
  const now = options.now ?? new Date();
  const validDays = options.validDays ?? DEFAULT_VALID_DAYS;
  // Backdate a day so a peer whose clock is slightly behind does not see a not-yet-valid certificate.
  const notBefore = new Date(now.getTime() - 86_400_000);
  const notAfter = new Date(now.getTime() + validDays * 86_400_000);

  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const signatureAlgorithm = SEQUENCE(OID(OID_ECDSA_WITH_SHA256));

  // Positive serial: a leading high bit would make it a negative INTEGER, which some parsers reject.
  const serial = Buffer.from(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey
    .export({ type: 'spki', format: 'der' }).subarray(-16));
  serial[0] &= 0x7f;
  serial[0] ||= 0x01;

  const name = SEQUENCE(SET(SEQUENCE(OID(OID_COMMON_NAME), UTF8_STRING(commonName))));
  const tbsCertificate = SEQUENCE(
    CONTEXT(0, INTEGER(Buffer.from([2]))), // v3
    INTEGER(serial),
    signatureAlgorithm,
    name, // issuer === subject: self-signed
    SEQUENCE(UTC_TIME(utcTime(notBefore)), UTC_TIME(utcTime(notAfter))),
    name,
    spki,
    CONTEXT(3, SEQUENCE(
      SEQUENCE(OID(OID_BASIC_CONSTRAINTS), BOOLEAN(true), OCTET_STRING(SEQUENCE())), // CA:FALSE, critical
      SEQUENCE(OID(OID_KEY_USAGE), BOOLEAN(true), OCTET_STRING(tlv(0x03, Buffer.from([0x05, 0xa0])))),
      // Both ends present a certificate: the host is a TLS server, the client authenticates with one.
      SEQUENCE(OID(OID_EXT_KEY_USAGE), OCTET_STRING(SEQUENCE(OID(OID_SERVER_AUTH), OID(OID_CLIENT_AUTH)))),
      SEQUENCE(OID(OID_SUBJECT_ALT_NAME), OCTET_STRING(SEQUENCE(tlv(0x82, Buffer.from(commonName, 'ascii'))))),
    )),
  );

  const signature = sign('sha256', tbsCertificate, privateKey); // ECDSA signs to the DER SEQUENCE{r,s} X.509 wants
  const der = SEQUENCE(tbsCertificate, signatureAlgorithm, BIT_STRING(signature));

  return {
    certPem: pem('CERTIFICATE', der),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    fingerprint: certificateFingerprint(der),
    notAfter,
  };
}

/** Fingerprint of a stored PEM, so a loaded identity reports the same value it was paired under. */
export function fingerprintOfPem(certPem: string): string {
  return certificateFingerprint(new X509Certificate(certPem).raw);
}
