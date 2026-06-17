// Pure helpers for surfacing DELETED projects on the Usage page. Claude's session logs live in
// ~/.claude/projects/<encoded-path>/ independently of the project folder, so a deleted project's
// usage still exists on disk — these reconcile that data with the live deck so the totals stay honest.

export interface ClaudeProjectRef { path: string; name: string; }
export interface UsageProjectRef { path: string; name: string; status: 'active' | 'deleted'; }

/** Cross-platform basename for a Windows OR POSIX path (the cwd may be a Windows path read on any OS). */
function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/** Normalize a path for cross-source comparison: unify separators, drop a trailing one, lowercase
 *  (project paths here are Windows / case-insensitive). */
export function normPath(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Recover a project's real { path, name } from a session file's lines — the first line carrying a
 *  string `cwd` wins (verified present within the first few lines of every Claude session). null if none. */
export function recoverProjectFromLines(lines: string[]): ClaudeProjectRef | null {
  for (const line of lines) {
    if (!line.trim()) continue;
    let o: { cwd?: unknown };
    try { o = JSON.parse(line); } catch { continue; }
    if (typeof o.cwd === 'string' && o.cwd) return { path: o.cwd, name: basenameOf(o.cwd) };
  }
  return null;
}

export interface ClassifyInput {
  scanned: { path: string; name: string }[];
  claudeProjects: ClaudeProjectRef[];
  exists: (path: string) => boolean;
}

/**
 * Merge the live deck with the ~/.claude project list:
 *  - every scanned deck repo → 'active'
 *  - a ~/.claude project NOT in the deck whose folder no longer exists → 'deleted'
 *  - a ~/.claude project NOT in the deck whose folder still exists → SKIPPED (unscanned, out of scope)
 * Deduped by normalized path (so an active repo is never also listed as deleted).
 */
export function classifyUsageProjects(i: ClassifyInput): UsageProjectRef[] {
  const out: UsageProjectRef[] = [];
  const seen = new Set<string>();
  for (const r of i.scanned) {
    const k = normPath(r.path);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ path: r.path, name: r.name, status: 'active' });
  }
  for (const c of i.claudeProjects) {
    const k = normPath(c.path);
    if (seen.has(k)) continue;      // already an active deck project
    if (i.exists(c.path)) continue; // folder exists but isn't scanned → out of scope
    seen.add(k);
    out.push({ path: c.path, name: c.name, status: 'deleted' });
  }
  return out;
}
