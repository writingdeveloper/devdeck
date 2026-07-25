// src/shared/usageWindows.ts
// Normalized live-subscription-limit domain, shared by every provider adapter and the renderer.
// Nothing provider-specific (and no credential material) may appear in these shapes.
import type { AgentId } from './types';

export type Severity = 'ok' | 'warn' | 'crit';

/** Why a provider section looks the way it does. `stale` = last-good data after a failed refresh. */
export type UsageProviderState =
  | 'ready' | 'stale' | 'login-required' | 'expired' | 'not-applicable'
  | 'cli-missing' | 'offline' | 'rate-limited' | 'unsupported';

/** `session`/`weekly` = Claude's fixed windows, `model-weekly` = a model-scoped weekly quota,
 *  `primary`/`secondary` = Codex's two app-server windows. */
export type UsageLimitKind = 'session' | 'weekly' | 'model-weekly' | 'primary' | 'secondary';

export interface UsageLimit {
  id: string;               // stable across refreshes (dedupe key + DOM key)
  kind: UsageLimitKind;
  label: string;            // an i18n KEY for known windows, or sanitized server text
  percent: number | null;   // 0..100, null when the provider didn't report one
  resetAt: number | null;   // epoch ms
  modelLabel: string | null; // sanitized server-supplied model display name (never hardcoded)
}

export interface UsageCredits { hasCredits: boolean | null; balance: number | null; spent: number | null; currency: string | null; }

export interface ProviderUsage {
  providerId: AgentId;
  state: UsageProviderState;
  planLabel: string | null;
  limits: UsageLimit[];
  credits: UsageCredits | null;
  /** Documented CLI commands to run when DevDeck cannot read the quota itself (Antigravity). */
  guidance: { commands: string[] } | null;
  fetchedAt: number;
  staleSince?: number;
}

export interface UsageSnapshot { providers: ProviderUsage[]; fetchedAt: number; }

export function usageSeverity(pct: number): Severity {
  if (pct >= 90) return 'crit';
  if (pct >= 70) return 'warn';
  return 'ok';
}

/** i18n key for a provider state (the UI never renders a raw state string). */
export function usageStateKey(state: UsageProviderState): string {
  return `usage.state_${state.replace(/-/g, '_')}`;
}

export function clampPercent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(0, Math.min(100, value))) : null;
}

export function parseResetTime(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 80) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Server-supplied text is display data, never trusted markup or unbounded length. */
export function safeUsageLabel(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : fallback;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Format the time until a reset. `t` is the i18n lookup; templates carry literal `X`/`Y`
 * placeholders (`reset_d` = X days/Y hours, `reset_h` = X hours/Y min, `reset_m` = Y min).
 * The weekly window can be days away, so a days tier is included.
 */
export function formatReset(resetAtMs: number, nowMs: number, t: (k: string) => string): string {
  const ms = resetAtMs - nowMs;
  if (ms < 60_000) return t('usage.reset_soon');
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return t('usage.reset_d').replace('X', String(d)).replace('Y', String(h));
  if (h > 0) return t('usage.reset_h').replace('X', String(h)).replace('Y', String(m));
  return t('usage.reset_m').replace('Y', String(m));
}

export interface ClaudeUsageParse { limits: UsageLimit[]; credits: UsageCredits | null; }

const WINDOW_KIND: Record<string, 'session' | 'weekly'> = {
  five_hour: 'session', fiveHour: 'session', session: 'session',
  // `weekly_all` / `weekly_scoped` are what the live `limits[]` entries call themselves; `group` says
  // plain `weekly` for both. Without these, a server that drops the legacy `seven_day` field would
  // silently lose the whole weekly row.
  seven_day: 'weekly', sevenDay: 'weekly', weekly: 'weekly', weekly_all: 'weekly', weekly_scoped: 'weekly',
};

function windowKind(entry: Record<string, unknown>): 'session' | 'weekly' | null {
  for (const field of ['type', 'kind', 'name', 'window', 'group']) {
    const v = entry[field];
    if (typeof v === 'string' && WINDOW_KIND[v]) return WINDOW_KIND[v];
  }
  return null;
}

/** The model a scoped window belongs to, wherever the server put it: flat on the entry (older shape)
 *  or nested under `scope.model` (current shape). */
function scopeModel(entry: Record<string, unknown>): Record<string, unknown> | null {
  const scope = entry.scope as Record<string, unknown> | undefined;
  const model = scope && typeof scope === 'object' ? scope.model : undefined;
  return model && typeof model === 'object' ? model as Record<string, unknown> : null;
}

/** A model discriminator makes the id (and the row) unique per model — Fable is NOT special-cased.
 *  The display name is the last resort: a scoped window with a null model id still needs a stable id. */
function modelKey(entry: Record<string, unknown>): string | null {
  const model = scopeModel(entry);
  const candidates = [entry.model, entry.model_id, entry.modelId, model?.id, model?.display_name, model?.displayName];
  for (const v of candidates) {
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 60).replace(/[^\w.:-]/g, '_');
  }
  return null;
}

function modelDisplay(entry: Record<string, unknown>): string | null {
  const model = scopeModel(entry);
  const candidates = [
    entry.model_display_name, entry.modelDisplayName, entry.display_name, entry.displayName,
    model?.display_name, model?.displayName,
  ];
  for (const v of candidates) {
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 80);
  }
  return null;
}

function toLimit(entry: unknown): UsageLimit | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const base = windowKind(e);
  if (!base) return null;
  const model = modelKey(e);
  const utilization = e.utilization ?? e.used_percent ?? e.usedPercent ?? e.percent;
  const resets = e.resets_at ?? e.resetsAt ?? e.reset_at;
  if (model && base === 'weekly') { // a model discriminator only ever scopes the weekly quota today
    return {
      id: `claude:seven_day:${model}`,
      kind: 'model-weekly',
      label: 'usage.limit_model_weekly',
      percent: clampPercent(utilization),
      resetAt: parseResetTime(resets),
      modelLabel: safeUsageLabel(modelDisplay(e), model),
    };
  }
  return {
    id: base === 'weekly' ? 'claude:weekly' : 'claude:session',
    kind: base,
    label: base === 'weekly' ? 'usage.limit_weekly' : 'usage.limit_session',
    percent: clampPercent(utilization),
    resetAt: parseResetTime(resets),
    modelLabel: null,
  };
}

function parseCredits(body: Record<string, unknown>): UsageCredits | null {
  const raw = (body.extra_usage ?? body.extraUsage ?? body.credits ?? body.usage_credits) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return null;
  // `is_enabled` / `used_credits` are the live `extra_usage` field names; the others are older shapes.
  const hasCredits = typeof raw.has_credits === 'boolean' ? raw.has_credits
    : typeof raw.hasCredits === 'boolean' ? raw.hasCredits
      : typeof raw.enabled === 'boolean' ? raw.enabled
        : typeof raw.is_enabled === 'boolean' ? raw.is_enabled : null;
  const credits: UsageCredits = {
    hasCredits,
    balance: finiteNumber(raw.balance ?? raw.remaining ?? raw.credit_balance),
    spent: finiteNumber(raw.spent ?? raw.used ?? raw.amount_spent ?? raw.used_credits),
    currency: typeof raw.currency === 'string' ? raw.currency.trim().slice(0, 8) : null,
  };
  // Nothing usable → don't render an empty credits block. Explicitly-off with no numbers is also
  // nothing to say: an account that never enabled extra usage gets no row rather than a "none" row.
  return credits.balance == null && credits.spent == null && (credits.hasCredits == null || credits.hasCredits === false)
    ? null : credits;
}

/**
 * Parse `/api/oauth/usage` into normalized limits + credits. Supports BOTH the legacy fixed
 * `five_hour`/`seven_day` fields and the current dynamic `limits` array, including model-scoped
 * weekly quotas — those are rendered from the server's own model display name, so an account
 * without such an entry simply has no such row.
 */
export function parseClaudeUsageResponse(body: unknown): ClaudeUsageParse | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const byId = new Map<string, UsageLimit>();
  const push = (l: UsageLimit | null): void => { if (l) byId.set(l.id, l); }; // last write wins

  push(toLimit({ type: 'five_hour', ...(b.five_hour as object ?? {}) } as unknown));
  push(toLimit({ type: 'seven_day', ...(b.seven_day as object ?? {}) } as unknown));
  if (!b.five_hour) byId.delete('claude:session');
  if (!b.seven_day) byId.delete('claude:weekly');
  if (Array.isArray(b.limits)) for (const entry of b.limits) push(toLimit(entry));

  return { limits: [...byId.values()], credits: parseCredits(b) };
}
