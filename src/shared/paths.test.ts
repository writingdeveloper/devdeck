import { describe, it, expect } from 'vitest';
import { encodeProjectPath, cwdKey, parentLabel } from './paths';

// The settings row used to ellipsise the full path on the right, cutting off the folder's own name —
// the only part that identifies it. The name is its own element now; this captions where it lives.
describe('parentLabel', () => {
  it('names the immediate parent, marking that there is more path above it', () => {
    expect(parentLabel('C:\\Users\\me\\Documents\\GitHub\\devdeck')).toBe('…/GitHub');
    expect(parentLabel('/home/me/src/devdeck')).toBe('…/src');
  });
  it('omits the ellipsis when the parent IS the whole prefix', () => {
    expect(parentLabel('/src/devdeck')).toBe('src');
    // A drive letter is a segment like any other, so there genuinely is something above `GitHub`.
    expect(parentLabel('C:\\GitHub\\devdeck')).toBe('…/GitHub');
  });
  it('has nothing to say for a root or a bare name', () => {
    expect(parentLabel('C:\\')).toBe('');
    expect(parentLabel('devdeck')).toBe('');
    expect(parentLabel('')).toBe('');
  });
  it('tolerates trailing separators and mixed slashes', () => {
    expect(parentLabel('C:/Users/me/GitHub/devdeck/')).toBe('…/GitHub');
  });
});

describe('encodeProjectPath', () => {
  it('encodes a Windows path the way Claude names its session dir', () => {
    expect(encodeProjectPath('C:\\Users\\dev\\Documents\\GitHub\\repo-one'))
      .toBe('C--Users-dev-Documents-GitHub-repo-one');
  });

  it('encodes the base dir itself', () => {
    expect(encodeProjectPath('C:\\Users\\dev\\Documents\\GitHub'))
      .toBe('C--Users-dev-Documents-GitHub');
  });

  it('replaces spaces the way Claude does (folder names with spaces)', () => {
    expect(encodeProjectPath('C:\\Users\\dev\\Documents\\GitHub\\Youtube Lythem Game'))
      .toBe('C--Users-dev-Documents-GitHub-Youtube-Lythem-Game');
  });

  it('replaces dots and other non-alphanumerics with a dash', () => {
    expect(encodeProjectPath('C:\\Users\\dev\\repo\\.claude\\worktrees\\vibe-music'))
      .toBe('C--Users-dev-repo--claude-worktrees-vibe-music');
  });
});

describe('cwdKey', () => {
  it('matches the same Windows project however the shell spelled it', () => {
    const want = cwdKey('C:\\Users\\dev\\proj');
    expect(cwdKey('c:/users/dev/proj')).toBe(want);
    expect(cwdKey('C:\\Users\\dev\\proj\\')).toBe(want);
    expect(cwdKey('C:/Users/dev//proj')).toBe(want);
  });

  it('keeps different projects apart', () => {
    expect(cwdKey('C:\\g\\proj')).not.toBe(cwdKey('C:\\g\\proj-two'));
  });

  it('does not fold case for POSIX paths (genuinely case-sensitive)', () => {
    expect(cwdKey('/home/dev/Proj')).toBe('\\home\\dev\\Proj');
    expect(cwdKey('/home/dev/Proj')).not.toBe(cwdKey('/home/dev/proj'));
  });
});
