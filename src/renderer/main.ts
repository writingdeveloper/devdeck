import { mountProjects, renderProjects, reloadProjects, setCockpitEnabled } from './projectsView';
import { mountNav } from './nav';
import { mountUsage, showUsage } from './usageView';
import { mountSettings, showSettings } from './settingsView';
import { mountNext, showNext } from './nextView';
import { mountCockpit, showCockpit } from './cockpitView';
import { isCockpitPlatform } from '../shared/cockpitModel';
import { setLanguage, tr, currentLang, languageName, SUPPORTED } from './i18n-runtime';
import { mountUsageBar, refreshUsageBar } from './usageBar';

const toastHost = document.getElementById('toast-host')!;
window.devdeck.onError((msg) => {
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
  toastHost.appendChild(el); setTimeout(() => el.remove(), 6000);
});

const updateBanner = document.getElementById('update-banner')!;
let lastUpdatePayload: import('../shared/update').UpdatePayload | null = null;
function renderUpdate(p: import('../shared/update').UpdatePayload): void {
  lastUpdatePayload = p;
  // Keep the About status span in sync for EVERY state so a click on
  // "check for updates" always gets feedback right next to the button —
  // it must never stay stuck on "checking".
  const s = document.getElementById('about-update-status');
  if (s) {
    if (p.status === 'checking') s.textContent = tr('about.checking');
    else if (p.status === 'none') s.textContent = tr('about.up_to_date');
    else if (p.status === 'error') s.textContent = tr('about.check_failed');
    else if (p.status === 'available') s.textContent = tr('about.update_available', { version: p.version });
    else s.textContent = ''; // downloading/downloaded — the banner carries the action
  }
  if (p.status !== 'available' && p.status !== 'downloading' && p.status !== 'downloaded') {
    updateBanner.classList.add('hidden');
    return;
  }
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
  document.querySelector<HTMLButtonElement>('#new-project')!.textContent = '+ ' + tr('proj.new');
  const refreshBtn = document.querySelector<HTMLButtonElement>('#refresh')!;
  refreshBtn.title = tr('app.refresh');
  refreshBtn.setAttribute('aria-label', tr('app.refresh'));
  const map: [string, string][] = [['[data-view="projects"]', 'nav.projects'], ['[data-view="usage"]', 'nav.usage'], ['[data-view="settings"]', 'nav.settings'], ['[data-view="next"]', 'nav.next'], ['[data-view="cockpit"]', 'nav.cockpit'], ['#lang-btn', 'nav.language']];
  for (const [sel, key] of map) { const el = document.querySelector<HTMLElement>(sel); if (el) { el.title = tr(key); el.setAttribute('aria-label', tr(key)); } }
  const agentSel = document.getElementById('agent-select');
  if (agentSel && !agentSel.classList.contains('hidden')) agentSel.setAttribute('aria-label', tr('agent.label'));
  const chk = document.querySelector('#view-projects .chk');
  if (chk?.lastChild) chk.lastChild.textContent = ' ' + tr('proj.neglected_only');
  const showHidden = document.getElementById('show-hidden');
  if (showHidden?.firstChild) showHidden.firstChild.textContent = '🙈 ' + tr('proj.hidden') + ' ';
  const ckSearch = document.getElementById('ck-search') as HTMLInputElement | null;
  if (ckSearch) ckSearch.placeholder = tr('cockpit.search');
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

// Switch the whole UI to `lang`: persist it, swap the active dictionary, then re-render
// every surface that shows translated text (labels, usage bar, update banner, active view).
async function applyLanguage(lang: string): Promise<void> {
  await window.devdeck.setLanguage(lang);
  setLanguage(lang);
  applyStaticLabels();
  void refreshUsageBar();
  if (lastUpdatePayload) renderUpdate(lastUpdatePayload);
  renderProjects();
  if (document.getElementById('view-usage')!.classList.contains('active')) showUsage();
  if (document.getElementById('view-settings')!.classList.contains('active')) showSettings();
  if (document.getElementById('view-next')!.classList.contains('active')) showNext();
}

// The 🌐 rail button opens a popup listing every language by its own-script name, so a
// language is one click to open + one to pick — no more blind cycling. Reuses the app's
// shared .menu component (the same one behind the project ⋯ menu).
function mountLangMenu(): void {
  const btn = document.getElementById('lang-btn')!;
  const wrap = btn.parentElement!; // .menu-wrap.lang-wrap — positions the popup beside the rail
  const menu = document.createElement('div');
  menu.className = 'menu lang-menu hidden';
  menu.setAttribute('role', 'menu');

  const items = SUPPORTED.map((lng) => {
    const item = document.createElement('button');
    item.className = 'menu-item'; item.setAttribute('role', 'menuitemradio');
    item.dataset.lang = lng;
    const mark = document.createElement('span'); mark.className = 'mi-mark';
    const label = document.createElement('span'); label.textContent = languageName(lng);
    item.append(mark, label);
    item.addEventListener('click', async () => {
      close(); btn.focus();
      if (lng !== currentLang()) await applyLanguage(lng);
    });
    menu.appendChild(item);
    return item;
  });

  const syncMarks = (): void => {
    for (const item of items) {
      const on = item.dataset.lang === currentLang();
      item.classList.toggle('active', on);
      item.setAttribute('aria-checked', on ? 'true' : 'false');
      item.querySelector<HTMLElement>('.mi-mark')!.textContent = on ? '✓' : '';
    }
  };
  const open = (): void => {
    syncMarks();
    menu.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
    (items.find((it) => it.dataset.lang === currentLang()) ?? items[0]).focus();
  };
  const close = (): void => {
    menu.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't let the document handler immediately re-close it
    if (menu.classList.contains('hidden')) open();
    else { close(); btn.focus(); }
  });
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); btn.focus(); } });
  document.addEventListener('click', () => { if (!menu.classList.contains('hidden')) close(); });

  wrap.appendChild(menu);
}

async function boot(): Promise<void> {
  mountTitlebar();
  setLanguage(await window.devdeck.getLanguage());
  // Cockpit (embedded node-pty terminals) is Windows-only for now; elsewhere "open" uses the external terminal.
  const cockpitOn = isCockpitPlatform((await window.devdeck.getSettings()).platform);
  setCockpitEnabled(cockpitOn);
  if (!cockpitOn) document.querySelector('.rail-item[data-view="cockpit"]')?.remove();
  applyStaticLabels();
  mountProjects();
  mountUsage();
  mountSettings(() => { applyStaticLabels(); reloadProjects(); void refreshUsageBar(); });
  mountNext();
  mountUsageBar();
  if (cockpitOn) mountCockpit();
  mountNav((view) => { if (view === 'usage') showUsage(); if (view === 'settings') showSettings(); if (view === 'next') showNext(); if (view === 'cockpit') showCockpit(); });

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

  mountLangMenu();
}

boot();
