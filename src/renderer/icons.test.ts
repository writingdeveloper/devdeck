import { describe, expect, it } from 'vitest';
import { iconMarkup, type IconName } from './icons';

describe('iconMarkup', () => {
  it('returns local, currentColor SVG markup for every shell icon', () => {
    const names: IconName[] = [
      'search', 'projects', 'sessions', 'tasks', 'usage', 'settings',
      'refresh', 'more', 'play', 'panel-left',
    ];

    for (const name of names) {
      expect(iconMarkup(name)).toContain('<svg');
      expect(iconMarkup(name)).toContain('stroke="currentColor"');
      expect(iconMarkup(name)).not.toContain('http');
    }
  });
});
