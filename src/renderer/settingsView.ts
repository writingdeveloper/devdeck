import { tr, SUPPORTED } from './i18n-runtime';

let host: HTMLElement;
let onChangedCb: () => void = () => {};

function field(labelKey: string, control: HTMLElement): HTMLElement {
  const row = document.createElement('div'); row.className = 'set-row';
  const lab = document.createElement('label'); lab.className = 'set-label'; lab.textContent = tr(labelKey);
  row.append(lab, control); return row;
}

async function render(): Promise<void> {
  const s = await window.devdeck.getSettings();
  host.replaceChildren();
  const title = document.createElement('h2'); title.className = 'set-title'; title.textContent = tr('nav.settings');
  host.appendChild(title);

  const dir = document.createElement('input'); dir.className = 'set-input'; dir.type = 'text'; dir.value = s.baseDir;
  const browse = document.createElement('button'); browse.className = 'chip'; browse.textContent = tr('set.browse');
  browse.addEventListener('click', async () => { const p = await window.devdeck.pickFolder(); if (p) { dir.value = p; await window.devdeck.setBaseDir(p); onChangedCb(); } });
  dir.addEventListener('change', async () => { await window.devdeck.setBaseDir(dir.value.trim()); onChangedCb(); });
  const dirWrap = document.createElement('div'); dirWrap.className = 'set-inline'; dirWrap.append(dir, browse);
  host.appendChild(field('set.scan_dir', dirWrap));

  const mk = (v: number) => { const n = document.createElement('input'); n.type = 'number'; n.min = '1'; n.className = 'set-num'; n.value = String(v); return n; };
  const f = mk(s.thresholds.freshDays), w = mk(s.thresholds.warnDays), g = mk(s.thresholds.neglectedDays);
  const save = async () => { await window.devdeck.setThresholds({ freshDays: +f.value, warnDays: +w.value, neglectedDays: +g.value }); onChangedCb(); };
  [f, w, g].forEach((n) => n.addEventListener('change', save));
  const tWrap = document.createElement('div'); tWrap.className = 'set-inline';
  for (const [key, el] of [['set.fresh', f], ['set.warn', w], ['set.neglected', g]] as [string, HTMLElement][]) {
    const grp = document.createElement('span'); grp.className = 'set-thr'; const l = document.createElement('span'); l.textContent = tr(key); grp.append(l, el); tWrap.appendChild(grp);
  }
  host.appendChild(field('set.thresholds', tWrap));

  const sel = document.createElement('select'); sel.className = 'set-input';
  for (const lng of SUPPORTED) { const o = document.createElement('option'); o.value = lng; o.textContent = lng.toUpperCase(); if (lng === s.language) o.selected = true; sel.appendChild(o); }
  sel.addEventListener('change', async () => { await window.devdeck.setLanguage(sel.value); onChangedCb(); });
  host.appendChild(field('nav.language', sel));
}

export function mountSettings(onChanged: () => void): void { host = document.getElementById('settings-form')!; onChangedCb = onChanged; }
export function showSettings(): void { void render(); }
