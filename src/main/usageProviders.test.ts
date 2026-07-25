// src/main/usageProviders.test.ts
import { describe, it, expect, vi } from 'vitest';
import { UsageCoordinator, antigravityUsage, sanitizeProviderUsage, ANTIGRAVITY_COMMANDS, type UsageCoordinatorDeps } from './usageProviders';
import type { ProviderUsage } from '../shared/usageWindows';
import type { AgentId } from '../shared/types';

const NOW = 1_700_000_000_000;

function usage(providerId: AgentId, over: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    providerId, state: 'ready', planLabel: 'Max', credits: null, guidance: null, fetchedAt: NOW,
    limits: [{ id: `${providerId}:session`, kind: 'session', label: 'usage.limit_session', percent: 10, resetAt: NOW + 1000, modelLabel: null }],
    ...over,
  };
}

function coordinator(over: Partial<UsageCoordinatorDeps> = {}, now = () => NOW) {
  const saved: ProviderUsage[][] = [];
  const deps: UsageCoordinatorDeps = {
    now,
    load: () => [],
    save: (v) => { saved.push(v); },
    providers: {
      claude: async () => usage('claude'),
      codex: async () => usage('codex'),
      antigravity: async () => antigravityUsage(now()),
    },
    ...over,
  };
  return { c: new UsageCoordinator(deps), saved, deps };
}

describe('antigravity adapter', () => {
  it('always returns documented CLI guidance and performs no I/O', () => {
    const r = antigravityUsage(NOW);
    expect(r.state).toBe('unsupported');
    expect(r.guidance).toEqual({ commands: ANTIGRAVITY_COMMANDS });
    expect(r.limits).toEqual([]);
    // It is a pure function of `now` — nothing to spy on means nothing can call out.
    expect(antigravityUsage(NOW)).toEqual(antigravityUsage(NOW));
  });
});

describe('UsageCoordinator', () => {
  it('queries installed providers concurrently and returns them in display order', async () => {
    const order: string[] = [];
    const { c } = coordinator({
      providers: {
        claude: async () => { order.push('claude-start'); await new Promise((r) => setTimeout(r, 20)); order.push('claude-end'); return usage('claude'); },
        codex: async () => { order.push('codex-start'); return usage('codex'); },
        antigravity: async () => antigravityUsage(NOW),
      },
    });
    const snap = await c.refresh(['codex', 'claude']);
    expect(order.slice(0, 2)).toEqual(['codex-start', 'claude-start']); // started before the slow one finished
    expect(snap.providers.map((p) => p.providerId)).toEqual(['claude', 'codex']); // stable order regardless of input
  });

  it('includes only installed providers', async () => {
    const { c } = coordinator();
    const snap = await c.refresh(['claude']);
    expect(snap.providers.map((p) => p.providerId)).toEqual(['claude']);
  });

  it('one provider throwing does not reject the snapshot', async () => {
    const { c } = coordinator({ providers: { claude: async () => usage('claude'), codex: async () => { throw new Error('boom'); }, antigravity: async () => antigravityUsage(NOW) } });
    const snap = await c.refresh(['claude', 'codex']);
    expect(snap.providers.find((p) => p.providerId === 'claude')!.state).toBe('ready');
    expect(snap.providers.find((p) => p.providerId === 'codex')!.state).toBe('offline'); // isolated, no last-good yet
  });

  it('a failed refresh downgrades only that provider to stale and keeps its numbers', async () => {
    let fail = false;
    let t = NOW;
    const { c } = coordinator({
      providers: {
        claude: async () => (fail ? { ...usage('claude', { limits: [], planLabel: null }), state: 'offline' as const, fetchedAt: t } : usage('claude')),
        codex: async () => usage('codex'),
        antigravity: async () => antigravityUsage(t),
      },
    }, () => t);
    await c.refresh(['claude', 'codex']);
    fail = true; t = NOW + 10 * 60_000;
    const snap = await c.refresh(['claude', 'codex'], true);
    const claude = snap.providers.find((p) => p.providerId === 'claude')!;
    expect(claude.state).toBe('stale');
    expect(claude.limits[0].percent).toBe(10);      // last-good numbers survive
    expect(claude.staleSince).toBe(NOW);            // and the UI can say how old they are
    expect(snap.providers.find((p) => p.providerId === 'codex')!.state).toBe('ready');
  });

  it('serves cache within the TTL without touching providers, and force bypasses it', async () => {
    let calls = 0;
    let t = NOW;
    const { c } = coordinator({ providers: { claude: async () => { calls++; return usage('claude'); }, codex: async () => usage('codex'), antigravity: async () => antigravityUsage(t) } }, () => t);
    await c.refresh(['claude']);
    expect(calls).toBe(1);
    t = NOW + 60_000;
    await c.refresh(['claude']);
    expect(calls).toBe(1); // still fresh
    await c.refresh(['claude'], true);
    expect(calls).toBe(2); // force
    t = NOW + 10 * 60_000;
    await c.refresh(['claude']);
    expect(calls).toBe(3); // past the TTL
  });

  it('a second call during a refresh reuses the same promise', async () => {
    let calls = 0;
    let release: (() => void) | null = null;
    const { c } = coordinator({ providers: {
      claude: async () => { calls++; await new Promise<void>((r) => { release = r; }); return usage('claude'); },
      codex: async () => usage('codex'), antigravity: async () => antigravityUsage(NOW),
    } });
    const a = c.refresh(['claude']);
    const b = c.refresh(['claude']);
    expect(a).toBe(b);
    release!();
    await a;
    expect(calls).toBe(1);
  });

  it('cached() answers instantly and is null before anything is known', async () => {
    const { c } = coordinator();
    expect(c.cached(['claude'])).toBeNull();
    await c.refresh(['claude']);
    expect(c.cached(['claude'])!.providers[0].providerId).toBe('claude');
  });

  it('persists a validated array and rejects junk on load', async () => {
    const { c, saved } = coordinator();
    await c.refresh(['claude', 'codex']);
    expect(saved.at(-1)!.map((p) => p.providerId).sort()).toEqual(['claude', 'codex']);

    const load = vi.fn(() => [
      usage('claude'),
      { providerId: 'evil', state: 'ready', fetchedAt: NOW },     // unknown provider
      { providerId: 'codex', state: 'weird', fetchedAt: NOW },    // unknown state
      { providerId: 'codex', state: 'ready', fetchedAt: 'soon' }, // bad timestamp
    ]);
    const restored = new UsageCoordinator({ ...coordinator({ load }).deps, load });
    expect(restored.cached(['claude', 'codex'])!.providers.map((p) => p.providerId)).toEqual(['claude']);
  });
});

describe('sanitizeProviderUsage', () => {
  it('clamps percentages, drops malformed limits, and caps labels', () => {
    const r = sanitizeProviderUsage({
      providerId: 'claude', state: 'ready', fetchedAt: NOW, planLabel: 'P'.repeat(200),
      limits: [
        { id: 'ok', kind: 'session', label: 'usage.limit_session', percent: 500, resetAt: NOW, modelLabel: 'M'.repeat(200) },
        { id: 'bad-kind', kind: 'nope', label: 'x', percent: 1, resetAt: null, modelLabel: null },
        { kind: 'session', label: 'x', percent: 1 }, // no id
        'junk',
      ],
    })!;
    expect(r.planLabel).toHaveLength(80);
    expect(r.limits).toHaveLength(1);
    expect(r.limits[0].percent).toBe(100);
    expect(r.limits[0].modelLabel).toHaveLength(80);
  });

  it('rejects non-objects and unknown provider ids', () => {
    expect(sanitizeProviderUsage(null)).toBeNull();
    expect(sanitizeProviderUsage({ providerId: 'gpt', state: 'ready', fetchedAt: NOW })).toBeNull();
  });
});
