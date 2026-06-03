import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSessions } from './sessions';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'devdeck-sess-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const userLine = (text: string) => JSON.stringify({ type: 'user', message: { content: text } });

describe('listSessions', () => {
  it('returns sessions newest-first with id, mtime, and first message', () => {
    const enc = 'C--g-proj';
    const d = join(root, enc);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'older.jsonl'), userLine('older work'));
    writeFileSync(join(d, 'newer.jsonl'), userLine('newer work'));
    utimesSync(join(d, 'older.jsonl'), 1000, 1000);
    utimesSync(join(d, 'newer.jsonl'), 2000, 2000);

    const out = listSessions('C:\\g\\proj', root);
    expect(out.map((s) => s.id)).toEqual(['newer', 'older']);
    expect(out[0]).toMatchObject({ id: 'newer', mtimeMs: 2000 * 1000, firstMessage: 'newer work' });
  });

  it('respects the limit', () => {
    const d = join(root, 'C--g-proj');
    mkdirSync(d, { recursive: true });
    for (let i = 0; i < 7; i++) {
      const f = join(d, `s${i}.jsonl`);
      writeFileSync(f, userLine(`m${i}`));
      utimesSync(f, 1000 + i, 1000 + i);
    }
    expect(listSessions('C:\\g\\proj', root, 3)).toHaveLength(3);
  });

  it('returns [] when the session dir is missing', () => {
    expect(listSessions('C:\\g\\missing', root)).toEqual([]);
  });
});
