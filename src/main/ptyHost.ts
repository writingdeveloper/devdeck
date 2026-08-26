export interface PtyProcess {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/**
 * A session's recent output, together with the geometry it was drawn for.
 *
 * The size travels WITH the bytes because the only safe use of them is painting a terminal that is
 * currently that size; a viewer holding a differently-sized one has to wait for a screen it can use
 * rather than paint one it will immediately have to draw over.
 */
export interface PtyScreen { data: string; cols: number; rows: number }

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
  /**
   * The name the user gave this session, when they renamed it.
   *
   * Kept here rather than only in the deck that renamed it, because a name is the ONLY thing telling
   * two sessions on the same repository apart — and a machine that cannot say what its sessions are
   * called leaves every viewer to fall back on the folder name, which is identical for all of them.
   * The deck holding the tile is the source of truth and writes it here (`note`); this is its copy,
   * so that the answer travels with the session rather than with the deck.
   */
  label: string | null;
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
  /**
   * The size the pty is at right now — and therefore the size every byte in `chunks` was drawn for.
   *
   * A terminal's output is not size-independent text. ConPTY repaints by absolute cursor address
   * ("go to row 9, column 118, erase to end of line"), computed against the width it had at the time.
   * Replaying bytes produced at one width into a terminal of another leaves those writes at the wrong
   * places, with the earlier, wider paint still showing through underneath — the split screen this is
   * reported as. So the size is kept here, the buffer is dropped whenever it changes, and what a
   * viewer is handed always says which geometry it belongs to.
   */
  cols: number;
  rows: number;
  proc: PtyProcess;
  info: PtySessionInfo;
  /**
   * A terminal DevDeck opened for its OWN purposes — a provider login — rather than a session on a
   * project. Never listed: another machine has no use for it, and a deck reconciling against the list
   * would build a project tile for an OAuth prompt, against a path outside any scanned folder.
   */
  internal: boolean;
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
    info?: Partial<Omit<PtySessionInfo, 'id'>> & { internal?: boolean },
  ): void {
    const proc = this.spawn(file, args, { cwd, cols, rows });
    const session: Session = {
      proc,
      cols,
      rows,
      info: {
        id,
        projectPath: info?.projectPath ?? cwd,
        sessionId: info?.sessionId ?? null,
        agentId: info?.agentId ?? 'claude',
        startedAtMs: info?.startedAtMs ?? Date.now(),
        label: info?.label ?? null,
      },
      internal: info?.internal === true,
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

  /** Every project session running here, for a viewer asking "what is already going on over there". */
  list(): PtySessionInfo[] {
    return [...this.sessions.values()].filter((s) => !s.internal).map((s) => ({ ...s.info }));
  }

  /**
   * Update what is known about a session — the live drift detector re-resolves the conversation id,
   * and the deck holding the tile writes back the name the user gave it.
   *
   * Returns whether anything actually changed, so a caller does not announce a no-op to every
   * connected machine (renaming is typed one character at a time on commit paths that re-send).
   */
  note(id: string, patch: Partial<Pick<PtySessionInfo, 'sessionId' | 'agentId' | 'label'>>): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    let changed = false;
    if (patch.sessionId !== undefined && patch.sessionId !== session.info.sessionId) { session.info.sessionId = patch.sessionId; changed = true; }
    if (patch.agentId !== undefined && patch.agentId !== session.info.agentId) { session.info.agentId = patch.agentId; changed = true; }
    if (patch.label !== undefined && patch.label !== session.info.label) { session.info.label = patch.label; changed = true; }
    return changed;
  }

  /**
   * Recent output, for repainting a terminal that is being attached to mid-flight.
   *
   * Trimmed to the first line boundary: the cut point is arbitrary, and starting a replay in the
   * middle of an escape sequence makes xterm render the tail of it as literal text.
   */
  buffer(id: string): PtyScreen {
    const session = this.sessions.get(id);
    if (!session) return { data: '', cols: 0, rows: 0 };
    const joined = session.chunks.join('');
    const firstBreak = joined.indexOf('\n');
    const data = firstBreak >= 0 && firstBreak < joined.length - 1 ? joined.slice(firstBreak + 1) : joined;
    return { data, cols: session.cols, rows: session.rows };
  }

  write(id: string, data: string): void { this.sessions.get(id)?.proc.write(data); }
  /**
   * Set a session's size — and forget everything printed at the old one.
   *
   * Two things happen here and both matter. A resize to the size the pty already has is dropped
   * outright: ConPTY answers every resize with a full repaint of the screen, so re-asserting an
   * unchanged size costs a screenful of bytes through the IPC channel and into every attached
   * terminal, on every machine watching, for nothing. And a resize that DOES change the size drops
   * the remembered output, because those bytes were drawn for the old geometry and replaying them at
   * the new one is what corrupts the screen (see `cols`). ConPTY's own repaint refills the buffer
   * within a frame or two, so what a viewer is handed next is a screen drawn for the size it is at.
   *
   * Returns whether the size changed, so a caller can tell "a repaint is coming" from "nothing did".
   */
  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.cols === cols && session.rows === rows) return false;
    session.cols = cols;
    session.rows = rows;
    session.chunks = [];
    session.bufferedLength = 0;
    session.proc.resize(cols, rows);
    return true;
  }
  kill(id: string): void { const s = this.sessions.get(id); if (s) { s.proc.kill(); this.sessions.delete(id); } }
  killAll(): void { for (const s of this.sessions.values()) s.proc.kill(); this.sessions.clear(); }
}
