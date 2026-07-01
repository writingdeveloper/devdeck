import { tr, localeTag } from './i18n-runtime';
import {
  groupTasksByDue, classifyDue, addTodo, toggleTodo, editTodoText, setTodoDue, removeTodo,
  type Todo, type TaskWithProject, type DueBucket,
} from '../shared/tasks';

let viewEl: HTMLElement;
interface Proj { path: string; name: string; todos: Todo[]; }
let projects: Proj[] = [];

async function load(): Promise<void> {
  const list = await window.devdeck.listProjects();
  projects = list.map((p) => ({ path: p.path, name: p.name, todos: p.todos ?? [] }));
  render();
}

function mutate(path: string, fn: (todos: Todo[]) => Todo[]): void {
  const p = projects.find((x) => x.path === path);
  if (!p) return;
  p.todos = fn(p.todos);
  void window.devdeck.setTodos(path, p.todos); // renderer owns the array; sends it whole (like note)
  render();
}

const BUCKET_CLASS: Record<DueBucket, string> = {
  overdue: 'tk-over', today: 'tk-today', week: 'tk-week', later: 'tk-later', none: 'tk-none',
};

/** 'YYYY-MM-DD' → a local Date at midnight (avoids the UTC-parse day shift of `new Date(str)`). */
function dueToLocalDate(due: string): Date {
  const [y, m, d] = due.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function dueLabel(due: string | null, now: number): string {
  if (!due) return '';
  const b = classifyDue(due, now);
  if (b === 'today') return tr('tasks.due_today');
  if (b === 'overdue') {
    const days = Math.round((now - dueToLocalDate(due).getTime()) / 86_400_000);
    return tr('tasks.overdue_days').replace('{n}', String(Math.max(1, days)));
  }
  return dueToLocalDate(due).toLocaleDateString(localeTag(), { month: 'numeric', day: 'numeric' });
}

function taskRow(it: TaskWithProject, now: number): HTMLElement {
  const { todo, projectPath, projectName } = it;
  const row = document.createElement('div'); row.className = 'tk-row'; row.setAttribute('role', 'listitem');

  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'tk-check';
  cb.checked = todo.done; cb.setAttribute('aria-label', tr('tasks.done'));
  cb.addEventListener('change', () => mutate(projectPath, (ts) => toggleTodo(ts, todo.id)));

  const proj = document.createElement('span'); proj.className = 'tk-proj'; proj.textContent = projectName;

  const text = document.createElement('span'); text.className = 'tk-text'; text.textContent = todo.text; text.title = todo.text;
  text.addEventListener('dblclick', () => startEdit(text, projectPath, todo));

  const due = document.createElement('button'); due.className = 'tk-due' + (todo.due ? ' ' + BUCKET_CLASS[classifyDue(todo.due, now)] : ' tk-due-empty');
  due.textContent = todo.due ? dueLabel(todo.due, now) : '＋' + tr('tasks.due');
  due.title = tr('tasks.due');
  due.addEventListener('click', () => startDueEdit(due, projectPath, todo));

  const del = document.createElement('button'); del.className = 'tk-del'; del.textContent = '🗑'; del.title = tr('tasks.delete');
  del.addEventListener('click', () => mutate(projectPath, (ts) => removeTodo(ts, todo.id)));

  const open = document.createElement('button'); open.className = 'primary tk-open'; open.textContent = '▶';
  open.title = tr('proj.open');
  open.addEventListener('click', () => window.devdeck.open([{ path: projectPath, sessionId: null }]));

  row.append(cb, proj, text, due, del, open);
  return row;
}

function startEdit(text: HTMLElement, path: string, todo: Todo): void {
  const input = document.createElement('input'); input.className = 'tk-edit'; input.value = todo.text;
  let done = false;
  const commit = (save: boolean): void => {
    if (done) return; done = true;
    if (save && input.value.trim()) mutate(path, (ts) => editTodoText(ts, todo.id, input.value));
    else render();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(true); if (e.key === 'Escape') commit(false); });
  input.addEventListener('blur', () => commit(true));
  text.replaceWith(input); input.focus(); input.select();
}

function startDueEdit(chip: HTMLElement, path: string, todo: Todo): void {
  const input = document.createElement('input'); input.type = 'date'; input.className = 'tk-due-input';
  input.value = todo.due ?? '';
  input.addEventListener('change', () => mutate(path, (ts) => setTodoDue(ts, todo.id, input.value || null)));
  input.addEventListener('blur', () => render());
  chip.replaceWith(input); input.focus();
  input.showPicker?.();
}

function addRow(): HTMLElement {
  const wrap = document.createElement('div'); wrap.className = 'tk-add';
  const sel = document.createElement('select'); sel.className = 'tk-add-proj';
  sel.setAttribute('aria-label', tr('tasks.add_project_ph'));
  for (const p of [...projects].sort((a, b) => a.name.localeCompare(b.name))) {
    const o = document.createElement('option'); o.value = p.path; o.textContent = p.name; sel.appendChild(o);
  }
  const text = document.createElement('input'); text.className = 'tk-add-text'; text.placeholder = tr('tasks.add_ph');
  const dueI = document.createElement('input'); dueI.type = 'date'; dueI.className = 'tk-add-due'; dueI.title = tr('tasks.due');
  const btn = document.createElement('button'); btn.className = 'primary tk-add-btn'; btn.textContent = tr('tasks.add');
  const submit = (): void => {
    if (!sel.value || !text.value.trim()) return;
    mutate(sel.value, (ts) => addTodo(ts, text.value, crypto.randomUUID(), new Date().toISOString(), dueI.value || null));
  };
  btn.addEventListener('click', submit);
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  if (projects.length === 0) { sel.disabled = true; text.disabled = true; btn.disabled = true; }
  wrap.append(sel, text, dueI, btn);
  return wrap;
}

function render(): void {
  const now = Date.now();
  viewEl.replaceChildren();
  const items: TaskWithProject[] = projects.flatMap((p) => p.todos.map((t) => ({ todo: t, projectPath: p.path, projectName: p.name })));
  const open = items.filter((i) => !i.todo.done);
  const overdue = open.filter((i) => classifyDue(i.todo.due, now) === 'overdue').length;

  const head = document.createElement('div'); head.className = 'next-head';
  head.textContent = `${tr('next.title')} · ${open.length}` + (overdue ? `  ·  🔴 ${overdue}` : '');
  viewEl.append(head, addRow());

  const groups = groupTasksByDue(items, now);
  if (groups.length === 0) {
    const e = document.createElement('div'); e.className = 'empty'; e.textContent = tr('next.empty');
    viewEl.appendChild(e);
    return;
  }
  for (const g of groups) {
    const gh = document.createElement('div'); gh.className = 'tk-group ' + BUCKET_CLASS[g.bucket];
    gh.textContent = `${tr('tasks.bucket_' + g.bucket)} · ${g.items.length}`;
    const listEl = document.createElement('div'); listEl.className = 'tk-list'; listEl.setAttribute('role', 'list');
    for (const it of g.items) listEl.appendChild(taskRow(it, now));
    viewEl.append(gh, listEl);
  }
}

export function mountNext(): void { viewEl = document.getElementById('view-next')!; }
export function showNext(): void { void load(); }
