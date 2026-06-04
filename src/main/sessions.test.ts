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
    const olderId = 'a0b1c2d3-e4f5-6789-abcd-ef0123456789';
    const newerId = 'a0b1c2d3-e4f5-6789-abcd-ef0123456790';
    writeFileSync(join(d, `${olderId}.jsonl`), userLine('older work'));
    writeFileSync(join(d, `${newerId}.jsonl`), userLine('newer work'));
    utimesSync(join(d, `${olderId}.jsonl`), 1000, 1000);
    utimesSync(join(d, `${newerId}.jsonl`), 2000, 2000);

    const out = listSessions('C:\\g\\proj', root);
    expect(out.map((s) => s.id)).toEqual([newerId, olderId]);
    expect(out[0]).toMatchObject({ id: newerId, mtimeMs: 2000 * 1000, firstMessage: 'newer work' });
  });

  it('respects the limit', () => {
    const d = join(root, 'C--g-proj2');
    mkdirSync(d, { recursive: true });
    for (let i = 0; i < 7; i++) {
      const f = join(d, `a0b1c2d3-e4f5-0000-0000-00000000000${i}.jsonl`);
      writeFileSync(f, userLine(`m${i}`));
      utimesSync(f, 1000 + i, 1000 + i);
    }
    expect(listSessions('C:\\g\\proj2', root, 3)).toHaveLength(3);
  });

  it('returns [] when the session dir is missing', () => {
    expect(listSessions('C:\\g\\missing', root)).toEqual([]);
  });
});

describe('listSessions sessionId filtering', () => {
  it('accepts UUID-ish ids', () => {
    const enc = 'C--g-filter';
    const d = join(root, enc);
    mkdirSync(d, { recursive: true });
    const validId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    writeFileSync(join(d, `${validId}.jsonl`), userLine('valid'));
    const out = listSessions('C:\\g\\filter', root);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(validId);
  });

  it('rejects ids with shell metacharacters or too short', () => {
    const enc = 'C--g-filter2';
    const d = join(root, enc);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '$(evil).jsonl'), userLine('bad'));
    writeFileSync(join(d, 'short.jsonl'), userLine('bad'));
    writeFileSync(join(d, 'nothex-zz.jsonl'), userLine('bad'));
    const out = listSessions('C:\\g\\filter2', root);
    expect(out).toHaveLength(0);
  });
});
