import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from 'node:fs/promises';
import { listSessions, lastUserMessageForSession, listSessionIds, listSessionStats, findInTail } from './sessions';
import { lastUserMessage } from '../shared/sessionParse';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'devdeck-sess-')); });
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })); // retry: Windows file-handle release race → ENOTEMPTY

const userLine = (text: string) => JSON.stringify({ type: 'user', message: { content: text } });

describe('listSessions', async () => {
  it('returns sessions newest-first with id, mtime, and first message', async () => {
    const enc = 'C--g-proj';
    const d = join(root, enc);
    mkdirSync(d, { recursive: true });
    const olderId = 'a0b1c2d3-e4f5-6789-abcd-ef0123456789';
    const newerId = 'a0b1c2d3-e4f5-6789-abcd-ef0123456790';
    writeFileSync(join(d, `${olderId}.jsonl`), userLine('older work'));
    writeFileSync(join(d, `${newerId}.jsonl`), userLine('newer work'));
    utimesSync(join(d, `${olderId}.jsonl`), 1000, 1000);
    utimesSync(join(d, `${newerId}.jsonl`), 2000, 2000);

    const out = await listSessions('C:\\g\\proj', root);
    expect(out.map((s) => s.id)).toEqual([newerId, olderId]);
    expect(out[0]).toMatchObject({ id: newerId, mtimeMs: 2000 * 1000, firstMessage: 'newer work' });
  });

  it('respects the limit', async () => {
    const d = join(root, 'C--g-proj2');
    mkdirSync(d, { recursive: true });
    for (let i = 0; i < 7; i++) {
      const f = join(d, `a0b1c2d3-e4f5-0000-0000-00000000000${i}.jsonl`);
      writeFileSync(f, userLine(`m${i}`));
      utimesSync(f, 1000 + i, 1000 + i);
    }
    expect(await listSessions('C:\\g\\proj2', root, 3)).toHaveLength(3);
  });

  it('returns [] when the session dir is missing', async () => {
    expect(await listSessions('C:\\g\\missing', root)).toEqual([]);
  });
});

describe('listSessions sessionId filtering', async () => {
  it('accepts UUID-ish ids', async () => {
    const enc = 'C--g-filter';
    const d = join(root, enc);
    mkdirSync(d, { recursive: true });
    const validId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    writeFileSync(join(d, `${validId}.jsonl`), userLine('valid'));
    const out = await listSessions('C:\\g\\filter', root);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(validId);
  });

  it('rejects ids with shell metacharacters or too short', async () => {
    const enc = 'C--g-filter2';
    const d = join(root, enc);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '$(evil).jsonl'), userLine('bad'));
    writeFileSync(join(d, 'short.jsonl'), userLine('bad'));
    writeFileSync(join(d, 'nothex-zz.jsonl'), userLine('bad'));
    const out = await listSessions('C:\\g\\filter2', root);
    expect(out).toHaveLength(0);
  });
});

describe('lastUserMessageForSession', async () => {
  it('returns the last genuine user message from the session tail', async () => {
    const d = join(root, 'C--g-cue');
    mkdirSync(d, { recursive: true });
    const id = 'a0b1c2d3-e4f5-6789-abcd-ef0123456789';
    const jsonl = [
      JSON.stringify({ type: 'user', message: { content: 'old prompt' } }),
      JSON.stringify({ type: 'user', message: { content: 'pick up the rail refactor' } }),
      JSON.stringify({ type: 'assistant', message: { content: 'done' } }),
    ].join('\n');
    writeFileSync(join(d, `${id}.jsonl`), jsonl);
    expect(await lastUserMessageForSession('C:\\g\\cue', id, root)).toBe('pick up the rail refactor');
  });

  it('returns null for a missing file or invalid session id', async () => {
    expect(await lastUserMessageForSession('C:\\g\\cue', 'a0b1c2d3-e4f5-6789-abcd-ef0123456789', root)).toBeNull();
    expect(await lastUserMessageForSession('C:\\g\\cue', '$(evil)', root)).toBeNull();
  });

  it('finds the last user message even when it is beyond the first tail chunk', async () => {
    const d = join(root, 'C--g-big');
    mkdirSync(d, { recursive: true });
    const id = 'a0b1c2d3-e4f5-6789-abcd-ef0123456789';
    const target = 'resume THIS specific work';
    const lines = [JSON.stringify({ type: 'user', message: { content: target } })];
    // ~1.3MB of trailing assistant content (> the 1MB chunk) after the last user message.
    const filler = 'x'.repeat(2000);
    for (let i = 0; i < 650; i++) lines.push(JSON.stringify({ type: 'assistant', message: { content: filler } }));
    writeFileSync(join(d, `${id}.jsonl`), lines.join('\n'));
    expect(await lastUserMessageForSession('C:\\g\\big', id, root)).toBe(target);
  });

  // The cue is cached per file on (size, mtime) — the deck asks for it every refresh — so it has to
  // move the moment the session does.
  it('answers again after the session is appended to', async () => {
    const d = join(root, 'C--g-grow');
    mkdirSync(d, { recursive: true });
    const id = 'a0b1c2d3-e4f5-6789-abcd-ef0123456789';
    const file = join(d, `${id}.jsonl`);
    writeFileSync(file, userLine('first ask') + '\n');
    expect(await lastUserMessageForSession('C:\\g\\grow', id, root)).toBe('first ask');
    expect(await lastUserMessageForSession('C:\\g\\grow', id, root)).toBe('first ask');
    appendFileSync(file, userLine('second ask') + '\n');
    expect(await lastUserMessageForSession('C:\\g\\grow', id, root)).toBe('second ask');
  });
});

describe('findInTail', () => {
  /** The loop findInTail replaced: re-decode and re-search the whole accumulated tail on every read. */
  async function reference(file: string, maxBytes: number, chunk: number): Promise<string | null> {
    const handle = await open(file, 'r');
    try {
      const size = (await handle.stat()).size;
      let pos = size;
      let acc = Buffer.alloc(0);
      while (pos > 0 && size - pos < maxBytes) {
        const len = Math.min(chunk, pos);
        pos -= len;
        const buf = Buffer.alloc(len);
        await handle.read(buf, 0, len, pos);
        acc = Buffer.concat([buf, acc]);
        const text = acc.toString('utf8');
        const nl = text.indexOf('\n');
        const body = pos === 0 ? text : nl < 0 ? '' : text.slice(nl + 1);
        const found = lastUserMessage(body);
        if (found) return found;
      }
      return null;
    } finally { await handle.close(); }
  }

  it('gives the same answer as re-searching the whole tail, for any chunk size and cap', async () => {
    let seed = 1;
    const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const assistant = (n: number) => JSON.stringify({ type: 'assistant', message: { content: '가나다 abc '.repeat(n) } });
    for (let trial = 0; trial < 40; trial++) {
      const lines: string[] = [];
      const count = 1 + Math.floor(rnd() * 30);
      for (let i = 0; i < count; i++) {
        lines.push(rnd() < 0.15 ? userLine(`ask ${trial}-${i} 한글`) : assistant(Math.floor(rnd() * 60)));
      }
      const file = join(root, `t${trial}.jsonl`);
      writeFileSync(file, lines.join('\n') + (rnd() < 0.5 ? '\n' : ''));
      for (const chunk of [7, 64, 333, 4096]) {
        for (const maxBytes of [50, 1000, 1 << 30]) {
          const handle = await open(file, 'r');
          try {
            const size = (await handle.stat()).size;
            const got = await findInTail(handle, size, maxBytes, chunk, lastUserMessage);
            expect(got, `trial ${trial} chunk ${chunk} cap ${maxBytes}`).toBe(await reference(file, maxBytes, chunk));
          } finally { await handle.close(); }
        }
      }
    }
  });
});

describe('listSessionIds / listSessionStats', () => {
  it('lists valid session files newest-first with their stats, and nothing for a missing dir', async () => {
    const d = join(root, 'C--g-stats');
    mkdirSync(d, { recursive: true });
    const a = 'a0b1c2d3-e4f5-6789-abcd-ef0123456780';
    const b = 'a0b1c2d3-e4f5-6789-abcd-ef0123456781';
    writeFileSync(join(d, `${a}.jsonl`), userLine('a'));
    writeFileSync(join(d, `${b}.jsonl`), userLine('b'));
    writeFileSync(join(d, '$(evil).jsonl'), userLine('bad'));
    writeFileSync(join(d, `${a}.txt`), 'not a session');
    utimesSync(join(d, `${a}.jsonl`), 1000, 1000);
    utimesSync(join(d, `${b}.jsonl`), 2000, 2000);
    expect(await listSessionIds('C:\\g\\stats', root)).toEqual([b, a]);
    const stats = await listSessionStats('C:\\g\\stats', root);
    expect(stats.map((s) => s.id).sort()).toEqual([a, b]);
    expect(stats.find((s) => s.id === a)).toMatchObject({ mtimeMs: 1_000_000 });
    expect(stats[0].birthtimeMs).toBeGreaterThan(0);
    expect(await listSessionIds('C:\\g\\none', root)).toEqual([]);
    expect(await listSessionStats('C:\\g\\none', root)).toEqual([]);
  });
});
