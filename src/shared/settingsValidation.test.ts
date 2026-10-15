import { describe, it, expect } from 'vitest';
import { validThresholds } from './settingsValidation';
describe('settings day-count validation', () => {
  it.each([null, {}, { freshDays: 999, warnDays: 7, neglectedDays: 14 },
    { freshDays: Infinity, warnDays: Infinity, neglectedDays: Infinity },
    { freshDays: 1.5, warnDays: 7, neglectedDays: 14 },
    { freshDays: 0, warnDays: 7, neglectedDays: 14 },
    { freshDays: '3', warnDays: 7, neglectedDays: 14 },
    { freshDays: NaN, warnDays: 7, neglectedDays: 14 }])('rejects invalid input %j', value => {
    expect(validThresholds(value)).toBe(false);
  });
  it('accepts ordered positive whole days and equal thresholds', () => {
    expect(validThresholds({ freshDays: 3, warnDays: 7, neglectedDays: 14 })).toBe(true);
    expect(validThresholds({ freshDays: 7, warnDays: 7, neglectedDays: 7 })).toBe(true);
  });
});
