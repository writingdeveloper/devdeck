/**
 * One framed link connection over a socket. Both ends use it, so framing exists once.
 *
 * The socket handed in is already authenticated — TLS completed and the peer's certificate
 * fingerprint was checked by the caller BEFORE this attached. Nothing here re-checks identity; this
 * layer only turns a byte stream into messages and back.
 */
import type { Duplex } from 'node:stream';
import {
  encodeJsonFrame, encodePtyFrame, decodePtyPayload, makeFrameDecoder, parseLinkMessage,
  FrameKind, type LinkMessage,
} from './protocol';

export interface ConnectionHandlers {
  onMessage(message: LinkMessage): void;
  onPty(sessionId: string, bytes: Buffer): void;
  /** Fired once, whatever the cause (peer closed, socket error, local close, protocol violation). */
  onClose(reason: string | null): void;
}

export interface LinkConnection {
  send(message: LinkMessage): void;
  sendPty(sessionId: string, chunk: string | Buffer): void;
  /** Idempotent. `reason` is for the audit log and the user-facing status, not for the peer. */
  close(reason?: string): void;
  readonly closed: boolean;
  /** Bytes buffered by the OS but not yet written — the backpressure signal (see hostServer). */
  readonly backlog: number;
  /**
   * Start pinging after a silence, and — only if `expectPong` — hang up after a longer one. A peer
   * that predates pings never answers them, and must not be dropped for it; TCP keepalive is all
   * that watches such a peer, which is exactly what watched every peer before this existed.
   */
  startHeartbeat(expectPong: boolean): void;
  /**
   * Ask now, and hang up if nothing at all arrives within `deadlineMs`. For the moment a machine
   * wakes from sleep: the socket may be long dead, and waiting out the regular heartbeat means a
   * minute of a terminal that looks fine and does nothing.
   */
  probe(deadlineMs: number): void;
  /** When something last arrived from the peer, by this connection's clock. */
  readonly lastFrameAt: number;
}

export interface HeartbeatOptions {
  /** Silence before a ping is sent (and re-sent, while the silence lasts). */
  idleMs: number;
  /** Silence before the peer is given up on. Keep it several pings long. */
  timeoutMs: number;
  now?: () => number;
  /** Test-only: pretend to be a peer that never answers. */
  answerPings?: boolean;
}

export const DEFAULT_HEARTBEAT: HeartbeatOptions = { idleMs: 15_000, timeoutMs: 45_000 };

export function attachConnection(socket: Duplex, handlers: ConnectionHandlers, heartbeat: HeartbeatOptions = DEFAULT_HEARTBEAT): LinkConnection {
  const decoder = makeFrameDecoder();
  let closed = false;
  const now = heartbeat.now ?? Date.now;
  let lastFrameAt = now();
  let lastPingAt = 0;
  let probeDeadline: number | null = null;
  let ticker: NodeJS.Timeout | null = null;
  /** Whether the peer said it answers pings. Null until startHeartbeat says; a probe then assumes not. */
  let peerAnswers: boolean | null = null;
  /** Runs only while a probe is outstanding — the heartbeat's own cadence is far too slow to hold a probe's deadline. */
  let probeTicker: NodeJS.Timeout | null = null;

  const stopProbe = (): void => { if (probeTicker) { clearInterval(probeTicker); probeTicker = null; } probeDeadline = null; };
  const stopHeartbeat = (): void => { if (ticker) { clearInterval(ticker); ticker = null; } stopProbe(); };

  /** Terminal: the socket is gone or must go now. Nothing further is read or written. */
  const finish = (reason: string | null): void => {
    if (closed) return;
    closed = true;
    stopHeartbeat();
    try { socket.destroy(); } catch { /* already gone */ }
    handlers.onClose(reason);
  };

  /**
   * Hang up on purpose, after letting what is already queued reach the peer.
   *
   * This distinction is not cosmetic. Refusals are sent as a frame and then the connection is closed —
   * `unpaired`, `token-expired`, `permission-denied`. Destroying the socket immediately after
   * `write()` discards that frame, and the peer sees an unexplained disconnect: the person is told
   * "could not connect" and goes to look at their firewall, when the host had told them their code
   * expired. `end()` flushes, then sends FIN; the timer is the backstop for a peer that never reads.
   */
  const closeGracefully = (reason: string | null): void => {
    if (closed) return;
    closed = true;
    stopHeartbeat();
    try {
      socket.end();
      const timer = setTimeout(() => { try { socket.destroy(); } catch { /* already gone */ } }, 2_000);
      timer.unref?.();
      socket.once('close', () => clearTimeout(timer));
    } catch {
      try { socket.destroy(); } catch { /* already gone */ }
    }
    handlers.onClose(reason);
  };

  socket.on('data', (chunk: Buffer) => {
    if (closed) return;
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch (err) {
      // A bad length or unknown kind means the stream is desynchronized: there is no way to find the
      // next frame boundary, so the only correct move is to hang up rather than guess.
      finish(err instanceof Error ? err.message : 'protocol error');
      return;
    }
    for (const frame of frames) {
      if (closed) return;
      // Anything at all from the peer is proof it is there — a terminal streaming output needs no
      // ping to vouch for it, and a probe is answered by whatever arrives first.
      lastFrameAt = now();
      if (probeDeadline !== null) stopProbe();
      if (frame.kind === FrameKind.Pty) {
        const pty = decodePtyPayload(frame.payload);
        if (pty) handlers.onPty(pty.sessionId, pty.bytes);
        continue;
      }
      const message = parseLinkMessage(frame.payload);
      // A malformed JSON payload is not fatal — it is one bad frame, and the peer may well be able to
      // say something sensible next. Framing errors above are fatal; content errors are not.
      if (!message) continue;
      // Liveness traffic stops HERE. Handed up, the host would count a ping as the peer using this
      // machine and keep it awake for a viewer that is merely connected; and every peer would have
      // to know to answer, when the answer is the same everywhere.
      if (message.t === 'ping') { if (heartbeat.answerPings !== false) write(encodeJsonFrame({ t: 'pong', at: message.at })); continue; }
      if (message.t === 'pong') continue;
      handlers.onMessage(message);
    }
  });

  socket.on('error', (err: Error) => finish(err.message));
  socket.on('close', () => finish(null));
  socket.on('end', () => finish(null));

  const write = (buffer: Buffer): void => {
    if (closed) return;
    // A write to a socket that died between our check and here throws synchronously on some platforms;
    // it must not unwind the pty callback that is publishing.
    try { socket.write(buffer); } catch { finish('write failed'); }
  };

  const tick = (expectPong: boolean): void => {
    if (closed) return;
    const t = now();
    const silence = t - lastFrameAt;
    if (probeDeadline !== null && t >= probeDeadline) { finish('heartbeat timeout'); return; }
    if (expectPong && silence >= heartbeat.timeoutMs) { finish('heartbeat timeout'); return; }
    if (silence >= heartbeat.idleMs && t - lastPingAt >= heartbeat.idleMs) {
      lastPingAt = t;
      write(encodeJsonFrame({ t: 'ping', at: t }));
    }
  };

  return {
    send(message) { write(encodeJsonFrame(message)); },
    startHeartbeat(expectPong) {
      if (closed || ticker) return;
      peerAnswers = expectPong;
      lastFrameAt = now();
      ticker = setInterval(() => tick(expectPong), Math.max(20, Math.floor(heartbeat.idleMs / 3)));
      ticker.unref?.();
    },
    probe(deadlineMs) {
      if (closed) return;
      const t = now();
      lastPingAt = t;
      write(encodeJsonFrame({ t: 'ping', at: t }));
      // A peer that never answers pings cannot be given a deadline to answer one by — the probe
      // would hang up on a perfectly live older build after every wake. It gets the ping (harmless)
      // and stays under TCP keepalive alone.
      if (peerAnswers !== true) return;
      probeDeadline = t + Math.max(100, deadlineMs);
      if (!probeTicker) { probeTicker = setInterval(() => tick(true), 50); probeTicker.unref?.(); }
    },
    get lastFrameAt() { return lastFrameAt; },
    sendPty(sessionId, chunk) {
      try {
        write(encodePtyFrame(sessionId, chunk));
      } catch (err) {
        // encodePtyFrame throws only on an over-long session id or an oversized chunk — a bug or a
        // pathological burst, either way not worth killing the connection over.
        handlers.onMessage({ t: 'error', code: 'rate-limited', message: err instanceof Error ? err.message : 'frame too large' });
      }
    },
    close(reason) { closeGracefully(reason ?? null); },
    get closed() { return closed; },
    get backlog() { return (socket as Duplex & { writableLength?: number }).writableLength ?? 0; },
  };
}
