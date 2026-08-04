import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readActiveTaskForm, TASK_STALE_MS } from './claudeTasks';

const SID = 'a0b1c2d3-e4f5-6789-abcd-ef0123456789';
let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'devdeck-tasks-')); });
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

function writeTasks(sessionId: string, tasks: Record<string, object>, ageMs = 0): void {
  const dir = join(root, sessionId);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(tasks)) {
    const f = join(dir, name);
    writeFileSync(f, JSON.stringify(body));
    if (ageMs) { const t = (Date.now() - ageMs) / 1000; utimesSync(f, t, t); }
  }
}

describe('readActiveTaskForm', () => {
  it('returns the in-progress task activeForm', () => {
    writeTasks(SID, {
      '1.json': { subject: 'Explore', activeForm: 'Exploring', status: 'completed' },
      '2.json': { subject: 'Play Console 배포', activeForm: 'Play Console 배포 중', status: 'in_progress' },
      '3.json': { subject: 'Verify', activeForm: 'Verifying', status: 'pending' },
    });
    expect(readActiveTaskForm(SID, root)).toBe('Play Console 배포 중');
  });

  it('picks the lowest-numbered in-progress task (10.json sorts after 2.json)', () => {
    writeTasks(SID, {
      '2.json': { activeForm: 'first', status: 'in_progress' },
      '10.json': { activeForm: 'second', status: 'in_progress' },
    });
    expect(readActiveTaskForm(SID, root)).toBe('first');
  });

  it('falls back to subject when activeForm is missing or blank', () => {
    writeTasks(SID, { '1.json': { subject: '릴리스 준비', activeForm: '   ', status: 'in_progress' } });
    expect(readActiveTaskForm(SID, root)).toBe('릴리스 준비');
  });

  it('returns null when nothing is in progress', () => {
    writeTasks(SID, { '1.json': { activeForm: 'done thing', status: 'completed' } });
    expect(readActiveTaskForm(SID, root)).toBeNull();
  });

  it('ignores a task file left far behind the session log (abandoned run)', () => {
    writeTasks(SID, { '1.json': { activeForm: '옛날 작업 중', status: 'in_progress' } }, TASK_STALE_MS + 60_000);
    expect(readActiveTaskForm(SID, root, Date.now())).toBeNull();
    // …but the same file counts as live when the log itself is that old (both sat idle together).
    expect(readActiveTaskForm(SID, root, Date.now() - TASK_STALE_MS - 120_000)).toBe('옛날 작업 중');
  });

  it('skips unreadable/half-written files instead of giving up on the list', () => {
    writeTasks(SID, { '1.json': { activeForm: 'x', status: 'in_progress' } });
    writeFileSync(join(root, SID, '0.json'), '{ not json');
    expect(readActiveTaskForm(SID, root)).toBe('x');
  });

  it('returns null for a missing directory and rejects a crafted session id', () => {
    expect(readActiveTaskForm(SID, root)).toBeNull(); // nothing written for this session
    writeTasks('..', { '1.json': { activeForm: 'escaped', status: 'in_progress' } });
    expect(readActiveTaskForm('..', root)).toBeNull();
    expect(readActiveTaskForm('../..', root)).toBeNull();
    expect(readActiveTaskForm('', root)).toBeNull();
  });
});
