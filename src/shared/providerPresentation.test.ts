import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDER_PRESENTATION, providerPresentation } from './providerPresentation';

describe('provider presentation', () => {
  it('defines a local SVG and an i18n name for every provider', () => {
    expect(Object.keys(PROVIDER_PRESENTATION).sort()).toEqual(['antigravity', 'claude', 'codex']);
    for (const item of Object.values(PROVIDER_PRESENTATION)) {
      expect(item.logoSrc).toMatch(/^\.\/assets\/provider-[a-z]+\.svg$/);
      expect(item.nameKey).toMatch(/^agent\./);
    }
  });

  it('falls back to Claude for an unknown id (legacy persisted state)', () => {
    expect(providerPresentation('claude')).toBe(PROVIDER_PRESENTATION.claude);
    expect(providerPresentation('nope' as never)).toBe(PROVIDER_PRESENTATION.claude);
  });

  // The renderer runs under `connect-src 'none'` — a mark that pulled in a remote image, font, or
  // script would silently fail to render (and would leak a request if the CSP ever loosened).
  it('ships each mark as a self-contained local SVG', () => {
    for (const item of Object.values(PROVIDER_PRESENTATION)) {
      const file = join(process.cwd(), 'src', 'assets', item.logoSrc.replace('./assets/', ''));
      const svg = readFileSync(file, 'utf8');
      expect(svg).toContain('viewBox="0 0 24 24"');
      expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/); // xmlns is the only allowed absolute URL
      expect(svg).not.toMatch(/<script|<image|@import|data:/i);
      expect(svg).not.toMatch(/url\((?!#)/i); // url(#localGradient) is fine; anything else would fetch
    }
  });
});
