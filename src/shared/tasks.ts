// Per-project task list (planning + deadlines). Pure + unit-tested; the store persists Todo[] per
// project and the Next view groups open tasks across all projects by due date. `due` is a date-only
// 'YYYY-MM-DD' string (or null) — deadlines here are day-granular, never a clock time.

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  due: string | null;      // 'YYYY-MM-DD' local calendar date, or null
  createdAt: string;       // ISO timestamp
}

export type DueBucket = 'overdue' | 'today' | 'week' | 'later' | 'none';
export interface TaskWithProject { todo: Todo; projectPath: string; projectName: string; }

const BUCKET_ORDER: DueBucket[] = ['overdue', 'today', 'week', 'later', 'none'];
const MAX_TODOS = 200;
const MAX_TEXT = 200;
const DUE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Calendar-day number for a Y/M/D triple — DST-immune (uses only the date components, via UTC). */
function dayNum(y: number, mo0: number, day: number): number {
  return Math.floor(Date.UTC(y, mo0, day) / 86_400_000);
}

/** Parse a 'YYYY-MM-DD' due into a calendar-day number, or null if malformed / not a real date. */
function dueDayNum(due: string): number | null {
  const m = DUE_RE.exec(due);
  if (!m) return null;
  const y = Number(m[1]), mo0 = Number(m[2]) - 1, day = Number(m[3]);
  const d = new Date(Date.UTC(y, mo0, day));
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo0 || d.getUTCDate() !== day) return null; // e.g. Feb 30
  return dayNum(y, mo0, day);
}

/** Bucket a due date relative to `now`, comparing LOCAL calendar days (a due "today" at 11pm is still 'today'). */
export function classifyDue(due: string | null, now: number): DueBucket {
  if (!due) return 'none';
  const dd = dueDayNum(due);
  if (dd == null) return 'none';
  const n = new Date(now);
  const today = dayNum(n.getFullYear(), n.getMonth(), n.getDate());
  if (dd < today) return 'overdue';
  if (dd === today) return 'today';
  if (dd <= today + 7) return 'week';
  return 'later';
}

/** Group INCOMPLETE tasks by due bucket, in fixed order; only non-empty groups; within a group
 *  sorted by due (asc, none last) then createdAt (asc). */
export function groupTasksByDue(items: TaskWithProject[], now: number): { bucket: DueBucket; items: TaskWithProject[] }[] {
  const byBucket = new Map<DueBucket, TaskWithProject[]>();
  for (const it of items) {
    if (it.todo.done) continue;
    const b = classifyDue(it.todo.due, now);
    (byBucket.get(b) ?? byBucket.set(b, []).get(b)!).push(it);
  }
  const out: { bucket: DueBucket; items: TaskWithProject[] }[] = [];
  for (const bucket of BUCKET_ORDER) {
    const list = byBucket.get(bucket);
    if (!list || !list.length) continue;
    list.sort((a, b) =>
      (a.todo.due ?? '9999-99-99').localeCompare(b.todo.due ?? '9999-99-99') ||
      a.todo.createdAt.localeCompare(b.todo.createdAt));
    out.push({ bucket, items: list });
  }
  return out;
}

/** Counts for the deck card badge. `overdue` counts only incomplete, past-due tasks. */
export function taskCounts(todos: Todo[], now: number): { total: number; done: number; open: number; overdue: number } {
  let done = 0, overdue = 0;
  for (const t of todos) {
    if (t.done) { done++; continue; }
    if (classifyDue(t.due, now) === 'overdue') overdue++;
  }
  return { total: todos.length, done, open: todos.length - done, overdue };
}

// ---- pure immutable reducers ----

export function addTodo(todos: Todo[], text: string, id: string, createdAtIso: string, due: string | null = null): Todo[] {
  const t = text.trim();
  if (!t) return todos;
  return [...todos, { id, text: t.slice(0, MAX_TEXT), done: false, due: normalizeDue(due), createdAt: createdAtIso }];
}
export function toggleTodo(todos: Todo[], id: string): Todo[] {
  return todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
}
export function editTodoText(todos: Todo[], id: string, text: string): Todo[] {
  const t = text.trim();
  if (!t) return todos;
  return todos.map((x) => (x.id === id ? { ...x, text: t.slice(0, MAX_TEXT) } : x));
}
export function setTodoDue(todos: Todo[], id: string, due: string | null): Todo[] {
  return todos.map((t) => (t.id === id ? { ...t, due: normalizeDue(due) } : t));
}
export function removeTodo(todos: Todo[], id: string): Todo[] {
  return todos.filter((t) => t.id !== id);
}
/** Drop every completed todo — done items otherwise accumulate silently toward the 200 cap. */
export function clearDone(todos: Todo[]): Todo[] {
  return todos.filter((t) => !t.done);
}

/** Board filters: narrow cross-project task items by project and/or case-insensitive text.
 *  Done-visibility is intentionally NOT handled here — grouping/done-sections are the view's concern. */
export function filterTaskItems(
  items: TaskWithProject[],
  opts: { project?: string | null; q?: string },
): TaskWithProject[] {
  const q = (opts.q ?? '').trim().toLowerCase();
  return items.filter((it) =>
    (!opts.project || it.projectPath === opts.project) &&
    (!q || it.todo.text.toLowerCase().includes(q)));
}

function normalizeDue(due: unknown): string | null {
  return typeof due === 'string' && dueDayNum(due) != null ? due : null;
}

/** Validate Todo[] loaded from disk: drop junk, coerce types, cap text + list length. */
export function sanitizeTodos(raw: unknown): Todo[] {
  if (!Array.isArray(raw)) return [];
  const out: Todo[] = [];
  for (const r of raw) {
    if (out.length >= MAX_TODOS) break;
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    const text = typeof o.text === 'string' ? o.text.trim().slice(0, MAX_TEXT) : '';
    if (!id || !text) continue;
    out.push({
      id, text,
      done: o.done === true,
      due: normalizeDue(o.due),
      createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date(0).toISOString(),
    });
  }
  return out;
}
