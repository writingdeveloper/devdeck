/**
 * The one file to read when DevDeck misbehaves on a machine you are not sitting at.
 *
 * Every bug in this app so far has been diagnosed by measuring the running program — and on the
 * remote half of a linked pair there was nothing to measure. The crash trap wrote to
 * `devdeck-errors.log`, but only for crashes, and only from the main process: a renderer exception,
 * a link that kept dropping, a session opening for a reason nobody could explain, all left no trace.
 * So this records what HAPPENED, not only what died, from both processes, in one place a person can
 * point an agent at.
 *
 * Kept deliberately small: an append, a size cap, and a tail. Nothing here may throw into a caller —
 * a diagnostic that can break the thing it is diagnosing is worse than none.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type DiagLevel = 'error' | 'warn' | 'info';

/**
 * How large the log may grow before it is rolled over.
 *
 * One previous generation is kept, so the worst case on disk is twice this. Sized so that a week of
 * ordinary use fits — which is the window a "it started acting up a few days ago" report needs —
 * without becoming a file too large to hand to an agent whole.
 */
export const DIAG_MAX_BYTES = 4 * 1024 * 1024;

/** Format one line. Exported for the tests, and because the shape is the contract a reader parses. */
export function formatDiagLine(
  at: Date, level: DiagLevel, source: string, message: string, memoryMb?: { rss: number; heap: number },
): string {
  const mem = memoryMb ? ` | rss=${memoryMb.rss}MB heap=${memoryMb.heap}MB` : '';
  // Newlines would make one entry read as several, and a stack trace is one entry.
  const flat = String(message).replace(/\r?\n/g, ' ⏎ ').slice(0, 4000);
  return `${at.toISOString()} ${level.toUpperCase().padEnd(5)} [${source}] ${flat}${mem}`;
}

export interface DiagnosticsOptions {
  /** Injected for the tests; defaults to the real clock and the real process memory. */
  now?: () => Date;
  memory?: () => { rss: number; heap: number };
  maxBytes?: number;
  /** Mirrored to the terminal so `npm start` still shows problems without opening the file. */
  echo?: (line: string) => void;
}

export class DiagnosticsLog {
  readonly path: string;
  private readonly previousPath: string;
  private readonly now: () => Date;
  private readonly memory: () => { rss: number; heap: number };
  private readonly maxBytes: number;
  private readonly echo: ((line: string) => void) | null;

  constructor(filePath: string, options: DiagnosticsOptions = {}) {
    this.path = filePath;
    this.previousPath = `${filePath}.1`;
    this.now = options.now ?? (() => new Date());
    this.memory = options.memory ?? (() => {
      const m = process.memoryUsage();
      return { rss: Math.round(m.rss / 1048576), heap: Math.round(m.heapUsed / 1048576) };
    });
    this.maxBytes = options.maxBytes ?? DIAG_MAX_BYTES;
    this.echo = options.echo ?? null;
  }

  write(level: DiagLevel, source: string, message: string): void {
    const line = formatDiagLine(this.now(), level, source, message, this.memory());
    this.echo?.(line);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      this.rollIfFull();
      appendFileSync(this.path, line + '\n');
    } catch { /* logging is best-effort and must never break its caller */ }
  }

  /** Roll over rather than truncate: the lines just before a problem are the ones worth keeping. */
  private rollIfFull(): void {
    try {
      if (statSync(this.path).size < this.maxBytes) return;
      renameSync(this.path, this.previousPath); // replaces the older generation
    } catch { /* no file yet, or a rename the OS refused — either way, keep appending */ }
  }

  /**
   * The last `lines` entries, oldest first — what a person copies into a bug report.
   *
   * Reads only the tail of the file. The whole point of this log is that it can be large, and a
   * reader that has to hold all of it in memory is one more thing that fails when things are
   * already going wrong.
   */
  tail(lines = 400): string {
    try {
      if (!existsSync(this.path)) return '';
      const size = statSync(this.path).size;
      // ~400 bytes per line is generous for this format; capped so a pathological file can't be
      // pulled in whole.
      const want = Math.min(size, Math.max(64 * 1024, lines * 400));
      const buffer = Buffer.alloc(want);
      const fd = openSync(this.path, 'r');
      try { readSync(fd, buffer, 0, want, size - want); } finally { closeSync(fd); }
      const text = buffer.toString('utf8');
      // The first line is very likely cut in half by the offset above.
      const all = text.split('\n').slice(size > want ? 1 : 0).filter((l) => l.length > 0);
      return all.slice(-lines).join('\n');
    } catch { return ''; }
  }

  size(): number {
    try { return statSync(this.path).size; } catch { return 0; }
  }
}

/**
 * Carry forward whatever the previous crash-only log holds, once, so a machine that has been
 * misbehaving for days does not start its diagnostics from an empty file.
 */
export function adoptLegacyErrorLog(diag: DiagnosticsLog, legacyPath: string): void {
  try {
    if (!existsSync(legacyPath) || diag.size() > 0) return;
    const text = readFileSync(legacyPath, 'utf8').split('\n').filter(Boolean).slice(-200);
    if (!text.length) return;
    diag.write('info', 'diag', `carried over ${text.length} lines from ${join(legacyPath)}`);
    for (const line of text) diag.write('error', 'legacy', line);
  } catch { /* best-effort */ }
}
