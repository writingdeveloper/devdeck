// Validation for a new project (folder) name. Pure and dependency-free so the
// main process can enforce it authoritatively while the renderer reuses the exact
// same rule for instant, pre-submit feedback.

export type NameError = 'empty' | 'chars' | 'reserved' | 'long';

export type NameCheck = { ok: true; name: string } | { ok: false; reason: NameError };

const MAX_LEN = 100;
// Characters illegal in a Windows path segment (also a safe superset for POSIX).
// Spaces and hyphens are intentionally allowed — real project folders use them
// (e.g. "Youtube Lythem Game"); only a *trailing* space is rejected below.
const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1f]/;
// Windows reserved device names (case-insensitive), bare or with an extension.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Validate a user-typed project folder name. Returns the trimmed canonical name
 * on success, or the reason it was rejected. Trimming is part of the contract so
 * the main process and renderer always agree on the exact folder that gets created.
 */
export function validateProjectName(raw: string): NameCheck {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, reason: 'empty' };
  if (name.length > MAX_LEN) return { ok: false, reason: 'long' };
  if (name === '.' || name === '..') return { ok: false, reason: 'chars' };
  if (INVALID_CHARS.test(name)) return { ok: false, reason: 'chars' };
  // Windows silently strips a trailing dot or space, which would create a folder
  // other than the one the user typed — reject rather than surprise them.
  if (/[. ]$/.test(name)) return { ok: false, reason: 'chars' };
  if (RESERVED.test(name)) return { ok: false, reason: 'reserved' };
  return { ok: true, name };
}
