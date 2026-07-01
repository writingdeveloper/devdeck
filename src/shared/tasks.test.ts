import { describe, it, expect } from 'vitest';
import {
  classifyDue, groupTasksByDue, taskCounts,
  addTodo, toggleTodo, editTodoText, setTodoDue, removeTodo, sanitizeTodos,
  type Todo, type TaskWithProject,
} from './tasks';

// Local-time anchor: 2026-07-01 (Wed) 15:00 local — a due "today" late in the day must still be 'today'.
const NOW = new Date(2026, 6, 1, 15, 0, 0).getTime();
function todo(over: Partial<Todo> = {}): Todo {
  return { id: 'x', text: 't', done: false, due: null, createdAt: '2026-06-01T00:00:00.000Z', ...over };
}

describe('classifyDue', () => {
  it('null / malformed / impossible date => none', () => {
    expect(classifyDue(null, NOW)).toBe('none');
    expect(classifyDue('not-a-date', NOW)).toBe('none');
    expect(classifyDue('2026-02-30', NOW)).toBe('none'); // Feb 30 doesn't exist
  });
  it('past day => overdue', () => {
    expect(classifyDue('2026-06-30', NOW)).toBe('overdue');
  });
  it('same local day => today even at 3pm', () => {
    expect(classifyDue('2026-07-01', NOW)).toBe('today');
  });
  it('within the next 7 days (inclusive) => week; +7 boundary is still week', () => {
    expect(classifyDue('2026-07-02', NOW)).toBe('week');
    expect(classifyDue('2026-07-08', NOW)).toBe('week'); // today+7
  });
  it('beyond 7 days => later', () => {
    expect(classifyDue('2026-07-09', NOW)).toBe('later'); // today+8
  });
});

describe('groupTasksByDue', () => {
  const p = (todoOver: Partial<Todo>, name = 'proj'): TaskWithProject =>
    ({ todo: todo(todoOver), projectPath: 'C:\\g\\' + name, projectName: name });
  it('returns only non-empty groups in fixed order, incomplete-only, sorted by due then createdAt', () => {
    const items: TaskWithProject[] = [
      p({ id: 'a', due: '2026-07-09', createdAt: '2026-06-01T00:00:00Z' }),   // later
      p({ id: 'b', due: '2026-06-30' }),                                       // overdue
      p({ id: 'c', due: null }),                                               // none
      p({ id: 'd', due: '2026-07-01' }),                                       // today
      p({ id: 'e', due: '2026-07-03', createdAt: '2026-06-02T00:00:00Z' }),    // week (later createdAt)
      p({ id: 'f', due: '2026-07-03', createdAt: '2026-06-01T00:00:00Z' }),    // week (earlier createdAt → first)
      p({ id: 'g', done: true, due: '2026-06-30' }),                           // done → excluded
    ];
    const groups = groupTasksByDue(items, NOW);
    expect(groups.map((g) => g.bucket)).toEqual(['overdue', 'today', 'week', 'later', 'none']);
    expect(groups.find((g) => g.bucket === 'week')!.items.map((i) => i.todo.id)).toEqual(['f', 'e']);
    expect(groups.flatMap((g) => g.items).some((i) => i.todo.id === 'g')).toBe(false); // done excluded
  });
  it('empty when there are no incomplete tasks', () => {
    expect(groupTasksByDue([p({ done: true })], NOW)).toEqual([]);
  });
});

describe('taskCounts', () => {
  it('counts total/done/open/overdue (overdue = incomplete + past due)', () => {
    const todos = [
      todo({ id: '1', done: true }),
      todo({ id: '2', due: '2026-06-30' }),          // open, overdue
      todo({ id: '3', due: '2026-07-05' }),          // open, not overdue
      todo({ id: '4', done: true, due: '2026-06-01' }), // done → not counted overdue
    ];
    expect(taskCounts(todos, NOW)).toEqual({ total: 4, done: 2, open: 2, overdue: 1 });
  });
});

describe('reducers (pure/immutable)', () => {
  it('addTodo appends a new todo without mutating the input', () => {
    const before: Todo[] = [];
    const after = addTodo(before, '  buy milk  ', 'id1', '2026-07-01T00:00:00Z', '2026-07-02');
    expect(before).toEqual([]);
    expect(after).toEqual([{ id: 'id1', text: 'buy milk', done: false, due: '2026-07-02', createdAt: '2026-07-01T00:00:00Z' }]);
  });
  it('addTodo ignores blank text (no-op)', () => {
    expect(addTodo([], '   ', 'id', '2026-07-01T00:00:00Z')).toEqual([]);
  });
  it('toggleTodo flips done for the matching id only', () => {
    const list = [todo({ id: 'a', done: false }), todo({ id: 'b', done: false })];
    expect(toggleTodo(list, 'a').map((t) => t.done)).toEqual([true, false]);
  });
  it('editTodoText trims; blank edit is ignored', () => {
    const list = [todo({ id: 'a', text: 'old' })];
    expect(editTodoText(list, 'a', ' new ')[0].text).toBe('new');
    expect(editTodoText(list, 'a', '   ')[0].text).toBe('old');
  });
  it('setTodoDue sets or clears the due date', () => {
    const list = [todo({ id: 'a', due: null })];
    expect(setTodoDue(list, 'a', '2026-07-04')[0].due).toBe('2026-07-04');
    expect(setTodoDue(setTodoDue(list, 'a', '2026-07-04'), 'a', null)[0].due).toBeNull();
  });
  it('removeTodo drops the matching id', () => {
    const list = [todo({ id: 'a' }), todo({ id: 'b' })];
    expect(removeTodo(list, 'a').map((t) => t.id)).toEqual(['b']);
  });
  it('unknown id is a no-op for toggle/edit/setDue/remove', () => {
    const list = [todo({ id: 'a' })];
    expect(toggleTodo(list, 'z')).toEqual(list);
    expect(editTodoText(list, 'z', 'x')).toEqual(list);
    expect(setTodoDue(list, 'z', '2026-07-01')).toEqual(list);
    expect(removeTodo(list, 'z')).toEqual(list);
  });
});

describe('sanitizeTodos', () => {
  it('drops non-array / junk entries and coerces types', () => {
    expect(sanitizeTodos(null)).toEqual([]);
    expect(sanitizeTodos('nope')).toEqual([]);
    const raw = [
      { id: 'a', text: 'ok', done: true, due: '2026-07-01', createdAt: '2026-06-01T00:00:00Z' },
      { id: 'b', text: '   ' },                       // blank text → dropped
      { text: 'no id' },                              // missing id → dropped
      { id: 'c', text: 'baddue', due: 'xx/yy' },      // bad due → null
      42,                                             // not an object → dropped
    ];
    const out = sanitizeTodos(raw);
    expect(out.map((t) => t.id)).toEqual(['a', 'c']);
    expect(out[0]).toEqual({ id: 'a', text: 'ok', done: true, due: '2026-07-01', createdAt: '2026-06-01T00:00:00Z' });
    expect(out[1].due).toBeNull();
    expect(out[1].done).toBe(false);
  });
  it('caps list length and text length', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ id: 's' + i, text: 'x' }));
    expect(sanitizeTodos(many).length).toBe(200);
    const long = sanitizeTodos([{ id: 'a', text: 'y'.repeat(1000) }]);
    expect(long[0].text.length).toBe(200);
  });
});
