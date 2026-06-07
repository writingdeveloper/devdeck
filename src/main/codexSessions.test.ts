import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listCodexSessions, lastUserMessageForCodexSession, codexAvailable } from './codexSessions';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'devdeck-codex-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const rollout = (id: string, cwd: string, msgs: string[]) => [
  JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp: '2026-06-06T00:00:00Z' } }),
  ...msgs.map((m) => JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: m } })),
].join('\n');

function writeRollout(day: string, id: string, cwd: string, msgs: string[], mtime: number) {
  const dir = join(root, day); mkdirSync(dir, { recursive: true });
  const f = join(dir, `rollout-${id}.jsonl`);
  writeFileSync(f, rollout(id, cwd, msgs));
  utimesSync(f, mtime, mtime);
}

describe('listCodexSessions', () => {
  it('returns sessions for a cwd, newest-first, with first message', () => {
    writeRollout('2026/06/06', 'a0b1c2d3-e4f5-6789-abcd-ef0123450001', 'C:\\g\\app', ['older'], 1000);
    writeRollout('2026/06/06', 'a0b1c2d3-e4f5-6789-abcd-ef0123450002', 'C:\\g\\app', ['newer one', 'and more'], 2000);
    writeRollout('2026/06/06', 'a0b1c2d3-e4f5-6789-abcd-ef0123450003', 'C:\\g\\other', ['elsewhere'], 3000);
    const out = listCodexSessions('C:\\g\\app', root);
    expect(out.map((s) => s.id)).toEqual([
      'a0b1c2d3-e4f5-6789-abcd-ef0123450002', 'a0b1c2d3-e4f5-6789-abcd-ef0123450001',
    ]);
    expect(out[0].firstMessage).toBe('newer one');
  });
  it('returns [] for an unknown cwd or missing dir', () => {
    expect(listCodexSessions('C:\\g\\none', root)).toEqual([]);
    expect(listCodexSessions('C:\\g\\none', join(root, 'nope'))).toEqual([]);
  });
});

describe('lastUserMessageForCodexSession', () => {
  it('returns the last user message of the matching session', () => {
    writeRollout('2026/06/06', 'a0b1c2d3-e4f5-6789-abcd-ef0123450009', 'C:\\g\\app', ['first', 'resume this'], 1000);
    expect(lastUserMessageForCodexSession('C:\\g\\app', 'a0b1c2d3-e4f5-6789-abcd-ef0123450009', root)).toBe('resume this');
  });
  it('returns null for an unknown id', () => {
    expect(lastUserMessageForCodexSession('C:\\g\\app', 'a0b1c2d3-e4f5-6789-abcd-ef0123450099', root)).toBeNull();
  });
  it('finds the last user message past a multi-MB trailing agent turn', () => {
    // Real rollouts can be multi-MB and the last user message sits hundreds of KB
    // before EOF (a long autonomous agent turn follows it) — a small fixed tail misses it.
    const id = 'a0b1c2d3-e4f5-6789-abcd-ef0123450010';
    const huge = 'x'.repeat(700 * 1024);
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: { id, cwd: 'C:\\g\\app', timestamp: '2026-06-06T00:00:00Z' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'resume from here' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: huge } }),
    ].join('\n');
    const dir = join(root, '2026/06/06'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-${id}.jsonl`), lines);
    expect(lastUserMessageForCodexSession('C:\\g\\app', id, root)).toBe('resume from here');
  });
});

describe('codexAvailable', () => {
  it('true when the sessions dir exists, false otherwise', () => {
    expect(codexAvailable(root)).toBe(true);
    expect(codexAvailable(join(root, 'nope'))).toBe(false);
  });
});
