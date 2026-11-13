import { describe, expect, it } from 'vitest';
import { oncePerTask, skipRenderWhileHidden, tileDrawn } from './hiddenTerminal';

/** The parts of an opened xterm the guard reaches for, and a record of what was drawn. */
function fakeTerminal(rows = 55) {
  const drawn: [number, number][] = [];
  const refreshed: [number, number][] = [];
  const renderer = { renderRows(start: number, end: number): void { drawn.push([start, end]); } };
  const service: { _renderer: { value: typeof renderer }; _needsFullRefresh: boolean } = { _renderer: { value: renderer }, _needsFullRefresh: false };
  const term = { rows, _core: { _renderService: service }, refresh(start: number, end: number): void { refreshed.push([start, end]); } };
  return { term, service, renderer, drawn, refreshed };
}

describe('a terminal that is not on screen does not draw', () => {
  it('draws as before while its tile is on screen', () => {
    const t = fakeTerminal();
    const guard = skipRenderWhileHidden(t.term, () => true);
    expect(guard.installed).toBe(true);
    t.renderer.renderRows(0, 54);
    expect(t.drawn).toEqual([[0, 54]]);
    expect(t.service._needsFullRefresh).toBe(false);
    guard.redrawIfSkipped();
    expect(t.refreshed).toEqual([]); // nothing was skipped, nothing is owed
  });

  it('skips every draw while hidden — a scroll, a blur, a resize all come through renderRows — and owes xterm one full refresh', () => {
    const t = fakeTerminal();
    let shown = false;
    skipRenderWhileHidden(t.term, () => shown);
    for (let i = 0; i < 200; i++) t.renderer.renderRows(0, 54); // 200 scrolled lines in the background
    expect(t.drawn).toEqual([]);
    expect(t.service._needsFullRefresh).toBe(true);
    shown = true;
    t.renderer.renderRows(3, 9);
    expect(t.drawn).toEqual([[3, 9]]);
  });

  it('redraws once when a tile comes back inside the same frame it was hidden in', () => {
    const t = fakeTerminal(40);
    let shown = false;
    const guard = skipRenderWhileHidden(t.term, () => shown);
    t.renderer.renderRows(0, 39);
    shown = true;
    guard.redrawIfSkipped();
    guard.redrawIfSkipped();
    expect(t.refreshed).toEqual([[0, 39]]);
  });

  it('changes nothing when xterm keeps its renderer somewhere else', () => {
    for (const term of [null, {}, { _core: {} }, { _core: { _renderService: {} } }, { _core: { _renderService: { _renderer: { value: {} } } }, refresh() { /* */ } }]) {
      const guard = skipRenderWhileHidden(term, () => false);
      expect(guard.installed).toBe(false);
      expect(() => guard.redrawIfSkipped()).not.toThrow();
    }
  });
});

describe('asking whether a tile is on screen costs nothing for the ones that are not', () => {
  const tile = (shown: boolean) => ({ classList: { contains: (c: string) => shown && c === 'show' } });

  it('answers for a tile that is not the selected one without asking the document anything', () => {
    let asked = 0;
    expect(tileDrawn(tile(false), () => { asked++; return true; })).toBe(false);
    expect(asked).toBe(0); // 19 of 20 tiles ask this on every scrolled line
  });

  it('the selected tile is on screen only while the terminal pane itself is', () => {
    expect(tileDrawn(tile(true), () => true)).toBe(true);
    expect(tileDrawn(tile(true), () => false)).toBe(false); // another view is open over the deck
  });

  it('asks the document once however many draws land in one task, and again in the next', () => {
    let asked = 0; let answer = true;
    const later: (() => void)[] = [];
    const drawn = oncePerTask(() => { asked++; return answer; }, (fn) => { later.push(fn); });
    expect([drawn(), drawn(), drawn()]).toEqual([true, true, true]);
    expect(asked).toBe(1);
    expect(later).toHaveLength(1);
    answer = false;
    later.shift()!(); // the task ended
    expect(drawn()).toBe(false);
    expect(asked).toBe(2);
  });
});
