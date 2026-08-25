// src/shared/usagePresentation.ts
// Pure helpers behind the one-line usage footer. Kept out of the renderer so the "which number does
// the user most need to see" rule is unit-tested rather than tangled with DOM code.
import { usageSeverity, usageStateKey, type ProviderUsage, type Severity, type UsageLimit, type UsageLimitKind, type UsageProviderState, type UsageSnapshot } from './usageWindows';
import type { AgentId } from './types';

export interface UsageSummary {
  /** 'limit' = a real number to show; 'guidance' = only unsupported providers; 'none' = nothing known. */
  kind: 'limit' | 'guidance' | 'none';
  providerId: AgentId | null;
  /** The single most urgent window (severity + the one-window callers). */
  limit: UsageLimit | null;
  /** EVERY window the footer shows for the reported provider, in canonical order — Claude has two
   *  independent windows (5h + weekly) and hiding one because the other is higher loses real signal. */
  limits: UsageLimit[];
  severity: Severity | null;
  /** True when the winning provider's data is last-good rather than current. */
  stale: boolean;
  /** When those numbers were last actually true, so the footer can say how old they are. A bare
   *  "last known" reads as a blip; the same chip next to "1d 11h" reads as the outage it is. */
  staleSince: number | null;
  /** What stopped the refresh — an expired sign-in is fixable, an outage is only waitable. */
  staleReason: UsageProviderState | null;
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

/** Canonical display order: the rolling/short window first, then the long one, then model-scoped
 *  quotas — so Claude always reads "5h, weekly" and Codex "primary, secondary", regardless of which
 *  one happens to be higher at the moment. */
const KIND_ORDER: Record<UsageLimitKind, number> = { session: 0, primary: 1, weekly: 2, secondary: 3, 'model-weekly': 4 };

/** How many windows fit on the one-line footer before the rest is left to the “all usage” dialog. */
export const FOOTER_LIMIT_COUNT = 3;

/** The windows the footer renders for one provider: every reported percentage, canonically ordered
 *  and capped. Ties inside a kind (several model-weekly quotas) go to the most urgent one. */
export function footerLimits(provider: ProviderUsage): UsageLimit[] {
  if (!NUMERIC_STATES.has(provider.state)) return [];
  return provider.limits
    // Base windows always show. A model-scoped quota only earns a slot on the 26px row once it is
    // actually pressing (warn+) — otherwise a mostly-idle per-model quota crowds out the two windows
    // the user steers by. It is always listed in full in the "all usage" dialog.
    .filter((l) => l.percent != null && (l.kind !== 'model-weekly' || usageSeverity(l.percent) !== 'ok'))
    .slice()
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.percent! - a.percent!)
    .slice(0, FOOTER_LIMIT_COUNT);
}

/** The most urgent limit WITHIN one provider (highest percentage; a null percentage never wins). */
export function mostUrgentLimit(provider: ProviderUsage): UsageLimit | null {
  if (!NUMERIC_STATES.has(provider.state)) return null;
  let best: UsageLimit | null = null;
  for (const l of provider.limits) {
    if (l.percent == null) continue;
    if (!best || l.percent > best.percent!) best = l;
  }
  return best;
}

/**
 * What the 26px footer line says.
 *
 * `activeProviderId` = the provider the user is actually working in right now (the selected cockpit
 * session's owner). When given, the footer follows THAT provider — switching sessions switches the
 * number — because a Claude tile must not be captioned with Codex's percentage. It falls back to the
 * cross-provider maximum only when the active provider isn't in the snapshot (no cockpit session, or
 * that provider isn't installed).
 */
export function summarizeProviderUsage(snapshot: UsageSnapshot | null, activeProviderId: AgentId | null = null): UsageSummary {
  const providers = snapshot?.providers ?? [];
  const active = activeProviderId ? providers.find((p) => p.providerId === activeProviderId) : undefined;
  if (active) {
    const limit = mostUrgentLimit(active);
    if (limit) {
      return {
        kind: 'limit', providerId: active.providerId, limit, limits: footerLimits(active),
        severity: usageSeverity(limit.percent!), stale: active.state === 'stale',
        staleSince: active.staleSince ?? null, staleReason: active.staleReason ?? null, messageKey: null,
      };
    }
    // No number for the active provider: say WHY in its own terms (login required, CLI-only, …)
    // instead of silently showing another provider's percentage under this session's mark.
    return active.state === 'unsupported'
      ? { kind: 'guidance', providerId: active.providerId, limit: null, limits: [], severity: null, stale: false, staleSince: null, staleReason: null, messageKey: 'usage.summary_guidance' }
      : { kind: 'none', providerId: active.providerId, limit: null, limits: [], severity: null, stale: active.state === 'stale', staleSince: active.staleSince ?? null, staleReason: active.staleReason ?? null, messageKey: usageStateKey(active.state) };
  }
  const best = criticalUsageLimit(providers);
  if (best) {
    return {
      kind: 'limit', providerId: best.provider.providerId, limit: best.limit, limits: footerLimits(best.provider),
      severity: usageSeverity(best.limit.percent!), stale: best.provider.state === 'stale',
      staleSince: best.provider.staleSince ?? null, staleReason: best.provider.staleReason ?? null, messageKey: null,
    };
  }
  // No numbers anywhere: if some provider can only be checked from its own CLI, say so instead of
  // implying an outage; otherwise stay neutral (signed out, not applicable, or nothing installed).
  if (providers.some((p) => p.state === 'unsupported')) {
    return { kind: 'guidance', providerId: null, limit: null, limits: [], severity: null, stale: false, staleSince: null, staleReason: null, messageKey: 'usage.summary_guidance' };
  }
  return { kind: 'none', providerId: null, limit: null, limits: [], severity: null, stale: false, staleSince: null, staleReason: null, messageKey: 'usage.summary_none' };
}

/**
 * How old last-good numbers are, in words.
 *
 * Minutes alone was the whole label, and it is exactly wrong at the scale that matters: an outage
 * long enough to mislead someone reads as "2107분 전". Days and hours make an old number look old.
 */
export function formatStaleAge(sinceMs: number, nowMs: number, t: (k: string) => string): string {
  const totalMin = Math.max(0, Math.floor((nowMs - sinceMs) / 60_000));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  if (d > 0) return t('usage.stale_age_d').replace('X', String(d)).replace('Y', String(h));
  if (h > 0) return t('usage.stale_age_h').replace('X', String(h)).replace('Y', String(totalMin % 60));
  return t('usage.stale_age').replace('X', String(totalMin));
}
