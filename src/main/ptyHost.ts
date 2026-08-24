export interface PtyProcess {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type PtySpawn = (
  file: string, args: string[], opts: { cwd: string; cols: number; rows: number }
) => PtyProcess;

/**
 * What a session IS, beyond its pid.
 *
 * Recorded at creation because it is the only moment this is known here: the ids are minted from a
 * project path and a counter, and everything else (which conversation, which agent) is decided by the
 * caller. Without it this process knows a machine is running six terminals but not one thing about
 * them — which is exactly what another machine needs to ask.
 */
export interface PtySessionInfo {
  id: string;
  projectPath: string;
  /** The conversation the session was opened on, when the provider records one. */
  sessionId: string | null;
  agentId: string;
  startedAtMs: number;
}

/**
 * Recent output kept per session, so a viewer that attaches to an ALREADY-RUNNING terminal sees what
 * is on it instead of a blank rectangle until the agent happens to speak again.
 *
 * 256KB is far more than a screen and comfortably covers a long agent turn. It is a cost paid per live
 * session, which is why it is capped rather than unbounded: a session streaming for hours would
 * otherwise hold every byte it ever produced.
 */
const SCROLLBACK_BYTES = 256 * 1024;

interface Session {
  proc: PtyProcess;
  info: PtySessionInfo;
  /** Chunks, oldest first, trimmed from the front once the total passes the cap. */
  chunks: string[];
  bufferedLength: number;
}

export class PtyHost {
  private sessions = new Map<string, Session>();
  constructor(private readonly spawn: PtySpawn) {}

  create(
    id: string, file: string, args: string[], cwd: string, cols: number, rows: number,
    onData: (data: string) => void, onExit: (e: { exitCode: number }) => void,
    info?: Omit<PtySessionInfo, 'id' | 'startedAtMs'> & { startedAtMs?: number },
  ): void {
    const proc = this.spawn(file, args, { cwd, cols, rows });
    const session: Session = {
      proc,
      info: {
        id,
        projectPath: info?.projectPath ?? cwd,
        sessionId: info?.sessionId ?? null,
        agentId: info?.agentId ?? 'claude',
        startedAtMs: info?.startedAtMs ?? Date.now(),
      },
      chunks: [],
      bufferedLength: 0,
    };
    this.sessions.set(id, session);
    proc.onData((data) => { this.remember(session, data); onData(data); });
    proc.onExit((e) => { this.sessions.delete(id); onExit(e); });
  }

  private remember(session: Session, data: string): void {
    session.chunks.push(data);
    session.bufferedLength += data.length;
    while (session.bufferedLength > SCROLLBACK_BYTES && session.chunks.length > 1) {
      session.bufferedLength -= session.chunks.shift()!.length;
    }
    // A single chunk larger than the cap still has to shrink, and it is cut from the FRONT so the most
    // recent output — the part a viewer actually needs to see — is what survives.
    if (session.bufferedLength > SCROLLBACK_BYTES && session.chunks.length === 1) {
      session.chunks[0] = session.chunks[0].slice(-SCROLLBACK_BYTES);
      session.bufferedLength = session.chunks[0].length;
    }
  }

  /** OS pid of a session's shell — the root for "which agent is actually running in this tile". */
  pid(id: string): number | null { return this.sessions.get(id)?.proc.pid ?? null; }

  /** Every session running here, for a viewer asking "what is already going on over there". */
  list(): PtySessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }));
  }

  /** Update what is known about a session — the live drift detector re-resolves the conversation id. */
  note(id: string, patch: Partial<Pick<PtySessionInfo, 'sessionId' | 'agentId'>>): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (patch.sessionId !== undefined) session.info.sessionId = patch.sessionId;
    if (patch.agentId !== undefined) session.info.agentId = patch.agentId;
  }

  /**
   * Recent output, for repainting a terminal that is being attached to mid-flight.
   *
   * Trimmed to the first line boundary: the cut point is arbitrary, and starting a replay in the
   * middle of an escape sequence makes xterm render the tail of it as literal text.
   */
  buffer(id: string): string {
    const session = this.sessions.get(id);
    if (!session) return '';
    const joined = session.chunks.join('');
    const firstBreak = joined.indexOf('\n');
    return firstBreak >= 0 && firstBreak < joined.length - 1 ? joined.slice(firstBreak + 1) : joined;
  }

  write(id: string, data: string): void { this.sessions.get(id)?.proc.write(data); }
  resize(id: string, cols: number, rows: number): void { this.sessions.get(id)?.proc.resize(cols, rows); }
  kill(id: string): void { const s = this.sessions.get(id); if (s) { s.proc.kill(); this.sessions.delete(id); } }
  killAll(): void { for (const s of this.sessions.values()) s.proc.kill(); this.sessions.clear(); }
}
