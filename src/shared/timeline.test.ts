import { describe, it, expect } from 'vitest';
import { imagesByTurn, pairTurnsWithRows, promptKey } from './timeline';
import type { SessionImageRef, SessionTurn } from './sessionImages';

const turn = (id: string, text: string, ts: number | null = null): SessionTurn => ({ id, ts, text, pasted: 0, reply: null });
const img = (id: string, ts: number | null): SessionImageRef => ({ id, kind: 'screenshot', ts, tool: null, path: null });

describe('promptKey', () => {
  it('drops the pointer, image placeholders, an ellipsis and spacing, and folds case', () => {
    expect(promptKey('❯  [Image #1] Fix   the Login page')).toBe('fix the login page');
    expect(promptKey('> hello')).toBe('hello');
    expect(promptKey('a long prompt cut short…')).toBe('a long prompt cut short');
  });
});

describe('pairTurnsWithRows', () => {
  it('pairs prompts newest first by how they start — a row is cut at the terminal width', () => {
    const turns = [turn('t1', 'first question'), turn('t2', 'second, much longer question that wraps past the width of the terminal')];
    const rows = [{ row: 10, text: '❯ first question' }, { row: 40, text: '❯ second, much longer question that wra' }];
    expect([...pairTurnsWithRows(turns, rows)]).toEqual([['t2', 40], ['t1', 10]]);
  });

  it('skips turns the screen no longer shows, and leaves a row nothing matches alone', () => {
    const turns = [turn('t1', 'alpha'), turn('t2', 'cleared away'), turn('t3', 'gamma')];
    const rows = [{ row: 3, text: '❯ alpha' }, { row: 7, text: '❯ something typed elsewhere' }, { row: 9, text: '❯ gamma' }];
    expect(pairTurnsWithRows(turns, rows)).toEqual(new Map([['t3', 9], ['t1', 3]]));
  });

  it('pairs a prompt that was only a pasted image with a row that only shows the placeholder', () => {
    expect(pairTurnsWithRows([turn('t1', '')], [{ row: 2, text: '❯ [Image #1]' }])).toEqual(new Map([['t1', 2]]));
  });

  it('never pairs an empty row with a prompt that had words', () => {
    expect(pairTurnsWithRows([turn('t1', 'words')], [{ row: 2, text: '❯ [Image #1]' }]).size).toBe(0);
  });
});

describe('imagesByTurn', () => {
  it('gives each image to the newest turn sent at or before it', () => {
    const turns = [turn('a', 'one', 100), turn('b', 'two', 200)];
    const refs = [img('x', 50), img('y', 150), img('z', 200), img('w', 999), img('n', null)];
    expect(imagesByTurn(turns, refs)).toEqual(new Map([['a', ['y']], ['b', ['z', 'w']]]));
  });
});
