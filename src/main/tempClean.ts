import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** Filename prefix for clipboard-paste temp PNGs — the ONE definition both the writer (ipc.ts
 * clipboard:readImage) and this sweeper share, so a rename can't silently decouple them. */
export const PASTE_IMAGE_PREFIX = 'devdeck-paste-';
// Matches the files clipboard:readImage writes (<prefix><uuid>.png) — nothing else.
const PASTE_IMAGE_RE = new RegExp(`^${PASTE_IMAGE_PREFIX}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.png$`, 'i');

/**
 * Best-effort sweep of stale clipboard-paste images from the OS temp dir. They're written so the
 * agent can read the image off a path, are useless minutes later, and were previously never
 * deleted — the one place DevDeck left junk outside userData. A ≥1-day grace period keeps files a
 * still-open session might reference. Never throws; returns how many files were removed.
 */
export async function cleanupPasteImages(dir: string, nowMs: number, maxAgeMs = 24 * 3_600_000): Promise<number> {
  let names: string[];
  try { names = await readdir(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!PASTE_IMAGE_RE.test(name)) continue;
    const file = join(dir, name);
    try {
      if (nowMs - (await stat(file)).mtimeMs > maxAgeMs) { await unlink(file); removed++; }
    } catch { /* raced/locked — leave it for the next sweep */ }
  }
  return removed;
}
