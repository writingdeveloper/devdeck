import { describe, it, expect } from 'vitest';
import {
  INVITE_TTL_MS, createPairingToken, tokensMatch,
  encodeInviteCode, parseInviteCode, findInviteCodeInText, type Invite,
} from './inviteCode';

const NOW = 1_756_000_000_000;
const FINGERPRINT = 'C9E6E8C7216F09E8'.repeat(4); // 64 hex chars

const invite = (over: Partial<Invite> = {}): Invite => ({
  machineId: '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
  machineName: 'SIHYEONG-MAIN',
  addresses: ['SIHYEONG-MAIN.local', '100.96.248.54', '192.168.1.69'],
  port: 47820,
  fingerprint: FINGERPRINT,
  token: 'HqPQFbBSFbwptA0LRVCwLQ',
  expiresAtMs: NOW + INVITE_TTL_MS,
  ...over,
});

describe('createPairingToken', () => {
  it('mints 128 bits of unguessable token', () => {
    const a = createPairingToken();
    expect(a).not.toBe(createPairingToken());
    expect(Buffer.from(a, 'base64url')).toHaveLength(16);
  });
});

describe('tokensMatch', () => {
  it('accepts an identical token and rejects everything else', () => {
    const token = createPairingToken();
    expect(tokensMatch(token, token)).toBe(true);
    expect(tokensMatch(token, createPairingToken())).toBe(false);
    expect(tokensMatch(token, token + 'x')).toBe(false);
    expect(tokensMatch(token, token.slice(0, -1))).toBe(false);
  });

  it('never lets an empty value pass, whatever it is compared against', () => {
    // A missing token must fail closed: this is the one check standing between a stranger who can
    // reach the port and a paired device.
    expect(tokensMatch('', '')).toBe(false);
    expect(tokensMatch(undefined as unknown as string, '')).toBe(false);
  });
});

describe('invite code round trip', () => {
  it('carries address, port, fingerprint and token so nothing is typed by hand', () => {
    const parsed = parseInviteCode(encodeInviteCode(invite()), NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.invite).toEqual(invite());
  });

  it('survives the wrapping a paste through another app adds', () => {
    // Copying through chat/notes/terminals wraps long strings. Someone who pasted the right code must
    // never be told it is wrong.
    const code = encodeInviteCode(invite());
    const wrapped = code.slice(0, 30) + '\n' + code.slice(30, 60) + '\r\n  ' + code.slice(60);
    expect(parseInviteCode(wrapped, NOW).ok).toBe(true);
  });

  it('normalizes a fingerprint written with separators to the pinned form', () => {
    const colons = (FINGERPRINT.match(/../g) ?? []).join(':').toLowerCase();
    const parsed = parseInviteCode(encodeInviteCode(invite({ fingerprint: colons })), NOW);
    expect(parsed.ok && parsed.invite.fingerprint).toBe(FINGERPRINT);
  });
});

describe('invite code rejection', () => {
  it('tells a truncated code apart from a wrong one', () => {
    // "the code got cut off" and "that is not a code" send the person to different actions, so the
    // checksum exists to distinguish them rather than to secure anything.
    const code = encodeInviteCode(invite());
    expect(parseInviteCode(code.slice(0, code.length - 12), NOW)).toEqual({ ok: false, problem: 'truncated' });
    expect(parseInviteCode('hello world', NOW)).toEqual({ ok: false, problem: 'not-a-code' });
    expect(parseInviteCode('', NOW)).toEqual({ ok: false, problem: 'not-a-code' });
  });

  it('names a version mismatch so the message can say to update', () => {
    expect(parseInviteCode('DDLINK2.abc.12345678', NOW)).toEqual({ ok: false, problem: 'unsupported-version' });
  });

  it('reports expiry as expiry, not as a parse failure', () => {
    const code = encodeInviteCode(invite({ expiresAtMs: NOW - 1 }));
    expect(parseInviteCode(code, NOW)).toEqual({ ok: false, problem: 'expired' });
  });

  it('refuses a code whose fingerprint is not a full SHA-256', () => {
    // A short or padded fingerprint would weaken the pin the code exists to establish.
    for (const bad of ['', 'AB'.repeat(10), FINGERPRINT.slice(0, 62), FINGERPRINT + 'AB']) {
      const code = encodeInviteCode(invite({ fingerprint: bad }));
      expect(parseInviteCode(code, NOW), bad).toEqual({ ok: false, problem: 'malformed' });
    }
  });

  it('refuses a code with no address or an impossible port', () => {
    expect(parseInviteCode(encodeInviteCode(invite({ addresses: [] })), NOW)).toEqual({ ok: false, problem: 'malformed' });
    expect(parseInviteCode(encodeInviteCode(invite({ port: 0 })), NOW)).toEqual({ ok: false, problem: 'malformed' });
    expect(parseInviteCode(encodeInviteCode(invite({ port: 70000 })), NOW)).toEqual({ ok: false, problem: 'malformed' });
  });

  it('refuses a code with a valid checksum but a hostile body', () => {
    // The checksum only proves the string arrived intact — it proves nothing about who wrote it, so
    // every field is still validated.
    const payload = Buffer.from(JSON.stringify({ v: 1, m: '', n: '', a: [], p: 1, f: '', t: '', e: NOW + 1 }), 'utf8').toString('base64url');
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const code = `DDLINK1.${payload}.${createHash('sha256').update(payload).digest('hex').slice(0, 8)}`;
    expect(parseInviteCode(code, NOW)).toEqual({ ok: false, problem: 'malformed' });
  });
});

describe('findInviteCodeInText', () => {
  it('finds a code the clipboard already holds, surrounded by other text', () => {
    // The "add a machine" screen sniffs the clipboard so the usual case is one click, not a paste.
    const code = encodeInviteCode(invite());
    expect(findInviteCodeInText(`여기 코드: ${code} — 붙여넣어`)).toBe(code);
    expect(findInviteCodeInText(code)).toBe(code);
  });

  it('finds one that a paste broke across lines', () => {
    const code = encodeInviteCode(invite());
    expect(findInviteCodeInText(code.slice(0, 40) + '\n' + code.slice(40))).toBe(code);
  });

  it('answers null when the clipboard holds something else', () => {
    for (const text of ['', 'git status', 'https://example.com', null, 42]) {
      expect(findInviteCodeInText(text), String(text)).toBeNull();
    }
  });
});
