import { describe, it, expect } from 'vitest';
import { isAllowedExternalUrl } from './externalUrl';

describe('isAllowedExternalUrl', () => {
  it('allows the repo root and sub-paths', () => {
    expect(isAllowedExternalUrl('https://github.com/writingdeveloper/devdeck')).toBe(true);
    expect(isAllowedExternalUrl('https://github.com/writingdeveloper/devdeck/releases/latest')).toBe(true);
    expect(isAllowedExternalUrl('https://github.com/writingdeveloper/devdeck/issues')).toBe(true);
    expect(isAllowedExternalUrl('https://github.com/writingdeveloper/devdeck/blob/main/LICENSE')).toBe(true);
  });
  it('rejects other hosts, schemes, look-alikes, and junk', () => {
    expect(isAllowedExternalUrl('https://github.com/someoneelse/repo')).toBe(false);
    expect(isAllowedExternalUrl('https://github.com.evil.com/writingdeveloper/devdeck')).toBe(false);
    expect(isAllowedExternalUrl('http://github.com/writingdeveloper/devdeck')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('https://github.com/writingdeveloper/devdeck-evil')).toBe(false);
    expect(isAllowedExternalUrl('not a url')).toBe(false);
  });
});
