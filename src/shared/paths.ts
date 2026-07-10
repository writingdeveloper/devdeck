/**
 * Encode an absolute path the way Claude names its ~/.claude/projects dir:
 * every non-alphanumeric character (drive colon, path separators, spaces, dots,
 * …) becomes '-'. Replacing only ':' and '\' missed folders whose names contain
 * spaces or dots, so their usage/sessions silently went unmatched.
 */
export function encodeProjectPath(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Shape guard for a session id before it is interpolated into an agent command
 * (`claude --resume <id>`) or used to build a path. Kept permissive (hex + dashes,
 * ≥8 chars) but non-injectable — no spaces, quotes, or shell metacharacters can pass.
 * Single source of truth: agents.ts, antigravitySessions.ts and sessions.ts all use this.
 */
export const SESSION_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,}$/;

/** A session id is safe to interpolate into an agent resume command only if it matches SESSION_ID_RE. */
export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

/**
 * Cross-platform basename: the last non-empty segment of a Windows OR POSIX path
 * (a cwd may be a Windows path read on any OS). Tolerates trailing separators —
 * `split(...).pop()` alone yields '' for a trailing-slash path, so filter first.
 */
export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}
