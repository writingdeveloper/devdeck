import { describe, it, expect } from 'vitest';
import { classifyStaleness, DEFAULT_THRESHOLDS } from './staleness';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

describe('classifyStaleness', () => {
  it('is fresh under a day', () => {
    const r = classifyStaleness(NOW - 2 * 3_600_000, NOW, DEFAULT_THRESHOLDS);
    expect(r.level).toBe('fresh');
    expect(r.badge).toContain('🟢');
  });
  it('is neutral between 1 and 3 days', () => {
    expect(classifyStaleness(NOW - 2 * DAY, NOW, DEFAULT_THRESHOLDS).level).toBe('neutral');
  });
  it('warns between 3 and 7 days', () => {
    const r = classifyStaleness(NOW - 5 * DAY, NOW, DEFAULT_THRESHOLDS);
    expect(r.level).toBe('warn');
    expect(r.badge).toContain('🟡');
  });
  it('is neglected past 7 days', () => {
    const r = classifyStaleness(NOW - 9 * DAY, NOW, DEFAULT_THRESHOLDS);
    expect(r.level).toBe('neglected');
    expect(r.badge).toContain('🔴');
  });
  it('treats null activity as neglected', () => {
    expect(classifyStaleness(null, NOW, DEFAULT_THRESHOLDS).level).toBe('neglected');
  });
});
