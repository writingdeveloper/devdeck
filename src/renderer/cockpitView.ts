import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { filterSessions, groupByActivity, needsAttentionCount, type CockpitSession } from '../shared/cockpitModel';
import { computeActivity, stripAnsi, type ActivityState } from '../shared/sessionStatus';
import type { StaleLevel } from '../shared/types';
import { tr } from './i18n-runtime';

interface Live { session: CockpitSession; term: Terminal; fit: FitAddon; el: HTMLElement; lastDataAt: number; recentOutput: string; }
export interface OpenReq { path: string; name: string; staleLevel: StaleLevel; branch: string | null; dirty: number; sessionId?: string | null; }

const live = new Map<string, Live>();
let selectedId: string | null = null;
let searchEl: HTMLInputElement, groupsEl: HTMLElement, headerEl: HTMLElement, termsEl: HTMLElement, emptyEl: HTMLElement, mainEl: HTMLElement;
let mounted = false;

export function mountCockpit(): void {
  if (mounted) return; // idempotent — register the bridge listeners exactly once
  mounted = true;
  searchEl = document.getElementById('ck-search') as HTMLInputElement;
  groupsEl = document.getElementById('ck-groups')!;
  headerEl = document.getElementById('ck-header')!;
  termsEl = document.getElementById('ck-terms')!;
  emptyEl = document.getElementById('ck-empty')!;
  mainEl = document.querySelector('#view-cockpit .ck-main')!;
  searchEl.addEventListener('input', renderList);

  window.devdeck.cockpit.onData(({ id, chunk }) => {
    const l = live.get(id); if (!l) return;
    l.term.write(chunk);
    l.lastDataAt = Date.now();
    l.recentOutput = (l.recentOutput + stripAnsi(chunk)).slice(-4096);
  });
  window.devdeck.cockpit.onExit(({ id }) => {
    const l = live.get(id); if (!l) return;
    l.session.status = 'exited'; l.session.activity = 'exited';
    renderList(); renderHeader(); updateRailBadge();
  });
  window.addEventListener('resize', () => { if (selectedId) fitSelected(); });
  setInterval(tickActivity, 1000);
  renderAll();
}

/** Re-fit the active terminal when the cockpit becomes visible (xterm can't size while hidden). */
export function showCockpit(): void {
  if (selectedId) requestAnimationFrame(() => { fitSelected(); live.get(selectedId!)?.term.focus(); });
}

/** Called by Projects "open": switch to the cockpit FIRST (so terminals fit a visible pane), then create a session per project. */
export async function openProjectsInCockpit(projects: OpenReq[]): Promise<void> {
  document.querySelector<HTMLButtonElement>('.rail-item[data-view="cockpit"]')!.click();
  for (const p of projects) await createSession(p);
}

async function createSession(p: OpenReq): Promise<void> {
  const el = document.createElement('div'); el.className = 'ck-term'; termsEl.appendChild(el);
  // Make this terminal visible BEFORE fitting: FitAddon measures 0 on a display:none element,
  // which would spawn the PTY at the wrong size. select() below re-affirms the show/hide state.
  for (const l of live.values()) l.el.classList.remove('show');
  el.classList.add('show');
  const term = new Terminal({ fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 12, theme: { background: '#0a0b0e' }, cursorBlink: true });
  const fit = new FitAddon(); term.loadAddon(fit); term.open(el); fit.fit();
  const { cols, rows } = term;
  const res = await window.devdeck.cockpit.open({ projectPath: p.path, sessionId: p.sessionId ?? null, cols, rows });
  if (!res.id) { el.remove(); term.dispose(); if (selectedId) select(selectedId); return; } // refused — restore prior selection
  const session: CockpitSession = { id: res.id, projectPath: p.path, name: p.name, agentId: res.agentId, status: 'running', staleLevel: p.staleLevel, branch: p.branch, dirty: p.dirty, activity: 'working' };
  term.onData((d) => {
    window.devdeck.cockpit.input(res.id, d);
    const l = live.get(res.id); // typing answers any pending prompt → clear the buffer so 'attention' doesn't stick
    if (l) l.recentOutput = '';
  });
  live.set(res.id, { session, term, fit, el, lastDataAt: Date.now(), recentOutput: '' });
  select(res.id);
  updateRailBadge();
}

function select(id: string): void {
  selectedId = id;
  for (const [lid, l] of live) l.el.classList.toggle('show', lid === id);
  mainEl.classList.toggle('has-session', live.size > 0);
  renderList(); renderHeader();
  requestAnimationFrame(() => { fitSelected(); live.get(id)?.term.focus(); });
}

function fitSelected(): void {
  const l = selectedId ? live.get(selectedId) : null; if (!l) return;
  l.fit.fit(); window.devdeck.cockpit.resize(l.session.id, l.term.cols, l.term.rows);
}

function tickActivity(): void {
  const now = Date.now();
  let changed = false;
  for (const l of live.values()) {
    const next = computeActivity({ exited: l.session.status === 'exited', lastDataAt: l.lastDataAt, now, recentOutput: l.recentOutput });
    if (next !== l.session.activity) { l.session.activity = next; changed = true; }
  }
  if (changed) { renderList(); updateRailBadge(); }
}

function renderAll(): void { renderList(); renderHeader(); }

function renderList(): void {
  const all = [...live.values()].map((l) => l.session);
  const filtered = filterSessions(all, searchEl?.value ?? '');
  groupsEl.replaceChildren();
  if (all.length === 0) { emptyEl.textContent = tr('cockpit.empty'); return; }
  emptyEl.textContent = '';
  for (const g of groupByActivity(filtered)) {
    const h = document.createElement('div'); h.className = 'ck-grp';
    h.textContent = `${tr('cockpit.grp_' + g.bucket)} · ${g.items.length}`;
    groupsEl.appendChild(h);
    for (const s of g.items) groupsEl.appendChild(row(s));
  }
}

function row(s: CockpitSession): HTMLElement {
  const a: ActivityState = s.activity;
  const el = document.createElement('div');
  el.className = `ck-row act-${a}${s.id === selectedId ? ' sel' : ''}`;
  const dirty = s.dirty > 0 ? ` ✎${s.dirty}` : '';
  el.innerHTML = `<span class="ck-ind"></span><div><div class="nm"></div><div class="mt"></div></div>`;
  const ind = el.querySelector('.ck-ind')!;
  if (a === 'working') ind.innerHTML = '<span class="ck-spin"></span>';
  else if (a === 'attention') ind.textContent = '❓';
  else ind.innerHTML = '<span class="ck-dot"></span>';
  el.querySelector('.nm')!.textContent = s.name;
  el.querySelector('.mt')!.textContent = `${s.branch ?? '-'}${dirty} · ${s.agentId}`;
  el.title = tr('cockpit.st_' + a);
  el.addEventListener('click', () => select(s.id));
  return el;
}

function updateRailBadge(): void {
  const badge = document.getElementById('ck-badge'); if (!badge) return;
  const n = needsAttentionCount([...live.values()].map((l) => l.session));
  badge.textContent = String(n);
  badge.classList.toggle('hidden', n === 0);
}

function renderHeader(): void {
  headerEl.replaceChildren();
  const l = selectedId ? live.get(selectedId) : null;
  if (!l) return;
  const s = l.session;
  const title = document.createElement('span'); title.className = 'title'; title.textContent = s.name;
  const branch = document.createElement('span'); branch.className = 'ck-pill'; branch.textContent = `⎇ ${s.branch ?? '-'}${s.dirty > 0 ? ` ✎${s.dirty}` : ''}`;
  const ag = document.createElement('span'); ag.className = 'ck-pill'; ag.textContent = `✦ ${s.agentId}`;
  const sp = document.createElement('span'); sp.className = 'sp';
  const folder = actBtn('📁', tr('cockpit.open_folder'), () => window.devdeck.openFolder(s.projectPath));
  const restart = actBtn('⟳', tr('cockpit.restart'), () => restartSession(s.id));
  const close = actBtn('✕', tr('cockpit.close'), () => closeSession(s.id));
  headerEl.append(title, branch, ag, sp, folder, restart, close);
}

function actBtn(glyph: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button'); b.className = 'ck-act'; b.textContent = glyph; b.title = title; b.addEventListener('click', onClick); return b;
}

async function restartSession(id: string): Promise<void> {
  const l = live.get(id); if (!l) return;
  const p: OpenReq = { path: l.session.projectPath, name: l.session.name, staleLevel: l.session.staleLevel, branch: l.session.branch, dirty: l.session.dirty };
  closeSession(id); await createSession(p);
}

function closeSession(id: string): void {
  const l = live.get(id); if (!l) return;
  window.devdeck.cockpit.close(id);
  l.term.dispose(); l.el.remove(); live.delete(id); updateRailBadge();
  if (selectedId === id) {
    const next = [...live.keys()][0] ?? null;
    selectedId = null;
    if (next) select(next);
    else { renderAll(); mainEl.classList.toggle('has-session', false); }
  } else renderList();
}
