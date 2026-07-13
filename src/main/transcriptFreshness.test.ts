import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { latestTranscriptMtime } from './transcriptFreshness';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'devdeck-tfresh-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });

const put = (dir: string, name: string, mtimeSec: number): void => {
  mkdirSync(join(root, dir), { recursive: true });
  const f = join(root, dir, name);
  writeFileSync(f, '{}', 'utf8');
  utimesSync(f, mtimeSec, mtimeSec);
};

describe('latestTranscriptMtime', () => {
  it('returns 0 for a missing root dir', async () => {
    expect(await latestTranscriptMtime(join(root, 'nope'))).toBe(0);
  });

  it('returns 0 when no project has any .jsonl', async () => {
    mkdirSync(join(root, 'C--proj-a'));
    put('C--proj-b', 'readme.txt', 5000);
    expect(await latestTranscriptMtime(root)).toBe(0);
  });

  it('returns the newest .jsonl mtime across all project dirs, ignoring non-jsonl files', async () => {
    put('C--proj-a', 'aaaa.jsonl', 1000);
    put('C--proj-b', 'bbbb.jsonl', 3000);
    put('C--proj-b', 'newer-but-not-transcript.png', 9000);
    put('C--proj-c', 'cccc.jsonl', 2000);
    expect(await latestTranscriptMtime(root)).toBe(3000_000); // utimes takes seconds; mtimeMs is ms
  });
});
