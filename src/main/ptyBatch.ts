/**
 * Coalesces PTY output before it crosses IPC. node-pty fires many tiny data events; sending each as
 * its own `cockpit:data` message floods the renderer's single UI thread when many sessions stream at
 * once (the renderer does stripAnsi + term.write per message). Buffering per id and flushing on a
 * frame-ish timer — or immediately once a buffer grows past a byte cap — cuts the renderer's wake-ups
 * dramatically while adding at most one frame of output latency. Input (keystrokes) is never batched.
 *
 * Free of any timer/Electron dependency — the scheduler is injected so it is unit-testable.
 */
export class PtyBatcher {
  private readonly pending = new Map<string, string>();
  private scheduled = false;

  constructor(
    private readonly emit: (id: string, chunk: string) => void,
    private readonly schedule: (flush: () => void) => void,
    private readonly maxBytes = 64 * 1024,
  ) {}

  push(id: string, chunk: string): void {
    const buf = (this.pending.get(id) ?? '') + chunk;
    this.pending.set(id, buf);
    if (buf.length >= this.maxBytes) { this.flush(); return; } // big burst → don't wait for the timer
    if (!this.scheduled) { this.scheduled = true; this.schedule(() => this.flush()); }
  }

  flush(): void {
    this.scheduled = false;
    // Isolate each emit: a destroyed/reloading webContents can throw from send. The scheduler runs
    // flush in a setTimeout callback, so an escaping throw becomes an uncaughtException that kills
    // the whole main process (and every terminal with it). One dead session must not do that, and
    // the survivors must still flush — so swallow per-id and always clear the buffer below.
    for (const [id, chunk] of this.pending) {
      try { this.emit(id, chunk); } catch { /* dead webContents — drop this chunk, keep the batcher (and the process) alive */ }
    }
    this.pending.clear();
  }

  /** Forget a session's buffered output (e.g. it was closed) so dead data isn't delivered. */
  drop(id: string): void { this.pending.delete(id); }
}
