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

/** `git rev-list --count @{upstream}..HEAD` -> unpushed commit count, or null when there is no upstream. */
export function parseAheadCount(out: string): number | null {
  const t = out.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Normalize a `remote.origin.url` into a browsable GitHub https URL, or null when
 * it is not a recognizable github.com remote. Handles the three common forms:
 *   git@github.com:owner/repo.git          (scp-like)
 *   https://github.com/owner/repo.git      (https)
 *   ssh://git@github.com/owner/repo.git    (ssh)
 * Only github.com is recognized (the deck shows a GitHub mark); other hosts -> null.
 */
export function parseRemoteUrl(out: string): string | null {
  const raw = out.trim();
  if (!raw) return null;
  let host: string;
  let path: string;
  const scp = raw.match(/^[^@\s]+@([^:/\s]+):(.+)$/); // git@host:owner/repo(.git)
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const u = new URL(raw);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  if (host.toLowerCase() !== 'github.com') return null;
  const seg = path.replace(/^\/+/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const m = seg.match(/^([^/]+)\/([^/]+)$/); // exactly owner/repo
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}`;
}
