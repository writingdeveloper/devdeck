import { describe, it, expect } from 'vitest';
import { usageInFlightKey } from './usageInFlightKey';

describe('usageInFlightKey', () => {
  it('shares a scan between two asks for the same range on the same day', () => {
    const base = Date.UTC(2026, 8, 1, 12, 0, 0);
    const sevenDays = 7 * 86_400_000;
    expect(usageInFlightKey(base - sevenDays)).toBe(usageInFlightKey(base - sevenDays + 5_000));
  });

  it('keeps "everything" apart from a bounded range', () => {
    expect(usageInFlightKey(0)).toBe('0');
    expect(usageInFlightKey(Infinity)).toBe('all');
    expect(usageInFlightKey(0)).not.toBe(usageInFlightKey(Date.UTC(2026, 8, 1)));
    expect(usageInFlightKey(NaN)).toBe('0');
  });
});
