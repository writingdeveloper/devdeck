export function parseBranch(out: string): string | null {
  const b = out.trim();
  return b.length ? b : null;
}

export function parseLastCommit(out: string): {
  lastCommitMs: number | null;
  lastSubject: string | null;
} {
  const line = out.trim();
  if (!line) return { lastCommitMs: null, lastSubject: null };
  const sep = line.indexOf('|');
  if (sep === -1) return { lastCommitMs: null, lastSubject: null };
  const secs = Number(line.slice(0, sep));
  const subject = line.slice(sep + 1);
  if (!Number.isFinite(secs)) return { lastCommitMs: null, lastSubject: null };
  return { lastCommitMs: secs * 1000, lastSubject: subject };
}

export function parsePorcelainCount(out: string): number {
  return out.split('\n').filter((l) => l.trim().length > 0).length;
}
