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
}

export function attachConnection(socket: Duplex, handlers: ConnectionHandlers): LinkConnection {
  const decoder = makeFrameDecoder();
  let closed = false;

  /** Terminal: the socket is gone or must go now. Nothing further is read or written. */
  const finish = (reason: string | null): void => {
    if (closed) return;
    closed = true;
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
      if (frame.kind === FrameKind.Pty) {
        const pty = decodePtyPayload(frame.payload);
        if (pty) handlers.onPty(pty.sessionId, pty.bytes);
        continue;
      }
      const message = parseLinkMessage(frame.payload);
      // A malformed JSON payload is not fatal — it is one bad frame, and the peer may well be able to
      // say something sensible next. Framing errors above are fatal; content errors are not.
      if (message) handlers.onMessage(message);
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

  return {
    send(message) { write(encodeJsonFrame(message)); },
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
