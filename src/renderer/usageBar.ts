import { tr } from './i18n-runtime';
import { severity, formatReset, usageErrorKey, type UsageResult, type UsageWindows } from '../shared/usageWindows';

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
    // null = not a Claude subscriber / not logged in → hide (no nagging); otherwise a specific,
    // actionable message (expired→re-login / rate-limited / offline).
    const key = usageErrorKey(res.error);
    if (key) renderMsg(key); else el.classList.add('hidden');
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

function meter(labelKey: string, pct: number | null, resetAt: number | null): HTMLElement {
  const wrap = document.createElement('span'); wrap.className = 'ub-meter';
  const lab = document.createElement('span'); lab.className = 'ub-lab'; lab.textContent = tr(labelKey);
  const track = document.createElement('span'); track.className = 'ub-track';
  const fill = document.createElement('span'); fill.className = 'ub-fill';
  const val = document.createElement('span'); val.className = 'ub-val';
  if (pct == null) { val.textContent = '—'; }
  else { fill.classList.add(severity(pct)); fill.style.width = `${pct}%`; val.textContent = `${pct}%`; }
  track.appendChild(fill);
  wrap.append(lab, track, val);
  // Each window shows ITS OWN reset (↻ countdown) so 5h vs weekly is never ambiguous;
  // the tooltip names the window and the exact reset clock time.
  if (resetAt) {
    const rst = document.createElement('span'); rst.className = 'ub-rst';
    rst.textContent = `↻ ${formatReset(resetAt, Date.now(), tr)}`;
    wrap.appendChild(rst);
    wrap.title = `${tr(labelKey)} ${pct ?? '—'}% · ${new Date(resetAt).toLocaleString()} ${tr('usage.bar_reset')}`;
  }
  return wrap;
}

function renderData(d: UsageWindows): void {
  el.classList.remove('hidden');
  el.replaceChildren();
  if (d.planName) { const p = document.createElement('span'); p.className = 'ub-plan'; p.textContent = `✦ ${d.planName}`; el.appendChild(p); }
  el.appendChild(meter('usage.bar_5h', d.fiveHour, d.fiveHourResetAt));
  const dot = document.createElement('span'); dot.className = 'ub-dot'; dot.textContent = '·'; el.appendChild(dot);
  el.appendChild(meter('usage.bar_week', d.sevenDay, d.sevenDayResetAt));
}
