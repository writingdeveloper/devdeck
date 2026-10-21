import { randomUUID } from 'node:crypto';
import { spawn as spawnChild } from 'node:child_process';
import { withTimeout } from '../shared/withTimeout';
import { hasProgramStatusProbe, PROGRAM_STATUS_REPLY } from '../shared/programStatus';

export interface PtyProcess {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** True when this terminal runs on the conpty.dll bundled with node-pty rather than Windows' own. */
  bundledConpty?: boolean;
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
  file: string, args: string[], opts: { cwd: string; cols: number; rows: number; bundledConpty?: boolean }
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
   * The host-owned title transaction persists and updates this value. All renderers, including
   * the host window, consume that committed snapshot rather than owning separate titles.
   */
  label: string | null;
  /** Absent on older hosts. Changes whenever the terminal is recreated. */
  instanceId?: string;
  labelRevision?: number;
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

/**
 * The most project terminals this machine will run at once. Each one is a real agent process
 * holding memory and quota, and the restore path has run away before — one bug opened 50 claude
 * processes in a loop and froze the host. Far past any real working set; a refusal there is a
 * readable error instead of a machine that stops responding. Internal terminals do not count.
 */
export const MAX_SESSIONS = 32;

/** How long `taskkill` may take before the plain kill goes ahead without it. */
const TREE_KILL_TIMEOUT_MS = 3_000;

/** How long one ending terminal may hold up the next before it goes ahead anyway. */
const KILL_STEP_TIMEOUT_MS = 4_000;
/** Quitting waits at least this long for the terminals, and longer when there are many to end one by one. */
const SHUTDOWN_PER_TERMINAL_MS = 1_500;

export type TreeKiller = (pid: number) => Promise<void>;

/**
 * `taskkill /PID <pid> /T /F`: end a Windows process AND everything it started. Never rejects —
 * however it ends (killed, nothing to kill, taskkill missing, too slow), the caller carries on.
 */
export function taskkillTree(pid: number, spawnFn: typeof spawnChild = spawnChild, timeoutMs = TREE_KILL_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(finish, timeoutMs);
    if (!Number.isInteger(pid) || pid <= 0) { finish(); return; }
    try {
      const p = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      p.once('error', finish);
      p.once('exit', finish);
    } catch { finish(); }
  });
}

/**
 * Make a pty's kill() take the shell's whole process tree, not only what is attached to its console.
 *
 * node-pty's Windows kill() ends the processes in the pseudoconsole's process list and closes it.
 * An agent's own children that were started hidden or detached — MCP servers, a dev server it ran
 * with Start-Process, anything spawned with windowsHide — are not in that list and outlive the tile,
 * holding ports and files. `taskkill /T` walks the parent chain instead, so it has to run FIRST,
 * while the shell still exists to walk from; the original kill() follows once it is done (or has
 * timed out), so the pseudoconsole is always closed and node-pty's exit still fires.
 */
export function withTreeKill(proc: PtyProcess, killTree: TreeKiller): PtyProcess {
  let killing = false;
  return {
    get pid() { return proc.pid; },
    bundledConpty: proc.bundledConpty,
    onData: (cb) => proc.onData(cb),
    onExit: (cb) => proc.onExit(cb),
    write: (d) => proc.write(d),
    resize: (c, r) => proc.resize(c, r),
    kill: () => {
      if (killing) return;
      killing = true;
      const pid = proc.pid;
      void killTree(pid).catch(() => { /* the plain kill below still runs */ }).then(() => {
        try { proc.kill(); } catch (error) { console.error('DevDeck: terminal close failed', error); }
      });
    },
  };
}

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
  /** Only a truncated prefix needs discarding through the next complete line. */
  prefixTruncated: boolean;
  /** Whether this terminal answers Claude Code's status probe (and so receives its status reports). */
  programStatus: boolean;
  /** Settles when the process has exited and node-pty has said so. */
  exit: Promise<void>;
}

export class PtyHost {
  private sessions = new Map<string, Session>();
  private pendingExits = new Set<Promise<void>>();
  private stopping = false;
  private shutdownWork: Promise<void> | null = null;
  /** The terminal being ended right now, until its exit lands; the next one waits for it. */
  private ending: Promise<void> | null = null;
  constructor(private readonly spawn: PtySpawn) {}

  create(
    id: string, file: string, args: string[], cwd: string, cols: number, rows: number,
    onData: (data: string) => void, onExit: (e: { exitCode: number }) => void,
    info?: Partial<Omit<PtySessionInfo, 'id'>> & { internal?: boolean; programStatus?: boolean },
  ): void {
    if (this.stopping) throw new Error('Terminals are shutting down');
    if (this.sessions.has(id)) throw new Error(`Terminal already exists: ${id}`);
    if (info?.internal !== true && this.list().length >= MAX_SESSIONS) {
      throw new Error(`Too many terminals open (${MAX_SESSIONS}). Close some sessions first.`);
    }
    // Claude Code reports its own state (OSC 7501) only to a terminal that answers its probe. On
    // Windows the probe has to REACH a terminal for that: Windows' own ConPTY answers the device
    // query Claude Code sends after it, so the probe looks unanswered before any reply can arrive.
    // The conpty.dll bundled with node-pty passes both through.
    const wantStatus = info?.programStatus === true;
    const proc = this.spawn(file, args, wantStatus && process.platform === 'win32' ? { cwd, cols, rows, bundledConpty: true } : { cwd, cols, rows });
    const answerProbe = wantStatus && (process.platform !== 'win32' || proc.bundledConpty === true);
    let probeTail = '';
    let exited!: () => void;
    const exit = new Promise<void>((resolve) => { exited = resolve; });
    this.pendingExits.add(exit);
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
        instanceId: randomUUID(),
        labelRevision: 0,
      },
      internal: info?.internal === true,
      chunks: [],
      bufferedLength: 0,
      prefixTruncated: false,
      programStatus: answerProbe,
      exit,
    };
    this.sessions.set(id, session);
    proc.onData((data) => {
      // Answered here, once, before the output reaches any viewer: every attached terminal would
      // otherwise answer for itself, and a session nobody is looking at would never be answered.
      if (answerProbe) {
        const seen = probeTail + data;
        if (hasProgramStatusProbe(seen)) { proc.write(PROGRAM_STATUS_REPLY); probeTail = ''; }
        else probeTail = seen.slice(-16);
      }
      this.remember(session, data);
      onData(data);
    });
    proc.onExit((e) => {
      if (this.sessions.get(id) === session) this.sessions.delete(id);
      this.pendingExits.delete(exit);
      exited();
      onExit(e);
    });
  }

  private remember(session: Session, data: string): void {
    session.chunks.push(data);
    session.bufferedLength += data.length;
    while (session.bufferedLength > SCROLLBACK_BYTES && session.chunks.length > 1) {
      session.bufferedLength -= session.chunks.shift()!.length;
      session.prefixTruncated = true;
    }
    // A single chunk larger than the cap still has to shrink, and it is cut from the FRONT so the most
    // recent output — the part a viewer actually needs to see — is what survives.
    if (session.bufferedLength > SCROLLBACK_BYTES && session.chunks.length === 1) {
      session.chunks[0] = session.chunks[0].slice(-SCROLLBACK_BYTES);
      session.bufferedLength = session.chunks[0].length;
      session.prefixTruncated = true;
    }
  }

  /** OS pid of a session's shell — the root for "which agent is actually running in this tile". */
  pid(id: string): number | null { return this.sessions.get(id)?.proc.pid ?? null; }

  /** Every project session running here, for a viewer asking "what is already going on over there". */
  /** Whether a session answers Claude Code's status probe; false for one that does not exist. */
  programStatus(id: string): boolean { return this.sessions.get(id)?.programStatus === true; }

  list(): PtySessionInfo[] {
    return [...this.sessions.values()].filter((s) => !s.internal).map((s) => ({ ...s.info }));
  }

  /**
   * Update what is known about a session — the live drift detector re-resolves the conversation id,
   * and the host-owned title transaction updates the committed label.
   *
   * Returns whether anything actually changed, so a caller does not announce a no-op to every
   * connected machine. Label changes follow an explicit confirmed rename.
   */
  note(id: string, patch: Partial<Pick<PtySessionInfo, 'sessionId' | 'agentId' | 'label'>>): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    let changed = false;
    if (patch.sessionId !== undefined && patch.sessionId !== session.info.sessionId) { session.info.sessionId = patch.sessionId; changed = true; }
    if (patch.agentId !== undefined && patch.agentId !== session.info.agentId) { session.info.agentId = patch.agentId; changed = true; }
    if (patch.label !== undefined && patch.label !== session.info.label) { session.info.label = patch.label; session.info.labelRevision = (session.info.labelRevision ?? 0) + 1; changed = true; }
    return changed;
  }

  /**
   * Recent output, for repainting a terminal that is being attached to mid-flight.
   *
   * Only a buffer that exceeded the cap is trimmed to a safe boundary. Discarding a first line from
   * an intact buffer loses real output (and the cursor-positioning prefix of a ConPTY repaint).
   */
  buffer(id: string): PtyScreen {
    const session = this.sessions.get(id);
    if (!session) return { data: '', cols: 0, rows: 0 };
    const joined = session.chunks.join('');
    const firstBreak = joined.indexOf('\n');
    // Full-screen TUIs can repaint using cursor addresses without any newline. Resume at an escape
    // boundary in that case, instead of returning a blank screen for the rest of their lifetime.
    const firstEscape = joined.indexOf('\x1b');
    const data = !session.prefixTruncated ? joined : firstBreak >= 0 ? joined.slice(firstBreak + 1)
      : firstEscape >= 0 ? joined.slice(firstEscape) : '';
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
    session.prefixTruncated = false;
    session.proc.resize(cols, rows);
    return true;
  }
  kill(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    // One at a time. On Windows, node-pty's exit threads remove a terminal from one shared list
    // without a lock (fixed upstream only in a 0.15 beta), so two terminals ending at the same moment
    // (quitting, Update all, closing a group) could corrupt it: an "Assertion failed:
    // remove_pty_baton" dialog, or a crash on the way out. The next kill starts once the previous
    // exit has been reported, and by then that thread is done with the list.
    const step = (): Promise<void> => {
      try { s.proc.kill(); } catch (error) { console.error('DevDeck: terminal close failed', error); }
      return withTimeout(s.exit, KILL_STEP_TIMEOUT_MS, 'terminal exit').catch(() => undefined);
    };
    const next = this.ending ? this.ending.then(step) : step();
    this.ending = next;
    void next.then(() => { if (this.ending === next) this.ending = null; });
  }
  killAll(): void {
    for (const id of [...this.sessions.keys()]) {
      try { this.kill(id); } catch (error) { console.error('DevDeck: terminal close failed', error); }
    }
  }
  /** Kill only the terminals DevDeck opened for itself (provider logins), leaving project sessions running. */
  killInternal(): void {
    for (const [id, s] of [...this.sessions]) {
      if (!s.internal) continue;
      try { this.kill(id); } catch (error) { console.error('DevDeck: terminal close failed', error); }
    }
  }

  /** Drain native exit callbacks while Electron's Node environment is still alive. */
  shutdown(timeoutMs?: number): Promise<void> {
    if (this.shutdownWork) return this.shutdownWork;
    this.stopping = true;
    const exits = [...this.pendingExits]; // also includes terminals already closing
    this.killAll();
    // Terminals end one by one (see kill), so many of them take longer than a few at once would.
    const budget = timeoutMs ?? Math.max(5_000, exits.length * SHUTDOWN_PER_TERMINAL_MS);
    this.shutdownWork = withTimeout(Promise.all(exits), budget, 'terminal shutdown').then(() => {});
    return this.shutdownWork;
  }
}
