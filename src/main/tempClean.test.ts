import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupPasteImages } from './tempClean';

const DAY = 24 * 3_600_000;

describe('cleanupPasteImages', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'devdeck-clean-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

  const touch = (name: string, ageMs: number, now: number): string => {
    const p = join(dir, name);
    writeFileSync(p, 'x');
    const t = new Date(now - ageMs);
    utimesSync(p, t, t);
    return p;
  };

  it('deletes paste images older than a day and keeps recent ones', async () => {
    const now = Date.now();
    const old = touch('devdeck-paste-0a1b2c3d-4e5f-6789-abcd-ef0123456789.png', 2 * DAY, now);
    const fresh = touch('devdeck-paste-1a1b2c3d-4e5f-6789-abcd-ef0123456789.png', DAY / 2, now);
    const removed = await cleanupPasteImages(dir, now);
    expect(removed).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('never touches files that do not match the paste-image name pattern', async () => {
    const now = Date.now();
    const other = touch('user-photo.png', 3 * DAY, now);
    const near = touch('devdeck-paste-not-a-real-suffix.txt', 3 * DAY, now);
    const removed = await cleanupPasteImages(dir, now);
    expect(removed).toBe(0);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(near)).toBe(true);
  });

  it('returns 0 (never throws) for a missing directory', async () => {
    await expect(cleanupPasteImages(join(dir, 'nope'), Date.now())).resolves.toBe(0);
  });
});
