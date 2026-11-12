import { describe, expect, it } from 'vitest';
import { skipRenderWhileHidden } from './hiddenTerminal';

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
