// src/main/usageProviders.ts
// Cross-provider orchestration for LIVE subscription limits: one isolated cache entry per provider,
// a single in-flight refresh, and failure containment (one provider's outage never blanks another).
import { PROVIDER_ORDER } from '../shared/providerPresentation';
import { clampPercent, type ProviderUsage, type UsageLimit, type UsageProviderState, type UsageSnapshot } from '../shared/usageWindows';
import { toAgentId, type AgentId } from '../shared/types';

export const USAGE_TTL_MS = 5 * 60_000;

/** Antigravity documents only the interactive `/usage` (`/quota`) and `/credits` panels — there is no
 *  supported programmatic quota read, so DevDeck performs NO I/O here and shows the commands instead. */
export const ANTIGRAVITY_COMMANDS = ['/usage', '/quota', '/credits'];

export function antigravityUsage(now: number): ProviderUsage {
  return {
    providerId: 'antigravity', state: 'unsupported', planLabel: null, limits: [], credits: null,
    guidance: { commands: [...ANTIGRAVITY_COMMANDS] }, fetchedAt: now,
  };
}

const STATES: UsageProviderState[] = ['ready', 'stale', 'login-required', 'expired', 'not-applicable', 'cli-missing', 'offline', 'rate-limited', 'unsupported'];
const KINDS = ['session', 'weekly', 'model-weekly', 'primary', 'secondary'];

function sanitizeLimit(v: unknown): UsageLimit | null {
  if (!v || typeof v !== 'object') return null;
  const l = v as Record<string, unknown>;
  if (typeof l.id !== 'string' || !l.id || l.id.length > 120) return null;
  if (typeof l.kind !== 'string' || !KINDS.includes(l.kind)) return null;
  if (typeof l.label !== 'string' || l.label.length > 80) return null;
  const resetAt = typeof l.resetAt === 'number' && Number.isFinite(l.resetAt) ? l.resetAt : null;
  const modelLabel = typeof l.modelLabel === 'string' ? l.modelLabel.slice(0, 80) : null;
  return { id: l.id, kind: l.kind as UsageLimit['kind'], label: l.label, percent: clampPercent(l.percent), resetAt, modelLabel };
}

/** Re-validate anything read back from disk: a hand-edited or corrupted cache must never reach the UI. */
export function sanitizeProviderUsage(v: unknown): ProviderUsage | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  const providerId = toAgentId(p.providerId);
  if (!providerId) return null;
  if (typeof p.state !== 'string' || !STATES.includes(p.state as UsageProviderState)) return null;
  if (typeof p.fetchedAt !== 'number' || !Number.isFinite(p.fetchedAt)) return null;
  const credits = p.credits && typeof p.credits === 'object' ? p.credits as ProviderUsage['credits'] : null;
  const guidance = p.guidance && typeof p.guidance === 'object' && Array.isArray((p.guidance as { commands?: unknown }).commands)
    ? { commands: ((p.guidance as { commands: unknown[] }).commands).filter((c): c is string => typeof c === 'string').slice(0, 8) }
    : null;
  return {
    providerId,
    state: p.state as UsageProviderState,
    planLabel: typeof p.planLabel === 'string' ? p.planLabel.slice(0, 80) : null,
    limits: Array.isArray(p.limits) ? p.limits.map(sanitizeLimit).filter((l): l is UsageLimit => !!l) : [],
    credits,
    guidance,
    fetchedAt: p.fetchedAt,
    ...(typeof p.staleSince === 'number' && Number.isFinite(p.staleSince) ? { staleSince: p.staleSince } : {}),
  };
}

export interface UsageCoordinatorDeps {
  now(): number;
  load(): unknown;
  save(values: ProviderUsage[]): void;
  providers: Record<AgentId, () => Promise<ProviderUsage>>;
}

/** States that carry no numbers of their own — for these, last-good data is worth keeping as `stale`. */
const DATALESS = new Set<UsageProviderState>(['offline', 'rate-limited', 'expired']);

export class UsageCoordinator {
  private cache = new Map<AgentId, ProviderUsage>();
  private inFlight: Promise<UsageSnapshot> | null = null;

  constructor(private deps: UsageCoordinatorDeps) {
    const loaded = deps.load();
    if (Array.isArray(loaded)) {
      for (const raw of loaded) {
        const value = sanitizeProviderUsage(raw);
        if (value) this.cache.set(value.providerId, value);
      }
    }
  }

  /** Whatever is already known, with no provider work — renders instantly at mount. */
  cached(installed: AgentId[]): UsageSnapshot | null {
    return installed.some((id) => this.cache.has(id)) ? this.snapshot(installed, this.deps.now()) : null;
  }

  refresh(installed: AgentId[], force = false): Promise<UsageSnapshot> {
    if (this.inFlight) return this.inFlight; // a caller arriving mid-refresh reuses it, never duplicates it
    const now = this.deps.now();
    if (!force && installed.length > 0 && installed.every((id) => this.isFresh(this.cache.get(id), now))) {
      return Promise.resolve(this.snapshot(installed, now));
    }
    this.inFlight = this.fetchProviders(installed, now).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private isFresh(value: ProviderUsage | undefined, now: number): boolean {
    return !!value && now - value.fetchedAt < USAGE_TTL_MS;
  }

  private snapshot(installed: AgentId[], now: number): UsageSnapshot {
    const order = PROVIDER_ORDER.filter((id) => installed.includes(id)); // stable display order
    return { providers: order.flatMap((id) => (this.cache.has(id) ? [this.cache.get(id)!] : [])), fetchedAt: now };
  }

  private async fetchProviders(installed: AgentId[], now: number): Promise<UsageSnapshot> {
    const settled = await Promise.allSettled(installed.map((id) => this.deps.providers[id]()));
    settled.forEach((res, i) => {
      const id = installed[i];
      const prev = this.cache.get(id);
      if (res.status === 'fulfilled' && res.value) {
        // A transient failure state must not erase numbers we already had: keep them, marked stale.
        this.cache.set(id, DATALESS.has(res.value.state) && prev && prev.limits.length > 0
          ? { ...prev, state: 'stale', staleSince: prev.staleSince ?? prev.fetchedAt, fetchedAt: now }
          : res.value);
        return;
      }
      this.cache.set(id, prev
        ? { ...prev, state: 'stale', staleSince: prev.staleSince ?? prev.fetchedAt, fetchedAt: now }
        : { providerId: id, state: 'offline', planLabel: null, limits: [], credits: null, guidance: null, fetchedAt: now });
    });
    this.deps.save([...this.cache.values()]);
    return this.snapshot(installed, now);
  }
}
