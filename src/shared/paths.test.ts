import { describe, it, expect } from 'vitest';
import { encodeProjectPath, cwdKey } from './paths';

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
