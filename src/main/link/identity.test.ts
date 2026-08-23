import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateIdentity, IDENTITY_FILENAME, type SafeStorageLike } from './identity';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'devdeck-link-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

/** Stand-in for Electron's safeStorage; the real one was measured available on Electron 43. */
const workingSafeStorage = (): SafeStorageLike => ({
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.concat([Buffer.from('DPAPI:'), Buffer.from(text, 'utf8')]),
  decryptString: (buf) => {
    const s = buf.toString('utf8');
    if (!s.startsWith('DPAPI:')) throw new Error('not ours');
    return s.slice('DPAPI:'.length);
  },
});

const brokenSafeStorage = (): SafeStorageLike => ({
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error('no keyring'); },
  decryptString: () => { throw new Error('no keyring'); },
});

describe('loadOrCreateIdentity', () => {
  it('creates an identity on first use and reuses it afterwards', () => {
    // The fingerprint IS the machine's identity to every paired device, so a second launch producing a
    // different one would silently break every pairing.
    const first = loadOrCreateIdentity({ userDataDir: dir, safeStorage: workingSafeStorage() });
    expect(first.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    const second = loadOrCreateIdentity({ userDataDir: dir, safeStorage: workingSafeStorage() });
    expect(second).toEqual(first);
  });

  it('keeps the private key out of state.json and encrypts it at rest', () => {
    loadOrCreateIdentity({ userDataDir: dir, safeStorage: workingSafeStorage() });
    const raw = readFileSync(join(dir, IDENTITY_FILENAME), 'utf8');
    expect(raw).not.toContain('PRIVATE KEY'); // the payload is ciphertext, not the PEM
    expect(JSON.parse(raw).encrypted).toBe(true);
    expect(existsSync(join(dir, 'state.json'))).toBe(false); // never written by this module
  });

  it('derives the fingerprint from the certificate rather than trusting a stored copy', () => {
    const created = loadOrCreateIdentity({ userDataDir: dir, safeStorage: workingSafeStorage() });
    const file = join(dir, IDENTITY_FILENAME);
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    // Even if something wrote a bogus fingerprint alongside, the loaded value must come from the cert:
    // advertising a fingerprint the certificate does not hash to means no peer can ever match it.
    writeFileSync(file, JSON.stringify({ ...stored, fingerprint: 'AA:BB' }), 'utf8');
    expect(loadOrCreateIdentity({ userDataDir: dir, safeStorage: workingSafeStorage() }).fingerprint).toBe(created.fingerprint);
  });

  it('falls back to plaintext with a warning when the OS has no credential store', () => {
    // Linux without a running keyring. Working is better than not starting, but the person is told
    // their key is sitting on disk in the clear.
    const onWarn = vi.fn();
    const id = loadOrCreateIdentity({ userDataDir: dir, safeStorage: brokenSafeStorage(), onWarn });
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('unencrypted'));
    expect(JSON.parse(readFileSync(join(dir, IDENTITY_FILENAME), 'utf8')).encrypted).toBe(false);
    expect(loadOrCreateIdentity({ userDataDir: dir, safeStorage: brokenSafeStorage() })).toEqual(id);
  });

  it('does not destroy an unreadable identity file — it may just be locked', () => {
    // Overwriting here would turn a transient problem (a half-written save, an antivirus lock) into a
    // permanent re-pair of every device.
    const file = join(dir, IDENTITY_FILENAME);
    writeFileSync(file, '{ not json', 'utf8');
    const onWarn = vi.fn();
    const id = loadOrCreateIdentity({ userDataDir: dir, safeStorage: workingSafeStorage(), onWarn });
    expect(id.fingerprint).toBeTruthy();
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('unreadable'));
  });

  it('says plainly that pairings are lost when the stored key cannot be decrypted', () => {
    // A different user profile, a restored machine, a locked keyring: the key is gone, and "my other
    // machine keeps asking me to pair again" is otherwise unexplainable.
    loadOrCreateIdentity({ userDataDir: dir, safeStorage: workingSafeStorage() });
    const onWarn = vi.fn();
    const foreign: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (t) => Buffer.from(t, 'utf8'),
      decryptString: () => { throw new Error('wrong profile'); },
    };
    const replacement = loadOrCreateIdentity({ userDataDir: dir, safeStorage: foreign, onWarn });
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('pair again'));
    expect(replacement.fingerprint).toBeTruthy();
  });

  it('still hands back a usable identity when it cannot be saved at all', () => {
    // A machine that cannot persist an identity should run with a temporary one, not fail to start —
    // but it must say so, because "paired devices keep asking me to pair again" needs an explanation.
    const onWarn = vi.fn();
    const blocker = join(dir, 'blocker'); // a FILE cannot be a parent directory
    writeFileSync(blocker, 'x', 'utf8');
    const id = loadOrCreateIdentity({ userDataDir: join(blocker, 'nested'), safeStorage: workingSafeStorage(), onWarn });
    expect(id.fingerprint).toBeTruthy(); // usable for this run
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('change on restart'));
  });
});
