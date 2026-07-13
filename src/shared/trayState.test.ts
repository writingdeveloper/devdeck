import { describe, it, expect } from 'vitest';
import { trayState, shutdownMenuShape } from './trayState';

describe('trayState', () => {
  it('reddens per mode: attention-only by default, attention+turn for "all", never for "off"', () => {
    const counts = { attention: 2, turn: 3, overdue: 0 };
    expect(trayState(counts, 'attention').red).toBe(2);
    expect(trayState(counts, 'all').red).toBe(5);
    expect(trayState(counts, 'off').red).toBe(0);
  });

  it('overdue tasks never redden the tray — they are a deadline signal, not an agent waiting', () => {
    expect(trayState({ attention: 0, turn: 0, overdue: 7 }, 'all').red).toBe(0);
  });

  it('tooltip is bare "DevDeck" when there is nothing to report', () => {
    expect(trayState({ attention: 0, turn: 0, overdue: 0 }, 'attention').tooltip).toBe('DevDeck');
  });

  it('tooltip shows the needs-you count and the overdue count, omitting zero parts', () => {
    expect(trayState({ attention: 2, turn: 0, overdue: 0 }, 'attention').tooltip).toBe('DevDeck — 2 waiting');
    expect(trayState({ attention: 0, turn: 0, overdue: 3 }, 'attention').tooltip).toBe('DevDeck — 3 overdue');
    expect(trayState({ attention: 2, turn: 0, overdue: 3 }, 'attention').tooltip).toBe('DevDeck — 2 waiting · 3 overdue');
  });

  it('overdue still shows in the tooltip when alerts are off (the red dot is what "off" disables)', () => {
    expect(trayState({ attention: 1, turn: 0, overdue: 3 }, 'off').tooltip).toBe('DevDeck — 3 overdue');
  });
});

describe('shutdownMenuShape', () => {
  it('hides everything when the feature is off (null phase — non-win32)', () => {
    expect(shutdownMenuShape(null)).toEqual([]);
  });
  it('disarmed: unchecked toggle + shutdown-now', () => {
    expect(shutdownMenuShape('disarmed')).toEqual([{ key: 'toggle', checked: false }, { key: 'now' }]);
  });
  it('armed: checked toggle + shutdown-now', () => {
    expect(shutdownMenuShape('armed')).toEqual([{ key: 'toggle', checked: true }, { key: 'now' }]);
  });
  it('countdown: cancel only (the OS timer is running — arm/now would double-issue)', () => {
    expect(shutdownMenuShape('countdown')).toEqual([{ key: 'cancel' }]);
  });
});
