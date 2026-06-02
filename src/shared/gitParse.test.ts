import { describe, it, expect } from 'vitest';
import { parseBranch, parseLastCommit, parsePorcelainCount } from './gitParse';

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
