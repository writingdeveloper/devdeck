/**
 * This machine's long-lived link identity: the TLS key pair and certificate whose fingerprint other
 * machines pin it by.
 *
 * Kept OUT of state.json deliberately. state.json is rewritten in full on every setting change and
 * mirrored to `state.json.bak` on every save, so a private key placed there would be copied around by
 * the corruption-recovery machinery and picked up by any sync tool watching that folder. The key
 * lives in its own file, encrypted with Electron's `safeStorage` (DPAPI on Windows, Keychain on
 * macOS, the desktop keyring on Linux) — measured available on Electron 43.
 *
 * Losing this file is recoverable but not free: the machine comes back with a NEW fingerprint, and
 * every device that paired with it will refuse to connect until it is paired again. That refusal is
 * the point — it is indistinguishable from an impostor, and treating it as routine would defeat
 * pinning entirely.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateMachineCertificate, fingerprintOfPem, type MachineCertificate } from './selfSignedCert';

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface LinkIdentity {
  certPem: string;
  keyPem: string;
  /** SHA-256 of the certificate — this machine's identity on the wire. */
  fingerprint: string;
}

interface IdentityFile {
  v: 1;
  /** base64 of the safeStorage ciphertext, or the plain JSON when encryption is unavailable. */
  encrypted: boolean;
  payload: string;
}

interface IdentityPayload {
  certPem: string;
  keyPem: string;
}

export const IDENTITY_FILENAME = 'link-identity.json';

export interface IdentityStoreOptions {
  /** Directory to keep the identity file in — `app.getPath('userData')` in the app. */
  userDataDir: string;
  safeStorage: SafeStorageLike;
  /** Injected for tests; the app passes nothing and gets a real certificate. */
  generate?: () => MachineCertificate;
  /** Reported when the identity could not be persisted, so it does not fail silently. */
  onWarn?: (message: string) => void;
}

/**
 * Load this machine's identity, generating and persisting one on first use.
 *
 * Never throws: a machine that cannot persist an identity should still be able to run (with an
 * in-memory one that changes on restart) rather than fail to start. The warning says which happened,
 * because "my other machine keeps asking me to re-pair" is otherwise unexplainable.
 */
export function loadOrCreateIdentity(options: IdentityStoreOptions): LinkIdentity {
  const file = join(options.userDataDir, IDENTITY_FILENAME);
  const warn = options.onWarn ?? (() => { /* best effort */ });

  const existing = readIdentity(file, options.safeStorage, warn);
  if (existing) return existing;

  const generated = (options.generate ?? (() => generateMachineCertificate()))();
  const identity: LinkIdentity = {
    certPem: generated.certPem,
    keyPem: generated.keyPem,
    fingerprint: generated.fingerprint,
  };
  writeIdentity(file, identity, options.safeStorage, warn);
  return identity;
}

function readIdentity(file: string, safeStorage: SafeStorageLike, warn: (m: string) => void): LinkIdentity | null {
  if (!existsSync(file)) return null;
  let stored: IdentityFile;
  try {
    stored = JSON.parse(readFileSync(file, 'utf8')) as IdentityFile;
  } catch {
    // Do NOT delete it. An unreadable identity file is more likely a half-written save or a locked
    // file than a corrupt one, and overwriting it would turn a transient problem into a permanent
    // re-pair of every device.
    warn('link: identity file is unreadable — using a temporary identity for this run');
    return null;
  }
  try {
    const json = stored.encrypted
      ? safeStorage.decryptString(Buffer.from(stored.payload, 'base64'))
      : stored.payload;
    const payload = JSON.parse(json) as IdentityPayload;
    if (typeof payload?.certPem !== 'string' || typeof payload?.keyPem !== 'string') throw new Error('shape');
    // Derive the fingerprint from the certificate rather than trusting a stored copy: a stored value
    // that drifted from the certificate would advertise a fingerprint peers can never match.
    return { certPem: payload.certPem, keyPem: payload.keyPem, fingerprint: fingerprintOfPem(payload.certPem) };
  } catch {
    // Decryption fails when the OS credential store cannot open it — a different user profile, a
    // restored machine, a Linux keyring that is locked. The key is unrecoverable; say so plainly.
    warn('link: this machine\'s stored identity could not be decrypted — paired devices will need to pair again');
    return null;
  }
}

function writeIdentity(file: string, identity: LinkIdentity, safeStorage: SafeStorageLike, warn: (m: string) => void): void {
  const payload = JSON.stringify({ certPem: identity.certPem, keyPem: identity.keyPem } satisfies IdentityPayload);
  let stored: IdentityFile;
  try {
    stored = safeStorage.isEncryptionAvailable()
      ? { v: 1, encrypted: true, payload: safeStorage.encryptString(payload).toString('base64') }
      : { v: 1, encrypted: false, payload };
  } catch {
    stored = { v: 1, encrypted: false, payload };
  }
  if (!stored.encrypted) {
    // Linux without a running keyring is the realistic case. Still better than not working, but the
    // person deserves to know their key is sitting on disk in the clear.
    warn('link: OS encryption is unavailable — this machine\'s link key is stored unencrypted');
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Write-then-rename: a crash mid-write must not leave a truncated identity that reads as corrupt
    // and forces every paired device to pair again.
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(stored), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    warn(`link: could not save this machine's identity (${err instanceof Error ? err.message : String(err)}) — it will change on restart`);
  }
}
