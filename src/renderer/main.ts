import { mountProjects, renderProjects, reloadProjects } from './projectsView';
import { mountNav } from './nav';
import { mountUsage, showUsage } from './usageView';
import { mountSettings, showSettings } from './settingsView';
import { setLanguage, tr, currentLang, SUPPORTED } from './i18n-runtime';

const toastHost = document.getElementById('toast-host')!;
window.devdeck.onError((msg) => {
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
  toastHost.appendChild(el); setTimeout(() => el.remove(), 6000);
});

function applyStaticLabels(): void {
  document.documentElement.lang = currentLang();
  document.querySelector<HTMLButtonElement>('#open-selected')!.textContent = '▶ ' + tr('app.open_selected');
  document.querySelector<HTMLButtonElement>('#refresh')!.title = tr('app.refresh');
  const map: [string, string][] = [['[data-view="projects"]', 'nav.projects'], ['[data-view="usage"]', 'nav.usage'], ['[data-view="settings"]', 'nav.settings'], ['#lang-btn', 'nav.language']];
  for (const [sel, key] of map) { const el = document.querySelector<HTMLElement>(sel); if (el) el.title = tr(key); }
  const chk = document.querySelector('#view-projects .chk');
  if (chk?.lastChild) chk.lastChild.textContent = ' ' + tr('proj.neglected_only');
  const showHidden = document.getElementById('show-hidden');
  if (showHidden?.firstChild) showHidden.firstChild.textContent = '🙈 ' + tr('proj.hidden') + ' ';
}

async function boot(): Promise<void> {
  setLanguage(await window.devdeck.getLanguage());
  applyStaticLabels();
  mountProjects();
  mountUsage();
  mountSettings(() => { applyStaticLabels(); reloadProjects(); });
  mountNav((view) => { if (view === 'usage') showUsage(); if (view === 'settings') showSettings(); });

  document.getElementById('lang-btn')!.addEventListener('click', async () => {
    const i = SUPPORTED.indexOf(currentLang());
    const next = SUPPORTED[(i + 1) % SUPPORTED.length];
    await window.devdeck.setLanguage(next);
    setLanguage(next);
    applyStaticLabels();
    renderProjects();
    if (document.getElementById('view-usage')!.classList.contains('active')) showUsage();
    if (document.getElementById('view-settings')!.classList.contains('active')) showSettings();
  });
}

boot();
