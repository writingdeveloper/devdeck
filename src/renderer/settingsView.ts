import { tr, SUPPORTED, languageName, setLanguage as setRuntimeLang } from './i18n-runtime';
import { setCockpitContextWindow, setCockpitTrayAlert, setCockpitSessionSummary, setCockpitAiSummary } from './cockpitView';
import type { Folder } from '../shared/types';
import { IDLE_HOLD_CHOICES } from '../shared/shutdownIdle';
import { basename, parentLabel } from '../shared/paths';
import { createIcon } from './icons';
import { renderLinkSettings } from './settingsLink';
import { bindSetting, bindCheck, bindChoice } from './settingsSave';
import { validThresholds } from '../shared/settingsValidation';
import { renderLoadError, reportSaveError } from './loadError';
import { withTimeout } from '../shared/withTimeout';

let host: HTMLElement;
let onChangedCb: () => void = () => {};
let uid = 0;
let renderVersion = 0;

function field(labelKey: string, control: HTMLElement, forEl?: HTMLElement): HTMLElement {
  const row = document.createElement('div'); row.className = 'set-row ui-row';
  const lab = document.createElement('label'); lab.className = 'set-label'; lab.textContent = tr(labelKey);
  if (forEl) { if (!forEl.id) forEl.id = `set-f${uid++}`; lab.htmlFor = forEl.id; }
  row.append(lab, control); return row;
}

async function render(): Promise<void> {
  const version = ++renderVersion;
  try {
    const [s, folders, info] = await withTimeout(Promise.all([
      window.devdeck.getSettings(), window.devdeck.getFolders(), window.devdeck.getAppInfo(),
    ]), 15_000, 'settings');
    if (version !== renderVersion) return;
    // Build off-screen; only the most recent complete read may replace the current form.
    const content = document.createElement('div');
    const title = document.createElement('h2'); title.className = 'set-title'; title.textContent = tr('nav.settings');
    content.appendChild(title);
    const list = document.createElement('div'); list.className = 'folder-list';
    const renderRow = (folder: Folder) => {
      const row = document.createElement('div'); row.className = 'folder-row';
      const path = document.createElement('span'); path.className = 'folder-path'; path.title = folder.path;
      const name = document.createElement('span'); name.className = 'folder-name'; name.textContent = basename(folder.path);
      const parent = document.createElement('span'); parent.className = 'folder-parent'; parent.textContent = parentLabel(folder.path);
      path.append(name, parent);
      // Folder kind stays read-only: widening an allowlist requires the native picker.
      const kind = document.createElement('span'); kind.className = 'folder-kind';
      kind.textContent = tr(folder.kind === 'repo' ? 'set.kind_repo' : 'set.kind_root');
      const rm = document.createElement('button'); rm.className = 'folder-rm'; rm.appendChild(createIcon('close'));
      rm.setAttribute('aria-label', tr('set.remove_folder'));
      rm.addEventListener('click', async () => {
        rm.disabled = true;
        try { await window.devdeck.removeFolder(folder.path); await render(); onChangedCb(); }
        catch (error) { reportSaveError(error); }
        finally { rm.disabled = false; }
      });
      row.append(path, kind, rm); return row;
    };
    for (const folder of folders) list.appendChild(renderRow(folder));
    const addBtn = (labelKey: string, kind: Folder['kind']) => {
      const b = document.createElement('button'); b.className = 'chip'; b.textContent = tr(labelKey);
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const picked = await window.devdeck.pickFolder();
          if (picked) { await window.devdeck.addFolder(picked, kind); await render(); onChangedCb(); }
        } catch (error) { reportSaveError(error); }
        finally { b.disabled = false; }
      });
      return b;
    };
    const adds = document.createElement('div'); adds.className = 'folder-adds';
    adds.append(addBtn('set.add_scan_root', 'root'), addBtn('set.add_project_folder', 'repo'));
    const hint = document.createElement('p'); hint.className = 'set-hint'; hint.textContent = tr('set.folder_hint');
    const listWrap = document.createElement('div'); listWrap.append(list, adds, hint);
    content.appendChild(field('set.scan_locations', listWrap));

    const mk = (v: number) => { const n = document.createElement('input'); n.type = 'number'; n.min = '1'; n.step = '1'; n.className = 'set-num'; n.value = String(v); return n; };
    const f = mk(s.thresholds.freshDays), w = mk(s.thresholds.warnDays), g = mk(s.thresholds.neglectedDays);
    bindSetting([f, w, g], {
      read: () => ({ freshDays: +f.value, warnDays: +w.value, neglectedDays: +g.value }),
      restore: v => { f.value = String(v.freshDays); w.value = String(v.warnDays); g.value = String(v.neglectedDays); },
      validate: v => validThresholds(v) ? null : 'set.invalid_thresholds',
      write: v => window.devdeck.setThresholds(v), apply: () => onChangedCb(),
    });
    const tWrap = document.createElement('div'); tWrap.className = 'set-inline';
    for (const [key, el] of [['set.fresh', f], ['set.warn', w], ['set.neglected', g]] as [string, HTMLInputElement][]) {
      const grp = document.createElement('span'); grp.className = 'set-thr';
      const l = document.createElement('label'); l.textContent = tr(key);
      el.id = `set-f${uid++}`; l.htmlFor = el.id;
      grp.append(l, el); tWrap.appendChild(grp);
    }
    content.appendChild(field('set.thresholds', tWrap));

    const sel = document.createElement('select'); sel.className = 'set-input';
    for (const lng of SUPPORTED) { const o = document.createElement('option'); o.value = lng; o.textContent = languageName(lng); o.selected = lng === s.language; sel.appendChild(o); }
    bindChoice(sel, v => window.devdeck.setLanguage(v), v => { setRuntimeLang(v); void render(); onChangedCb(); });
    content.appendChild(field('nav.language', sel, sel));

    if (s.platform === 'win32') {
      const chk = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'set-check'; chk.checked = s.openAtLogin;
      bindCheck(chk, v => window.devdeck.setOpenAtLogin(v));
      content.appendChild(field('set.open_at_login', chk, chk));
      const tray = document.createElement('select'); tray.className = 'set-input';
      for (const [val, key] of [['attention', 'set.tray_alert_attention'], ['all', 'set.tray_alert_all'], ['off', 'set.tray_alert_off']]) {
        const o = document.createElement('option'); o.value = val; o.textContent = tr(key); o.selected = val === s.trayAlert; tray.appendChild(o);
      }
      bindChoice<'off' | 'attention' | 'all'>(tray, v => window.devdeck.setTrayAlert(v), setCockpitTrayAlert);
      content.appendChild(field('set.tray_alert', tray, tray));
      const ctxWin = document.createElement('select'); ctxWin.className = 'set-input';
      for (const val of [1_000_000, 200_000]) {
        const o = document.createElement('option'); o.value = String(val); o.textContent = val === 1_000_000 ? '1M' : '200K'; o.selected = val === s.contextWindow; ctxWin.appendChild(o);
      }
      bindChoice(ctxWin, v => window.devdeck.setContextWindow(Number(v)), v => setCockpitContextWindow(Number(v)));
      content.appendChild(field('set.context_window', ctxWin, ctxWin));
      const sum = document.createElement('input'); sum.type = 'checkbox'; sum.className = 'set-check'; sum.checked = s.sessionSummary;
      const ai = document.createElement('input'); ai.type = 'checkbox'; ai.className = 'set-check'; ai.checked = s.aiSessionSummary; ai.disabled = !s.sessionSummary;
      bindCheck(sum, v => window.devdeck.setSessionSummary(v), v => { setCockpitSessionSummary(v); ai.disabled = !v; }, [sum, ai]);
      bindCheck(ai, v => window.devdeck.setAiSessionSummary(v), setCockpitAiSummary, [sum, ai]);
      content.appendChild(field('set.session_summary', sum, sum));
      const aiWrap = document.createElement('div'); aiWrap.className = 'set-inline';
      const aiHint = document.createElement('span'); aiHint.className = 'set-hint'; aiHint.textContent = tr('set.ai_summary_hint');
      aiWrap.append(ai, aiHint); content.appendChild(field('set.ai_summary', aiWrap, ai));
      const hold = document.createElement('select'); hold.className = 'set-input';
      for (const m of IDLE_HOLD_CHOICES) {
        const o = document.createElement('option'); o.value = String(m); o.textContent = String(m); o.selected = m === s.shutdownIdleMinutes; hold.appendChild(o);
      }
      bindChoice(hold, v => window.devdeck.shutdown.setIdleMinutes(Number(v)));
      content.appendChild(field('shutdown.idle_minutes', hold, hold));
      const hist = document.createElement('div'); hist.className = 'shutdown-hist';
      const SHOWN = 10;
      const renderHistory = async (): Promise<void> => {
        const records = await withTimeout(window.devdeck.shutdown.history(), 15_000, 'shutdown history');
        hist.replaceChildren();
        if (!records.length) {
          const empty = document.createElement('div'); empty.className = 'shutdown-hist-empty'; empty.textContent = tr('shutdown.hist_empty'); hist.appendChild(empty); return;
        }
        for (const r of records.slice(0, SHOWN)) {
          const row = document.createElement('div'); row.className = 'shutdown-hist-row';
          const kind = tr(r.kind === 'auto' ? 'shutdown.hist_auto' : 'shutdown.hist_manual');
          row.textContent = `⏻ ${new Date(r.scheduledAt).toLocaleString()} · ${kind}${r.status === 'cancelled' ? ' · ' + tr('shutdown.hist_cancelled') : ''}`;
          hist.appendChild(row);
        }
        const foot = document.createElement('div'); foot.className = 'shutdown-hist-foot';
        const count = document.createElement('span'); count.className = 'shutdown-hist-count';
        count.textContent = records.length > SHOWN ? tr('shutdown.hist_more', { shown: SHOWN, total: records.length }) : tr('shutdown.hist_count', { total: records.length });
        const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'chip'; clear.textContent = tr('shutdown.hist_clear');
        clear.addEventListener('click', async () => {
          clear.disabled = true;
          try { await window.devdeck.shutdown.clearHistory(); await renderHistory(); }
          catch (error) { reportSaveError(error); }
          finally { clear.disabled = false; }
        });
        foot.append(count, clear); hist.appendChild(foot);
      };
      await renderHistory(); content.appendChild(field('shutdown.history', hist));
    }

    const linkSection = await withTimeout(renderLinkSettings(() => { void render(); }), 15_000, 'link settings');
    if (linkSection) content.appendChild(field('link.section', linkSection));
    const about = document.createElement('div'); about.className = 'about';
    const aTitle = document.createElement('h3'); aTitle.className = 'about-title'; aTitle.textContent = tr('about.title');
    const ver = document.createElement('div'); ver.className = 'about-ver'; ver.textContent = `DevDeck v${info.version}`;
    const rt = document.createElement('span'); rt.className = 'about-rt'; rt.textContent = ` (Electron ${info.electron})`; ver.appendChild(rt);
    const links = document.createElement('div'); links.className = 'about-links';
    const link = (labelKey: string, url: string) => {
      const b = document.createElement('button'); b.className = 'chip'; b.textContent = tr(labelKey);
      b.addEventListener('click', () => void window.devdeck.openExternal(url)); return b;
    };
    links.append(link('about.github', info.repoUrl), link('about.releases', info.repoUrl + '/releases/latest'), link('about.license', info.repoUrl + '/blob/main/LICENSE'), link('about.report_issue', info.repoUrl + '/issues'));
    const upd = document.createElement('div'); upd.className = 'about-upd';
    const check = document.createElement('button'); check.className = 'chip'; check.textContent = tr('about.check_updates');
    const status = document.createElement('span'); status.id = 'about-update-status'; status.className = 'about-status'; status.setAttribute('aria-live', 'polite');
    if (info.packaged) check.addEventListener('click', () => void window.devdeck.checkForUpdates());
    else { check.disabled = true; status.textContent = tr('about.updates_dev'); }
    upd.append(check, status);
    const meta = document.createElement('div'); meta.className = 'about-meta'; meta.textContent = 'MIT · © Si Hyeong Lee';
    about.append(aTitle, ver, links, upd, buildDiagnostics(), meta); content.appendChild(about);
    if (version === renderVersion) host.replaceChildren(...Array.from(content.childNodes));
  } catch (error) {
    if (version === renderVersion) renderLoadError(host, () => void render());
    console.error('DevDeck: settings load failed', error);
  }
}

/** Local diagnostic tail only; copying is an explicit user action. */
function buildDiagnostics(): HTMLElement {
  const wrap = document.createElement('div'); wrap.className = 'about-diag';
  const label = document.createElement('div'); label.className = 'about-diag-label'; label.textContent = tr('diag.title');
  const path = document.createElement('code'); path.className = 'about-diag-path'; path.textContent = '…';
  const acts = document.createElement('div'); acts.className = 'about-diag-acts';
  const reveal = document.createElement('button'); reveal.className = 'chip'; reveal.textContent = tr('diag.reveal');
  const copy = document.createElement('button'); copy.className = 'chip'; copy.textContent = tr('diag.copy');
  const status = document.createElement('span'); status.className = 'about-status'; status.setAttribute('aria-live', 'polite');
  reveal.addEventListener('click', () => void window.devdeck.revealDiagnostics());
  copy.addEventListener('click', async () => {
    const text = await window.devdeck.diagnosticsTail(400).catch(() => '');
    if (!text) { status.textContent = tr('diag.empty'); return; }
    window.devdeck.clipboard.writeText(text); status.textContent = tr('diag.copied', { n: String(text.split('\n').length) });
  });
  acts.append(reveal, copy, status);
  void window.devdeck.diagnosticsInfo().then(info => {
    if (!info.path) { wrap.classList.add('hidden'); return; }
    path.textContent = info.path; path.title = info.path;
    label.textContent = `${tr('diag.title')} · ${(info.bytes / 1024).toFixed(0)} KB`;
  }).catch(() => wrap.classList.add('hidden'));
  wrap.append(label, path, acts); return wrap;
}

export function mountSettings(onChanged: () => void): void { host = document.getElementById('settings-form')!; onChangedCb = onChanged; }
export function showSettings(): void { void render(); }
