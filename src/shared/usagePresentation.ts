// src/shared/usagePresentation.ts
// Pure helpers behind the one-line usage footer. Kept out of the renderer so the "which number does
// the user most need to see" rule is unit-tested rather than tangled with DOM code.
import { usageSeverity, type ProviderUsage, type Severity, type UsageLimit, type UsageSnapshot } from './usageWindows';
import type { AgentId } from './types';

export interface UsageSummary {
  /** 'limit' = a real number to show; 'guidance' = only unsupported providers; 'none' = nothing known. */
  kind: 'limit' | 'guidance' | 'none';
  providerId: AgentId | null;
  limit: UsageLimit | null;
  severity: Severity | null;
  /** True when the winning provider's data is last-good rather than current. */
  stale: boolean;
  /** i18n key for the 'guidance' / 'none' cases. */
  messageKey: string | null;
}

/** Only these states carry numbers a user should act on. */
const NUMERIC_STATES = new Set<ProviderUsage['state']>(['ready', 'stale']);

/** The single most urgent limit across every provider: highest percentage wins; a null percentage
 *  never wins (a provider that reported nothing must not outrank one that did). */
export function criticalUsageLimit(providers: ProviderUsage[]): { provider: ProviderUsage; limit: UsageLimit } | null {
  let best: { provider: ProviderUsage; limit: UsageLimit } | null = null;
  for (const p of providers) {
    if (!NUMERIC_STATES.has(p.state)) continue;
    for (const l of p.limits) {
      if (l.percent == null) continue;
      if (!best || l.percent > best.limit.percent!) best = { provider: p, limit: l };
    }
  }
  return best;
}

/** What the 26px footer line says. */
export function summarizeProviderUsage(snapshot: UsageSnapshot | null): UsageSummary {
  const providers = snapshot?.providers ?? [];
  const best = criticalUsageLimit(providers);
  if (best) {
    return {
      kind: 'limit', providerId: best.provider.providerId, limit: best.limit,
      severity: usageSeverity(best.limit.percent!), stale: best.provider.state === 'stale', messageKey: null,
    };
  }
  // No numbers anywhere: if some provider can only be checked from its own CLI, say so instead of
  // implying an outage; otherwise stay neutral (signed out, not applicable, or nothing installed).
  if (providers.some((p) => p.state === 'unsupported')) {
    return { kind: 'guidance', providerId: null, limit: null, severity: null, stale: false, messageKey: 'usage.summary_guidance' };
  }
  return { kind: 'none', providerId: null, limit: null, severity: null, stale: false, messageKey: 'usage.summary_none' };
}

/** How old last-good data is, in whole minutes (for the "stale · Nm" label). */
export function staleAgeMinutes(provider: ProviderUsage, nowMs: number): number | null {
  if (provider.state !== 'stale' || provider.staleSince == null) return null;
  return Math.max(0, Math.floor((nowMs - provider.staleSince) / 60_000));
}
