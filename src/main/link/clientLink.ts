/**
 * The viewer half of DevDeck Link: this machine, calling another machine's deck API.
 *
 * Two things matter here and everything else is plumbing.
 *
 * PINNING. The host's certificate fingerprint arrives inside the invite code, so it is known before
 * the first connection is ever made. There is no trust-on-first-use window: the fingerprint is
 * checked the instant the handshake completes and before a single byte of application data is read
 * or written. A mismatch is not retried — it means either a different machine or someone in the
 * middle, and quietly reconnecting until it "works" would defeat the whole design.
 *
 * DIALING. A host advertises several addresses (addressCandidates.ts) and they are tried in order,
 * last-known-good first. This is what makes a laptop that moved between networks reconnect without
 * anyone opening Settings: something in the list still answers, and the host then teaches the client
 * its refreshed address list.
 */
import * as tls from 'node:tls';
import { dialReasonFor, type DialAttempt } from '../../shared/link/dialReason';
import { attachConnection, type LinkConnection } from './connection';
import { fingerprintsMatch } from './selfSignedCert';
import { dialOrder, type KnownHost } from './devices';
import {
  LINK_PROTOCOL, protocolMatches,
  type LinkErrorCode, type LinkMessage, type ReadyMessage,
} from './protocol';
import type { LinkIdentity } from './identity';

/** Why a connection attempt ended, in the vocabulary the diagnostic UI speaks (plan section 4.1). */
export type DialFailure =
  /**
   * Nothing answered at any advertised address.
   *
   * `attempts` carries the reason PER address, because most of them are expected to fail from
   * wherever the caller is standing — a LAN address from another network, a hostname that resolves
   * nowhere, an overlay address without the overlay — and a flat list of six buries the one that
   * could have worked among five that never could.
   */
  | { kind: 'unreachable'; tried: string[]; attempts: DialAttempt[]; lastError: string }
  /** TCP connected but TLS did not complete — usually a version gap between the two installs. */
  | { kind: 'tls'; address: string; error: string }
  /** The machine that answered is NOT the one that was paired with. Never retried. */
  | { kind: 'fingerprint'; address: string; expected: string; seen: string }
  /** The host answered and refused us, with a reason. */
  | { kind: 'refused'; code: LinkErrorCode; message: string };

export interface ConnectedLink {
  host: KnownHost;
  /** The address that actually answered — feed it to `noteHostReached`. */
  address: string;
  ready: ReadyMessage;
  /** Call a remote `invoke` method. Rejects on refusal, timeout, or disconnection. */
  request(method: string, args: unknown[]): Promise<unknown>;
  /** Call a remote `send` method. No reply exists to wait for. */
  notify(method: string, args: unknown[]): void;
  attach(sessionId: string, cols: number, rows: number): void;
  detach(sessionId: string): void;
  close(reason?: string): void;
  readonly closed: boolean;
}

export interface DialOptions {
  identity: LinkIdentity;
  host: KnownHost;
  machineId: string;
  machineName: string;
  appVersion: string;
  /** Present only while redeeming an invite; omitted once the device is paired. */
  pairingToken?: string;
  /** Per-address connect timeout. Kept short: the point is to fall through to the next candidate. */
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  onEvent?: (channel: string, payload: unknown) => void;
  onPty?: (sessionId: string, bytes: Buffer) => void;
  onClose?: (reason: string | null) => void;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 4_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type DialResult =
  | { ok: true; link: ConnectedLink }
  | { ok: false; failure: DialFailure };

/**
 * Try each of the host's addresses in turn and return the first that completes a handshake.
 *
 * Sequential rather than parallel on purpose: a successful pairing has a side effect on the host
 * (it spends the invite), and racing several connections would spend it from one while the others
 * are still in flight.
 */
export async function dialHost(options: DialOptions): Promise<DialResult> {
  const addresses = dialOrder(options.host);
  if (addresses.length === 0) {
    return { ok: false, failure: { kind: 'unreachable', tried: [], attempts: [], lastError: 'no address' } };
  }
  let lastError = '';
  const attempts: DialAttempt[] = [];
  for (const address of addresses) {
    const attempt = await dialOne(address, options);
    if (attempt.ok) return attempt;
    // A wrong machine or an explicit refusal is an answer, not a miss — stop and report it rather
    // than working down the list and finally saying "unreachable", which would be false.
    if (attempt.failure.kind === 'fingerprint' || attempt.failure.kind === 'refused') return attempt;
    if (attempt.failure.kind === 'tls') {
      lastError = attempt.failure.error;
      attempts.push({ address, reason: 'tls' });
    } else {
      lastError = attempt.failure.lastError;
      attempts.push(attempt.failure.attempts[0] ?? { address, reason: 'other' });
    }
  }
  return { ok: false, failure: { kind: 'unreachable', tried: addresses, attempts, lastError } };
}

function dialOne(address: string, options: DialOptions): Promise<DialResult> {
  return new Promise<DialResult>((resolve) => {
    let settled = false;
    const done = (result: DialResult): void => { if (!settled) { settled = true; resolve(result); } };

    const socket = tls.connect({
      host: address,
      port: options.host.port,
      key: options.identity.keyPem,
      cert: options.identity.certPem,
      // Authentication is the fingerprint pin below, not a CA chain — these certificates are
      // self-signed by design. checkServerIdentity is disabled for the same reason: the certificate
      // names nothing meaningful, and the fingerprint is a far stronger statement than a hostname.
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
      minVersion: 'TLSv1.3',
    });

    const timer = setTimeout(() => {
      socket.destroy();
      done({ ok: false, failure: { kind: 'unreachable', tried: [address], attempts: [{ address, reason: 'timed-out' }], lastError: 'timed out' } });
    }, options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

    socket.once('error', (err: Error & { code?: string }) => {
      clearTimeout(timer);
      // ECONNREFUSED/EHOSTUNREACH/ENOTFOUND are "try the next address"; a TLS-layer failure is not,
      // because it means something IS there and the two ends could not agree.
      const transport = err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH'
        || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT' || err.code === 'ENETUNREACH'
        || err.code === 'EAI_AGAIN';
      done(transport
        ? { ok: false, failure: { kind: 'unreachable', tried: [address], attempts: [{ address, reason: dialReasonFor(err.code, err.message) }], lastError: err.message } }
        : { ok: false, failure: { kind: 'tls', address, error: err.message } });
    });

    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const seen = socket.getPeerX509Certificate()?.fingerprint256 ?? '';
      if (!fingerprintsMatch(options.host.fingerprint, seen)) {
        // Checked before a byte is exchanged. Not retried, not fallen through: a different machine
        // answering at this address is exactly what pinning exists to catch.
        socket.destroy();
        done({ ok: false, failure: { kind: 'fingerprint', address, expected: options.host.fingerprint, seen } });
        return;
      }
      handshake(socket, address, options, done);
    });
  });
}

function handshake(
  socket: tls.TLSSocket,
  address: string,
  options: DialOptions,
  done: (result: DialResult) => void,
): void {
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let nextId = 1;
  let established = false;

  const settleAllPending = (reason: string): void => {
    for (const [, entry] of pending) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
    pending.clear();
  };

  const connection: LinkConnection = attachConnection(socket, {
    onMessage: (message) => onMessage(message),
    onPty: (sessionId, bytes) => options.onPty?.(sessionId, bytes),
    onClose: (reason) => {
      settleAllPending(reason ?? 'disconnected');
      if (!established) done({ ok: false, failure: { kind: 'unreachable', tried: [address], attempts: [{ address, reason: 'other' }], lastError: reason ?? 'closed' } });
      else options.onClose?.(reason);
    },
  });

  function onMessage(message: LinkMessage): void {
    switch (message.t) {
      case 'hello': {
        if (!protocolMatches(message.protocol)) {
          // Settle BEFORE closing. close() runs onClose synchronously, and onClose reports an
          // unestablished link as 'unreachable' — which would overwrite the real reason with a
          // wrong one and send the person to check their network instead of their version.
          done({ ok: false, failure: { kind: 'refused', code: 'protocol-mismatch', message: `The other machine speaks ${String(message.protocol)}; this one speaks ${LINK_PROTOCOL}. Update both.` } });
          connection.close('protocol-mismatch');
          return;
        }
        connection.send({
          t: 'hello', protocol: LINK_PROTOCOL, appVersion: options.appVersion,
          machineId: options.machineId, machineName: options.machineName,
          wantsPairing: !!options.pairingToken,
        });
        // Redeeming an invite is a separate step so an already-paired device never sends a token it
        // does not have, and the host can tell the two cases apart.
        if (options.pairingToken) connection.send({ t: 'pair', token: options.pairingToken });
        return;
      }
      case 'ready': {
        established = true;
        done({ ok: true, link: makeLink(message) });
        return;
      }
      case 'error': {
        if (!established) {
          // Same ordering rule as above: the host's stated reason ('unpaired', 'token-expired',
          // 'permission-denied') is the whole point of it having answered at all, and closing first
          // would replace it with 'unreachable'.
          done({ ok: false, failure: { kind: 'refused', code: message.code, message: message.message } });
          connection.close(message.code);
          return;
        }
        // Established links surface mid-session refusals (e.g. an output backlog reset) as events.
        options.onEvent?.('link:error', message);
        return;
      }
      case 'res': {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.value);
        else entry.reject(new Error(message.error));
        return;
      }
      case 'evt': {
        options.onEvent?.(message.ch, message.payload);
        return;
      }
      default:
        return;
    }
  }

  function makeLink(ready: ReadyMessage): ConnectedLink {
    return {
      host: options.host,
      address,
      ready,
      request(method, args) {
        return new Promise<unknown>((resolve, reject) => {
          if (connection.closed) { reject(new Error('link is closed')); return; }
          const id = nextId++;
          // Without a timeout a request against a host that stopped answering (asleep, killed, network
          // black hole) would hang forever and take a deck refresh with it.
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`timed out: ${method}`));
          }, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
          pending.set(id, { resolve, reject, timer });
          connection.send({ t: 'req', id, method, args });
        });
      },
      notify(method, args) { connection.send({ t: 'notify', method, args }); },
      attach(sessionId, cols, rows) { connection.send({ t: 'attach', sessionId, cols, rows }); },
      detach(sessionId) { connection.send({ t: 'detach', sessionId }); },
      close(reason) { connection.close(reason); },
      get closed() { return connection.closed; },
    };
  }
}
