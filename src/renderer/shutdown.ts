import { tr } from './i18n-runtime';
import { toast } from './loadError';
import type { ShutdownStatus } from '../main/shutdownScheduler';

// 🌙 one-shot idle shutdown: topbar menu (arm toggle / shut down now), a countdown banner with the
// only cancel path, and the next-boot verification banner ("did it REALLY shut down last night?").
// win32-only — mountShutdown is a no-op elsewhere and the button stays hidden.

let status: ShutdownStatus = { phase: 'disarmed', lastBusyAt: 0, scheduledAt: null, kind: null };
let bannerEl: HTMLElement;
let btnEl: HTMLButtonElement;
let menuEl: HTMLElement;
let countdownTimer: ReturnType<typeof setInterval> | undefined;

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function applyStatus(s: ShutdownStatus): void {
  status = s;
  btnEl.classList.toggle('shutdown-armed', s.phase === 'armed');
  btnEl.classList.toggle('shutdown-counting', s.phase === 'countdown');
  btnEl.title = s.phase === 'armed' ? tr('shutdown.armed_chip') : tr('shutdown.arm');
  btnEl.setAttribute('aria-label', btnEl.title);
  renderCountdown();
}

function renderCountdown(): void {
  clearInterval(countdownTimer);
  if (status.phase !== 'countdown' || status.scheduledAt === null) {
    if (bannerEl.dataset.mode === 'countdown') { bannerEl.classList.add('hidden'); bannerEl.replaceChildren(); delete bannerEl.dataset.mode; }
    return;
  }
  bannerEl.dataset.mode = 'countdown';
  bannerEl.classList.remove('hidden');
  const text = document.createElement('span');
  const cancel = document.createElement('button');
  cancel.className = 'primary';
  cancel.textContent = tr('shutdown.cancel');
  cancel.addEventListener('click', async () => { applyStatus(await window.devdeck.shutdown.cancel()); });
  bannerEl.replaceChildren(text, cancel);
  const tickText = (): void => {
    const remain = Math.max(0, Math.ceil(((status.scheduledAt ?? 0) - Date.now()) / 1000));
    text.textContent = '⏻ ' + tr('shutdown.countdown', { s: remain });
  };
  tickText();
  countdownTimer = setInterval(tickText, 1000);
}

async function showBootBanner(): Promise<void> {
  const b = await window.devdeck.shutdown.bootBanner();
  if (!b || status.phase === 'countdown') return;
  bannerEl.dataset.mode = 'boot';
  bannerEl.classList.remove('hidden');
  const text = document.createElement('span');
  const t = fmtTime(b.record.scheduledAt);
  if (b.verdict === 'confirmed') {
    text.textContent = b.record.kind === 'auto'
      ? tr('shutdown.banner_confirmed', { time: t, m: b.record.idleMinutes ?? 0 })
      : tr('shutdown.banner_confirmed_manual', { time: t });
  } else {
    text.textContent = tr('shutdown.banner_not_executed', { time: t });
    bannerEl.classList.add('shutdown-warn');
  }
  const close = document.createElement('button');
  close.className = 'chip';
  close.textContent = tr('shutdown.banner_close');
  close.addEventListener('click', async () => {
    await window.devdeck.shutdown.ackBanner();
    bannerEl.classList.add('hidden'); bannerEl.classList.remove('shutdown-warn'); bannerEl.replaceChildren(); delete bannerEl.dataset.mode;
  });
  bannerEl.replaceChildren(text, close);
}

function buildMenu(): void {
  const wrap = document.getElementById('shutdown-wrap')!;
  menuEl = document.createElement('div');
  menuEl.className = 'menu shutdown-menu hidden';
  menuEl.setAttribute('role', 'menu');
  wrap.appendChild(menuEl);

  const item = (label: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'menu-item'; b.setAttribute('role', 'menuitem'); b.textContent = label;
    b.addEventListener('click', () => { close(); onClick(); });
    return b;
  };
  const render = (): void => {
    menuEl.replaceChildren();
    if (status.phase === 'countdown') {
      menuEl.appendChild(item('⏻ ' + tr('shutdown.cancel'), async () => applyStatus(await window.devdeck.shutdown.cancel())));
      return;
    }
    const toggleLabel = (status.phase === 'armed' ? '✓ ' : '') + '🌙 ' + tr('shutdown.arm');
    menuEl.appendChild(item(toggleLabel, async () => {
      if (status.phase === 'armed') { applyStatus(await window.devdeck.shutdown.disarm()); return; }
      applyStatus(await window.devdeck.shutdown.arm());
      toast(tr('shutdown.arm_warn')); // one-shot force-close warning, non-blocking
    }));
    menuEl.appendChild(item('⏻ ' + tr('shutdown.now'), async () => applyStatus(await window.devdeck.shutdown.now())));
  };
  const open = (): void => { render(); menuEl.classList.remove('hidden'); btnEl.setAttribute('aria-expanded', 'true'); };
  const close = (): void => { menuEl.classList.add('hidden'); btnEl.setAttribute('aria-expanded', 'false'); };
  btnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menuEl.classList.contains('hidden')) open(); else close();
  });
  menuEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); btnEl.focus(); } });
  document.addEventListener('click', () => { if (!menuEl.classList.contains('hidden')) close(); });
}

/** Forward the cockpit's per-tick activity to main (busy signal B + the record's session summary). */
let lastReportSig = '';
export function reportShutdownActivity(working: number, sessions: { project: string; activity: string }[]): void {
  const sig = working + '|' + sessions.map((s) => s.project + ':' + s.activity).join(',');
  if (sig === lastReportSig) return; // only cross IPC on change
  lastReportSig = sig;
  window.devdeck.shutdown.report({ working, sessions });
}

export function mountShutdown(platform: string): void {
  if (platform !== 'win32') return; // feature (and shutdown.exe semantics) are Windows-only
  bannerEl = document.getElementById('shutdown-banner')!;
  btnEl = document.getElementById('shutdown-btn') as HTMLButtonElement;
  document.getElementById('shutdown-wrap')!.classList.remove('hidden');
  buildMenu();
  window.devdeck.shutdown.onStatus(applyStatus);
  void window.devdeck.shutdown.status().then(applyStatus);
  void showBootBanner();
}
