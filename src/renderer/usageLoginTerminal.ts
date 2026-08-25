import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { AgentId } from '../shared/types';
import { tr } from './i18n-runtime';
import { providerName } from './providerLogo';
import { createIcon } from './icons';
import { ptyCompatFor } from './ptyCompat';

type LoginProvider = Extract<AgentId, 'claude' | 'codex'>;

let active: { id: string | null; overlay: HTMLElement; term: Terminal; fit: FitAddon; resize: ResizeObserver } | null = null;
let listenersMounted = false;

function ensureBridgeListeners(): void {
  if (listenersMounted) return;
  listenersMounted = true;
  window.devdeck.cockpit.onData(({ id, chunk }) => { if (active?.id === id) active.term.write(chunk); });
  window.devdeck.cockpit.onExit(({ id, exitCode }) => {
    if (active?.id === id) active.term.writeln(`\r\n[${tr('usage.login_exited')} ${exitCode}]`);
  });
}

function closeLoginTerminal(): void {
  const current = active;
  if (!current) return;
  active = null;
  current.resize.disconnect();
  if (current.id) window.devdeck.cockpit.close(current.id);
  current.term.dispose();
  current.overlay.remove();
  void import('./usageBar').then((module) => module.refreshUsageBar(true));
}

/** Open one provider-owned OAuth command in a visible, interactive in-app terminal. */
export async function openUsageLoginTerminal(providerId: LoginProvider): Promise<void> {
  if (active) closeLoginTerminal();
  ensureBridgeListeners();
  // Resolved before any of the dialog exists: xterm only reads this at construction, and this pty
  // is always a local one (see ptyCompatFor).
  const windowsPty = await ptyCompatFor();

  const overlay = document.createElement('div'); overlay.className = 'usage-login-overlay';
  const dialog = document.createElement('div'); dialog.className = 'usage-login-dialog';
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
  const head = document.createElement('div'); head.className = 'usage-login-head';
  const title = document.createElement('h2'); title.textContent = tr('usage.login_title').replace('{provider}', providerName(providerId));
  const close = document.createElement('button'); close.type = 'button'; close.className = 'usage-login-close';
  close.appendChild(createIcon('close')); close.title = tr('usage.modal_close'); close.setAttribute('aria-label', tr('usage.modal_close'));
  head.append(title, close);
  const note = document.createElement('p'); note.className = 'usage-login-note'; note.textContent = tr('usage.login_hint');
  const terminalHost = document.createElement('div'); terminalHost.className = 'usage-login-terminal';
  dialog.append(head, note, terminalHost); overlay.appendChild(dialog); document.body.appendChild(overlay);

  const term = new Terminal({ fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 12, theme: { background: '#0a0b0e' }, cursorBlink: true, windowsPty });
  const fit = new FitAddon(); term.loadAddon(fit); term.open(terminalHost); fit.fit();
  const resize = new ResizeObserver(() => {
    if (!active || active.overlay !== overlay) return;
    fit.fit();
    if (active.id) window.devdeck.cockpit.resize(active.id, term.cols, term.rows);
  });
  resize.observe(terminalHost);
  active = { id: null, overlay, term, fit, resize };
  term.onData((data) => { if (active?.overlay === overlay && active.id) window.devdeck.cockpit.input(active.id, data); });
  close.addEventListener('click', closeLoginTerminal);
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) closeLoginTerminal(); });

  const opened = await window.devdeck.openUsageLogin(providerId, term.cols, term.rows);
  if (!active || active.overlay !== overlay) { if (opened?.id) window.devdeck.cockpit.close(opened.id); return; }
  if (!opened) { term.writeln(tr('usage.login_unavailable')); return; }
  active.id = opened.id;
  terminalHost.focus();
}

