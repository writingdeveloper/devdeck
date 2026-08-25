/**
 * The host half of DevDeck Link: this machine, serving its own deck API to paired machines.
 *
 * Security shape, in the order it is enforced:
 *
 *  1. TLS 1.3 with this machine's certificate, `requestCert: true`. A peer that presents no
 *     certificate has no identity and is dropped.
 *  2. The peer's certificate fingerprint is looked up in the paired-device ledger before any
 *     application data is read. An unknown device may say exactly two things — `hello` and `pair` —
 *     and is disconnected on anything else, on a bad or expired code, or on saying nothing at all
 *     within a short grace period. Nothing else in the API is reachable until it is paired.
 *  3. Every call is re-checked against the calling device's permissions and against the method's own
 *     remote policy (`mayCallRemotely`). A method marked `blocked` or `local` is unreachable no
 *     matter what a device holds.
 *  4. Paths are re-validated by the handlers themselves against THIS machine's folder allowlist. The
 *     caller's opinion about what is allowed never enters into it.
 *
 * Output is not broadcast. A connection receives a session's terminal bytes only while it is attached
 * to that session — otherwise every viewer would pay for every session's output, and a machine's
 * activity would leak to a device that never asked to watch it.
 */
import * as tls from 'node:tls';
import type { DeckApiBundle } from '../api/deckApi';
import { mayCallRemotely } from '../api/methods';
import { attachConnection, type LinkConnection } from './connection';
import { fingerprintsMatch } from './selfSignedCert';
import { findPairedDevice, upsertPairedDevice, type PairedDevice } from './devices';
import { tokensMatch } from './inviteCode';
import { LINK_PROTOCOL, protocolMatches, type LinkErrorCode, type LinkMessage } from './protocol';
import { sanitizeMachineName } from '../../shared/link/machine';
import { sanitizePermissions, type LinkPermission } from '../../shared/link/permissions';
import type { LinkIdentity } from './identity';

/** An invite the person generated on this machine and has not spent yet. */
export interface ActiveInvite {
  token: string;
  expiresAtMs: number;
  /** What the device gets when it redeems this invite — shown on screen before the code is copied. */
  permissions: LinkPermission[];
}

export interface HostLogEntry {
  at: number;
  kind: 'connected' | 'disconnected' | 'paired' | 'rejected' | 'denied';
  machineName: string;
  fingerprint: string;
  detail: string;
}

export interface HostServerOptions {
  identity: LinkIdentity;
  port: number;
  /** Defaults to every interface. A tunnel-only setup can bind 127.0.0.1 instead. */
  bindHost?: string;
  api: DeckApiBundle;
  machineId: string;
  machineName: () => string;
  appVersion: string;
  /** Read fresh on every connection so un-pairing takes effect immediately, not on restart. */
  pairedDevices: () => PairedDevice[];
  savePairedDevices: (devices: PairedDevice[]) => void;
  /** The unspent invite, or null. Read per attempt so an expired one cannot be cached into validity. */
  activeInvite: () => ActiveInvite | null;
  /** Called once an invite has been redeemed; the token is single-use. */
  consumeInvite: () => void;
  /** This machine's currently reachable addresses, re-enumerated per connection. */
  addresses: () => string[];
  now: () => number;
  log: (entry: HostLogEntry) => void;
  onConnectionsChanged?: (connections: HostConnectionInfo[]) => void;
  /** Called for every request a paired device makes — this machine is in use, even with no terminal
   *  attached and nobody at the keyboard. See handleMessage. */
  onActivity?: () => void;
}

export interface HostConnectionInfo {
  machineId: string;
  machineName: string;
  fingerprint: string;
  permissions: LinkPermission[];
  connectedAtMs: number;
  attachedSessions: string[];
}

export interface HostServer {
  readonly port: number;
  readonly connections: HostConnectionInfo[];
  /** Drop one device's connections (the kill switch in Settings). */
  disconnect(fingerprint: string): void;
  close(): Promise<void>;
}

/**
 * Failed pairing attempts tolerated per connection before it is dropped. The token is 128 bits, so
 * this is not what makes guessing infeasible — it is what stops one socket from being used as a
 * grinder and filling the audit log.
 */
const MAX_PAIR_ATTEMPTS = 3;

/**
 * Per-connection send buffer ceiling. Terminal bytes cannot be silently dropped without corrupting
 * the peer's screen, so a viewer that has stopped reading is disconnected instead — it can re-attach
 * and repaint from the host's scrollback rather than resume mid-stream on a corrupted screen.
 */
const MAX_BACKLOG_BYTES = 4 * 1024 * 1024;

/**
 * How long an unidentified connection may stay open. Anyone who can reach the port can open one, so
 * without this they accumulate. Generous enough to cover a slow link's hello round trip.
 */
const UNAUTHENTICATED_GRACE_MS = 10_000;

interface Session {
  connection: LinkConnection;
  unauthenticatedTimer?: NodeJS.Timeout;
  device: PairedDevice | null;
  attached: Set<string>;
  connectedAtMs: number;
  pairAttempts: number;
  helloSeen: boolean;
}

export function startHostServer(options: HostServerOptions): Promise<HostServer> {
  const sessions = new Set<Session>();

  const info = (): HostConnectionInfo[] => [...sessions]
    .filter((s): s is Session & { device: PairedDevice } => s.device !== null)
    .map((s) => ({
      machineId: s.device.machineId,
      machineName: s.device.machineName,
      fingerprint: s.device.fingerprint,
      permissions: s.device.permissions,
      connectedAtMs: s.connectedAtMs,
      attachedSessions: [...s.attached],
    }));

  const announce = (): void => options.onConnectionsChanged?.(info());

  const fail = (session: Session, code: LinkErrorCode, message: string): void => {
    session.connection.send({ t: 'error', code, message });
    session.connection.close(code);
  };

  const server = tls.createServer({
    key: options.identity.keyPem,
    cert: options.identity.certPem,
    // Both flags are load-bearing. requestCert makes the peer present an identity at all;
    // rejectUnauthorized:false is NOT a relaxation — these are self-signed certificates with no CA to
    // chain to, so authentication is done below by comparing the fingerprint to the paired ledger.
    requestCert: true,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3',
  });

  server.on('secureConnection', (socket) => {
    const fingerprint = socket.getPeerX509Certificate()?.fingerprint256 ?? '';
    const known = findPairedDevice(options.pairedDevices(), fingerprint);

    // No certificate at all: nothing to identify, nothing to pair. Refuse before reading a byte.
    if (!fingerprint) {
      options.log({ at: options.now(), kind: 'rejected', machineName: '', fingerprint: '', detail: 'no client certificate' });
      socket.destroy();
      return;
    }

    const session: Session = {
      connection: undefined as unknown as LinkConnection,
      device: known,
      attached: new Set(),
      connectedAtMs: options.now(),
      pairAttempts: 0,
      helloSeen: false,
    };

    session.connection = attachConnection(socket, {
      onMessage: (message) => handleMessage(session, message, fingerprint),
      onPty: () => {
        // Terminal bytes only ever flow host -> viewer. Input arrives as a `cockpit:input` notify so
        // it passes the same permission gate as every other call.
        fail(session, 'method-not-available', 'terminal frames are not accepted from a client');
      },
      onClose: () => {
        if (session.unauthenticatedTimer) clearTimeout(session.unauthenticatedTimer);
        sessions.delete(session);
        options.log({
          at: options.now(), kind: 'disconnected',
          machineName: session.device?.machineName ?? '', fingerprint, detail: '',
        });
        announce();
      },
    });

    sessions.add(session);
    // An unknown device that connects and then says nothing must not sit here holding a socket. This
    // is the only thing keeping unauthenticated connections bounded, since anyone who can reach the
    // port can open one.
    if (!known) {
      const deadline = setTimeout(() => {
        if (!session.device) fail(session, 'unpaired', 'This machine is not paired.');
      }, UNAUTHENTICATED_GRACE_MS);
      deadline.unref?.();
      session.unauthenticatedTimer = deadline;
    }
    session.connection.send({
      t: 'hello',
      protocol: LINK_PROTOCOL,
      appVersion: options.appVersion,
      machineId: options.machineId,
      machineName: options.machineName(),
    });
  });

  function handleMessage(session: Session, message: LinkMessage, fingerprint: string): void {
    // Anything a PAIRED device asks of this machine is this machine being used, and the idle watcher
    // has no other way to know it. It counts local input devices; a person driving this deck from the
    // next room touches none of them. Only attached terminals used to register — so someone reading
    // this machine's projects, git state or usage for half an hour was, to the watcher, an idle
    // machine, and it would run `shutdown /s` out from under them. Recorded here rather than in each
    // case so a new message type cannot quietly opt out of it.
    if (session.device) options.onActivity?.();
    switch (message.t) {
      case 'hello': {
        if (!protocolMatches(message.protocol)) {
          fail(session, 'protocol-mismatch', `This machine speaks ${LINK_PROTOCOL}; the other speaks ${String(message.protocol)}. Update both.`);
          return;
        }
        session.helloSeen = true;
        if (session.device) { sendReady(session, fingerprint); return; }
        // Unknown device. It has just told us whether it is about to redeem a code, so the refusal can
        // be the RIGHT one on the first message: a device with no code is simply not paired, while one
        // holding a code deserves to hear whether that code was wrong, expired, or already spent —
        // which only the pair handler can say. Guessing this from arrival timing instead is how an
        // expired code ends up reported as "not paired" and sends someone to check their firewall.
        if (message.wantsPairing !== true) {
          fail(session, 'unpaired', 'This machine is not paired. Generate a connection code on the host.');
          options.log({ at: options.now(), kind: 'rejected', machineName: '', fingerprint, detail: 'unpaired device' });
        }
        return;
      }
      case 'pair': {
        if (!session.helloSeen) { fail(session, 'protocol-mismatch', 'pair before hello'); return; }
        pair(session, message.token, fingerprint);
        return;
      }
      case 'req': {
        const method = options.api.methods[message.method];
        if (!authorized(session, message.method)) {
          session.connection.send({
            t: 'res', id: message.id, ok: false,
            code: method ? 'permission-denied' : 'method-not-available',
            error: method ? `not permitted: ${message.method}` : `no such method: ${message.method}`,
          });
          denied(session, fingerprint, message.method);
          return;
        }
        void Promise.resolve()
          .then(() => method.handler(...(Array.isArray(message.args) ? message.args : [])))
          .then(
            (value) => session.connection.send({ t: 'res', id: message.id, ok: true, value: value ?? null }),
            (err: unknown) => session.connection.send({
              t: 'res', id: message.id, ok: false, code: 'method-not-available',
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        return;
      }
      case 'notify': {
        if (!authorized(session, message.method)) { denied(session, fingerprint, message.method); return; }
        try {
          options.api.methods[message.method].handler(...(Array.isArray(message.args) ? message.args : []));
        } catch { /* a fire-and-forget call has nowhere to report to; the global trap logs it */ }
        return;
      }
      case 'attach': {
        // Watching a session's output is reading it, and resizing it is driving it — so attach needs
        // both, and asks through the same methods a local viewer would.
        if (!authorized(session, 'cockpit:resize')) { denied(session, fingerprint, 'attach'); return; }
        session.attached.add(String(message.sessionId));
        announce();
        return;
      }
      case 'detach': {
        session.attached.delete(String(message.sessionId));
        announce();
        return;
      }
      default:
        return; // responses/events/errors are the client's direction; ignore rather than disconnect
    }
  }

  function authorized(session: Session, methodName: string): boolean {
    if (!session.device) return false;
    return mayCallRemotely(options.api.methods[methodName], session.device.permissions);
  }

  function denied(session: Session, fingerprint: string, methodName: string): void {
    options.log({
      at: options.now(), kind: 'denied',
      machineName: session.device?.machineName ?? '', fingerprint, detail: methodName,
    });
  }

  function pair(session: Session, token: unknown, fingerprint: string): void {
    const invite = options.activeInvite();
    const now = options.now();
    if (!invite || invite.expiresAtMs <= now) {
      fail(session, 'token-expired', 'That connection code has expired. Generate a new one on the host.');
      options.log({ at: now, kind: 'rejected', machineName: '', fingerprint, detail: 'expired invite' });
      return;
    }
    if (typeof token !== 'string' || !tokensMatch(invite.token, token)) {
      session.pairAttempts += 1;
      options.log({ at: now, kind: 'rejected', machineName: '', fingerprint, detail: 'bad token' });
      if (session.pairAttempts >= MAX_PAIR_ATTEMPTS) {
        fail(session, 'rate-limited', 'Too many attempts.');
        return;
      }
      session.connection.send({ t: 'error', code: 'bad-token', message: 'That connection code was not recognized.' });
      return;
    }

    const device: PairedDevice = {
      machineId: session.device?.machineId ?? fingerprint.slice(0, 8),
      machineName: session.device?.machineName ?? '',
      fingerprint,
      permissions: sanitizePermissions(invite.permissions),
      pairedAtMs: now,
      lastSeenMs: now,
    };
    session.device = device;
    options.savePairedDevices(upsertPairedDevice(options.pairedDevices(), device));
    // Single use. A code that stays valid after it worked is a code that is still valid when it is
    // pasted into the wrong window later.
    options.consumeInvite();
    options.log({ at: now, kind: 'paired', machineName: device.machineName, fingerprint, detail: device.permissions.join(',') });
    sendReady(session, fingerprint);
  }

  function sendReady(session: Session, fingerprint: string): void {
    const device = session.device;
    if (!device) return;
    if (session.unauthenticatedTimer) { clearTimeout(session.unauthenticatedTimer); session.unauthenticatedTimer = undefined; }
    session.connection.send({
      t: 'ready',
      machineId: options.machineId,
      machineName: options.machineName(),
      appVersion: options.appVersion,
      permissions: device.permissions,
      // Re-enumerated per connection: this is how a machine that moved teaches its client the new
      // address using the one that still worked.
      addresses: options.addresses(),
      port: options.port,
    });
    options.log({ at: options.now(), kind: 'connected', machineName: device.machineName, fingerprint, detail: '' });
    announce();
  }

  /**
   * Fan the API's pushes out. Terminal output goes only to connections attached to that session, as a
   * binary frame; everything else goes to any connection allowed to observe.
   */
  const unsubscribe = options.api.events.subscribe((channel, payload) => {
    if (sessions.size === 0) return;
    const sessionId = channel === 'cockpit:data' || channel === 'cockpit:exit' || channel === 'cockpit:resized'
      ? String((payload as { id?: unknown })?.id ?? '')
      : null;
    for (const session of sessions) {
      if (!session.device || session.connection.closed) continue;
      if (sessionId !== null) {
        if (!session.attached.has(sessionId)) continue;
        if (channel === 'cockpit:data') {
          if (session.connection.backlog > MAX_BACKLOG_BYTES) {
            // Dropping bytes would corrupt the peer's screen silently; disconnecting lets it
            // re-attach and repaint. Loud beats subtly wrong.
            session.connection.send({ t: 'error', code: 'rate-limited', message: 'output backlog exceeded — reattach to resync' });
            session.connection.close('backlog');
            continue;
          }
          session.connection.sendPty(sessionId, String((payload as { chunk?: unknown }).chunk ?? ''));
          continue;
        }
      } else if (!session.device.permissions.includes('observe')) {
        continue;
      }
      session.connection.send({ t: 'evt', ch: channel, payload });
    }
  });

  return new Promise<HostServer>((resolve, reject) => {
    const onListenError = (err: Error): void => { server.off('error', onListenError); unsubscribe(); reject(err); };
    server.once('error', onListenError);
    server.listen(options.port, options.bindHost ?? '0.0.0.0', () => {
      server.off('error', onListenError);
      // A TLS error from one client (a probe, a scanner, a version mismatch) must not take the
      // listener down with it.
      server.on('error', () => { /* logged per connection */ });
      server.on('tlsClientError', () => { /* an unauthenticated peer failing TLS is not an event */ });
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        port,
        get connections() { return info(); },
        disconnect(fingerprint: string) {
          for (const session of [...sessions]) {
            if (fingerprintsMatch(session.device?.fingerprint, fingerprint)) session.connection.close('disconnected by host');
          }
        },
        close() {
          unsubscribe();
          for (const session of [...sessions]) session.connection.close('host stopped');
          return new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

/** Re-exported so callers building an invite do not have to reach past this module. */
export { sanitizeMachineName };
