/**
 * The invite code — one string that carries everything needed to reach and trust a host.
 *
 * The whole point is that nobody types an address, a port, or a fingerprint. The host presses "copy",
 * the person pastes it on the other machine, and that is the entire pairing flow. Every field a manual
 * form would have asked for travels inside the code instead, which is also what makes the *security*
 * work: the host's certificate fingerprint is in there, so the client pins the host from its very
 * first connection and there is no leap-of-faith window for a man in the middle to occupy.
 *
 * The one-time token is therefore an authorization proof, not key material: it is only ever sent
 * inside an already-encrypted, already-host-authenticated channel.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX = 'DDLINK1';
const SEPARATOR = '.';

/** Five minutes: long enough to walk to the other machine, short enough that a stale copy is useless. */
export const INVITE_TTL_MS = 5 * 60_000;

/** 128 bits. Nobody transcribes this by hand, so there is no reason for it to be short. */
export function createPairingToken(): string {
  return randomBytes(16).toString('base64url');
}

/** Constant-time compare — a token check that leaks timing is a token check that can be walked. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface Invite {
  machineId: string;
  machineName: string;
  /** Ordered candidates; the client tries them in this order (see addressCandidates.ts). */
  addresses: string[];
  port: number;
  /** Host certificate SHA-256, hex without separators inside the code; compared case-insensitively. */
  fingerprint: string;
  token: string;
  expiresAtMs: number;
}

/** Wire shape, kept terse because this string is pasted by a human. */
interface InviteWire {
  v: 1; m: string; n: string; a: string[]; p: number; f: string; t: string; e: number;
}

export function encodeInviteCode(invite: Invite): string {
  const wire: InviteWire = {
    v: 1,
    m: invite.machineId,
    n: invite.machineName,
    a: invite.addresses,
    p: invite.port,
    f: invite.fingerprint.replace(/[^0-9a-fA-F]/g, '').toUpperCase(),
    t: invite.token,
    e: Math.round(invite.expiresAtMs),
  };
  const payload = Buffer.from(JSON.stringify(wire), 'utf8').toString('base64url');
  return [PREFIX, payload, checksum(payload)].join(SEPARATOR);
}

function checksum(payload: string): string {
  // Not a security control — it exists so a code that lost characters in transit says so, instead of
  // failing later as "cannot connect" and sending the person to look at their firewall.
  return createHash('sha256').update(payload).digest('hex').slice(0, 8);
}

export type InviteProblem =
  | 'not-a-code'
  | 'unsupported-version'
  | 'truncated'
  | 'malformed'
  | 'expired';

export type InviteParse =
  | { ok: true; invite: Invite }
  | { ok: false; problem: InviteProblem };

/**
 * Parse a pasted code.
 *
 * All whitespace is stripped first: pasting through chat apps, terminals and note editors wraps long
 * strings, and a person who pasted the right code should never be told it is wrong.
 */
export function parseInviteCode(text: unknown, nowMs: number = Date.now()): InviteParse {
  const raw = typeof text === 'string' ? text.replace(/\s+/g, '') : '';
  if (!raw) return { ok: false, problem: 'not-a-code' };

  const parts = raw.split(SEPARATOR);
  if (parts[0] !== PREFIX) {
    // Distinguish "a DevDeck code of another version" from "not a code at all", so the message can
    // say to update rather than to check what was copied.
    return { ok: false, problem: /^DDLINK\d+\./.test(raw) ? 'unsupported-version' : 'not-a-code' };
  }
  if (parts.length !== 3 || !parts[1] || !parts[2]) return { ok: false, problem: 'truncated' };
  if (checksum(parts[1]) !== parts[2].toLowerCase()) return { ok: false, problem: 'truncated' };

  let wire: InviteWire;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return { ok: false, problem: 'malformed' };
    wire = parsed as InviteWire;
  } catch {
    return { ok: false, problem: 'malformed' };
  }
  if (wire.v !== 1) return { ok: false, problem: 'unsupported-version' };

  const addresses = Array.isArray(wire.a)
    ? wire.a.filter((a): a is string => typeof a === 'string' && !!a.trim()).map((a) => a.trim()).slice(0, 8)
    : [];
  const fingerprint = typeof wire.f === 'string' ? wire.f.replace(/[^0-9a-fA-F]/g, '').toUpperCase() : '';
  const port = Number(wire.p);
  if (
    typeof wire.m !== 'string' || !wire.m
    || typeof wire.t !== 'string' || !wire.t
    || fingerprint.length !== 64                  // a SHA-256, not a truncated or padded stand-in
    || !Number.isInteger(port) || port < 1 || port > 65535
    || addresses.length === 0
    || !Number.isFinite(wire.e)
  ) {
    return { ok: false, problem: 'malformed' };
  }
  // Expiry is checked AFTER the structure so an old code reports "expired" — an actionable message —
  // rather than a generic parse failure.
  if (wire.e <= nowMs) return { ok: false, problem: 'expired' };

  return {
    ok: true,
    invite: {
      machineId: wire.m,
      machineName: typeof wire.n === 'string' ? wire.n : '',
      addresses,
      port,
      fingerprint,
      token: wire.t,
      expiresAtMs: wire.e,
    },
  };
}

/**
 * Pull a code out of arbitrary text, for the clipboard sniff on the "add a machine" screen: if the
 * code is already in the clipboard, the screen should offer to use it instead of presenting an empty
 * field. Tolerates surrounding chatter ("here you go: DDLINK1...."), and any wrapping the paste added.
 */
export function findInviteCodeInText(text: unknown): string | null {
  if (typeof text !== 'string' || !text) return null;
  // Whitespace is stripped before matching so a code broken across lines is still found; the trailing
  // checksum is fixed-length, which is what keeps a following word from being swallowed.
  const match = text.replace(/\s+/g, '').match(/DDLINK1\.[A-Za-z0-9_-]+\.[0-9a-fA-F]{8}/);
  return match ? match[0] : null;
}
