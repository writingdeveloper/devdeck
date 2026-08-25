import { describe, it, expect } from 'vitest';
import { windowsPtyCompat } from './windowsPty';

describe('windowsPtyCompat', () => {
  it('describes a modern Windows pty as conpty with its build', () => {
    expect(windowsPtyCompat('win32', '10.0.26200')).toEqual({ backend: 'conpty', buildNumber: 26200 });
  });

  it('reports winpty below the build where ConPTY exists, matching node-pty', () => {
    expect(windowsPtyCompat('win32', '10.0.17763')).toEqual({ backend: 'winpty', buildNumber: 17763 });
    expect(windowsPtyCompat('win32', '10.0.18309')).toEqual({ backend: 'conpty', buildNumber: 18309 });
  });

  it('keeps xterm reflow on, which needs the build and not just the backend', () => {
    // xterm disables reflow unless (backend === 'conpty' && buildNumber >= 21376).
    const compat = windowsPtyCompat('win32', '10.0.22631')!;
    expect(compat.backend === 'conpty' && compat.buildNumber >= 21376).toBe(true);
  });

  it('says nothing for a pty that is not on Windows', () => {
    expect(windowsPtyCompat('darwin', '24.5.0')).toBeUndefined();
    expect(windowsPtyCompat('linux', '6.8.0-45-generic')).toBeUndefined();
  });

  it('stays at the default rather than guessing when the release is unreadable', () => {
    // A backend with no build number is the one combination that silently turns reflow off.
    expect(windowsPtyCompat('win32', '')).toBeUndefined();
    expect(windowsPtyCompat('win32', undefined)).toBeUndefined();
    expect(windowsPtyCompat('win32', 'unknown')).toBeUndefined();
    expect(windowsPtyCompat(undefined, '10.0.26200')).toBeUndefined();
  });
});
