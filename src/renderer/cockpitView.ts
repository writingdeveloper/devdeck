import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { filterSessions, groupByActivity, needsAttentionCount, numberCollidingNames, cockpitListSignature, type CockpitSession } from '../shared/cockpitModel';
import { computeActivity, stripAnsi, type ActivityState } from '../shared/sessionStatus';
import { friendlyModel } from '../shared/sessionMeta';
import { formatDuration } from '../shared/usage';
import { decideKeyAction } from '../shared/terminalKeys';
import { unwrapCopiedUrl } from '../shared/urlCopy';
import { sanitizePersistedList, pickRestoreSessionId, type PersistedSession } from '../shared/cockpitPersist';
import type { StaleLevel } from '../shared/types';
import { tr, currentLang } from './i18n-runtime';

interface Live { session: CockpitSession; term: Terminal; fit: FitAddon; search: SearchAddon; el: HTMLElement; lastDataAt: number; lastInputAt: number; recentOutput: string; openedSessionId: string | null; customLabel: string | null; meta: { model: string | null; activeMs: number } | null; }
export interface OpenReq { path: string; name: string; staleLevel: StaleLevel; branch: string | null; dirty: number; sessionId?: string | null; fresh?: boolean; label?: string | null; }

const live = new Map<string, Live>();
let restorable: PersistedSession[] = []; // previous sessions persisted across restarts, not yet restored
let restorableLoaded = false; // guard: don't persist (and clobber the on-disk list) until the initial load resolves
let liveLabels = new Map<string, string>(); // live session id -> display label (#N when a project has several sessions)
let lastListSig = ''; // signature of the last-rendered session list — renderList() skips a rebuild when nothing visible changed
let editingId: string | null = null; // session being inline-renamed (rendered as an <input> in its row, so re-renders keep it)
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
  buildFindBar();
  const newBtn = document.getElementById('ck-new-session') as HTMLButtonElement;
  document.getElementById('ck-new-label')!.textContent = tr('cockpit.new_session');
  newBtn.title = tr('cockpit.new_session');
  newBtn.addEventListener('click', () => void addSessionToCurrentProject());

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
  setInterval(refreshAllMeta, 30_000); // model/active-time change slowly — refresh on a slow tick (+ on open/select)
  sendTrayAlertImage(); // hand the main process a red-dotted tray icon for the attention alert
  renderAll();
  // Load previously-open sessions (from a prior quit/crash) as restorable entries. Guard persist()
  // until this resolves so a session opened during the load window can't clobber the on-disk list;
  // then persist once to capture any such session in the correct union.
  window.devdeck.cockpit.loadSessions()
    .then((list) => { restorable = sanitizePersistedList(list); restorableLoaded = true; renderList(); if (live.size > 0) persist(); })
    .catch(() => { restorableLoaded = true; });
}

// ---- in-terminal find (Ctrl+F over the selected session's scrollback) ----
let findBar: HTMLElement | null = null;
let findInput: HTMLInputElement | null = null;

function buildFindBar(): void {
  findBar = document.createElement('div'); findBar.className = 'ck-find hidden';
  findInput = document.createElement('input');
  findInput.className = 'ck-find-input'; findInput.placeholder = tr('cockpit.find_ph');
  findInput.setAttribute('aria-label', tr('cockpit.find_ph'));
  const prev = document.createElement('button'); prev.className = 'ck-find-btn'; prev.textContent = '↑'; prev.title = tr('cockpit.find_prev');
  const next = document.createElement('button'); next.className = 'ck-find-btn'; next.textContent = '↓'; next.title = tr('cockpit.find_next');
  const close = document.createElement('button'); close.className = 'ck-find-btn'; close.textContent = '✕'; close.title = tr('cockpit.find_close');
  const sel = (): Live | undefined => (selectedId ? live.get(selectedId) : undefined);
  findInput.addEventListener('input', () => { const l = sel(); if (l && findInput!.value) l.search.findNext(findInput!.value, { incremental: true }); });
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); const l = sel(); if (l && findInput!.value) l.search.findPrevious(findInput!.value); }
    else if (e.key === 'Enter') { e.preventDefault(); const l = sel(); if (l && findInput!.value) l.search.findNext(findInput!.value); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFindBar(); }
  });
  prev.addEventListener('click', () => { const l = sel(); if (l && findInput!.value) l.search.findPrevious(findInput!.value); });
  next.addEventListener('click', () => { const l = sel(); if (l && findInput!.value) l.search.findNext(findInput!.value); });
  close.addEventListener('click', closeFindBar);
  findBar.append(findInput, prev, next, close);
  termsEl.appendChild(findBar); // .ck-terms is position:relative — the bar floats over the terminal
}

function openFindBar(): void {
  if (!findBar || !findInput) return;
  findBar.classList.remove('hidden');
  findInput.focus(); findInput.select();
}

function closeFindBar(): void {
  if (!findBar) return;
  findBar.classList.add('hidden');
  const l = selectedId ? live.get(selectedId) : undefined;
  l?.search.clearDecorations();
  l?.term.focus(); // hand focus back to the terminal the user was searching
}

/** Persist the current cockpit membership (live sessions + not-yet-restored entries) eagerly,
 *  so a crash/power-outage loses nothing. Dedupe by path: a live path is never also restorable. */
function persist(): void {
  if (!restorableLoaded) return; // initial load not done — persisting now would overwrite the unread list
  const liveIds = new Set([...live.values()].map((l) => l.openedSessionId).filter((x): x is string => !!x));
  const fromLive: PersistedSession[] = [...live.values()].map((l) => ({ projectPath: l.session.projectPath, name: l.session.name, sessionId: l.openedSessionId, agentId: l.session.agentId, label: l.customLabel }));
  const rest = restorable.filter((r) => !(r.sessionId && liveIds.has(r.sessionId))); // keep siblings + null-id (antigravity) entries
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
  // Make http(s) links in terminal output clickable → open via a scheme-guarded IPC.
  // (shell:openExternal is locked to DevDeck's own repo, so terminal links need their own path.)
  term.loadAddon(new WebLinksAddon((_e, uri) => { void window.devdeck.cockpit.openLink(uri); }));
  // Resolve the Ctrl+C copy-vs-SIGINT conflict (and Ctrl+V paste) before xterm forwards the key.
  // Returning false stops xterm processing it, so 'copy'/'paste' never reach the PTY as keystrokes.
  term.attachCustomKeyEventHandler((e) => {
    const action = decideKeyAction(e, term.hasSelection());
    if (action === 'copy') { window.devdeck.clipboard.writeText(unwrapCopiedUrl(term.getSelection())); return false; }
    if (action === 'paste') {
      e.preventDefault(); // cancel the native paste gesture so xterm's own paste can't double with our IPC paste
      window.devdeck.clipboard.readText().then((t) => { if (t) term.paste(t); });
      return false;
    }
    if (action === 'find') { e.preventDefault(); openFindBar(); return false; } // Ctrl+F searches scrollback, never reaches the PTY
    return true;
  });
  const search = new SearchAddon(); term.loadAddon(search);
  const { cols, rows } = term;
  const res = await window.devdeck.cockpit.open({ projectPath: p.path, sessionId: p.sessionId ?? null, cols, rows, fresh: !!p.fresh });
  if (!res.id) { el.remove(); term.dispose(); if (selectedId) select(selectedId); return; } // refused — restore prior selection
  const session: CockpitSession = { id: res.id, projectPath: p.path, name: p.name, agentId: res.agentId, status: 'running', staleLevel: p.staleLevel, branch: p.branch, dirty: p.dirty, activity: 'working' };
  term.onData((d) => {
    window.devdeck.cockpit.input(res.id, d);
    const l = live.get(res.id); // typing answers any pending prompt → clear the buffer + mark input so it reads as "your turn", not "working"
    if (l) { l.recentOutput = ''; l.lastInputAt = Date.now(); }
  });
  live.set(res.id, { session, term, fit, search, el, lastDataAt: Date.now(), lastInputAt: 0, recentOutput: '', openedSessionId: res.sessionId ?? null, customLabel: p.label ?? null, meta: null });
  if (res.sessionId) restorable = restorable.filter((r) => r.sessionId !== res.sessionId); // dedupe by session id, not path (siblings stay)
  select(res.id);
  updateRailBadge();
  persist();
  void refreshMeta(res.id);
  void refreshGit(res.id);
}

/** Pull a session's model + active-time from its log (for the header/list). Cheap; called on open/select + a slow tick. */
async function refreshMeta(id: string): Promise<void> {
  const l = live.get(id); if (!l || !l.openedSessionId) return;
  let meta: { model: string | null; activeMs: number };
  try { meta = await window.devdeck.cockpit.sessionMeta(l.session.projectPath, l.openedSessionId); } catch { return; }
  if (l.meta?.model === meta.model && l.meta?.activeMs === meta.activeMs) return; // unchanged → no re-render
  l.meta = meta;
  if (!editingId) renderList();
  renderHeader();
}
/** Pull a session's CURRENT git branch + dirty count by project path, so a RESTORED session — which is
 *  re-created with no branch — and in-terminal branch switches both show the live branch instead of "-". */
async function refreshGit(id: string): Promise<void> {
  const l = live.get(id); if (!l) return;
  let info: { branch: string | null; dirty: number } | null;
  try { info = await window.devdeck.cockpit.gitInfo(l.session.projectPath); } catch { return; }
  if (!info) return; // main refused the path (allowlist guard)
  if (l.session.branch === info.branch && l.session.dirty === info.dirty) return; // unchanged → no re-render
  l.session.branch = info.branch;
  l.session.dirty = info.dirty;
  if (!editingId) renderList();
  renderHeader();
}
// The 30s tick: skip exited sessions — their model/branch can't change, so re-reading their log +
// re-spawning git every tick is pure waste (matters most with many concurrent sessions).
function refreshAllMeta(): void { if (editingId) return; for (const [id, l] of live) { if (l.session.status === 'exited') continue; void refreshMeta(id); void refreshGit(id); } }

function select(id: string): void {
  if (selectedId !== id && findBar && !findBar.classList.contains('hidden')) closeFindBar(); // find decorations belong to the previous session
  selectedId = id;
  for (const [lid, l] of live) l.el.classList.toggle('show', lid === id);
  mainEl.classList.toggle('has-session', live.size > 0);
  renderList(); renderHeader();
  void refreshMeta(id);
  void refreshGit(id);
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
    const next = computeActivity({ exited: l.session.status === 'exited', lastDataAt: l.lastDataAt, lastInputAt: l.lastInputAt, now, recentOutput: l.recentOutput, prev: l.session.activity });
    if (next !== l.session.activity) { l.session.activity = next; changed = true; }
  }
  // Don't rebuild the list mid-rename (it would recreate the <input> and clobber what's being typed).
  if (changed) { if (!editingId) renderList(); updateRailBadge(); }
}

function renderAll(): void { renderList(); renderHeader(); }

function renderList(): void {
  const search = (searchEl?.value ?? '').toLowerCase();
  const liveSessions = [...live.values()].map((l) => l.session);
  const liveIds = new Set([...live.values()].map((l) => l.openedSessionId).filter((x): x is string => !!x));
  // Previous (restorable) sessions, excluding any whose specific session id is currently live (siblings of
  // the same project stay — dedupe is per session id, not per path).
  const prev = restorable.filter((r) => !(r.sessionId && liveIds.has(r.sessionId)) && r.name.toLowerCase().includes(search));

  // Display name = custom label (if renamed) else folder name; then #N only where two would read alike.
  const liveLive = [...live.values()];
  const union = [...liveLive.map((l) => l.customLabel || l.session.name), ...prev.map((r) => r.label || r.name)];
  const labels = numberCollidingNames(union);
  liveLabels = new Map(liveLive.map((l, i) => [l.session.id, labels[i]]));
  const prevLabels = prev.map((_r, i) => labels[liveLive.length + i]);

  // Skip the full DOM rebuild when nothing the list shows has changed (this runs on every 1s activity
  // tick + per-session meta/git refresh, so most calls become no-ops once the deck settles).
  const sig = cockpitListSignature(
    liveLive.map((l) => ({
      id: l.session.id, activity: l.session.activity, label: liveLabels.get(l.session.id) ?? '', dirty: l.session.dirty,
      branch: l.session.branch, model: friendlyModel(l.meta?.model ?? null), agentId: l.session.agentId, selected: l.session.id === selectedId,
    })),
    prev.map((r, i) => ({ key: r.sessionId ?? r.projectPath, label: prevLabels[i], agentId: r.agentId })),
    currentLang(), search,
  ) + `\nedit:${editingId ?? ''}`; // a row being renamed becomes an <input> — also part of what the list renders
  if (sig === lastListSig) return;
  lastListSig = sig;

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
  const newBtn = document.getElementById('ck-new-session') as HTMLButtonElement | null;
  if (newBtn) {
    newBtn.disabled = live.size === 0; // "+ New session" needs a project context (a live session)
    // Show WHICH project it targets (the selected session's repo) so it's clearly "another session here".
    const sel = selectedId ? live.get(selectedId) : null;
    const text = sel ? `${tr('cockpit.new_session')} · ${sel.session.name}` : tr('cockpit.new_session');
    const lbl = document.getElementById('ck-new-label'); if (lbl) lbl.textContent = text;
    newBtn.title = text;
  }
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
  el.innerHTML = `<span class="ck-ind"></span><div><div class="nm"></div><div class="mt"></div></div><span class="ck-row-acts"></span>`;
  const ind = el.querySelector('.ck-ind')!;
  if (a === 'working') ind.innerHTML = '<span class="ck-spin"></span>';
  else if (a === 'attention') ind.textContent = '❓';
  else ind.innerHTML = '<span class="ck-dot"></span>';
  const nm = el.querySelector('.nm') as HTMLElement;
  if (s.id === editingId) {
    nm.replaceChildren(renameInput(s.id, live.get(s.id)?.customLabel ?? s.name));
  } else {
    nm.textContent = liveLabels.get(s.id) ?? s.name;
    nm.addEventListener('dblclick', (e) => { e.stopPropagation(); beginRename(s.id); }); // rename: double-click the name…
  }
  const rowModel = friendlyModel(live.get(s.id)?.meta?.model ?? null);
  el.querySelector('.mt')!.textContent = `${s.branch ?? '-'}${dirty} · ${s.agentId}${rowModel ? ` · ${rowModel}` : ''}`;
  el.title = tr('cockpit.st_' + a);
  el.addEventListener('click', () => { if (editingId !== s.id) select(s.id); });
  const rename = document.createElement('button'); rename.className = 'ck-rename'; rename.textContent = '✎'; rename.title = tr('cockpit.rename'); // …or the ✎ on hover
  rename.addEventListener('click', (e) => { e.stopPropagation(); beginRename(s.id); });
  const close = document.createElement('button'); close.className = 'ck-close'; close.textContent = '✕'; close.title = tr('cockpit.close'); // ✕ closes the session (with confirm)
  close.addEventListener('click', (e) => { e.stopPropagation(); void requestClose(s.id); });
  el.querySelector('.ck-row-acts')!.append(rename, close);
  return el;
}

function updateRailBadge(): void {
  const sessions = [...live.values()].map((l) => l.session);
  const attention = needsAttentionCount(sessions); // genuine agent questions only
  const badge = document.getElementById('ck-badge');
  if (badge) { badge.textContent = String(attention); badge.classList.toggle('hidden', attention === 0); }
  // Tray attention indicator: send both counts; the main process reddens the tray per the user's setting.
  const turn = sessions.filter((s) => s.activity === 'turn').length;
  window.devdeck.setTrayCounts({ attention, turn });
}

/** Draw the tray icon + a red dot on a canvas and hand it to main for the attention alert (no extra asset/dep). */
function sendTrayAlertImage(): void {
  const img = new Image();
  img.onload = () => {
    const size = Math.max(img.width || 0, img.height || 0, 16);
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    const ctx = c.getContext('2d'); if (!ctx) return;
    ctx.drawImage(img, 0, 0, size, size);
    const r = Math.round(size * 0.32);
    ctx.beginPath(); ctx.arc(size - r, size - r, r, 0, Math.PI * 2);
    ctx.fillStyle = '#f5453a'; ctx.fill();
    ctx.lineWidth = Math.max(1, size * 0.07); ctx.strokeStyle = '#0d0e12'; ctx.stroke();
    try { window.devdeck.setTrayAlertImage(c.toDataURL('image/png')); } catch { /* ignore */ }
  };
  img.src = './assets/tray.png';
}

function renderHeader(): void {
  headerEl.replaceChildren();
  const l = selectedId ? live.get(selectedId) : null;
  if (!l) return;
  const s = l.session;
  const title = document.createElement('span'); title.className = 'title'; title.textContent = liveLabels.get(s.id) ?? s.name;
  title.title = tr('cockpit.rename');
  title.addEventListener('dblclick', () => beginRename(s.id)); // edits in the session's list row (single editor, survives re-render)
  const branch = document.createElement('span'); branch.className = 'ck-pill'; branch.textContent = `⎇ ${s.branch ?? '-'}${s.dirty > 0 ? ` ✎${s.dirty}` : ''}`;
  const ag = document.createElement('span'); ag.className = 'ck-pill'; ag.textContent = `✦ ${s.agentId}`;
  const pills: HTMLElement[] = [title, branch, ag];
  const model = friendlyModel(l.meta?.model ?? null);
  if (model) { const mp = document.createElement('span'); mp.className = 'ck-pill'; mp.textContent = model; pills.push(mp); }
  if (l.meta && l.meta.activeMs > 0) { const tp = document.createElement('span'); tp.className = 'ck-pill'; tp.textContent = `⏱️ ${formatDuration(l.meta.activeMs)}`; pills.push(tp); }
  const sp = document.createElement('span'); sp.className = 'sp';
  const newSession = actBtn('+', tr('cockpit.new_session'), () => void addSessionToCurrentProject());
  const folder = actBtn('📁', tr('cockpit.open_folder'), () => window.devdeck.openFolder(s.projectPath));
  const restart = actBtn('⟳', tr('cockpit.restart'), () => restartSession(s.id));
  const close = actBtn('✕', tr('cockpit.close'), () => void requestClose(s.id));
  headerEl.append(...pills, sp, newSession, folder, restart, close);
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

/** Small in-app confirmation modal (a DOM overlay, NOT window.confirm). Resolves true on confirm. */
function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div'); overlay.className = 'ck-confirm-overlay';
    const panel = document.createElement('div'); panel.className = 'ck-confirm';
    const msg = document.createElement('div'); msg.className = 'ck-confirm-msg'; msg.textContent = message;
    const acts = document.createElement('div'); acts.className = 'ck-confirm-acts';
    const cancel = document.createElement('button'); cancel.className = 'ck-confirm-cancel'; cancel.textContent = tr('cockpit.cancel');
    const ok = document.createElement('button'); ok.className = 'ck-confirm-ok'; ok.textContent = tr('cockpit.close');
    const done = (v: boolean) => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(v); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      e.preventDefault(); e.stopPropagation(); // keep Esc/Enter inside the dialog (don't leak to terminal/rename)
      done(e.key === 'Enter');
    };
    cancel.addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(true));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', onKey, true);
    acts.append(cancel, ok); panel.append(msg, acts); overlay.append(panel);
    document.body.appendChild(overlay);
    ok.focus();
  });
}

/** User-facing close (row ✕ / header ✕): confirm first. restartSession calls closeSession directly (no confirm). */
async function requestClose(id: string): Promise<void> {
  const l = live.get(id); if (!l) return;
  const name = liveLabels.get(id) ?? l.session.name;
  if (await confirmDialog(tr('cockpit.close_confirm').replace('{name}', name))) closeSession(id);
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
  // Resume the project's NEWEST conversation, not the frozen pinned id (which goes stale the moment a
  // newer session exists → the "restart sends me to the past" bug). Skip ids already open in another
  // tile so multiple tiles of one project each land on a distinct recent conversation. A null result
  // (no sessions, or all already live) falls through to the main process's continue/new resolution.
  let sessionId: string | null = null;
  if (entry.agentId === active) {
    const liveIds = new Set([...live.values()].map((l) => l.openedSessionId).filter((x): x is string => !!x));
    let ids: string[] = [];
    try { ids = await window.devdeck.cockpit.sessionIds(entry.projectPath); } catch { ids = []; }
    sessionId = pickRestoreSessionId(ids, liveIds);
  }
  await createSession({ path: entry.projectPath, name: entry.name, staleLevel: 'neutral', branch: null, dirty: 0, sessionId, label: entry.label ?? null });
}

/** Set a live session's custom name (empty → revert to the auto label); persist so it survives restart. */
function renameSession(id: string, label: string): void {
  const l = live.get(id); if (!l) return;
  l.customLabel = label.trim() || null;
  persist(); renderList(); renderHeader();
}

// Editing is RENDER STATE (editingId), not a mutated DOM node: a list rebuild (e.g. row click → select)
// would otherwise orphan a captured <input> and the editor would silently never appear.
function beginRename(id: string): void { editingId = id; renderList(); }
function cancelRename(): void { editingId = null; renderList(); }
function commitRename(id: string, value: string): void { editingId = null; renameSession(id, value); }

/** Build the inline rename <input> rendered into the editing row's name slot. */
function renameInput(id: string, current: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'ck-rename-input'; input.value = current; input.maxLength = 60;
  const stop = (e: Event) => e.stopPropagation(); // don't let editing leak to row-select
  input.addEventListener('click', stop); input.addEventListener('dblclick', stop);
  let done = false;
  const finish = (commit: boolean) => { if (done) return; done = true; if (commit) commitRename(id, input.value); else cancelRename(); };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  requestAnimationFrame(() => { input.focus(); input.select(); }); // focus after it's in the rebuilt DOM
  return input;
}

async function restoreAll(): Promise<void> {
  for (const entry of [...restorable]) await restoreSession(entry);
}

function forgetSession(entry: PersistedSession): void {
  restorable = restorable.filter((r) => r !== entry);
  persist();
  renderList();
}
