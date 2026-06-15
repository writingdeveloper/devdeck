import { tr } from './i18n-runtime';
import { severity, formatReset, type UsageResult, type UsageWindows } from '../shared/usageWindows';

const POLL_MS = 5 * 60_000;
let el: HTMLElement;
let timer: ReturnType<typeof setInterval> | null = null;

export function mountUsageBar(): void {
  el = document.getElementById('usage-bar')!;
  el.addEventListener('click', () => document.querySelector<HTMLButtonElement>('.rail-item[data-view="usage"]')?.click());
  void refreshUsageBar();
  window.addEventListener('focus', () => { void refreshUsageBar(); });
}

/** Re-fetch + re-render. Called on mount, focus, the 5-min timer, and after the settings toggle changes. */
export async function refreshUsageBar(): Promise<void> {
  let res: UsageResult;
  try { res = await window.devdeck.usageWindows(); } catch { res = { enabled: true, error: 'offline' }; }
  if (!res.enabled) { el.classList.add('hidden'); stopTimer(); return; }
  if ('error' in res) {
    if (res.error === 'not-applicable') { el.classList.add('hidden'); }
    else { renderMsg(res.error === 'no-credentials' ? 'usage.bar_need_login' : 'usage.bar_unavailable'); }
    startTimer();
    return;
  }
  renderData(res.data);
  startTimer();
}

function startTimer(): void { if (!timer) timer = setInterval(() => { void refreshUsageBar(); }, POLL_MS); }
function stopTimer(): void { if (timer) { clearInterval(timer); timer = null; } }

function renderMsg(key: string): void {
  el.classList.remove('hidden');
  el.replaceChildren();
  const m = document.createElement('span'); m.className = 'ub-msg'; m.textContent = tr(key);
  el.appendChild(m);
}

function meter(labelKey: string, pct: number | null): HTMLElement {
  const wrap = document.createElement('span'); wrap.className = 'ub-meter';
  const lab = document.createElement('span'); lab.textContent = tr(labelKey);
  const track = document.createElement('span'); track.className = 'ub-track';
  const fill = document.createElement('span'); fill.className = 'ub-fill';
  const val = document.createElement('span');
  if (pct == null) { val.textContent = '—'; }
  else { fill.classList.add(severity(pct)); fill.style.width = `${pct}%`; val.textContent = `${pct}%`; }
  track.appendChild(fill);
  wrap.append(lab, track, val);
  return wrap;
}

function renderData(d: UsageWindows): void {
  el.classList.remove('hidden');
  el.replaceChildren();
  if (d.planName) { const p = document.createElement('span'); p.className = 'ub-plan'; p.textContent = `✦ ${d.planName}`; el.appendChild(p); }
  el.appendChild(meter('usage.bar_5h', d.fiveHour));
  const dot = document.createElement('span'); dot.className = 'ub-dot'; dot.textContent = '·'; el.appendChild(dot);
  el.appendChild(meter('usage.bar_week', d.sevenDay));
  const resetAt = d.fiveHourResetAt ?? d.sevenDayResetAt;
  if (resetAt) {
    const r = document.createElement('span'); r.className = 'ub-reset';
    r.textContent = `${formatReset(resetAt, Date.now(), tr)} · ${tr('usage.bar_reset')}`;
    el.appendChild(r);
  }
}
