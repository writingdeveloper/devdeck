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

/**
 * Parse `git status --porcelain=v2 --branch` output: branch + dirty count + ahead in ONE subprocess
 * (the deck previously spawned rev-parse + status + rev-list separately per project — 3 of its 5
 * per-project git calls — which at 100 projects meant hundreds of process launches every refresh).
 */
export function parseStatusV2(out: string): { branch: string | null; dirty: number; ahead: number | null } {
  let branch: string | null = null;
  let ahead: number | null = null;
  let dirty = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const name = line.slice('# branch.head '.length).trim();
      branch = name === '(detached)' ? null : name;
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -\d+/);
      if (m) ahead = Number(m[1]);
    } else if (line && !line.startsWith('#')) {
      dirty++; // every non-header entry line is one changed/untracked/unmerged path
    }
  }
  return { branch, dirty, ahead };
}
