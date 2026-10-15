import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store';
import type { Todo } from '../shared/tasks';

let dir: string, file: string, store: Store;
const task = (id: string): Todo => ({ id, text: `Task ${id}`, done: false, due: null, createdAt: '2026-09-08T00:00:00Z' });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'devdeck-cas-')); file = join(dir, 'state.json'); store = new Store(file); });
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

describe('task compare-and-save', () => {
  it('migrates an existing list without a revision, without losing tasks', () => {
    writeFileSync(file, JSON.stringify({ projects: { repo: { todos: [task('A')] } } }));
    store = new Store(file);
    expect(store.get('repo').todosRevision).toBe(0);
    const saved = store.saveTodos('repo', [task('A'), task('B')], 0);
    expect(saved).toEqual({ ok: true, todos: [task('A'), task('B')], revision: 1 });
    expect(new Store(file).get('repo').todosRevision).toBe(1);
  });
  it('rejects a stale second writer and returns the committed snapshot', () => {
    store.saveTodos('repo', [task('A'), task('B')], 0);
    const a = store.get('repo'), b = store.get('repo');
    a.todos[0].done = true; b.todos[1].done = true;
    expect(store.saveTodos('repo', a.todos, a.todosRevision!).ok).toBe(true);
    const before = readFileSync(file, 'utf8');
    const conflict = store.saveTodos('repo', b.todos, b.todosRevision!);
    expect(conflict.ok).toBe(false);
    expect(conflict.todos.map(t => t.done)).toEqual([true, false]);
    expect(readFileSync(file, 'utf8')).toBe(before);
    conflict.todos[1].done = true; // explicit review/retry uses the latest snapshot
    expect(store.saveTodos('repo', conflict.todos, conflict.revision).ok).toBe(true);
    expect(new Store(file).getTodos('repo').map(t => t.done)).toEqual([true, true]);
  });
  it('rolls back both revision and tasks on disk failure and accepts retry', () => {
    store.saveTodos('repo', [task('A')], 0);
    mkdirSync(file + '.tmp');
    expect(() => store.saveTodos('repo', [task('B')], 1)).toThrow();
    expect(store.get('repo').todosRevision).toBe(1);
    expect(store.getTodos('repo')).toEqual([task('A')]);
    rmSync(file + '.tmp', { recursive: true });
    expect(store.saveTodos('repo', [task('B')], 1).revision).toBe(2);
  });
  it('does not invalidate a task snapshot when a note changes', () => {
    store.saveTodos('repo', [task('A')], 0);
    store.setNote('repo', 'note');
    expect(store.saveTodos('repo', [task('B')], 1).ok).toBe(true);
    expect(store.get('repo').note).toBe('note');
  });
  it('does not advance a revision for a no-op', () => {
    store.saveTodos('repo', [task('A')], 0);
    expect(store.saveTodos('repo', [task('A')], 1).revision).toBe(1);
  });
  it.each([undefined, null, -1, 0.5, NaN, Infinity, '0'])('refuses an invalid revision %s', revision => {
    expect(() => store.saveTodos('repo', [task('A')], revision as number)).toThrow('TASKS_INVALID_REVISION');
  });
  it('refuses over-cap and non-array writes instead of reporting a lost new task as saved', () => {
    expect(() => store.saveTodos('repo', Array.from({ length: 201 }, (_, i) => task(String(i))), 0)).toThrow('TASKS_INVALID_LIST');
    expect(() => store.saveTodos('repo', null, 0)).toThrow('TASKS_INVALID_LIST');
    expect(store.getTodos('repo')).toEqual([]);
  });
});
