import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store';
import { createSessionLabels } from './sessionLabels';
import type { PtySessionInfo } from './ptyHost';
import { normalizeSessionLabel } from '../shared/sessionLabel';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'devdeck-labels-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
function fixture(sessionId: string | null = 'conversation') {
  const file = join(dir, 'state.json'), store = new Store(file);
  const info: PtySessionInfo = { id: 'runtime', projectPath: 'C:\\repo', sessionId, agentId: 'claude',
    label: null, labelRevision: 0, instanceId: 'incarnation', startedAtMs: 1 };
  const events: string[] = [];
  const service = createSessionLabels({ list: () => [{ ...info }], load: () => store.getCockpitSessions(),
    save: entries => { store.setCockpitSessions(entries); events.push('saved'); },
    note: (_, patch) => { expect(new Store(file).getCockpitSessions()[0].label).toBe(patch.label); info.label = patch.label; info.labelRevision!++; events.push('runtime'); return true; },
    announce: () => { events.push('announced'); },
  });
  return { file, store, info, events, service };
}
describe('host-owned session title transaction', () => {
  it.each(['conversation', null])('persists before announcement including id-less sessions: %s', sessionId => {
    const f = fixture(sessionId);
    expect(f.service.rename('runtime', '  Release  ', f.info)).toEqual({ ok: true, snapshot: { label: 'Release', labelRevision: 1, instanceId: 'incarnation' } });
    expect(f.events).toEqual(['saved', 'runtime', 'announced']);
    expect(new Store(f.file).getCockpitSessions()[0]).toMatchObject({ label: 'Release', runtimeId: 'incarnation', sessionId });
  });
  it('does not publish or mutate runtime on disk failure; same revision is retryable', () => {
    const f = fixture(); mkdirSync(f.file + '.tmp');
    expect(() => f.service.rename('runtime', 'unsaved', f.info)).toThrow();
    expect(f.info.label).toBeNull(); expect(f.events).toEqual([]);
    rmSync(f.file + '.tmp', { recursive: true });
    expect(f.service.rename('runtime', 'retry', f.info).ok).toBe(true);
  });
  it('rejects stale revisions and old terminal incarnations', () => {
    const f = fixture(), stale = { ...f.info };
    f.service.rename('runtime', 'winner', stale);
    expect(f.service.rename('runtime', 'loser', stale)).toMatchObject({ ok: false, reason: 'conflict', snapshot: { label: 'winner' } });
    expect(f.service.rename('runtime', 'old instance', { ...f.info, instanceId: 'another' })).toMatchObject({ ok: false, reason: 'conflict' });
    expect(f.events).toHaveLength(3);
  });
  it('clear is a committed null, not permission to restore a cached name', () => {
    const f = fixture(); f.service.rename('runtime', 'old', f.info);
    const cached = f.store.getCockpitSessions();
    f.service.rename('runtime', '  ', f.info);
    expect(f.service.reconcile(cached)[0].label).toBeNull();
    expect(new Store(f.file).getCockpitSessions()[0].label).toBeNull();
  });
  it('does not let stale UI membership saves overwrite owner labels or remote records', () => {
    const f = fixture(); f.service.rename('runtime', 'owner title', f.info);
    const entries = f.store.getCockpitSessions();
    entries[0].label = 'stale'; entries[0].pinned = true;
    const remote = { ...entries[0], tileId: 'remote', machineId: '11111111-2222-4333-8444-555555555555', label: 'remote title' };
    const merged = f.service.reconcile([...entries, remote]);
    expect(merged[0]).toMatchObject({ label: 'owner title', pinned: true });
    expect(merged[1].label).toBe('remote title');
  });
  it('no-op makes no extra disk write or announcement; missing session is explicit', () => {
    const f = fixture(); expect(f.service.rename('runtime', '', f.info).ok).toBe(true);
    expect(f.events).toEqual([]);
    expect(f.service.rename('gone', 'x', f.info)).toEqual({ ok: false, reason: 'missing' });
  });
  it.each([undefined, {}, { instanceId: 'a', labelRevision: -1 }, { instanceId: '', labelRevision: 0 }])('refuses unversioned/malformed writes: %j', version => {
    const f = fixture(); expect(() => f.service.rename('runtime', 'x', version)).toThrow(/both machines/);
  });
  it('a seeded interleaving of stale readers never replaces a successful later commit', () => {
    const f = fixture(); let seed = 418; let expectedLabel: string | null = null, revision = 0;
    const clients = Array.from({ length: 3 }, () => ({ ...f.info }));
    for (let i = 0; i < 90; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const index = seed % 3, client = clients[index], label = i % 7 ? 'title-' + i : null;
      const result = f.service.rename('runtime', label, client);
      if (client.labelRevision === revision) {
        expect(result.ok).toBe(true);
        if (label !== expectedLabel) revision++;
        expectedLabel = label;
      } else expect(result).toMatchObject({ ok: false, reason: 'conflict' });
      expect(f.info.labelRevision).toBe(revision); expect(f.info.label).toBe(expectedLabel);
      clients[index] = { ...f.info };
    }
  });
  it('normalizes pasted controls and bounds titles', () => {
    expect(normalizeSessionLabel(' a\nb\t ')).toBe('a b');
    expect(normalizeSessionLabel('x'.repeat(100))).toHaveLength(60);
    expect(normalizeSessionLabel({})).toBeNull();
  });
});
