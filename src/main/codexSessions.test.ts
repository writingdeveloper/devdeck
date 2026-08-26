import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  codexAvailable,
  lastUserMessageForCodexSession,
  listCodexSessionIds,
  listCodexSessionStats,
  listCodexSessions,
  readCodexSessionMeta,
  emptyCodexMeta,
  listCodexRolloutHeads,
  _clearCodexHeadCache,
} from './codexSessions';

let dir: string;
const PROJECT = 'C:\\repo\\devdeck';
const OTHER_PROJECT = 'C:\\repo\\other';
const OLD_ID = '11111111-1111-1111-1111-111111111111';
const NEW_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_ID = '33333333-3333-3333-3333-333333333333';

const meta = (id: string, cwd: string) => JSON.stringify({ type: 'session_meta', payload: { id, cwd } });
const user = (message: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message } });

function rollout(id: string, cwd: string, lines: string[] = [user(`first ${id}`)]): string {
  return [meta(id, cwd), ...lines].join('\n');
}

function writeRollout(name: string, body: string): string {
  const path = join(dir, '2026', '07', '23', name);
  mkdirSync(join(dir, '2026', '07', '23'), { recursive: true });
  writeFileSync(path, body);
  return path;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'devdeck-codex-')); _clearCodexHeadCache(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

describe('codexSessions', () => {
  it('detects the rollout directory and lists only exact-project sessions newest-first', async () => {
    const oldFile = writeRollout(`rollout-${OLD_ID}.jsonl`, rollout(OLD_ID, PROJECT));
    const newFile = writeRollout(`rollout-${NEW_ID}.jsonl`, rollout(NEW_ID, PROJECT));
    writeRollout(`rollout-${OTHER_ID}.jsonl`, rollout(OTHER_ID, OTHER_PROJECT));
    writeRollout('not-a-rollout.jsonl', rollout('44444444-4444-4444-4444-444444444444', PROJECT));
    utimesSync(oldFile, 1000, 1000);
    utimesSync(newFile, 2000, 2000);

    expect(codexAvailable(dir)).toBe(true);
    expect((await listCodexSessions(PROJECT, dir)).map((s) => s.id)).toEqual([NEW_ID, OLD_ID]);
    expect((await listCodexSessions(PROJECT, dir))[0]).toMatchObject({ id: NEW_ID, mtimeMs: 2_000_000, firstMessage: `first ${NEW_ID}` });
  });

  it('uses a default limit, while ids include every matching rollout', async () => {
    const ids = Array.from({ length: 7 }, (_v, index) => `a0b1c2d3-e4f5-0000-0000-00000000000${index}`);
    for (const [index, id] of ids.entries()) {
      const file = writeRollout(`rollout-${id}.jsonl`, rollout(id, PROJECT));
      utimesSync(file, 1000 + index, 1000 + index);
    }

    expect(await listCodexSessions(PROJECT, dir)).toHaveLength(5);
    expect(await listCodexSessions(PROJECT, dir, 3)).toHaveLength(3);
    expect(await listCodexSessionIds(PROJECT, dir)).toEqual([...ids].reverse());
  });

  it('returns mtime and birthtime stats only for exact matching sessions', async () => {
    const file = writeRollout(`rollout-${NEW_ID}.jsonl`, rollout(NEW_ID, PROJECT));
    writeRollout(`rollout-${OTHER_ID}.jsonl`, rollout(OTHER_ID, OTHER_PROJECT));
    utimesSync(file, 3000, 3000);

    const stats = await listCodexSessionStats(PROJECT, dir);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ id: NEW_ID, mtimeMs: 3_000_000 });
    expect(stats[0].birthtimeMs).toBeGreaterThan(0);
  });

  it('exposes validated bounded rollout metadata for local analytics', async () => {
    const file = writeRollout(`rollout-${NEW_ID}.jsonl`, rollout(NEW_ID, PROJECT));
    writeRollout('rollout-badbadbad.jsonl', '{');
    writeRollout('not-a-rollout.jsonl', rollout(OTHER_ID, OTHER_PROJECT));
    utimesSync(file, 3000, 3000);

    const heads = await listCodexRolloutHeads(dir);
    expect(heads).toHaveLength(1);
    expect(heads[0]).toMatchObject({ file, id: NEW_ID, cwd: PROJECT, mtimeMs: 3_000_000 });
    expect(heads[0].size).toBe(Buffer.byteLength(rollout(NEW_ID, PROJECT)));
    expect(heads[0].birthtimeMs).toBeGreaterThan(0);
  });

  it('ignores malformed headers and invalid ids and tolerates missing directories', async () => {
    writeRollout('rollout-badbadbad.jsonl', '{');
    writeRollout('rollout-$(evil).jsonl', rollout('$(evil)', PROJECT));
    expect(codexAvailable(join(dir, 'missing'))).toBe(false);
    expect(await listCodexSessions(PROJECT, join(dir, 'missing'))).toEqual([]);
    expect(await listCodexSessionIds(PROJECT, dir)).toEqual([]);
    expect(await listCodexSessionStats(PROJECT, dir)).toEqual([]);
    expect(await lastUserMessageForCodexSession(PROJECT, '$(evil)', dir)).toBeNull();
  });

  it('finds a user message before an 800 KiB trailing agent event', async () => {
    const tail = JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(800 * 1024) } });
    writeRollout(`rollout-${NEW_ID}.jsonl`, rollout(NEW_ID, PROJECT, [user('resume the codex rollout'), tail]));

    expect(await lastUserMessageForCodexSession(PROJECT, NEW_ID, dir)).toBe('resume the codex rollout');
    expect(await lastUserMessageForCodexSession(OTHER_PROJECT, NEW_ID, dir)).toBeNull();
  });
});

describe('readCodexSessionMeta', () => {
  const patch = (files: string[]) => JSON.stringify({
    type: 'event_msg',
    payload: { type: 'patch_apply_end', changes: Object.fromEntries(files.map((f) => [f, { type: 'update' }])) },
  });
  const done = (message: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: message } });

  it('reads the summary sources of a matching session, with the rollout mtime', async () => {
    const file = writeRollout(`rollout-${NEW_ID}.jsonl`, rollout(NEW_ID, PROJECT, [
      user('요약 붙여줘'), patch(['C:\\repo\\devdeck\\src\\store.ts']), done('설정 저장 로직을 정리했습니다'),
    ]));
    utimesSync(file, 4000, 4000);

    const out = await readCodexSessionMeta(PROJECT, NEW_ID, dir);
    expect(out).toEqual({
      assistantText: '설정 저장 로직을 정리했습니다',
      editedFiles: ['store.ts'],
      userText: '요약 붙여줘',
      model: null,
      contextTokens: 0,
      contextWindow: 0,
      mtimeMs: 4000 * 1000,
    });
  });

  it('refuses a crafted id, another project\'s session, and a missing store', async () => {
    writeRollout(`rollout-${NEW_ID}.jsonl`, rollout(NEW_ID, PROJECT, [done('한 일')]));
    expect(await readCodexSessionMeta(PROJECT, '$(evil)', dir)).toEqual(emptyCodexMeta());
    expect(await readCodexSessionMeta(OTHER_PROJECT, NEW_ID, dir)).toEqual(emptyCodexMeta());
    expect(await readCodexSessionMeta(PROJECT, NEW_ID, join(dir, 'missing'))).toEqual(emptyCodexMeta());
  });

  // Rollouts reach multiple GB, so only the tail is read — a summary must still come out of one.
  it('reads only the tail of a large rollout', async () => {
    const filler = JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'y'.repeat(200 * 1024) } });
    const lines = [user('오래된 요청'), ...Array.from({ length: 20 }, () => filler), done('마지막 보고입니다')];
    writeRollout(`rollout-${NEW_ID}.jsonl`, rollout(NEW_ID, PROJECT, lines));

    const out = await readCodexSessionMeta(PROJECT, NEW_ID, dir);
    expect(out.assistantText).toBe('마지막 보고입니다');
    expect(out.mtimeMs).toBeGreaterThan(0);
  });
});

describe('the head cache', () => {
  // Codex's store is FLAT: answering anything about one session means reading the head of every
  // rollout on the machine. Measured on the machine this was reported from: 5,044 rollouts, 315 MB
  // read on every pass, 1.73 seconds during which the main process replied to nothing. A head is
  // written once and only appended to after that, so a file whose size, mtime and birthtime are all
  // unchanged cannot have a different one.
  it('does not re-read a head whose file has not changed', async () => {
    // Rewrite the head to name a DIFFERENT project, then put back the exact length and timestamps
    // the cache recorded. Nothing observable about the file changed, so nothing may be re-read — and
    // the answer must still be the old one. (No real rollout rewrites its own head; this is how
    // "was that file read a second time" is made visible to a test.)
    const SAME_LENGTH = PROJECT.slice(0, -7) + 'devDECK'; // same bytes on disk, different value
    expect(SAME_LENGTH).toHaveLength(PROJECT.length);
    expect(SAME_LENGTH).not.toBe(PROJECT);
    const file = writeRollout(`rollout-${NEW_ID}.jsonl`, rollout(NEW_ID, PROJECT));
    const stamp = new Date(1_700_000_000_000);
    utimesSync(file, stamp, stamp);
    expect((await listCodexRolloutHeads(dir))[0]).toMatchObject({ cwd: PROJECT });

    writeFileSync(file, rollout(NEW_ID, SAME_LENGTH));
    utimesSync(file, stamp, stamp);
    expect((await listCodexRolloutHeads(dir))[0]).toMatchObject({ cwd: PROJECT });
  });

  it('re-reads once the file actually changes', async () => {
    // An append moves mtime and size; the cached head must not survive that, or a session written
    // after the scan would keep answering with whatever the store looked like before it existed.
    const file = writeRollout(`rollout-${NEW_ID}.jsonl`, rollout(NEW_ID, PROJECT));
    expect((await listCodexRolloutHeads(dir))[0]).toMatchObject({ cwd: PROJECT });
    writeFileSync(file, rollout(NEW_ID, OTHER_PROJECT, [user('a longer first message than before')]));
    expect((await listCodexRolloutHeads(dir))[0]).toMatchObject({ cwd: OTHER_PROJECT });
  });

  it('forgets a rollout that has been deleted', async () => {
    // Otherwise the cache only ever grows, on a store that reaches five thousand files.
    const file = writeRollout(`rollout-${NEW_ID}.jsonl`, rollout(NEW_ID, PROJECT));
    expect(await listCodexRolloutHeads(dir)).toHaveLength(1);
    rmSync(file);
    expect(await listCodexRolloutHeads(dir)).toEqual([]);
  });

  it('remembers a file it could not parse, so it is not re-read either', async () => {
    // A stray file in the store is still 64 KiB of reading per pass if nothing remembers the verdict.
    writeRollout(`rollout-${NEW_ID}.jsonl`, 'not json at all');
    expect(await listCodexRolloutHeads(dir)).toEqual([]);
    expect(await listCodexRolloutHeads(dir)).toEqual([]);
  });
});
