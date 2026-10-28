import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions, FEATURES, featuresAfter, whatsNewOnStart } from './whatsNew';

describe('when the What\'s new window opens', () => {
  it('opens once after an update, never on a first run, and not again for the same version', () => {
    expect(whatsNewOnStart('1.42.0', '1.41.0', true)).toEqual({ show: true, after: '1.41.0' });
    expect(whatsNewOnStart('1.42.0', '1.42.0', true)).toEqual({ show: false, after: '1.42.0' });
    // Before 1.42.0 nothing was recorded: an install that was used before is an upgrade.
    expect(whatsNewOnStart('1.42.0', null, true)).toEqual({ show: true, after: null });
    expect(whatsNewOnStart('1.42.0', null, false)).toEqual({ show: false, after: null });
  });

  it('lists only what is newer than what was last shown, newest first', () => {
    expect(featuresAfter('1.41.0').map((f) => f.version)).toEqual(['1.49.0', '1.46.0', '1.45.0', '1.44.0', '1.43.0', '1.42.0']);
    const all = featuresAfter(null).map((f) => f.version);
    expect(all[0]).toBe('1.49.0');
    expect([...all].sort((a, b) => compareVersions(b, a))).toEqual(all);
  });

  it('compares versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.41.0', '1.41.0')).toBe(0);
  });

  it('has every feature described in every language', () => {
    for (const lang of ['en', 'ko', 'ja', 'zh']) {
      const dict = JSON.parse(readFileSync(join(__dirname, 'locales', `${lang}.json`), 'utf8')) as Record<string, string>;
      for (const f of FEATURES) for (const part of ['title', 'body', 'where']) {
        expect(dict[`whatsnew.f.${f.id}.${part}`], `${lang} ${f.id}.${part}`).toBeTruthy();
      }
    }
  });
});
