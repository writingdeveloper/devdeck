import { mountProjects, renderProjects, reloadProjects } from './projectsView';
import { mountNav } from './nav';
import { mountUsage, showUsage } from './usageView';
import { mountSettings, showSettings } from './settingsView';
import { mountNext, showNext } from './nextView';
import { setLanguage, tr, currentLang, SUPPORTED } from './i18n-runtime';

const toastHost = document.getElementById('toast-host')!;
window.devdeck.onError((msg) => {
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
  toastHost.appendChild(el); setTimeout(() => el.remove(), 6000);
});

const updateBanner = document.getElementById('update-banner')!;
function renderUpdate(p: import('../shared/update').UpdatePayload): void {
  updateBanner.classList.remove('hidden');
  updateBanner.replaceChildren();
  const text = document.createElement('span');
  if (p.status === 'available') text.textContent = tr('update.available', { version: p.version });
  else if (p.status === 'downloading') text.textContent = tr('update.downloading', { percent: p.percent });
  else text.textContent = tr('update.ready', { version: p.version });
  updateBanner.appendChild(text);
  if (p.status === 'available') {
    const btn = document.createElement('button'); btn.className = 'chip'; btn.textContent = tr('update.download');
    btn.addEventListener('click', () => { btn.disabled = true; void window.devdeck.downloadUpdate(); });
    updateBanner.appendChild(btn);
  } else if (p.status === 'downloaded') {
    const btn = document.createElement('button'); btn.className = 'primary'; btn.textContent = tr('update.restart');
    btn.addEventListener('click', () => { void window.devdeck.installUpdate(); });
    updateBanner.appendChild(btn);
  }
}
window.devdeck.onUpdate(renderUpdate);

function applyStaticLabels(): void {
  document.documentElement.lang = currentLang();
  document.querySelector<HTMLButtonElement>('#open-selected')!.textContent = '▶ ' + tr('app.open_selected');
  const refreshBtn = document.querySelector<HTMLButtonElement>('#refresh')!;
  refreshBtn.title = tr('app.refresh');
  refreshBtn.setAttribute('aria-label', tr('app.refresh'));
  const map: [string, string][] = [['[data-view="projects"]', 'nav.projects'], ['[data-view="usage"]', 'nav.usage'], ['[data-view="settings"]', 'nav.settings'], ['[data-view="next"]', 'nav.next'], ['#lang-btn', 'nav.language']];
  for (const [sel, key] of map) { const el = document.querySelector<HTMLElement>(sel); if (el) { el.title = tr(key); el.setAttribute('aria-label', tr(key)); } }
  const agentSel = document.getElementById('agent-select');
  if (agentSel && !agentSel.classList.contains('hidden')) agentSel.setAttribute('aria-label', tr('agent.label'));
  const chk = document.querySelector('#view-projects .chk');
  if (chk?.lastChild) chk.lastChild.textContent = ' ' + tr('proj.neglected_only');
  const showHidden = document.getElementById('show-hidden');
  if (showHidden?.firstChild) showHidden.firstChild.textContent = '🙈 ' + tr('proj.hidden') + ' ';
}

function mountTitlebar(): void {
  const wc = window.devdeck.windowControls;
  document.getElementById('win-min')!.addEventListener('click', () => void wc.minimize());
  document.getElementById('win-close')!.addEventListener('click', () => void wc.close());
  const maxBtn = document.getElementById('win-max')!;
  maxBtn.addEventListener('click', () => void wc.toggleMaximize());
  document.querySelector<HTMLElement>('.tb-drag')!.addEventListener('dblclick', () => void wc.toggleMaximize());
  const setGlyph = (m: boolean) => { maxBtn.textContent = m ? '❐' : '☐'; maxBtn.title = m ? 'Restore' : 'Maximize'; };
  wc.onMaximizeChange(setGlyph);
  void wc.isMaximized().then(setGlyph);
}

async function boot(): Promise<void> {
  mountTitlebar();
  setLanguage(await window.devdeck.getLanguage());
  applyStaticLabels();
  mountProjects();
  mountUsage();
  mountSettings(() => { applyStaticLabels(); reloadProjects(); });
  mountNext();
  mountNav((view) => { if (view === 'usage') showUsage(); if (view === 'settings') showSettings(); if (view === 'next') showNext(); });

  const agentSel = document.getElementById('agent-select') as HTMLSelectElement;
  const agents = await window.devdeck.availableAgents();
  const active = await window.devdeck.getAgent();
  if (agents.length > 1) {
    agentSel.classList.remove('hidden');
    agentSel.replaceChildren(...agents.map((a) => {
      const o = document.createElement('option'); o.value = a; o.textContent = tr('agent.' + a); o.selected = a === active; return o;
    }));
    agentSel.setAttribute('aria-label', tr('agent.label'));
    agentSel.addEventListener('change', async () => {
      await window.devdeck.setAgent(agentSel.value);
      reloadProjects();
    });
  }

  document.getElementById('lang-btn')!.addEventListener('click', async () => {
    const i = SUPPORTED.indexOf(currentLang());
    const next = SUPPORTED[(i + 1) % SUPPORTED.length];
    await window.devdeck.setLanguage(next);
    setLanguage(next);
    applyStaticLabels();
    renderProjects();
    if (document.getElementById('view-usage')!.classList.contains('active')) showUsage();
    if (document.getElementById('view-settings')!.classList.contains('active')) showSettings();
    if (document.getElementById('view-next')!.classList.contains('active')) showNext();
  });
}

boot();
