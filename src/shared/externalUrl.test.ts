import { describe, it, expect } from 'vitest';
import { isAllowedExternalUrl, isSafeRepoUrl, isOpenableTerminalLink } from './externalUrl';

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

describe('isOpenableTerminalLink', () => {
  // Unlike isAllowedExternalUrl (locked to DevDeck's own repo), terminal output is arbitrary:
  // any http/https link the user clicks may open. Everything else (file:, javascript:, etc.) is denied.
  it('allows any http or https URL (the whole point of clickable terminal links)', () => {
    expect(isOpenableTerminalLink('https://access.stripe.com/mcp/oauth2/authorize?response_type=code&state=abc')).toBe(true);
    expect(isOpenableTerminalLink('https://example.com/anything?x=1#y')).toBe(true);
    expect(isOpenableTerminalLink('http://localhost:39824/callback?code=oac_123')).toBe(true);
    expect(isOpenableTerminalLink('HTTPS://UPPER.example.com')).toBe(true); // protocol is case-insensitive
  });
  it('denies non-http(s) schemes that shell.openExternal would otherwise honor', () => {
    expect(isOpenableTerminalLink('file:///etc/passwd')).toBe(false);
    expect(isOpenableTerminalLink('javascript:alert(1)')).toBe(false);
    expect(isOpenableTerminalLink('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isOpenableTerminalLink('vscode://file/etc/passwd')).toBe(false);
    expect(isOpenableTerminalLink('ftp://example.com/x')).toBe(false);
    expect(isOpenableTerminalLink('mailto:a@b.com')).toBe(false);
  });
  it('denies junk and empty input', () => {
    expect(isOpenableTerminalLink('not a url')).toBe(false);
    expect(isOpenableTerminalLink('')).toBe(false);
    expect(isOpenableTerminalLink('https://')).toBe(false);
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
