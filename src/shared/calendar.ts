import type { TaskWithProject } from './tasks';

export interface DayCell {
  dateStr: string;   // 'YYYY-MM-DD' local calendar date
  day: number;       // 1..31
  inMonth: boolean;  // false = leading/trailing filler from an adjacent month
  isToday: boolean;
  tasks: TaskWithProject[]; // tasks whose due === dateStr (done + open)
  openCount: number;        // undone tasks that day
  overdue: boolean;         // a past day (< today) that still has an undone task
}
export interface MonthGrid {
  year: number;
  month: number;            // 0-11
  weeks: DayCell[][];       // 6 rows × 7 days, Sunday-first
  undated: TaskWithProject[]; // tasks with no due date (not placeable on the grid)
}

const pad = (n: number): string => String(n).padStart(2, '0');
/** Local calendar date as 'YYYY-MM-DD' (matches the date-only `due` format; no UTC shift). */
export const toDateStr = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Build a 6×7 (Sunday-first) month grid with each day's due tasks. Pure: `todayStr` ('YYYY-MM-DD') is
 * passed in (no Date.now), and tasks are matched to cells by STRING equality on the date, so there's
 * no timezone/DST drift — a due "2026-07-14" always lands on the 2026-07-14 cell regardless of clock.
 */
export function buildMonthGrid(year: number, month: number, tasks: TaskWithProject[], todayStr: string): MonthGrid {
  const byDate = new Map<string, TaskWithProject[]>();
  const undated: TaskWithProject[] = [];
  for (const t of tasks) {
    if (t.todo.due) { const a = byDate.get(t.todo.due) ?? []; a.push(t); byDate.set(t.todo.due, a); }
    else undated.push(t);
  }
  const firstWeekday = new Date(year, month, 1).getDay(); // 0 = Sunday
  const weeks: DayCell[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: DayCell[] = [];
    for (let d = 0; d < 7; d++) {
      const cell = new Date(year, month, 1 - firstWeekday + w * 7 + d);
      const dateStr = toDateStr(cell);
      const cellTasks = byDate.get(dateStr) ?? [];
      const openCount = cellTasks.reduce((n, t) => n + (t.todo.done ? 0 : 1), 0);
      row.push({
        dateStr, day: cell.getDate(), inMonth: cell.getMonth() === month,
        isToday: dateStr === todayStr, tasks: cellTasks, openCount,
        overdue: dateStr < todayStr && openCount > 0,
      });
    }
    weeks.push(row);
  }
  return { year, month, weeks, undated };
}
