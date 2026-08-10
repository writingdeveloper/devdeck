import { describe, expect, it } from 'vitest';
import { createContextRestoreCoordinator } from './contextRestore';

describe('context restoration', () => {
  it('restores a saved project after projects finish loading', () => {
    const restore = createContextRestoreCoordinator({ kind: 'project', path: 'C:/repo' }, true);

    expect(restore.projectsLoaded(new Set(['C:/repo']))).toEqual({ kind: 'project', path: 'C:/repo' });
    expect(restore.projectsLoaded(new Set(['C:/repo']))).toBeNull();
    expect(restore.sessionsLoaded(new Set(['session-1']))).toBeNull();
  });

  it('falls back to and persists Projects only after a missing project source loads', () => {
    const restore = createContextRestoreCoordinator({ kind: 'project', path: 'C:/gone' }, true);

    expect(restore.sessionsLoaded(new Set(['session-1']))).toBeNull();
    expect(restore.projectsLoaded(new Set(['C:/repo']))).toEqual({ kind: 'view', id: 'projects' });
  });

  it('restores a saved session after sessions finish loading', () => {
    const restore = createContextRestoreCoordinator({ kind: 'session', id: 'session-1' }, true);

    expect(restore.projectsLoaded(new Set(['C:/repo']))).toBeNull();
    expect(restore.sessionsLoaded(new Set(['session-1']))).toEqual({ kind: 'session', id: 'session-1' });
    expect(restore.sessionsLoaded(new Set(['session-1']))).toBeNull();
  });

  it('falls back to Projects for a missing or unavailable saved session', () => {
    const missing = createContextRestoreCoordinator({ kind: 'session', id: 'gone' }, true);
    const unavailable = createContextRestoreCoordinator({ kind: 'session', id: 'session-1' }, false);

    expect(missing.sessionsLoaded(new Set(['session-1']))).toEqual({ kind: 'view', id: 'projects' });
    expect(unavailable.sessionsLoaded(new Set(['session-1']))).toEqual({ kind: 'view', id: 'projects' });
  });

  it('does not restore after cancellation before delayed data arrives', () => {
    const restore = createContextRestoreCoordinator({ kind: 'session', id: 'session-1' }, true);

    restore.cancel();
    expect(restore.projectsLoaded(new Set(['C:/repo']))).toBeNull();
    expect(restore.sessionsLoaded(new Set(['session-1']))).toBeNull();
  });
});
