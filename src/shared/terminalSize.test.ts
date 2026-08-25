import { describe, it, expect } from 'vitest';
import { followPtySize } from './terminalSize';

const d = (cols: number, rows: number) => ({ cols, rows });

describe('followPtySize', () => {
  it('does nothing when the pty already has this view\'s size', () => {
    expect(followPtySize(d(120, 40), d(120, 40), d(200, 60))).toEqual({ action: 'ignore' });
  });

  it('adopts a pty smaller than this view — the extra space just stays blank', () => {
    expect(followPtySize(d(200, 60), d(90, 30), d(200, 60)))
      .toEqual({ action: 'adopt', size: { cols: 90, rows: 30 } });
  });

  it('claims back when the pty is bigger than this view can show', () => {
    // The big machine set 200x60; this window can only show 90x30, and drawing 200 columns into a
    // 90-column terminal is exactly the split screen.
    expect(followPtySize(d(90, 30), d(200, 60), d(90, 30)))
      .toEqual({ action: 'claim', size: { cols: 90, rows: 30 } });
  });

  it('claims the minimum of the two, never its own pane, so the exchange cannot ping-pong', () => {
    // Wider than this pane but SHORTER than it: claiming the pane would push rows back up, and the
    // other view would answer by pulling them down again.
    expect(followPtySize(d(120, 10), d(200, 10), d(120, 60)))
      .toEqual({ action: 'claim', size: { cols: 120, rows: 10 } });
  });

  it('settles in one exchange: the big view adopts what the small one claimed', () => {
    const pane = { big: d(200, 60), small: d(90, 30) };
    const claimed = followPtySize(d(90, 30), d(200, 60), pane.small);
    expect(claimed.action).toBe('claim');
    const size = (claimed as { size: { cols: number; rows: number } }).size;
    const answer = followPtySize(d(200, 60), size, pane.big);
    expect(answer).toEqual({ action: 'adopt', size });
    // ...and the small view has nothing left to say about it.
    expect(followPtySize(size, size, pane.small)).toEqual({ action: 'ignore' });
  });

  it('agrees with the pty when this view has never been measured', () => {
    expect(followPtySize(d(80, 24), d(200, 60), null))
      .toEqual({ action: 'adopt', size: { cols: 200, rows: 60 } });
  });

  it('re-states its own size every time the pty drifts off it — that IS how it tells the others', () => {
    // Silence here would leave the pty at a width this view cannot draw, which is the bug.
    expect(followPtySize(d(90, 30), d(200, 60), d(90, 30)))
      .toEqual({ action: 'claim', size: { cols: 90, rows: 30 } });
  });
});
