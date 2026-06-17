import { tr, SUPPORTED, languageName, setLanguage as setRuntimeLang } from './i18n-runtime';
import type { Folder } from '../shared/types';

let host: HTMLElement;
let onChangedCb: () => void = () => {};
let uid = 0;

function field(labelKey: string, control: HTMLElement, forEl?: HTMLElement): HTMLElement {
  const row = document.createElement('div'); row.className = 'set-row';
  const lab = document.createElement('label'); lab.className = 'set-label'; lab.textContent = tr(labelKey);
  if (forEl) { if (!forEl.id) forEl.id = `set-f${uid++}`; lab.htmlFor = forEl.id; }
  row.append(lab, control); return row;
}

async function render(): Promise<void> {
  const s = await window.devdeck.getSettings();
  host.replaceChildren();
  const title = document.createElement('h2'); title.className = 'set-title'; title.textContent = tr('nav.settings');
  host.appendChild(title);

  const folders = await window.devdeck.getFolders();
  const list = document.createElement('div'); list.className = 'folder-list';
  const renderRow = (f: Folder) => {
    const row = document.createElement('div'); row.className = 'folder-row';
    const path = document.createElement('span'); path.className = 'folder-path'; path.textContent = f.path;
    const kind = document.createElement('span'); kind.className = 'folder-kind';
    kind.textContent = tr(f.kind === 'repo' ? 'set.kind_repo' : 'set.kind_root');
    const rm = document.createElement('button'); rm.className = 'folder-rm'; rm.textContent = '✕';
    rm.setAttribute('aria-label', tr('set.remove_folder'));
    rm.addEventListener('click', async () => { await window.devdeck.removeFolder(f.path); render(); onChangedCb(); });
    row.append(path, kind, rm); return row;
  };
  for (const f of folders) list.appendChild(renderRow(f));
  const add = document.createElement('button'); add.className = 'chip'; add.textContent = tr('set.add_folder');
  add.addEventListener('click', async () => {
    const p = await window.devdeck.pickFolder();
    if (p) { await window.devdeck.addFolder(p); render(); onChangedCb(); }
  });
  const listWrap = document.createElement('div'); listWrap.append(list, add);
  host.appendChild(field('set.scan_locations', listWrap));

  const mk = (v: number) => { const n = document.createElement('input'); n.type = 'number'; n.min = '1'; n.className = 'set-num'; n.value = String(v); return n; };
  const f = mk(s.thresholds.freshDays), w = mk(s.thresholds.warnDays), g = mk(s.thresholds.neglectedDays);
  const save = async () => { await window.devdeck.setThresholds({ freshDays: +f.value, warnDays: +w.value, neglectedDays: +g.value }); onChangedCb(); };
  [f, w, g].forEach((n) => n.addEventListener('change', save));
  const tWrap = document.createElement('div'); tWrap.className = 'set-inline';
  for (const [key, el] of [['set.fresh', f], ['set.warn', w], ['set.neglected', g]] as [string, HTMLInputElement][]) {
    const grp = document.createElement('span'); grp.className = 'set-thr';
    const l = document.createElement('label'); l.textContent = tr(key);
    if (!el.id) el.id = `set-f${uid++}`; l.htmlFor = el.id;
    grp.append(l, el); tWrap.appendChild(grp);
  }
  host.appendChild(field('set.thresholds', tWrap));

  const sel = document.createElement('select'); sel.className = 'set-input';
  for (const lng of SUPPORTED) { const o = document.createElement('option'); o.value = lng; o.textContent = languageName(lng); if (lng === s.language) o.selected = true; sel.appendChild(o); }
  sel.addEventListener('change', async () => { await window.devdeck.setLanguage(sel.value); setRuntimeLang(sel.value); render(); onChangedCb(); });
  host.appendChild(field('nav.language', sel, sel));

  if (s.platform === 'win32') {
    const chk = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'set-check';
    chk.checked = s.openAtLogin;
    chk.addEventListener('change', () => void window.devdeck.setOpenAtLogin(chk.checked));
    host.appendChild(field('set.open_at_login', chk, chk));

    // Tray attention alert: redden the tray icon when a cockpit session needs you.
    const tray = document.createElement('select'); tray.className = 'set-input';
    for (const [val, key] of [['attention', 'set.tray_alert_attention'], ['all', 'set.tray_alert_all'], ['off', 'set.tray_alert_off']] as [string, string][]) {
      const o = document.createElement('option'); o.value = val; o.textContent = tr(key); if (val === s.trayAlert) o.selected = true; tray.appendChild(o);
    }
    tray.addEventListener('change', () => void window.devdeck.setTrayAlert(tray.value as 'off' | 'attention' | 'all'));
    host.appendChild(field('set.tray_alert', tray, tray));
  }

  const info = await window.devdeck.getAppInfo();
  const about = document.createElement('div'); about.className = 'about';
  const aTitle = document.createElement('h3'); aTitle.className = 'about-title'; aTitle.textContent = tr('about.title');
  const ver = document.createElement('div'); ver.className = 'about-ver'; ver.textContent = `DevDeck v${info.version}`;
  const rt = document.createElement('span'); rt.className = 'about-rt'; rt.textContent = ` (Electron ${info.electron})`;
  ver.appendChild(rt);
  const links = document.createElement('div'); links.className = 'about-links';
  const link = (labelKey: string, url: string) => {
    const b = document.createElement('button'); b.className = 'chip'; b.textContent = tr(labelKey);
    b.addEventListener('click', () => void window.devdeck.openExternal(url));
    return b;
  };
  links.append(
    link('about.github', info.repoUrl),
    link('about.releases', info.repoUrl + '/releases/latest'),
    link('about.license', info.repoUrl + '/blob/main/LICENSE'),
    link('about.report_issue', info.repoUrl + '/issues'),
  );
  const upd = document.createElement('div'); upd.className = 'about-upd';
  const chk = document.createElement('button'); chk.className = 'chip'; chk.textContent = tr('about.check_updates');
  const status = document.createElement('span'); status.id = 'about-update-status'; status.className = 'about-status'; status.setAttribute('aria-live', 'polite');
  if (info.packaged) {
    chk.addEventListener('click', () => void window.devdeck.checkForUpdates());
  } else {
    chk.disabled = true; status.textContent = tr('about.updates_dev');
  }
  upd.append(chk, status);
  const meta = document.createElement('div'); meta.className = 'about-meta'; meta.textContent = 'MIT · © Si Hyeong Lee';
  about.append(aTitle, ver, links, upd, meta);
  host.appendChild(about);
}

export function mountSettings(onChanged: () => void): void { host = document.getElementById('settings-form')!; onChangedCb = onChanged; }
export function showSettings(): void { void render(); }
