import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { filterSessions, groupByActivity, needsAttentionCount, labelByProject, type CockpitSession } from '../shared/cockpitModel';
import { computeActivity, stripAnsi, type ActivityState } from '../shared/sessionStatus';
import { decideKeyAction } from '../shared/terminalKeys';
import { sanitizePersistedList, type PersistedSession } from '../shared/cockpitPersist';
import type { StaleLevel } from '../shared/types';
import { tr } from './i18n-runtime';

interface Live { session: CockpitSession; term: Terminal; fit: FitAddon; el: HTMLElement; lastDataAt: number; lastInputAt: number; recentOutput: string; openedSessionId: string | null; }
export interface OpenReq { path: string; name: string; staleLevel: StaleLevel; branch: string | null; dirty: number; sessionId?: string | null; fresh?: boolean; }

const live = new Map<string, Live>();
let restorable: PersistedSession[] = []; // previous sessions persisted across restarts, not yet restored
let restorableLoaded = false; // guard: don't persist (and clobber the on-disk list) until the initial load resolves
let liveLabels = new Map<string, string>(); // live session id -> display label (#N when a project has several sessions)
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
  // Load previously-open sessions (from a prior quit/crash) as restorable entries. Guard persist()
  // until this resolves so a session opened during the load window can't clobber the on-disk list;
  // then persist once to capture any such session in the correct union.
  window.devdeck.cockpit.loadSessions()
    .then((list) => { restorable = sanitizePersistedList(list); restorableLoaded = true; renderList(); if (live.size > 0) persist(); })
    .catch(() => { restorableLoaded = true; });
}

/** Persist the current cockpit membership (live sessions + not-yet-restored entries) eagerly,
 *  so a crash/power-outage loses nothing. Dedupe by path: a live path is never also restorable. */
function persist(): void {
  if (!restorableLoaded) return; // initial load not done — persisting now would overwrite the unread list
  const liveIds = new Set([...live.values()].map((l) => l.openedSessionId).filter((x): x is string => !!x));
  const fromLive: PersistedSession[] = [...live.values()].map((l) => ({ projectPath: l.session.projectPath, name: l.session.name, sessionId: l.openedSessionId, agentId: l.session.agentId }));
  const rest = restorable.filter((r) => !(r.sessionId && liveIds.has(r.sessionId))); // keep siblings + null-id (codex) entries
  window.devdeck.cockpit.saveSessions([...fromLive, ...rest]);
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
  // Resolve the Ctrl+C copy-vs-SIGINT conflict (and Ctrl+V paste) before xterm forwards the key.
  // Returning false stops xterm processing it, so 'copy'/'paste' never reach the PTY as keystrokes.
  term.attachCustomKeyEventHandler((e) => {
    const action = decideKeyAction(e, term.hasSelection());
    if (action === 'copy') { window.devdeck.clipboard.writeText(term.getSelection()); return false; }
    if (action === 'paste') {
      e.preventDefault(); // cancel the native paste gesture so xterm's own paste can't double with our IPC paste
      window.devdeck.clipboard.readText().then((t) => { if (t) term.paste(t); });
      return false;
    }
    return true;
  });
  const { cols, rows } = term;
  const res = await window.devdeck.cockpit.open({ projectPath: p.path, sessionId: p.sessionId ?? null, cols, rows, fresh: !!p.fresh });
  if (!res.id) { el.remove(); term.dispose(); if (selectedId) select(selectedId); return; } // refused — restore prior selection
  const session: CockpitSession = { id: res.id, projectPath: p.path, name: p.name, agentId: res.agentId, status: 'running', staleLevel: p.staleLevel, branch: p.branch, dirty: p.dirty, activity: 'working' };
  term.onData((d) => {
    window.devdeck.cockpit.input(res.id, d);
    const l = live.get(res.id); // typing answers any pending prompt → clear the buffer + mark input so it reads as "your turn", not "working"
    if (l) { l.recentOutput = ''; l.lastInputAt = Date.now(); }
  });
  live.set(res.id, { session, term, fit, el, lastDataAt: Date.now(), lastInputAt: 0, recentOutput: '', openedSessionId: res.sessionId ?? null });
  if (res.sessionId) restorable = restorable.filter((r) => r.sessionId !== res.sessionId); // dedupe by session id, not path (siblings stay)
  select(res.id);
  updateRailBadge();
  persist();
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
    const next = computeActivity({ exited: l.session.status === 'exited', lastDataAt: l.lastDataAt, lastInputAt: l.lastInputAt, now, recentOutput: l.recentOutput });
    if (next !== l.session.activity) { l.session.activity = next; changed = true; }
  }
  if (changed) { renderList(); updateRailBadge(); }
}

function renderAll(): void { renderList(); renderHeader(); }

function renderList(): void {
  const search = (searchEl?.value ?? '').toLowerCase();
  const liveSessions = [...live.values()].map((l) => l.session);
  const liveIds = new Set([...live.values()].map((l) => l.openedSessionId).filter((x): x is string => !!x));
  // Previous (restorable) sessions, excluding any whose specific session id is currently live (siblings of
  // the same project stay — dedupe is per session id, not per path).
  const prev = restorable.filter((r) => !(r.sessionId && liveIds.has(r.sessionId)) && r.name.toLowerCase().includes(search));

  // #N labels across the union (live + visible-restorable) so a project's sessions are numbered consistently.
  const union = [...liveSessions.map((s) => ({ projectPath: s.projectPath, name: s.name })), ...prev.map((r) => ({ projectPath: r.projectPath, name: r.name }))];
  const labels = labelByProject(union);
  liveLabels = new Map(liveSessions.map((s, i) => [s.id, labels[i]]));
  const prevLabels = prev.map((_r, i) => labels[liveSessions.length + i]);

  const filtered = filterSessions(liveSessions, searchEl?.value ?? '');
  groupsEl.replaceChildren();
  for (const g of groupByActivity(filtered)) {
    const h = document.createElement('div'); h.className = 'ck-grp';
    h.textContent = `${tr('cockpit.grp_' + g.bucket)} · ${g.items.length}`;
    groupsEl.appendChild(h);
    for (const s of g.items) groupsEl.appendChild(row(s));
  }
  if (prev.length) {
    const h = document.createElement('div'); h.className = 'ck-grp ck-grp-prev';
    const label = document.createElement('span'); label.textContent = `${tr('cockpit.prev_sessions')} · ${prev.length}`;
    const allBtn = document.createElement('button'); allBtn.className = 'ck-restore-all'; allBtn.textContent = `↻ ${tr('cockpit.restore_all')}`; allBtn.title = tr('cockpit.restore_all');
    allBtn.addEventListener('click', () => void restoreAll());
    h.append(label, allBtn);
    groupsEl.appendChild(h);
    prev.forEach((r, i) => groupsEl.appendChild(prevRow(r, prevLabels[i])));
  }
  emptyEl.textContent = liveSessions.length > 0 ? '' : (prev.length > 0 ? tr('cockpit.empty_prev') : tr('cockpit.empty'));
}

function prevRow(r: PersistedSession, label: string): HTMLElement {
  const el = document.createElement('div'); el.className = 'ck-row ck-row-prev';
  el.innerHTML = `<span class="ck-ind"><span class="ck-dot"></span></span><div><div class="nm"></div><div class="mt"></div></div><span class="ck-prev-acts"></span>`;
  el.querySelector('.nm')!.textContent = label;
  el.querySelector('.mt')!.textContent = `${tr('cockpit.restore')} · ${r.agentId}`;
  el.title = tr('cockpit.restore');
  const forget = document.createElement('button'); forget.className = 'ck-forget'; forget.textContent = '✕'; forget.title = tr('cockpit.forget');
  forget.addEventListener('click', (e) => { e.stopPropagation(); forgetSession(r); });
  el.querySelector('.ck-prev-acts')!.appendChild(forget);
  el.addEventListener('click', () => void restoreSession(r));
  return el;
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
  el.querySelector('.nm')!.textContent = liveLabels.get(s.id) ?? s.name;
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
  const title = document.createElement('span'); title.className = 'title'; title.textContent = liveLabels.get(s.id) ?? s.name;
  const branch = document.createElement('span'); branch.className = 'ck-pill'; branch.textContent = `⎇ ${s.branch ?? '-'}${s.dirty > 0 ? ` ✎${s.dirty}` : ''}`;
  const ag = document.createElement('span'); ag.className = 'ck-pill'; ag.textContent = `✦ ${s.agentId}`;
  const sp = document.createElement('span'); sp.className = 'sp';
  const newSession = actBtn('+', tr('cockpit.new_session'), () => void addSessionToCurrentProject());
  const folder = actBtn('📁', tr('cockpit.open_folder'), () => window.devdeck.openFolder(s.projectPath));
  const restart = actBtn('⟳', tr('cockpit.restart'), () => restartSession(s.id));
  const close = actBtn('✕', tr('cockpit.close'), () => closeSession(s.id));
  headerEl.append(title, branch, ag, sp, newSession, folder, restart, close);
}

/** "+ New session": spawn another, fresh conversation in the SAME project as the selected session. */
async function addSessionToCurrentProject(): Promise<void> {
  const l = selectedId ? live.get(selectedId) : null; if (!l) return;
  const s = l.session;
  await createSession({ path: s.projectPath, name: s.name, staleLevel: s.staleLevel, branch: s.branch, dirty: s.dirty, fresh: true });
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
  persist(); // close = forget (the closed session drops out of persistence)
  if (selectedId === id) {
    const next = [...live.keys()][0] ?? null;
    selectedId = null;
    if (next) select(next);
    else { renderAll(); mainEl.classList.toggle('has-session', false); }
  } else renderList();
}

/** Bring a previous session back to life via its resume command. If the active agent differs from
 *  the one it was opened with, drop the saved sessionId (don't resume one agent's id under another). */
async function restoreSession(entry: PersistedSession): Promise<void> {
  restorable = restorable.filter((r) => r !== entry);
  const active = await window.devdeck.getAgent();
  const sessionId = entry.agentId === active ? entry.sessionId : null;
  await createSession({ path: entry.projectPath, name: entry.name, staleLevel: 'neutral', branch: null, dirty: 0, sessionId });
}

async function restoreAll(): Promise<void> {
  for (const entry of [...restorable]) await restoreSession(entry);
}

function forgetSession(entry: PersistedSession): void {
  restorable = restorable.filter((r) => r !== entry);
  persist();
  renderList();
}
