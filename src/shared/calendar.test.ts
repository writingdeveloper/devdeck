import { describe, it, expect } from 'vitest';
import { buildMonthGrid, type MonthGrid } from './calendar';
import type { TaskWithProject } from './tasks';

const task = (due: string | null, done = false, text = 't'): TaskWithProject =>
  ({ todo: { id: `${due}-${text}-${done}`, text, done, due, createdAt: '2026-01-01T00:00:00.000Z' }, projectPath: 'C:/p', projectName: 'p' });
const cellByDate = (g: MonthGrid, dateStr: string) => g.weeks.flat().find((c) => c.dateStr === dateStr);

describe('buildMonthGrid', () => {
  it('lays out 6 weeks × 7 days covering the month with leading/trailing filler', () => {
    const g = buildMonthGrid(2026, 6, [], '2026-07-14'); // July 2026 (month is 0-indexed)
    expect(g.weeks).toHaveLength(6);
    for (const w of g.weeks) expect(w).toHaveLength(7);
    expect(cellByDate(g, '2026-07-01')?.inMonth).toBe(true);
    expect(cellByDate(g, '2026-07-31')?.inMonth).toBe(true);
    expect(g.weeks[0][0].dateStr <= '2026-07-01').toBe(true); // first cell is on/before the 1st (Sun-first grid)
  });

  it('buckets tasks onto their due day; openCount excludes done; undated listed separately', () => {
    const tasks = [
      task('2026-07-14', false, 'a'),
      task('2026-07-14', true, 'b'), // done → counted in tasks but not openCount
      task('2026-07-20', false, 'c'),
      task(null, false, 'd'),        // no due → undated, not on the grid
    ];
    const g = buildMonthGrid(2026, 6, tasks, '2026-07-14');
    const c14 = cellByDate(g, '2026-07-14')!;
    expect(c14.tasks).toHaveLength(2);
    expect(c14.openCount).toBe(1);
    expect(c14.isToday).toBe(true);
    expect(cellByDate(g, '2026-07-20')!.openCount).toBe(1);
    expect(g.undated.map((t) => t.todo.text)).toEqual(['d']);
  });

  it('flags a past day with an undone task as overdue (not future days, not done tasks)', () => {
    const g = buildMonthGrid(2026, 6, [task('2026-07-10', false), task('2026-07-25', false)], '2026-07-14');
    expect(cellByDate(g, '2026-07-10')!.overdue).toBe(true);  // past + undone
    expect(cellByDate(g, '2026-07-25')!.overdue).toBe(false); // future
    const g2 = buildMonthGrid(2026, 6, [task('2026-07-10', true)], '2026-07-14');
    expect(cellByDate(g2, '2026-07-10')!.overdue).toBe(false); // past but done
  });
});
