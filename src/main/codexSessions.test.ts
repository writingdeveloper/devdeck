import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  codexAvailable,
  lastUserMessageForCodexSession,
  listCodexSessionIds,
  listCodexSessionStats,
  listCodexSessions,
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

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'devdeck-codex-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

describe('codexSessions', () => {
  it('detects the rollout directory and lists only exact-project sessions newest-first', () => {
    const oldFile = writeRollout(`rollout-${OLD_ID}.jsonl`, rollout(OLD_ID, PROJECT));
    const newFile = writeRollout(`rollout-${NEW_ID}.jsonl`, rollout(NEW_ID, PROJECT));
    writeRollout(`rollout-${OTHER_ID}.jsonl`, rollout(OTHER_ID, OTHER_PROJECT));
    writeRollout('not-a-rollout.jsonl', rollout('44444444-4444-4444-4444-444444444444', PROJECT));
    utimesSync(oldFile, 1000, 1000);
    utimesSync(newFile, 2000, 2000);

    expect(codexAvailable(dir)).toBe(true);
    expect(listCodexSessions(PROJECT, dir).map((s) => s.id)).toEqual([NEW_ID, OLD_ID]);
    expect(listCodexSessions(PROJECT, dir)[0]).toMatchObject({ id: NEW_ID, mtimeMs: 2_000_000, firstMessage: `first ${NEW_ID}` });
  });

  it('uses a default limit, while ids include every matching rollout', () => {
    const ids = Array.from({ length: 7 }, (_v, index) => `a0b1c2d3-e4f5-0000-0000-00000000000${index}`);
    for (const [index, id] of ids.entries()) {
      const file = writeRollout(`rollout-${id}.jsonl`, rollout(id, PROJECT));
      utimesSync(file, 1000 + index, 1000 + index);
    }

    expect(listCodexSessions(PROJECT, dir)).toHaveLength(5);
    expect(listCodexSessions(PROJECT, dir, 3)).toHaveLength(3);
    expect(listCodexSessionIds(PROJECT, dir)).toEqual([...ids].reverse());
  });

  it('returns mtime and birthtime stats only for exact matching sessions', () => {
    const file = writeRollout(`rollout-${NEW_ID}.jsonl`, rollout(NEW_ID, PROJECT));
    writeRollout(`rollout-${OTHER_ID}.jsonl`, rollout(OTHER_ID, OTHER_PROJECT));
    utimesSync(file, 3000, 3000);

    const stats = listCodexSessionStats(PROJECT, dir);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ id: NEW_ID, mtimeMs: 3_000_000 });
    expect(stats[0].birthtimeMs).toBeGreaterThan(0);
  });

  it('ignores malformed headers and invalid ids and tolerates missing directories', () => {
    writeRollout('rollout-badbadbad.jsonl', '{');
    writeRollout('rollout-$(evil).jsonl', rollout('$(evil)', PROJECT));
    expect(codexAvailable(join(dir, 'missing'))).toBe(false);
    expect(listCodexSessions(PROJECT, join(dir, 'missing'))).toEqual([]);
    expect(listCodexSessionIds(PROJECT, dir)).toEqual([]);
    expect(listCodexSessionStats(PROJECT, dir)).toEqual([]);
    expect(lastUserMessageForCodexSession(PROJECT, '$(evil)', dir)).toBeNull();
  });

  it('finds a user message before an 800 KiB trailing agent event', () => {
    const tail = JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(800 * 1024) } });
    writeRollout(`rollout-${NEW_ID}.jsonl`, rollout(NEW_ID, PROJECT, [user('resume the codex rollout'), tail]));

    expect(lastUserMessageForCodexSession(PROJECT, NEW_ID, dir)).toBe('resume the codex rollout');
    expect(lastUserMessageForCodexSession(OTHER_PROJECT, NEW_ID, dir)).toBeNull();
  });
});
