import { tr } from './i18n-runtime';
import { createProviderLogo, providerName } from './providerLogo';
import { formatStaleAge } from '../shared/usagePresentation';
import { formatReset, usageActionFor, usageSeverity, usageStateKey, type ProviderUsage, type UsageSnapshot } from '../shared/usageWindows';
import { createIcon } from './icons';
import { openUsageLoginTerminal } from './usageLoginTerminal';

// The all-provider limits dialog. It is an OVERLAY (fixed, outside the flex column) precisely so that
// opening it cannot change the shell, cockpit, or xterm geometry — a terminal resize storm was a real
// regression once, and a modal that reflows the layout would re-trigger it.
let overlay: HTMLElement | null = null;
let lastTrigger: HTMLElement | null = null;
let lastSnapshot: UsageSnapshot | null = null;
let onKeydown: ((e: KeyboardEvent) => void) | null = null;

export function isUsageModalOpen(): boolean { return !!overlay; }

export function openUsageModal(snapshot: UsageSnapshot | null, trigger: HTMLElement | null): void {
  if (overlay) return;
  lastSnapshot = snapshot;
  lastTrigger = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);

  overlay = document.createElement('div');
  overlay.className = 'usage-modal-overlay';
  overlay.innerHTML = `<div class="usage-modal ui-dialog" role="dialog" aria-modal="true" aria-labelledby="usage-modal-title">
    <div class="um-head">
      <h2 id="usage-modal-title" class="um-title"></h2>
      <button type="button" class="um-refresh"></button>
      <button type="button" class="um-close"></button>
    </div>
    <div class="um-body"></div>
  </div>`;
  const modal = overlay.querySelector('.usage-modal') as HTMLElement;
  (overlay.querySelector('.um-title') as HTMLElement).textContent = tr('usage.modal_title');
  const refresh = overlay.querySelector('.um-refresh') as HTMLButtonElement;
  refresh.textContent = tr('usage.modal_refresh');
  const close = overlay.querySelector('.um-close') as HTMLButtonElement;
  close.appendChild(createIcon('close'));
  close.setAttribute('aria-label', tr('usage.modal_close'));
  close.title = tr('usage.modal_close');

  refresh.addEventListener('click', () => {
    refresh.disabled = true; // only the refresh control is disabled; the dialog stays usable
    // Imported lazily to avoid an import cycle with usageBar (which owns the shared refresh promise).
    void import('./usageBar').then((m) => m.refreshUsageBar(true)).finally(() => { refresh.disabled = false; });
  });
  close.addEventListener('click', () => closeUsageModal());
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeUsageModal(); });

  onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); closeUsageModal(); return; }
    if (e.key !== 'Tab') return;
    const focusable = Array.from(modal.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !modal.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKeydown, true);

  document.body.appendChild(overlay);
  renderUsageModal(snapshot);
  close.focus();
}

export function closeUsageModal(): void {
  if (!overlay) return;
  if (onKeydown) document.removeEventListener('keydown', onKeydown, true);
  onKeydown = null;
  overlay.remove();
  overlay = null;
  lastTrigger?.focus(); // focus returns to whatever opened the dialog
  lastTrigger = null;
}

/** Re-render the open dialog with newer data (a refresh landing while it is open). No-op when closed. */
export function renderUsageModal(snapshot: UsageSnapshot | null): void {
  if (!overlay) return;
  if (snapshot) lastSnapshot = snapshot;
  const body = overlay.querySelector('.um-body') as HTMLElement;
  body.replaceChildren();
  const providers = lastSnapshot?.providers ?? [];
  if (!providers.length) {
    const empty = document.createElement('p'); empty.className = 'um-empty'; empty.textContent = tr('usage.summary_none');
    body.appendChild(empty);
    return;
  }
  for (const p of providers) body.appendChild(providerSection(p));
}

function providerSection(p: ProviderUsage): HTMLElement {
  const sec = document.createElement('section'); sec.className = 'um-provider';
  const head = document.createElement('div'); head.className = 'um-p-head';
  head.append(createProviderLogo(p.providerId, 'ck-provider-logo'));
  const name = document.createElement('span'); name.className = 'um-p-name'; name.textContent = providerName(p.providerId);
  head.appendChild(name);
  if (p.planLabel) { const plan = document.createElement('span'); plan.className = 'um-plan'; plan.textContent = p.planLabel; head.appendChild(plan); }
  const state = document.createElement('span'); state.className = `um-state st-${p.state}`;
  // Last-good numbers say three things, and only the first was ever shown: that they are last-good,
  // how old they are, and what stopped them refreshing. The third is what turns "that number looks
  // wrong" into something the user can act on — and it is what puts the sign-in button below.
  const stateParts = [tr(usageStateKey(p.state))];
  if (p.state === 'stale') {
    if (p.staleSince != null) stateParts.push(formatStaleAge(p.staleSince, Date.now(), tr));
    if (p.staleReason) stateParts.push(tr(usageStateKey(p.staleReason)));
  }
  state.textContent = stateParts.join(' · ');
  head.appendChild(state);
  sec.appendChild(head);

  for (const l of p.limits) {
    const row = document.createElement('div'); row.className = 'um-limit';
    const lab = document.createElement('span'); lab.className = 'um-l-label';
    // A model-scoped window is labelled with the SERVER's model name (sanitized data, not a key), so
    // an account without that model simply has no such row.
    lab.textContent = l.modelLabel ? `${tr(l.label)} · ${l.modelLabel}` : tr(l.label);
    const track = document.createElement('span'); track.className = 'um-track';
    const fill = document.createElement('span'); fill.className = 'um-fill';
    const val = document.createElement('span'); val.className = 'um-val';
    if (l.percent == null) { val.textContent = '—'; }
    else { fill.classList.add(usageSeverity(l.percent)); fill.style.width = `${l.percent}%`; val.textContent = `${l.percent}%`; }
    track.appendChild(fill);
    row.append(lab, track, val);
    if (l.resetAt) {
      const rst = document.createElement('span'); rst.className = 'um-reset';
      rst.textContent = `↻ ${formatReset(l.resetAt, Date.now(), tr)}`;
      rst.title = `${new Date(l.resetAt).toLocaleString()} ${tr('usage.bar_reset')}`;
      row.appendChild(rst);
    }
    sec.appendChild(row);
  }

  if (p.credits) {
    const c = document.createElement('div'); c.className = 'um-credits';
    const parts: string[] = [];
    if (p.credits.balance != null) parts.push(`${tr('usage.credits_balance')} ${fmtMoney(p.credits.balance, p.credits.currency)}`);
    if (p.credits.spent != null) parts.push(`${tr('usage.credits_spent')} ${fmtMoney(p.credits.spent, p.credits.currency)}`);
    if (!parts.length && p.credits.hasCredits != null) parts.push(tr(p.credits.hasCredits ? 'usage.credits_on' : 'usage.credits_off'));
    c.textContent = `${tr('usage.credits')} · ${parts.join(' · ')}`;
    sec.appendChild(c);
  }

  const action = usageActionFor(p.providerId, p.state, p.staleReason);
  if (action === 'login') {
    const row = document.createElement('div'); row.className = 'um-guidance';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'um-action';
    button.textContent = tr('usage.login_open');
    button.addEventListener('click', () => { void openUsageLoginTerminal(p.providerId as 'claude' | 'codex'); });
    row.appendChild(button);
    // Signing in again is the heavy way. Claude Code refreshes this token itself whenever it runs —
    // which is exactly why the reported outage lasted 35 hours: the user had not run it. Say so, so
    // "my usage is stuck" has an answer that costs nothing.
    if (p.providerId === 'claude') {
      const hint = document.createElement('span'); hint.className = 'um-hint';
      hint.textContent = tr('usage.token_refresh_hint');
      row.appendChild(hint);
    }
    sec.appendChild(row);
  } else if (action === 'install') {
    const command = p.providerId === 'codex' ? 'npm install -g @openai/codex' : 'npm install -g @anthropic-ai/claude-code';
    const row = document.createElement('div'); row.className = 'um-guidance';
    const text = document.createElement('span'); text.textContent = tr('usage.install_hint');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'um-cmd'; button.textContent = command;
    button.addEventListener('click', () => { window.devdeck.clipboard.writeText(command); button.classList.add('copied'); setTimeout(() => button.classList.remove('copied'), 1200); });
    row.append(text, button); sec.appendChild(row);
  }

  if (p.guidance) {
    const g = document.createElement('div'); g.className = 'um-guidance';
    const text = document.createElement('span'); text.textContent = tr('usage.guidance_cli');
    g.appendChild(text);
    for (const cmd of p.guidance.commands) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'um-cmd';
      b.textContent = cmd;
      b.setAttribute('aria-label', `${tr('usage.copy_command')} ${cmd}`);
      b.title = tr('usage.copy_command');
      b.addEventListener('click', () => { window.devdeck.clipboard.writeText(cmd); b.classList.add('copied'); setTimeout(() => b.classList.remove('copied'), 1200); });
      g.appendChild(b);
    }
    sec.appendChild(g);
  }
  return sec;
}

function fmtMoney(v: number, currency: string | null): string {
  const n = Math.round(v * 100) / 100;
  return currency ? `${n} ${currency}` : String(n);
}
