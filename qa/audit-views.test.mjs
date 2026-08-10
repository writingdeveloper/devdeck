import { describe, expect, it } from 'vitest';
import { auditableViews } from './audit-views.mjs';

describe('auditableViews', () => {
  it('excludes navigation items that exist but are hidden on the current platform', () => {
    expect(auditableViews([
      { view: 'projects', visible: true },
      { view: 'cockpit', visible: false },
    ])).toEqual(['projects']);
  });
});
