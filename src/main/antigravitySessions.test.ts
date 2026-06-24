import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { antigravityAvailable, listAntigravitySessions, lastUserMessageForAntigravitySession } from './antigravitySessions';

let dir: string;
function dbFor(path: string): Buffer {
  const uri = Buffer.from(path, 'utf8');
  return Buffer.concat([Buffer.from([0x0a]), Buffer.from([uri.length]), uri]);
}
function writeSession(id: string, cwd: string, transcript?: string) {
  mkdirSync(join(dir, 'conversations'), { recursive: true });
  writeFileSync(join(dir, 'conversations', `${id}.db`), dbFor(`file:///${cwd.replace(/\\/g, '/').replace(/^([A-Z]):/, (_m, d) => d.toLowerCase() + ':')}`));
  if (transcript !== undefined) {
    const logs = join(dir, 'brain', id, '.system_generated', 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'transcript.jsonl'), transcript);
  }
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agy-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('antigravitySessions', () => {
  it('antigravityAvailable is true only when conversations/ exists', () => {
    expect(antigravityAvailable(dir)).toBe(false);
    mkdirSync(join(dir, 'conversations'));
    expect(antigravityAvailable(dir)).toBe(true);
  });

  it('lists only sessions whose cwd matches the project, newest-first', () => {
    writeSession('11111111-1111-1111-1111-111111111111', 'C:\\proj\\a');
    writeSession('22222222-2222-2222-2222-222222222222', 'C:\\proj\\b');
    const out = listAntigravitySessions('C:\\proj\\a', dir);
    expect(out.map((s) => s.id)).toEqual(['11111111-1111-1111-1111-111111111111']);
  });

  it('reads first message from the transcript when present', () => {
    const tr = JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>hello agy</USER_REQUEST>' });
    writeSession('33333333-3333-3333-3333-333333333333', 'C:\\proj\\a', tr);
    const out = listAntigravitySessions('C:\\proj\\a', dir);
    expect(out[0].firstMessage).toBe('hello agy');
  });

  it('lastUserMessageForAntigravitySession reads the transcript tail; null when no transcript', () => {
    const tr = [
      JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>one</USER_REQUEST>' }),
      JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>two</USER_REQUEST>' }),
    ].join('\n');
    writeSession('44444444-4444-4444-4444-444444444444', 'C:\\proj\\a', tr);
    writeSession('55555555-5555-5555-5555-555555555555', 'C:\\proj\\a'); // no transcript
    expect(lastUserMessageForAntigravitySession('C:\\proj\\a', '44444444-4444-4444-4444-444444444444', dir)).toBe('two');
    expect(lastUserMessageForAntigravitySession('C:\\proj\\a', '55555555-5555-5555-5555-555555555555', dir)).toBeNull();
  });
});
