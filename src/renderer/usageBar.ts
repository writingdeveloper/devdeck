import { tr } from './i18n-runtime';
import { createProviderLogo, providerName } from './providerLogo';
import { openUsageModal, renderUsageModal, isUsageModalOpen } from './usageModal';
import { summarizeProviderUsage } from '../shared/usagePresentation';
import { usageSeverity, formatReset, type UsageSnapshot } from '../shared/usageWindows';
import type { AgentId } from '../shared/types';

const POLL_MS = 5 * 60_000;
let el: HTMLElement;
let timer: ReturnType<typeof setInterval> | null = null;
let snapshot: UsageSnapshot | null = null;
let refreshInFlight: Promise<UsageSnapshot> | null = null;
/** Provider of the session the user is working in (set by the cockpit on every selection change).
 *  The footer's number follows it, so switching sessions switches which provider is being reported. */
let activeProviderId: AgentId | null = null;

/** Point the footer at the selected cockpit session's provider (null = no session → cross-provider max). */
export function setActiveUsageProvider(id: AgentId | null): void {
  if (activeProviderId === id) return;
  activeProviderId = id;
  render();
}

/** The last snapshot the renderer received — language switches re-render THIS instead of re-polling. */
export function currentUsageSnapshot(): UsageSnapshot | null { return snapshot; }

export function mountUsageBar(): void {
  el = document.getElementById('usage-bar')!;
  // Render whatever is cached first (instant), then refresh in the background.
  void window.devdeck.usageSnapshot()
    .then((s) => { if (s) { snapshot = s; render(); } })
    .catch(() => { /* first paint just waits for the refresh */ })
    .finally(() => { void refreshUsageBar(); });
  window.addEventListener('focus', () => { void refreshUsageBar(); });
  // Opening the all-usage dialog from outside the footer (QA harness today, a keyboard shortcut
  // later): `detail.snapshot` overrides what is rendered, otherwise the live one is used.
  document.addEventListener('devdeck:usage-open', (e) => {
    const detail = (e as CustomEvent<{ snapshot?: UsageSnapshot }>).detail;
    openUsageModal(detail?.snapshot ?? snapshot, null);
  });
  // Same shape of seam as above: the QA harness can point the footer at a provider without having to
  // spawn a real agent session (the cockpit does this via setActiveUsageProvider on every selection).
  document.addEventListener('devdeck:usage-active-provider', (e) => {
    setActiveUsageProvider((e as CustomEvent<{ providerId?: AgentId | null }>).detail?.providerId ?? null);
  });
}

/**
 * Re-fetch every installed provider and re-render the footer (and the modal, if open).
 * One shared promise: a focus event, the timer, and a manual refresh arriving together do ONE round.
 */
export function refreshUsageBar(force = false): Promise<UsageSnapshot> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = window.devdeck.refreshUsageProviders({ force })
    .then((s) => { snapshot = s; render(); renderUsageModal(s); return s; })
    .catch(() => { render(); return snapshot ?? { providers: [], fetchedAt: Date.now() }; })
    .finally(() => { refreshInFlight = null; startTimer(); });
  return refreshInFlight;
}

/** Re-render from the cached snapshot (language change) without asking providers for anything. */
export function rerenderUsageBar(): void {
  if (el) { render(); renderUsageModal(snapshot); }
}

function startTimer(): void { if (!timer) timer = setInterval(() => { void refreshUsageBar(); }, POLL_MS); }

function render(): void {
  if (!el) return;
  const providers = snapshot?.providers ?? [];
  // Hide only when there is NOTHING to say — a single unavailable provider must not blank the row.
  if (providers.length === 0) { el.classList.add('hidden'); el.replaceChildren(); return; }
  el.classList.remove('hidden');
  el.replaceChildren();

  const summary = summarizeProviderUsage(snapshot, activeProviderId);

  const cluster = document.createElement('span'); cluster.className = 'ub-providers';
  for (const p of providers) {
    // Which provider the number belongs to must be visible, not inferred: the reported provider's
    // mark is highlighted (and named via aria-current), the others stay dimmed.
    const logo = createProviderLogo(p.providerId, 'ck-provider-logo sm');
    if (p.providerId === summary.providerId) { logo.classList.add('active'); logo.setAttribute('aria-current', 'true'); }
    cluster.appendChild(logo);
  }
  el.appendChild(cluster);

  const box = document.createElement('span'); box.className = 'ub-summary';
  if (summary.providerId) box.title = providerName(summary.providerId);
  if (summary.kind === 'limit' && summary.limit) {
    const pct = summary.limit.percent!;
    const lab = document.createElement('span'); lab.className = 'ub-lab';
    lab.textContent = summary.limit.modelLabel ?? tr(summary.limit.label);
    const track = document.createElement('span'); track.className = 'ub-track';
    const fill = document.createElement('span'); fill.className = `ub-fill ${usageSeverity(pct)}`; fill.style.width = `${pct}%`;
    track.appendChild(fill);
    const val = document.createElement('span'); val.className = 'ub-val'; val.textContent = `${pct}%`;
    box.append(lab, track, val);
    if (summary.limit.resetAt) {
      const rst = document.createElement('span'); rst.className = 'ub-rst';
      rst.textContent = `↻ ${formatReset(summary.limit.resetAt, Date.now(), tr)}`;
      box.appendChild(rst);
    }
    if (summary.stale) { const st = document.createElement('span'); st.className = 'ub-stale'; st.textContent = tr('usage.state_stale'); box.appendChild(st); }
  } else {
    const m = document.createElement('span'); m.className = 'ub-msg'; m.textContent = tr(summary.messageKey!);
    box.appendChild(m);
  }
  el.appendChild(box);

  const sp = document.createElement('span'); sp.className = 'ub-sp'; el.appendChild(sp);
  // A real button (not the whole bar) — the footer must not navigate to the Claude-only analytics page.
  const all = document.createElement('button'); all.className = 'ub-all'; all.type = 'button';
  all.textContent = tr('usage.all_usage');
  all.addEventListener('click', () => openUsageModal(snapshot, all));
  el.appendChild(all);
  if (isUsageModalOpen()) renderUsageModal(snapshot);
}
