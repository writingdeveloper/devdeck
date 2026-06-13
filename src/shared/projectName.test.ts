import { describe, it, expect } from 'vitest';
import { validateProjectName } from './projectName';

describe('validateProjectName', () => {
  it('accepts an ordinary name and returns it unchanged', () => {
    expect(validateProjectName('my-app')).toEqual({ ok: true, name: 'my-app' });
  });

  it('allows spaces, dots and hyphens inside the name', () => {
    expect(validateProjectName('Youtube Lythem Game')).toEqual({ ok: true, name: 'Youtube Lythem Game' });
    expect(validateProjectName('my.project')).toEqual({ ok: true, name: 'my.project' });
    expect(validateProjectName('a_b-c')).toEqual({ ok: true, name: 'a_b-c' });
  });

  it('trims surrounding whitespace into the canonical name', () => {
    expect(validateProjectName('  spaced  ')).toEqual({ ok: true, name: 'spaced' });
  });

  it('rejects empty or whitespace-only names', () => {
    expect(validateProjectName('')).toEqual({ ok: false, reason: 'empty' });
    expect(validateProjectName('   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects every illegal path character', () => {
    for (const ch of ['<', '>', ':', '"', '/', '\\', '|', '?', '*']) {
      expect(validateProjectName(`a${ch}b`)).toEqual({ ok: false, reason: 'chars' });
    }
  });

  it('rejects "." and ".."', () => {
    expect(validateProjectName('.')).toEqual({ ok: false, reason: 'chars' });
    expect(validateProjectName('..')).toEqual({ ok: false, reason: 'chars' });
  });

  it('rejects a trailing dot (Windows would strip it)', () => {
    expect(validateProjectName('build.')).toEqual({ ok: false, reason: 'chars' });
  });

  it('rejects Windows reserved device names, bare or with extension', () => {
    for (const n of ['con', 'NUL', 'Com1', 'lpt9', 'aux.txt']) {
      expect(validateProjectName(n)).toEqual({ ok: false, reason: 'reserved' });
    }
  });

  it('does not flag names that merely start with a reserved word', () => {
    expect(validateProjectName('console')).toEqual({ ok: true, name: 'console' });
    expect(validateProjectName('communications')).toEqual({ ok: true, name: 'communications' });
  });

  it('rejects names longer than 100 characters', () => {
    expect(validateProjectName('a'.repeat(101))).toEqual({ ok: false, reason: 'long' });
    expect(validateProjectName('a'.repeat(100)).ok).toBe(true);
  });
});
