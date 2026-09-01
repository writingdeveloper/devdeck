/**
 * DevDeck Link wire protocol.
 *
 * Point-to-point between two copies of DevDeck over a mutually-authenticated TLS socket (see
 * identity.ts). No HTTP or WebSocket upgrade: there is no browser at either end, and every byte spent
 * on framing we do not need is a byte spent on a terminal stream that is latency-sensitive.
 *
 * Frame = [4-byte big-endian payload length][1-byte kind][payload].
 *
 * Terminal output gets its OWN binary kind rather than riding inside JSON. ANSI-dense text inflates
 * under JSON escaping and costs a parse on every chunk, and pty output is the one stream that arrives
 * continuously for as long as an agent is working.
 */
import type { LinkPermission } from '../../shared/link/permissions';

export const LINK_PROTOCOL = 'devdeck-link/1';

/**
 * Optional abilities, announced in `hello`/`ready` so a build can tell what the OTHER end will do.
 *
 * The protocol version is exact-match and has never been bumped; everything added since ships as a
 * message an older peer ignores (both ends drop unknown kinds). What an older peer will not do is
 * ANSWER — so a feature that expects a reply must be enforced only when the peer said it has it.
 */
export const LINK_FEATURES = ['ping'] as const;

/** Whether a `hello`/`ready` announced `feature`. A message without `features` is an older build. */
export function peerSupports(message: { features?: unknown }, feature: (typeof LINK_FEATURES)[number]): boolean {
  return Array.isArray(message.features) && message.features.includes(feature);
}

/** Default listening port. Configurable; nothing in the protocol depends on it. */
export const LINK_DEFAULT_PORT = 47820;

export const FRAME_HEADER_BYTES = 5;

export enum FrameKind {
  /** UTF-8 JSON `LinkMessage`. */
  Json = 1,
  /** `[2-byte BE session-id length][session id UTF-8][raw terminal bytes]`. */
  Pty = 2,
}

/**
 * Hard ceiling on one frame. A desynchronized or hostile peer must not be able to make us allocate an
 * arbitrary buffer by claiming a huge length — the socket is dropped instead. Well above any real
 * frame: the largest by far is an attach's scrollback replay (~512KB).
 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export type LinkErrorCode =
  /** The two ends do not speak the same protocol version. */
  | 'protocol-mismatch'
  /** This device is not paired with the host (or was un-paired since it last connected). */
  | 'unpaired'
  /** Pairing was attempted with a token the host does not recognize. */
  | 'bad-token'
  /** The pairing token existed but has expired or was already used. */
  | 'token-expired'
  /** Paired, but lacking the permission this method requires. */
  | 'permission-denied'
  /** The method does not exist, or exists but may never be called remotely. */
  | 'method-not-available'
  /** Too many requests, or too many pairing attempts. */
  | 'rate-limited'
  /** The host is refusing new connections (host mode turned off mid-session). */
  | 'host-unavailable';

export interface HelloMessage {
  t: 'hello';
  protocol: string;
  appVersion: string;
  machineId: string;
  machineName: string;
  /**
   * "I am about to redeem a connection code."
   *
   * Stated up front so the host can answer an unknown device correctly on the FIRST message instead
   * of inferring intent from whether a `pair` frame shows up in time. Without it, a device pasting an
   * expired code gets told it is "not paired" — sending the person to check their firewall when the
   * real answer is that their code aged out five minutes ago.
   */
  wantsPairing?: boolean;
  /** See `LINK_FEATURES`. Absent from a build that predates the field. */
  features?: string[];
}

/** Sent by a client that has a one-time invite token and wants to become paired. */
export interface PairMessage {
  t: 'pair';
  token: string;
}

/** The host accepted the connection. `addresses` refreshes the client's candidate list (see §4.1). */
export interface ReadyMessage {
  t: 'ready';
  machineId: string;
  machineName: string;
  appVersion: string;
  permissions: LinkPermission[];
  addresses: string[];
  port: number;
  features?: string[];
}

export interface ErrorMessage {
  t: 'error';
  code: LinkErrorCode;
  /** Human-readable, for the diagnostic surface — never the only signal; `code` drives behavior. */
  message: string;
}

export interface RequestMessage { t: 'req'; id: number; method: string; args: unknown[] }
export type ResponseMessage =
  | { t: 'res'; id: number; ok: true; value: unknown }
  | { t: 'res'; id: number; ok: false; code: LinkErrorCode; error: string };
/** Fire-and-forget: a `send`-channel method, which has no reply. */
export interface NotifyMessage { t: 'notify'; method: string; args: unknown[] }
/** A push from the host: one of the API's event-hub channels. */
export interface EventMessage { t: 'evt'; ch: string; payload: unknown }
/** Attach/detach a terminal session's byte stream. Only attached sessions stream to this client. */
/**
 * Liveness. A socket that lost its peer without a FIN — the peer slept, a NAT forgot the flow, the
 * Wi-Fi changed — reads as perfectly connected forever; nothing ever arrives and nothing ever errors.
 * Either end pings after a silence and hangs up after a longer one. Answered by the connection layer
 * itself, so a ping is never mistaken for the peer USING this machine.
 */
export interface PingMessage { t: 'ping'; at: number }
export interface PongMessage { t: 'pong'; at: number }
export interface AttachMessage { t: 'attach'; sessionId: string; cols: number; rows: number }
export interface DetachMessage { t: 'detach'; sessionId: string }

export type LinkMessage =
  | HelloMessage | PairMessage | ReadyMessage | ErrorMessage
  | RequestMessage | ResponseMessage | NotifyMessage | EventMessage
  | AttachMessage | DetachMessage | PingMessage | PongMessage;

export function encodeJsonFrame(message: LinkMessage): Buffer {
  return frame(FrameKind.Json, Buffer.from(JSON.stringify(message), 'utf8'));
}

export function encodePtyFrame(sessionId: string, chunk: string | Buffer): Buffer {
  const id = Buffer.from(sessionId, 'utf8');
  if (id.length > 0xffff) throw new Error('link: session id too long to frame');
  const head = Buffer.allocUnsafe(2);
  head.writeUInt16BE(id.length, 0);
  const body = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
  return frame(FrameKind.Pty, Buffer.concat([head, id, body]));
}

export function decodePtyPayload(payload: Buffer): { sessionId: string; bytes: Buffer } | null {
  if (payload.length < 2) return null;
  const idLength = payload.readUInt16BE(0);
  if (payload.length < 2 + idLength) return null;
  return {
    sessionId: payload.toString('utf8', 2, 2 + idLength),
    bytes: payload.subarray(2 + idLength),
  };
}

function frame(kind: FrameKind, payload: Buffer): Buffer {
  if (payload.length + 1 > MAX_FRAME_BYTES) throw new Error('link: frame exceeds the size ceiling');
  const out = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.length);
  out.writeUInt32BE(payload.length + 1, 0); // length covers the kind byte
  out.writeUInt8(kind, 4);
  payload.copy(out, FRAME_HEADER_BYTES);
  return out;
}

export interface DecodedFrame {
  kind: FrameKind;
  payload: Buffer;
}

export interface FrameDecoder {
  /**
   * Feed one socket chunk; returns whatever complete frames it completed.
   * @throws when the peer declares an impossible frame — the caller must drop the connection, since
   *         after a bad length there is no way to find the next frame boundary.
   */
  push(chunk: Buffer): DecodedFrame[];
  /** Bytes held back waiting for the rest of a frame — a stall diagnostic, not a protocol feature. */
  readonly pending: number;
}

/**
 * TCP gives a byte stream, not messages: a frame arrives split across chunks, several frames arrive in
 * one chunk, and a header itself can straddle the boundary. That is where framing bugs live, so this
 * is a plain buffer-and-slice loop with no fast paths.
 */
export function makeFrameDecoder(): FrameDecoder {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      // Copy the incoming chunk rather than adopting it: the socket's buffer is reused, and holding a
      // reference to it across ticks is how a decoder starts reading bytes from a later read.
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      const frames: DecodedFrame[] = [];
      for (;;) {
        if (buffer.length < FRAME_HEADER_BYTES) break;
        const declared = buffer.readUInt32BE(0);
        // A zero-length frame carries not even a kind byte; a huge one is a peer we cannot follow.
        if (declared < 1 || declared > MAX_FRAME_BYTES) {
          throw new Error(`link: refusing a frame of ${declared} bytes`);
        }
        const total = 4 + declared;
        if (buffer.length < total) break;
        const kind = buffer.readUInt8(4);
        if (kind !== FrameKind.Json && kind !== FrameKind.Pty) {
          throw new Error(`link: unknown frame kind ${kind}`);
        }
        // Copy rather than subarray: the slice would pin the whole concatenated buffer alive, which for
        // a long-lived terminal stream means holding every chunk it was ever glued to.
        frames.push({ kind, payload: Buffer.from(buffer.subarray(FRAME_HEADER_BYTES, total)) });
        buffer = Buffer.from(buffer.subarray(total));
      }
      return frames;
    },
    get pending() { return buffer.length; },
  };
}

/**
 * Parse a JSON frame's payload into a message.
 *
 * Returns null for anything malformed rather than throwing: the payload is attacker-controlled text,
 * and a parse failure is a normal thing to answer with an error frame, not to crash on.
 */
export function parseLinkMessage(payload: Buffer): LinkMessage | null {
  let parsed: unknown;
  try { parsed = JSON.parse(payload.toString('utf8')); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const message = parsed as { t?: unknown };
  return typeof message.t === 'string' ? (parsed as LinkMessage) : null;
}

/** Both ends must speak the same version; there is no negotiation to fall back to. */
export function protocolMatches(theirs: unknown): boolean {
  return theirs === LINK_PROTOCOL;
}
