import type { ShellContext } from './shellNavigation';

type RestoreDecision = ShellContext | null;

function requestedContext(saved: unknown): ShellContext | null {
  if (!saved || typeof saved !== 'object') return null;
  const value = saved as { kind?: unknown; id?: unknown; path?: unknown };
  if (value.kind === 'project' && typeof value.path === 'string') return { kind: 'project', path: value.path };
  if (value.kind === 'session' && typeof value.id === 'string') return { kind: 'session', id: value.id };
  if (value.kind === 'view' && (value.id === 'projects' || value.id === 'next' || value.id === 'usage' || value.id === 'settings')) {
    return { kind: 'view', id: value.id };
  }
  return null;
}

export interface ContextRestoreCoordinator {
  immediate(): RestoreDecision;
  projectsLoaded(paths: ReadonlySet<string>): RestoreDecision;
  sessionsLoaded(ids: ReadonlySet<string>, aliases?: ReadonlyMap<string, string>): RestoreDecision;
  cancel(): void;
}

/** A selection/identity callback may synchronize state only while Cockpit is still the active context. */
export function cockpitIdentityContext(activeView: string, id: string): Extract<ShellContext, { kind: 'session' }> | null {
  return activeView === 'cockpit' ? { kind: 'session', id } : null;
}

export function createContextRestoreCoordinator(saved: unknown, cockpitAvailable: boolean): ContextRestoreCoordinator {
  let pending = requestedContext(saved);

  const decide = (decision: ShellContext): ShellContext => {
    pending = null;
    return decision;
  };

  return {
    immediate() {
      if (!pending || pending.kind !== 'view') return null;
      return decide(pending);
    },
    projectsLoaded(paths) {
      if (!pending) return null;
      if (pending.kind === 'project') return decide(paths.has(pending.path) ? pending : { kind: 'view', id: 'projects' });
      return null;
    },
    sessionsLoaded(ids, aliases = new Map()) {
      if (!pending || pending.kind !== 'session') return null;
      const canonical = ids.has(pending.id) ? pending.id : aliases.get(pending.id);
      return decide(cockpitAvailable && canonical && ids.has(canonical)
        ? { kind: 'session', id: canonical }
        : { kind: 'view', id: 'projects' });
    },
    cancel() {
      pending = null;
    },
  };
}
