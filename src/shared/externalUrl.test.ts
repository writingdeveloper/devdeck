import { describe, it, expect } from 'vitest';
import { isAllowedExternalUrl, isSafeRepoUrl } from './externalUrl';

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
    // canonical URL-injection vectors — all must be rejected
    expect(isAllowedExternalUrl('https://github.com@evil.com/writingdeveloper/devdeck')).toBe(false); // userinfo injection
    expect(isAllowedExternalUrl('https://github.com./writingdeveloper/devdeck')).toBe(false);          // trailing-dot FQDN
    expect(isAllowedExternalUrl('https://github.com/writingdeveloper/devdeck/../../../passwd')).toBe(false); // path traversal (normalised away)
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });
});

describe('isSafeRepoUrl', () => {
  it('allows any https github.com URL', () => {
    expect(isSafeRepoUrl('https://github.com/someone/their-repo')).toBe(true);
    expect(isSafeRepoUrl('https://github.com/writingdeveloper/devdeck')).toBe(true);
  });
  it('rejects non-https, other hosts, look-alikes, and junk', () => {
    expect(isSafeRepoUrl('http://github.com/someone/repo')).toBe(false);
    expect(isSafeRepoUrl('https://gitlab.com/someone/repo')).toBe(false);
    expect(isSafeRepoUrl('https://github.com.evil.com/someone/repo')).toBe(false);
    expect(isSafeRepoUrl('https://github.com@evil.com/someone/repo')).toBe(false);
    expect(isSafeRepoUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeRepoUrl('not a url')).toBe(false);
  });
});
