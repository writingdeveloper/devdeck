import type { PtySessionInfo } from './ptyHost';
import type { PersistedSession } from '../shared/cockpitPersist';
import { createCockpitTileId, sanitizePersistedList } from '../shared/cockpitPersist';
import { LOCAL_MACHINE_ID } from '../shared/link/machine';
import { sameScope } from '../shared/sessionIdentity';
import { normalizeSessionLabel, hasLabelVersion, type SessionLabelResult, type SessionLabelSnapshot } from '../shared/sessionLabel';
import { basename } from '../shared/paths';

export interface LabelDependencies {
  list(): PtySessionInfo[];
  load(): PersistedSession[];
  save(entries: PersistedSession[]): void;
  note(id: string, patch: { label: string | null }): boolean;
  announce(): void;
}
function matches(entry: PersistedSession, info: PtySessionInfo): boolean {
  if ((entry.machineId ?? LOCAL_MACHINE_ID) !== LOCAL_MACHINE_ID || !sameScope(entry, info)) return false;
  return (!!info.instanceId && entry.runtimeId === info.instanceId)
    || (!!info.sessionId && entry.sessionId === info.sessionId);
}
function snapshot(info: PtySessionInfo): SessionLabelSnapshot {
  if (!hasLabelVersion(info)) throw new Error('Session metadata does not support confirmed renames');
  return { label: info.label, labelRevision: info.labelRevision, instanceId: info.instanceId };
}
/** Host-owned transaction: validate, persist, update runtime state, announce, acknowledge. */
export function createSessionLabels(deps: LabelDependencies) {
  return {
    /** Membership/pins are viewer-local; stale UI saves cannot rewrite live host-owned titles. */
    reconcile(entries: unknown): PersistedSession[] {
      const running = deps.list();
      return sanitizePersistedList(entries).map(entry => {
        const owner = running.find(info => matches(entry, info));
        return owner ? { ...entry, label: owner.label, runtimeId: owner.instanceId } : entry;
      });
    },
    rename(id: string, label: unknown, expected: unknown): SessionLabelResult {
      if (!hasLabelVersion(expected)) throw new Error('Update both machines for confirmed session renames');
      const info = deps.list().find(info => info.id === id);
      if (!info) return { ok: false, reason: 'missing' };
      const current = snapshot(info);
      if (current.instanceId !== expected.instanceId || current.labelRevision !== expected.labelRevision)
        return { ok: false, reason: 'conflict', snapshot: current };
      const next = normalizeSessionLabel(label);
      if (next === current.label) return { ok: true, snapshot: current };
      const entries = deps.load();
      const found = entries.findIndex(entry => matches(entry, info));
      if (found >= 0) entries[found] = { ...entries[found], label: next, runtimeId: info.instanceId };
      else entries.unshift({ tileId: createCockpitTileId(), projectPath: info.projectPath, name: basename(info.projectPath),
        sessionId: info.sessionId, agentId: info.agentId, runtimeId: info.instanceId, label: next });
      // No await between compare and commit. Failed persistence leaves runtime and peers unchanged.
      deps.save(entries);
      deps.note(id, { label: next });
      deps.announce();
      return { ok: true, snapshot: { ...current, label: next, labelRevision: current.labelRevision + 1 } };
    },
  };
}
