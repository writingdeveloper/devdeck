import { tr, SUPPORTED, setLanguage as setRuntimeLang } from './i18n-runtime';

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
  const renderRow = (f: { path: string; kind: 'root' | 'repo' }) => {
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
  for (const lng of SUPPORTED) { const o = document.createElement('option'); o.value = lng; o.textContent = lng.toUpperCase(); if (lng === s.language) o.selected = true; sel.appendChild(o); }
  sel.addEventListener('change', async () => { await window.devdeck.setLanguage(sel.value); setRuntimeLang(sel.value); render(); onChangedCb(); });
  host.appendChild(field('nav.language', sel, sel));
}

export function mountSettings(onChanged: () => void): void { host = document.getElementById('settings-form')!; onChangedCb = onChanged; }
export function showSettings(): void { void render(); }
