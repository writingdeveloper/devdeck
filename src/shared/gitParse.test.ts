import { describe, it, expect } from 'vitest';
import { parseBranch, parseLastCommit, parsePorcelainCount, parseAheadCount, parseRemoteUrl } from './gitParse';

describe('parseBranch', () => {
  it('trims branch output', () => {
    expect(parseBranch('main\n')).toBe('main');
  });
  it('returns null for empty', () => {
    expect(parseBranch('   ')).toBeNull();
  });
});

describe('parseLastCommit', () => {
  it('splits epoch-seconds and subject into ms + text', () => {
    expect(parseLastCommit('1717287840|scaffold Vite+TS\n')).toEqual({
      lastCommitMs: 1717287840000,
      lastSubject: 'scaffold Vite+TS',
    });
  });
  it('keeps pipes that appear inside the subject', () => {
    expect(parseLastCommit('1717287840|feat: a | b')).toEqual({
      lastCommitMs: 1717287840000,
      lastSubject: 'feat: a | b',
    });
  });
  it('returns nulls for empty output (repo with no commits)', () => {
    expect(parseLastCommit('')).toEqual({ lastCommitMs: null, lastSubject: null });
  });
});

describe('parsePorcelainCount', () => {
  it('counts non-empty lines', () => {
    expect(parsePorcelainCount(' M a.ts\n?? b.ts\n')).toBe(2);
  });
  it('returns 0 for a clean tree', () => {
    expect(parsePorcelainCount('')).toBe(0);
  });
});

describe('parseAheadCount', () => {
  it('parses the unpushed (ahead-of-upstream) commit count', () => {
    expect(parseAheadCount('3\n')).toBe(3);
    expect(parseAheadCount('0\n')).toBe(0);
  });
  it('returns null when there is no upstream or output is unparseable', () => {
    expect(parseAheadCount('')).toBeNull();
    expect(parseAheadCount('   ')).toBeNull();
    expect(parseAheadCount('fatal: no upstream configured')).toBeNull();
  });
});

describe('parseRemoteUrl', () => {
  const want = 'https://github.com/writingdeveloper/devdeck';
  it('normalizes the scp-like SSH form', () => {
    expect(parseRemoteUrl('git@github.com:writingdeveloper/devdeck.git\n')).toBe(want);
    expect(parseRemoteUrl('git@github.com:writingdeveloper/devdeck')).toBe(want);
  });
  it('normalizes the https form, stripping .git and trailing slash', () => {
    expect(parseRemoteUrl('https://github.com/writingdeveloper/devdeck.git')).toBe(want);
    expect(parseRemoteUrl('https://github.com/writingdeveloper/devdeck/')).toBe(want);
  });
  it('normalizes the ssh:// form and ignores userinfo + host case', () => {
    expect(parseRemoteUrl('ssh://git@github.com/writingdeveloper/devdeck.git')).toBe(want);
    expect(parseRemoteUrl('https://GitHub.com/writingdeveloper/devdeck')).toBe(want);
  });
  it('returns null for non-github hosts, empty, or unparseable input', () => {
    expect(parseRemoteUrl('git@gitlab.com:owner/repo.git')).toBeNull();
    expect(parseRemoteUrl('https://bitbucket.org/owner/repo')).toBeNull();
    expect(parseRemoteUrl('')).toBeNull();
    expect(parseRemoteUrl('   ')).toBeNull();
    expect(parseRemoteUrl('not a url')).toBeNull();
  });
  it('returns null when the path is not exactly owner/repo', () => {
    expect(parseRemoteUrl('https://github.com/writingdeveloper')).toBeNull();
    expect(parseRemoteUrl('https://github.com/a/b/c')).toBeNull();
  });
});
