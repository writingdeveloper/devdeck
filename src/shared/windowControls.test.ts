import { describe, expect, it } from 'vitest';
import { maximizeActionPresentation } from './windowControls';

describe('maximizeActionPresentation', () => {
  it('switches both the icon and localized action label with window state', () => {
    expect(maximizeActionPresentation(false)).toEqual({ icon: 'maximize', labelKey: 'window.maximize' });
    expect(maximizeActionPresentation(true)).toEqual({ icon: 'restore', labelKey: 'window.restore' });
  });
});
