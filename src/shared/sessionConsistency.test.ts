import { describe, it, expect } from 'vitest';
import { conversationKey, sameScope } from './sessionIdentity';
import { acceptsLabelVersion } from './sessionLabel';
import { SessionReadGate } from './sessionReadGate';
import { adoptRestorableMatch, removeAutoRestoreMatches, sanitizePersistedList } from './cockpitPersist';
const a = { name: 'repo', projectPath: 'C:\\repo', agentId: 'claude', sessionId: 'same-id', tileId: 'first', label: 'old' };
const remote = { ...a, tileId: 'remote', machineId: '11111111-2222-4333-8444-555555555555' };
describe('session ownership invariants', () => {
  it('all machine, project, provider and conversation fields participate in identity', () => {
    expect(new Set([a, remote, { ...a, projectPath: 'C:\\other' }, { ...a, agentId: 'codex' }].map(conversationKey)).size).toBe(4);
    expect(sameScope(a, { ...a, projectPath: 'c:/REPO/' })).toBe(true);
    expect(sameScope({ ...a, projectPath: '/Work' }, { ...a, projectPath: '/work' })).toBe(false);
  });
  it('saved-list sanitization keeps unrelated conversations that reused an id', () => {
    const list = sanitizePersistedList([a, remote, { ...a, tileId: 'codex', agentId: 'codex' }, { ...a, tileId: 'project', projectPath: 'C:\\other' }]);
    expect(list).toHaveLength(4);
  });
  it('adoption consumes only the matching owner and preserves an explicit clear', () => {
    const list = sanitizePersistedList([a, remote]);
    const adopted = adoptRestorableMatch(list, a.sessionId, { label: null, pinned: false, scope: a, authoritativeLabel: true });
    expect(adopted.label).toBeNull(); expect(adopted.rest).toEqual([list[1]]);
  });
  it('id-less live adoption consumes only its exact saved tile, not its siblings', () => {
    const list = sanitizePersistedList([{ ...a, sessionId: null }, { ...a, sessionId: null, tileId: 'sibling' }]);
    const adopted = adoptRestorableMatch(list, null, { tileId: a.tileId, label: null, pinned: false, scope: a, authoritativeLabel: true });
    expect(adopted.rest).toEqual([list[1]]); expect(adopted.label).toBeNull();
  });
  it('legacy restore fallback cannot remove another machine record', () => {
    const migrated = { ...a, tileId: 'different-migration' };
    expect(removeAutoRestoreMatches([remote], [migrated])).toEqual([remote]);
  });
  it('a late reply never overwrites a newer announcement or another terminal instance', () => {
    const current = { instanceId: 'running', labelRevision: 4 };
    expect(acceptsLabelVersion(current, { ...current, labelRevision: 3 })).toBe(false);
    expect(acceptsLabelVersion(current, { ...current, instanceId: 'old-process' })).toBe(false);
    expect(acceptsLabelVersion(current, current)).toBe(true);
  });
  it('a push or newer read cancels an old pull only for its own machine', () => {
    const gate = new SessionReadGate();
    const a = gate.begin('host-A'), b = gate.begin('host-B');
    gate.begin('host-A');
    expect(gate.current('host-A', a)).toBe(false);
    expect(gate.current('host-B', b)).toBe(true);
    const fresh = gate.begin('host-A'); expect(gate.current('host-A', fresh)).toBe(true);
  });
});
