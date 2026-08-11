import { describe, it, expect } from 'vitest';
import {
  resolveWindowBounds, sanitizeWindowBounds,
  WINDOW_DEFAULT_HEIGHT, WINDOW_DEFAULT_WIDTH, WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH,
} from './windowBounds';

const screen = { x: 0, y: 0, width: 2560, height: 1400 };
const small = { x: 0, y: 0, width: 1280, height: 800 };

describe('sanitizeWindowBounds', () => {
  it('keeps a usable rectangle', () => {
    expect(sanitizeWindowBounds({ width: 1500, height: 900, x: 20, y: 30, maximized: true }))
      .toEqual({ width: 1500, height: 900, x: 20, y: 30, maximized: true });
  });
  it('rounds fractional device pixels', () => {
    expect(sanitizeWindowBounds({ width: 1500.6, height: 900.2 })).toEqual({ width: 1501, height: 900 });
  });
  it('rejects anything without a real size', () => {
    expect(sanitizeWindowBounds(null)).toBeNull();
    expect(sanitizeWindowBounds({ width: 0, height: 900 })).toBeNull();
    expect(sanitizeWindowBounds({ width: '1500', height: 900 })).toBeNull();
    expect(sanitizeWindowBounds({ width: Number.NaN, height: 900 })).toBeNull();
    expect(sanitizeWindowBounds({ height: 900 })).toBeNull();
  });
  it('omits a position that was not saved, rather than inventing 0,0', () => {
    expect(sanitizeWindowBounds({ width: 1500, height: 900 })).toEqual({ width: 1500, height: 900 });
  });
});

describe('resolveWindowBounds', () => {
  it('opens at the default size on first run, letting the OS centre it', () => {
    expect(resolveWindowBounds(null, [screen]))
      .toEqual({ width: WINDOW_DEFAULT_WIDTH, height: WINDOW_DEFAULT_HEIGHT });
  });

  it('never proposes a default larger than the display it will open on', () => {
    const laptop = { x: 0, y: 0, width: 1180, height: 700 };
    expect(resolveWindowBounds(null, [laptop])).toEqual({ width: 1180, height: 700 });
  });

  it('restores the size and position the user chose', () => {
    expect(resolveWindowBounds({ width: 1800, height: 1100, x: 120, y: 60 }, [screen]))
      .toEqual({ width: 1800, height: 1100, x: 120, y: 60 });
  });

  it('carries the maximized state back', () => {
    expect(resolveWindowBounds({ width: 1800, height: 1100, x: 0, y: 0, maximized: true }, [screen]).maximized).toBe(true);
  });

  // Unplugging the monitor the window was last on would otherwise reopen it somewhere unreachable.
  it('drops an off-screen position but keeps the size the user picked', () => {
    expect(resolveWindowBounds({ width: 1400, height: 900, x: 4000, y: 200 }, [screen]))
      .toEqual({ width: 1400, height: 900 });
    expect(resolveWindowBounds({ width: 1400, height: 900, x: -1500, y: 0 }, [screen]))
      .toEqual({ width: 1400, height: 900 });
  });

  it('keeps a position that is only partly on screen — that is still draggable back', () => {
    expect(resolveWindowBounds({ width: 1400, height: 900, x: 2400, y: 100 }, [screen]).x).toBe(2400);
  });

  it('accepts a position on a secondary display', () => {
    const second = { x: 2560, y: 0, width: 1920, height: 1080 };
    expect(resolveWindowBounds({ width: 1400, height: 900, x: 2700, y: 40 }, [screen, second]).x).toBe(2700);
  });

  it('shrinks a size saved on a bigger monitor down to what fits here', () => {
    expect(resolveWindowBounds({ width: 2400, height: 1300, x: 0, y: 0 }, [small]))
      .toEqual({ width: 1280, height: 800, x: 0, y: 0 });
  });

  it('never restores a window too small to use', () => {
    const tiny = resolveWindowBounds({ width: 200, height: 100, x: 0, y: 0 }, [screen]);
    expect(tiny.width).toBe(WINDOW_MIN_WIDTH);
    expect(tiny.height).toBe(WINDOW_MIN_HEIGHT);
  });
});
