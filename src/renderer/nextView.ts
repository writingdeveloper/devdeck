import { tr, localeTag } from './i18n-runtime';
import { openInTerminal } from './openRouter';
import { renderLoadError } from './loadError';
import { buildMonthGrid, toDateStr, type DayCell } from '../shared/calendar';
import {
  groupTasksByDue, classifyDue, addTodo, toggleTodo, editTodoText, setTodoDue, removeTodo,
  clearDone, filterTaskItems,
  type Todo, type TaskWithProject, type DueBucket,
} from '../shared/tasks';

let viewEl: HTMLElement;
interface Proj { path: string; name: string; todos: Todo[]; }
let projects: Proj[] = [];

// Board filters (view-local; reset only by explicit user action, so a re-render keeps them).
let filterProject: string | null = null;
let filterText = '';
let showDone = false;
// Board view mode + calendar month state (view-local, so a re-render keeps the user's place).
let boardView: 'list' | 'calendar' = 'list';
let calYear: number | null = null; // null until first render seeds it from "now"
let calMonth = 0;                   // 0-11
let calSelected: string | null = null; // the clicked day (YYYY-MM-DD), shows its tasks below the grid

/** Deck task-badge deep-link: land on the board already narrowed to that project. */
export function presetBoardProject(path: string): void { filterProject = path; }

async function load(): Promise<void> {
  let list;
  try {
    list = await window.devdeck.listProjects();
  } catch (e) {
    console.error('DevDeck: task board load failed', e); // otherwise the board would sit blank
    renderLoadError(viewEl, () => void load());
    return;
  }
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
  const row = document.createElement('div'); row.className = 'tk-row' + (todo.done ? ' tk-done' : ''); row.setAttribute('role', 'listitem');

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
  // Route through the shared opener so the task board opens in the cockpit (Windows) just like the deck,
  // instead of always spawning an external PowerShell window.
  open.addEventListener('click', () => openInTerminal([{ path: projectPath, name: projectName, staleLevel: 'neutral', branch: null, dirty: 0, sessionId: null }]));

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

/** [project select][new-todo input][date][add] — appended straight into the shared `.tk-bar`. */
function addControls(bar: HTMLElement): void {
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
  bar.append(sel, text, dueI, btn);
}

/** Thin vertical rule between the add group and the filter group of `.tk-bar` (decorative only). */
function barSeparator(): HTMLElement {
  const sep = document.createElement('span'); sep.className = 'tk-sep'; sep.setAttribute('aria-hidden', 'true');
  return sep;
}

/** [filter project][filter input][show-done toggle](+optional clear-done) — appended into the shared `.tk-bar`. */
function filterControls(bar: HTMLElement): void {
  const sel = document.createElement('select'); sel.className = 'tk-filter-proj';
  sel.setAttribute('aria-label', tr('tasks.filter_all'));
  const all = document.createElement('option'); all.value = ''; all.textContent = tr('tasks.filter_all'); sel.appendChild(all);
  for (const p of [...projects].filter((x) => x.todos.length).sort((a, b) => a.name.localeCompare(b.name))) {
    const o = document.createElement('option'); o.value = p.path; o.textContent = p.name; sel.appendChild(o);
  }
  if (filterProject && !Array.from(sel.options).some((o) => o.value === filterProject)) filterProject = null; // preset project has no tasks anymore
  sel.value = filterProject ?? '';
  sel.addEventListener('change', () => { filterProject = sel.value || null; render(); });

  const q = document.createElement('input'); q.className = 'tk-filter-text';
  q.placeholder = tr('tasks.filter_ph'); q.setAttribute('aria-label', tr('tasks.filter_ph'));
  q.value = filterText;
  q.addEventListener('input', () => {
    filterText = q.value;
    render();
    // render() rebuilt the row — put the caret back so typing keeps flowing
    const el = viewEl.querySelector<HTMLInputElement>('.tk-filter-text');
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  });

  const doneLab = document.createElement('label'); doneLab.className = 'tk-show-done';
  const doneCb = document.createElement('input'); doneCb.type = 'checkbox'; doneCb.checked = showDone;
  doneCb.addEventListener('change', () => { showDone = doneCb.checked; render(); });
  doneLab.append(doneCb, document.createTextNode(' ' + tr('tasks.show_done')));

  bar.append(sel, q, doneLab);

  const doneCount = projects.reduce((n, p) => n + p.todos.filter((t) => t.done).length, 0);
  if (doneCount > 0) {
    // Two-click confirm (no native dialog): first click arms the button with the count, second wipes.
    const clear = document.createElement('button'); clear.className = 'tk-clear-done';
    clear.textContent = tr('tasks.clear_done');
    let armed = false;
    clear.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        clear.textContent = tr('tasks.clear_done_confirm').replace('{n}', String(doneCount));
        clear.classList.add('armed');
        setTimeout(() => { armed = false; clear.textContent = tr('tasks.clear_done'); clear.classList.remove('armed'); }, 3000);
        return;
      }
      for (const p of projects) {
        if (!p.todos.some((t) => t.done)) continue;
        p.todos = clearDone(p.todos);
        void window.devdeck.setTodos(p.path, p.todos);
      }
      render();
    });
    bar.appendChild(clear);
  }
}

function render(): void {
  const now = Date.now();
  viewEl.replaceChildren();
  const items: TaskWithProject[] = projects.flatMap((p) => p.todos.map((t) => ({ todo: t, projectPath: p.path, projectName: p.name })));
  const open = items.filter((i) => !i.todo.done);
  const overdue = open.filter((i) => classifyDue(i.todo.due, now) === 'overdue').length;

  const head = document.createElement('div'); head.className = 'next-head';
  head.textContent = `${tr('next.title')} · ${open.length}` + (overdue ? `  ·  🔴 ${overdue}` : '');
  // Checking off / re-dating a task changes the overdue total — keep the tray tooltip current
  // (partial update: the cockpit owns attention/turn on the same channel).
  window.devdeck.setTrayCounts({ overdue });

  // Single control row: [project▾][new-todo…][date][add] | separator | [filter▾][filter…][show-done](+clear) | [list|calendar]
  const bar = document.createElement('div'); bar.className = 'tk-bar';
  addControls(bar);
  bar.appendChild(barSeparator());
  filterControls(bar);
  bar.appendChild(viewToggle());
  viewEl.append(head, bar);

  const visible = filterTaskItems(items, { project: filterProject, q: filterText });
  if (boardView === 'calendar') { renderCalendar(visible, now); return; }
  const groups = groupTasksByDue(visible, now);
  const doneItems = showDone ? visible.filter((i) => i.todo.done) : [];
  if (groups.length === 0 && doneItems.length === 0) {
    const e = document.createElement('div'); e.className = 'empty';
    const msg = document.createElement('div'); msg.textContent = tr('next.empty');
    const cta = document.createElement('button'); cta.className = 'primary tk-empty-cta'; cta.textContent = tr('tasks.empty_cta');
    // Mirror addControls' zero-projects guard: with no projects the .tk-add-text input is
    // disabled, so focusing it would be a no-op — disable the CTA too instead of doing nothing.
    if (projects.length === 0) cta.disabled = true;
    cta.addEventListener('click', () => viewEl.querySelector<HTMLInputElement>('.tk-add-text')?.focus());
    e.append(msg, cta);
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
  if (doneItems.length > 0) {
    const gh = document.createElement('div'); gh.className = 'tk-group tk-none';
    gh.textContent = `${tr('tasks.done_section')} · ${doneItems.length}`;
    const listEl = document.createElement('div'); listEl.className = 'tk-list'; listEl.setAttribute('role', 'list');
    for (const it of doneItems) listEl.appendChild(taskRow(it, now));
    viewEl.append(gh, listEl);
  }
}

/** [목록 | 달력] segmented toggle for the board. */
function viewToggle(): HTMLElement {
  const wrap = document.createElement('div'); wrap.className = 'tk-viewtoggle';
  for (const [mode, key] of [['list', 'tasks.view_list'], ['calendar', 'tasks.view_calendar']] as ['list' | 'calendar', string][]) {
    const b = document.createElement('button'); b.className = 'tk-vt' + (boardView === mode ? ' on' : '');
    b.textContent = tr(key);
    b.addEventListener('click', () => { if (boardView !== mode) { boardView = mode; render(); } });
    wrap.appendChild(b);
  }
  return wrap;
}

/** Month calendar of task due dates (same todos as the list, viewed by date). */
function renderCalendar(items: TaskWithProject[], now: number): void {
  const today = toDateStr(new Date(now));
  if (calYear === null) { const d = new Date(now); calYear = d.getFullYear(); calMonth = d.getMonth(); }
  const grid = buildMonthGrid(calYear, calMonth, items, today);

  const nav = document.createElement('div'); nav.className = 'cal-nav';
  const prev = document.createElement('button'); prev.className = 'cal-navbtn'; prev.textContent = '◀'; prev.title = tr('tasks.prev_month');
  prev.addEventListener('click', () => { if (calMonth === 0) { calMonth = 11; calYear!--; } else calMonth!--; render(); });
  const next = document.createElement('button'); next.className = 'cal-navbtn'; next.textContent = '▶'; next.title = tr('tasks.next_month');
  next.addEventListener('click', () => { if (calMonth === 11) { calMonth = 0; calYear!++; } else calMonth!++; render(); });
  const title = document.createElement('span'); title.className = 'cal-title';
  title.textContent = new Intl.DateTimeFormat(localeTag(), { year: 'numeric', month: 'long' }).format(new Date(calYear, calMonth, 1));
  const todayBtn = document.createElement('button'); todayBtn.className = 'cal-today'; todayBtn.textContent = tr('tasks.today');
  todayBtn.addEventListener('click', () => { const d = new Date(now); calYear = d.getFullYear(); calMonth = d.getMonth(); calSelected = today; render(); });
  nav.append(prev, title, next, todayBtn);
  viewEl.appendChild(nav);

  // Weekday header — locale-aware (2023-01-01 was a Sunday → Sun..Sat, matching the grid's Sunday-first).
  const wk = document.createElement('div'); wk.className = 'cal-grid cal-weekdays';
  const wf = new Intl.DateTimeFormat(localeTag(), { weekday: 'short' });
  for (let i = 0; i < 7; i++) { const c = document.createElement('div'); c.className = 'cal-wd'; c.textContent = wf.format(new Date(2023, 0, 1 + i)); wk.appendChild(c); }
  viewEl.appendChild(wk);

  const gEl = document.createElement('div'); gEl.className = 'cal-grid';
  for (const week of grid.weeks) for (const cell of week) gEl.appendChild(dayCell(cell));
  viewEl.appendChild(gEl);

  if (calSelected) {
    const cell = grid.weeks.flat().find((c) => c.dateStr === calSelected);
    const dayTasks = (cell?.tasks ?? []).filter((t) => showDone || !t.todo.done);
    const panel = document.createElement('div'); panel.className = 'cal-day';
    const h = document.createElement('div'); h.className = 'cal-day-head'; h.textContent = `${calSelected} · ${dayTasks.length}`;
    panel.appendChild(h);
    if (dayTasks.length === 0) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = tr('next.empty'); panel.appendChild(e); }
    else { const list = document.createElement('div'); list.className = 'tk-list'; list.setAttribute('role', 'list'); for (const it of dayTasks) list.appendChild(taskRow(it, now)); panel.appendChild(list); }
    viewEl.appendChild(panel);
  }
}

/** One day cell in the month grid (a button: click selects the day → shows its tasks below). */
function dayCell(cell: DayCell): HTMLElement {
  const el = document.createElement('button');
  el.className = 'cal-cell' + (cell.inMonth ? '' : ' out') + (cell.isToday ? ' today' : '') + (cell.dateStr === calSelected ? ' sel' : '');
  const n = document.createElement('span'); n.className = 'cal-day-n'; n.textContent = String(cell.day); el.appendChild(n);
  if (cell.openCount > 0) {
    const m = document.createElement('span'); m.className = 'cal-mark' + (cell.overdue ? ' overdue' : '');
    m.textContent = `${cell.overdue ? '🔴' : '●'}${cell.openCount}`;
    el.appendChild(m);
  }
  el.addEventListener('click', () => { calSelected = cell.dateStr; render(); });
  return el;
}

export function mountNext(): void { viewEl = document.getElementById('view-next')!; }
export function showNext(): void { void load(); }
