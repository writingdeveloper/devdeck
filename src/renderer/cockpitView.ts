import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { filterSessions, groupByActivity, needsAttentionCount, numberCollidingNames, cockpitListSignature, shouldNotifyAttention, foldProjectActivity, type CockpitSession } from '../shared/cockpitModel';
import { computeActivity, stripAnsi, type ActivityState } from '../shared/sessionStatus';
import { friendlyModel, contextPercent, contextSeverity } from '../shared/sessionMeta';
import { formatDuration } from '../shared/usage';
import { decideKeyAction, selectionCellLength } from '../shared/terminalKeys';
import { unwrapCopiedUrl } from '../shared/urlCopy';
import { findUrlLinks, findImagePathLinks, type BufferRow } from '../shared/linkWrap';
import { sanitizePersistedList, resolveRestoreSessionId, adoptRestorableMatch, type PersistedSession } from '../shared/cockpitPersist';
import type { AgentId, StaleLevel } from '../shared/types';
import { tr, currentLang } from './i18n-runtime';
import { toast } from './loadError';

interface Live { session: CockpitSession; term: Terminal; fit: FitAddon; search: SearchAddon; el: HTMLElement; lastDataAt: number; lastInputAt: number; recentOutput: string; openedSessionId: string | null; openedAt: number; idCheckAt: number; customLabel: string | null; meta: { model: string | null; activeMs: number; contextTokens: number } | null; pinned: boolean; }
export interface OpenReq { path: string; name: string; staleLevel: StaleLevel; branch: string | null; dirty: number; sessionId?: string | null; fresh?: boolean; label?: string | null; pinned?: boolean; }

const live = new Map<string, Live>();
let restorable: PersistedSession[] = []; // previous sessions persisted across restarts, not yet restored
let restorableLoaded = false; // guard: don't persist (and clobber the on-disk list) until the initial load resolves
let liveLabels = new Map<string, string>(); // live session id -> display label (#N when a project has several sessions)
let lastListSig = ''; // signature of the last-rendered session list — renderList() skips a rebuild when nothing visible changed
let editingId: string | null = null; // session being inline-renamed (rendered as an <input> in its row, so re-renders keep it)
let selectedId: string | null = null;
// Context window (tokens) for the header's per-session context % — set from settings at boot + on change.
let contextWindow = 1_000_000;
/** Update the context-window basis for the 🧠 context % (called from settings + boot). */
export function setCockpitContextWindow(w: number): void { contextWindow = w === 200_000 ? 200_000 : 1_000_000; renderHeader(); lastListSig = ''; renderList(); }
// The tray-alert setting doubles as the gate for the attention OS notification — set from settings at boot + on change.
let trayAlertMode: 'off' | 'attention' | 'all' = 'attention';
export function setCockpitTrayAlert(mode: 'off' | 'attention' | 'all'): void { trayAlertMode = mode; }
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
  // Re-fit the active terminal whenever its pane changes size — NOT just on window resize. The
  // always-on usage bar appears/disappears after its async load, resizing #shell (and thus .ck-terms)
  // by ~27px while the user sits on the cockpit; without a re-fit the terminal keeps its old row count
  // and its bottom rows get clipped by #view-cockpit's overflow:hidden. Observing the pane directly
  // covers that, window resizes, and header reflow alike. Coalesced to one rAF (also lets layout settle
  // before measuring); skipped while the pane is hidden (0-height) since showCockpit() re-fits on show.
  let refitQueued = false;
  // TRAILING-DEBOUNCED (not per-frame): every PTY resize makes conpty re-emit the whole screen, and a
  // window drag-resize used to fire dozens of those per second — interleaved repaints at different
  // widths shredded the scrollback (garbled tables / stray characters at the right edge, worst with CJK
  // + box-drawing). Waiting for the size to settle yields ONE clean fit + ONE conpty repaint.
  let refitTimer: ReturnType<typeof setTimeout> | undefined;
  new ResizeObserver(() => {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => { if (selectedId && termsEl.clientHeight > 0) fitSelected(); }, 200);
  }).observe(termsEl);
  setInterval(tickActivity, 1000);
  setInterval(refreshAllMeta, 30_000); // model/active-time change slowly — refresh on a slow tick (+ on open/select)
  sendTrayAlertImage(); // hand the main process a red-dotted tray icon for the attention alert
  renderAll();
  // Load previously-open sessions (from a prior quit/crash) as restorable entries. Guard persist()
  // until this resolves so a session opened during the load window can't clobber the on-disk list;
  // then persist once to capture any such session in the correct union.
  window.devdeck.cockpit.loadSessions()
    .then(async (list) => {
      restorable = sanitizePersistedList(list); restorableLoaded = true; renderList(); if (live.size > 0) persist();
      // Seamless update: if this launch is the relaunch after an update, auto-restore the sessions that
      // were live at restart (consume clears the marker so a later normal launch won't re-trigger).
      const pending = await window.devdeck.consumeAutoRestore().catch(() => [] as PersistedSession[]);
      if (pending.length) await autoRestoreAfterUpdate(pending);
    })
    .catch(() => { restorableLoaded = true; });
}

/** After an update relaunch, re-open the sessions that were live — each resolving to its project's
 *  latest conversation (via restoreSession). They're removed from the "Previous" list first so they
 *  aren't shown as restorable AND opened. Sequential to avoid a simultaneous PTY burst. */
async function autoRestoreAfterUpdate(pending: PersistedSession[]): Promise<void> {
  const key = (p: PersistedSession): string => `${p.projectPath}\0${p.sessionId ?? ''}`;
  const keys = new Set(pending.map(key));
  restorable = restorable.filter((r) => !keys.has(key(r)));
  renderList();
  for (const entry of pending) await restoreSession(entry);
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
  const fromLive = liveSessionsForPersist();
  const rest = restorable.filter((r) => !(r.sessionId && liveIds.has(r.sessionId))); // keep siblings + null-id (antigravity) entries
  window.devdeck.cockpit.saveSessions([...fromLive, ...rest]);
}

/** The currently-live sessions in PersistedSession form (for saving / update auto-restore). */
export function liveSessionsForPersist(): PersistedSession[] {
  return [...live.values()].map((l) => ({ projectPath: l.session.projectPath, name: l.session.name, sessionId: l.openedSessionId, agentId: l.session.agentId, label: l.customLabel, pinned: l.pinned }));
}
/** How many cockpit sessions are live right now (for the update-restart button label). */
export function liveSessionCount(): number { return live.size; }

/** Per-project live status for the deck's summary + card stripes (no IPC — renderer-shared). */
export function liveProjectActivity(): Map<string, 'attention' | 'working'> {
  return foldProjectActivity([...live.values()].map((l) => ({ projectPath: l.session.projectPath, activity: l.session.activity })));
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

/** Open a session for the request; false = refused or failed (already cleaned up + reported via toast). */
async function createSession(p: OpenReq): Promise<boolean> {
  const el = document.createElement('div'); el.className = 'ck-term'; termsEl.appendChild(el);
  // Make this terminal visible BEFORE fitting: FitAddon measures 0 on a display:none element,
  // which would spawn the PTY at the wrong size. select() below re-affirms the show/hide state.
  for (const l of live.values()) l.el.classList.remove('show');
  el.classList.add('show');
  const term = new Terminal({ fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 12, theme: { background: '#0a0b0e' }, cursorBlink: true });
  const fit = new FitAddon(); term.loadAddon(fit); term.open(el); fit.fit();
  // Make http(s) links clickable → open via a scheme-guarded IPC. Custom provider instead of the
  // WebLinksAddon: Claude's renderer HARD-wraps long URLs at its own inner width (real newlines +
  // indentation), which the addon can't join — clicking then opened only the first fragment. Our
  // provider (shared findUrlLinks) joins soft-wrapped rows by ground truth and hard-wrapped rows via
  // the same conservative fragment heuristic as unwrapCopiedUrl.
  const LINK_CONTEXT_ROWS = 6;
  const linkProvider = {
    provideLinks(bufferLineNumber: number, callback: (links: { range: { start: { x: number; y: number }; end: { x: number; y: number } }; text: string; activate: (e: MouseEvent, text: string) => void }[] | undefined) => void) {
      const buf = term.buffer.active;
      const hoveredIdx = bufferLineNumber - 1; // 0-based buffer row
      const first = Math.max(0, hoveredIdx - LINK_CONTEXT_ROWS);
      const last = Math.min(buf.length - 1, hoveredIdx + LINK_CONTEXT_ROWS);
      const rows: BufferRow[] = [];
      for (let i = first; i <= last; i++) {
        const line = buf.getLine(i);
        rows.push({ text: line?.translateToString(true) ?? '', wrapped: !!line?.isWrapped });
      }
      const rel = hoveredIdx - first;
      // xterm ranges are 1-based with an inclusive end cell; our cols are 0-based/exclusive-end.
      const toRange = (h: { start: { row: number; col: number }; end: { row: number; col: number } }) =>
        ({ start: { x: h.start.col + 1, y: first + h.start.row + 1 }, end: { x: h.end.col, y: first + h.end.row + 1 } });
      const onRow = (h: { start: { row: number }; end: { row: number } }) => h.start.row <= rel && rel <= h.end.row;
      const links = [
        ...findUrlLinks(rows).filter(onRow).map((h) => ({
          range: toRange(h), text: h.url,
          activate: (_e: MouseEvent, text: string) => { void window.devdeck.cockpit.openLink(text); },
        })),
        // Local image paths the agent printed (e.g. "> [image] assets\a.png") — click opens the viewer.
        ...findImagePathLinks(rows).filter(onRow).map((h) => ({
          range: toRange(h), text: h.url,
          activate: (_e: MouseEvent, text: string) => { void window.devdeck.cockpit.openImage(p.path, text); },
        })),
      ];
      callback(links.length ? links : undefined);
    },
  };
  term.registerLinkProvider(linkProvider);
  // Resolve the Ctrl+C copy-vs-SIGINT conflict (and Ctrl+V paste) before xterm forwards the key.
  // Returning false stops xterm processing it, so 'copy'/'paste' never reach the PTY as keystrokes.
  term.attachCustomKeyEventHandler((e) => {
    const action = decideKeyAction(e, term.hasSelection());
    if (action === 'copy') { window.devdeck.clipboard.writeText(unwrapCopiedUrl(term.getSelection())); return false; }
    if (action === 'paste') {
      e.preventDefault(); // cancel the native paste gesture so xterm's own paste can't double with our IPC paste
      // Prefer a clipboard IMAGE (screenshot): main writes it to a temp PNG and returns the path, which
      // we inject as text — Claude Code reads an image off a path even where native clipboard-image paste
      // can't (e.g. Windows). No image on the clipboard → fall back to the normal text paste.
      window.devdeck.clipboard.readImage().then((imgPath) => {
        if (imgPath) { term.paste(imgPath + ' '); toast(tr('cockpit.image_pasted')); return; }
        window.devdeck.clipboard.readText().then((t) => { if (t) term.paste(t); });
      });
      return false;
    }
    if (action === 'find') { e.preventDefault(); openFindBar(); return false; } // Ctrl+F searches scrollback, never reaches the PTY
    return true;
  });
  const search = new SearchAddon(); term.loadAddon(search);
  // Copy-on-select: selecting text copies it right away (like Claude Code's own auto-copy / classic
  // Windows quick-edit). This matters most while a TUI has mouse tracking ON — a plain drag goes to the
  // TUI, so the user selects with Shift+drag, and requiring another Ctrl+C afterwards was exactly the
  // step that intermittently turned into a SIGINT. Debounced so mid-drag updates don't spam the
  // clipboard; skipped for the programmatic re-select in fitSelected (guard below) so a background fit
  // can't clobber whatever the user copied elsewhere in the meantime.
  // Triggered by the mouse GESTURE itself (mouseup after a drag / double-click word select), never by
  // xterm's selection events: those also fire for programmatic select() (fitSelected's restore) and
  // around buffer reflow/repaint, and copying such a selection would silently overwrite whatever the
  // user last copied in another app. mouseup is deterministic: exactly what the user just highlighted.
  el.addEventListener('mouseup', () => {
    setTimeout(() => { // let xterm finalize the selection for this gesture first
      if (!term.hasSelection()) return;
      const s = term.getSelection();
      if (s.trim()) window.devdeck.clipboard.writeText(unwrapCopiedUrl(s));
    }, 50);
  });
  const { cols, rows } = term;
  // Main answers a failed open with id:'' (allowlist refusal / pty spawn error) — but guard the invoke
  // itself too, so a reject can't leak the terminal we already mounted or abort a restore-all loop.
  let res: { id: string; agentId: AgentId; sessionId: string | null };
  try {
    res = await window.devdeck.cockpit.open({ projectPath: p.path, sessionId: p.sessionId ?? null, cols, rows, fresh: !!p.fresh });
  } catch {
    res = { id: '', agentId: 'claude', sessionId: null };
  }
  if (!res.id) { el.remove(); term.dispose(); if (selectedId) select(selectedId); return false; } // refused/failed — restore prior selection
  const session: CockpitSession = { id: res.id, projectPath: p.path, name: p.name, agentId: res.agentId, status: 'running', staleLevel: p.staleLevel, branch: p.branch, dirty: p.dirty, activity: 'working' };
  term.onData((d) => {
    window.devdeck.cockpit.input(res.id, d);
    const l = live.get(res.id); // typing answers any pending prompt → clear the buffer + mark input so it reads as "your turn", not "working"
    if (l) { l.recentOutput = ''; l.lastInputAt = Date.now(); }
  });
  // Consume the matching restorable entry (dedupe by session id, not path — siblings stay), inheriting
  // its pin + label when the open request has none (deck/board opens don't know about pins).
  const adopted = adoptRestorableMatch(restorable, res.sessionId ?? null, { label: p.label ?? null, pinned: !!p.pinned });
  restorable = adopted.rest;
  live.set(res.id, { session, term, fit, search, el, lastDataAt: Date.now(), lastInputAt: 0, recentOutput: '', openedSessionId: res.sessionId ?? null, openedAt: Date.now(), idCheckAt: Date.now(), customLabel: adopted.label, meta: null, pinned: adopted.pinned });
  select(res.id);
  updateRailBadge();
  persist();
  void refreshMeta(res.id);
  void refreshGit(res.id);
  return true;
}

/** Pull a session's model + active-time from its log (for the header/list). Cheap; called on open/select + a slow tick. */
async function refreshMeta(id: string): Promise<void> {
  const l = live.get(id); if (!l || !l.openedSessionId) return;
  let meta: { model: string | null; activeMs: number; contextTokens: number };
  try { meta = await window.devdeck.cockpit.sessionMeta(l.session.projectPath, l.openedSessionId); } catch { return; }
  if (l.meta?.model === meta.model && l.meta?.activeMs === meta.activeMs && l.meta?.contextTokens === meta.contextTokens) return; // unchanged → no re-render
  l.meta = meta;
  if (!editingId) renderList();
  renderHeader();
}
/** Re-resolve WHICH on-disk conversation a live tile is actually writing to. /clear starts a
 *  brand-new session id in the same terminal, so the open-time id goes permanently stale — persisting
 *  it made a restart/update restore the PAST conversation. Evidence-gated (pickDriftedSessionId in
 *  main): adopts a new id only when this tile streamed output, its own file did not move, and exactly
 *  one unclaimed file born after the tile opened moved in lockstep with the tile's output. */
async function refreshSessionId(id: string): Promise<void> {
  const l = live.get(id); if (!l || l.session.agentId !== 'claude' || l.session.status === 'exited') return;
  const since = l.idCheckAt;
  if (l.lastDataAt <= since) return; // no output since the last check — nothing moved on our behalf
  l.idCheckAt = Date.now(); // advance BEFORE the async hop so overlapping calls can't double-adopt
  const claimedIds = [...live.values()].filter((o) => o !== l).map((o) => o.openedSessionId).filter((x): x is string => !!x);
  let next: string | null = null;
  try {
    next = await window.devdeck.cockpit.liveSessionId(l.session.projectPath, {
      currentId: l.openedSessionId, claimedIds, openedAtMs: l.openedAt, sinceMs: since, lastDataAtMs: l.lastDataAt,
    });
  } catch { return; }
  if (!next || next === l.openedSessionId || !live.has(id)) return; // tile may have closed mid-await
  l.openedSessionId = next;
  persist(); // the drifted id is exactly what a quit would have frozen — save the corrected one now
  void refreshMeta(id); // model/context % must now read the NEW conversation, not the stale file
}

/** Await a drift check for every live tile — the update-restart path calls this right before it
 *  snapshots liveSessionsForPersist, so the relaunch restores the post-/clear conversations. */
export async function refreshLiveSessionIds(): Promise<void> {
  await Promise.all([...live.keys()].map((id) => refreshSessionId(id)));
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
function refreshAllMeta(): void { if (editingId) return; for (const [id, l] of live) { if (l.session.status === 'exited') continue; void refreshSessionId(id); void refreshMeta(id); void refreshGit(id); } }

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
  const term = l.term;
  // xterm drops the text selection on resize, and a fit can fire in the background (usage-bar toggle,
  // header-pill reflow via the ResizeObserver, window resize) — silently clearing a selection the user
  // is about to Ctrl+C-copy, so the copy falls through to SIGINT. Preserve it across a HEIGHT-ONLY fit
  // (cols unchanged → buffer coords stay valid; a width change reflows the buffer, so we let it go).
  const colsBefore = term.cols;
  const rowsBefore = term.rows;
  const sel = term.hasSelection() ? term.getSelectionPosition() : undefined;
  l.fit.fit();
  if (term.cols === colsBefore && term.rows === rowsBefore) return; // no-op fit (e.g. a 1px container jiggle) — don't make conpty repaint
  if (sel && term.cols === colsBefore) {
    const len = selectionCellLength(sel.start, sel.end, term.cols);
    if (len > 0) term.select(sel.start.x, sel.start.y, len); // copy-on-select ignores this (no mouse gesture)
  }
  window.devdeck.cockpit.resize(l.session.id, term.cols, term.rows);
}

// How many drawn rows the spinner scan reads, counted up from the LAST NON-EMPTY live row — not from
// the bottom of the screen, which is blank whenever the session's content is short. Claude draws its
// spinner just above the input box/status bar, well inside this window.
const SCREEN_TAIL_ROWS = 12;
/** The tail of what's actually drawn on the live screen — ground truth for "is the spinner still there". */
function liveScreenTail(l: Live): string {
  const buf = l.term.buffer.active;
  const top = buf.baseY;
  let last = top + l.term.rows - 1;
  while (last >= top && (buf.getLine(last)?.translateToString(true) ?? '') === '') last--;
  if (last < top) return '';
  let out = '';
  for (let i = Math.max(top, last - SCREEN_TAIL_ROWS + 1); i <= last; i++) out += (buf.getLine(i)?.translateToString(true) ?? '') + '\n';
  return out;
}

function tickActivity(): void {
  const now = Date.now();
  let changed = false;
  for (const l of live.values()) {
    const prev = l.session.activity;
    // spinnerReliable: only Claude's spinner glyph is one we match, so only there can we trust "spinner
    // gone ⇒ turn" and skip the timing hysteresis (avoids 작업중 lingering ~10s after each Claude turn).
    const next = computeActivity({
      exited: l.session.status === 'exited', lastDataAt: l.lastDataAt, lastInputAt: l.lastInputAt, now,
      recentOutput: l.recentOutput, screenText: liveScreenTail(l), prev, spinnerReliable: l.session.agentId === 'claude',
    });
    if (next !== prev) {
      l.session.activity = next; changed = true;
      // A turn just finished → a new assistant model may have been logged; refresh so the sidebar model
      // isn't stuck on the previous turn's model after a /model switch (only otherwise refreshed on the
      // 30s tick). The drift check rides along so a /clear is adopted within seconds of the next turn,
      // not up to 30s later (a quit inside that window would still have frozen the stale id).
      if (next === 'turn' && prev === 'working') { void refreshSessionId(l.session.id); void refreshMeta(l.session.id); }
      // The agent just started waiting on the user → OS notification (click = jump to that session).
      if (shouldNotifyAttention({ prev, next, trayAlert: trayAlertMode, windowFocused: document.hasFocus() })) notifyAttention(l);
    }
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
  const prev = restorable.filter((r) => !(r.sessionId && liveIds.has(r.sessionId))
    && (r.name.toLowerCase().includes(search) || (r.label ?? '').toLowerCase().includes(search)));

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
      branch: l.session.branch, model: friendlyModel(l.meta?.model ?? null), agentId: l.session.agentId, selected: l.session.id === selectedId, pinned: l.pinned,
      ctx: contextPercent(l.meta?.contextTokens ?? 0, contextWindow),
    })),
    prev.map((r, i) => ({ key: r.sessionId ?? r.projectPath, label: prevLabels[i], agentId: r.agentId, pinned: r.pinned === true })),
    currentLang(), search,
  ) + `\nedit:${editingId ?? ''}`; // a row being renamed becomes an <input> — also part of what the list renders
  if (sig === lastListSig) return;
  lastListSig = sig;

  // Search matches what the list shows: folder name, branch, AND the custom (renamed) label.
  const customLabels = new Map(liveLive.map((l) => [l.session.id, l.customLabel ?? '']));
  const filtered = filterSessions(liveSessions, searchEl?.value ?? '', customLabels);
  groupsEl.replaceChildren();
  // Pinned sessions form a dedicated group, stable (label-sorted) so they don't move as activity
  // changes. Each row still shows its live activity indicator (a pinned session in attention keeps its
  // act-attention tint via row()'s className — the isPinned filter below already excludes it from
  // groupByActivity, so it's never shown twice). Not-yet-restored (previous) pinned entries render here
  // too, so a restart doesn't appear to lose pins.
  const prevPairs = prev.map((r, i) => ({ r, label: prevLabels[i] }));
  const prevPinned = prevPairs.filter((x) => x.r.pinned === true);
  const prevRest = prevPairs.filter((x) => x.r.pinned !== true);
  const isPinned = (s: CockpitSession): boolean => live.get(s.id)?.pinned ?? false;
  const pinned = filtered.filter(isPinned).sort((a, b) => (liveLabels.get(a.id) ?? a.name).localeCompare(liveLabels.get(b.id) ?? b.name));
  const renderPinnedGroup = () => {
    if (pinned.length + prevPinned.length === 0) return;
    const h = document.createElement('div'); h.className = 'ck-grp ck-grp-pinned';
    h.textContent = `📌 ${tr('cockpit.grp_pinned')} · ${pinned.length + prevPinned.length}`;
    groupsEl.appendChild(h);
    for (const s of pinned) groupsEl.appendChild(row(s));
    for (const x of prevPinned) groupsEl.appendChild(prevRow(x.r, x.label));
  };
  const renderActivityGroup = (g: { bucket: string; items: CockpitSession[] }) => {
    const h = document.createElement('div'); h.className = 'ck-grp';
    h.textContent = `${tr('cockpit.grp_' + g.bucket)} · ${g.items.length}`;
    groupsEl.appendChild(h);
    for (const s of g.items) groupsEl.appendChild(row(s));
  };
  // Urgency-first sidebar order: attention + working float ABOVE the pinned group (a session that needs
  // you is never buried under quiet pins), pinned anchors the middle, and the calmer turn/idle groups
  // sit below. Bucket membership is derived from `activity`, which is already a field in
  // cockpitListSignature — so this reordering needs no signature change (see the doc comment on
  // cockpitListSignature in cockpitModel.ts).
  const activityGroups = groupByActivity(filtered.filter((s) => !isPinned(s)));
  for (const g of activityGroups.filter((x) => x.bucket === 'attention' || x.bucket === 'working')) renderActivityGroup(g);
  renderPinnedGroup();
  for (const g of activityGroups.filter((x) => x.bucket !== 'attention' && x.bucket !== 'working')) renderActivityGroup(g);
  if (prevRest.length) {
    const h = document.createElement('div'); h.className = 'ck-grp ck-grp-prev';
    const label = document.createElement('span'); label.textContent = `${tr('cockpit.prev_sessions')} · ${prevRest.length}`;
    const allBtn = document.createElement('button'); allBtn.className = 'ck-restore-all'; allBtn.textContent = `↻ ${tr('cockpit.restore_all')}`; allBtn.title = tr('cockpit.restore_all');
    allBtn.addEventListener('click', () => void restoreAll());
    h.append(label, allBtn);
    groupsEl.appendChild(h);
    for (const x of prevRest) groupsEl.appendChild(prevRow(x.r, x.label));
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
  const isPinned = r.pinned === true;
  const el = document.createElement('div'); el.className = `ck-row ck-row-prev${isPinned ? ' pinned' : ''}`;
  el.innerHTML = `<span class="ck-ind"><span class="ck-dot"></span></span><div class="ck-row-main"><div class="nm"></div><div class="mt"></div></div><span class="ck-prev-acts"></span>`;
  el.querySelector('.nm')!.textContent = label;
  el.querySelector('.mt')!.textContent = `${tr('cockpit.restore')} · ${r.agentId}`;
  el.title = tr('cockpit.restore');
  // Same 📌 affordance as live rows: a not-yet-restored entry can be (un)pinned without opening it.
  const pin = document.createElement('button'); pin.className = 'ck-pin'; pin.textContent = '📌'; pin.title = tr(isPinned ? 'cockpit.unpin' : 'cockpit.pin');
  pin.addEventListener('click', (e) => { e.stopPropagation(); togglePrevPin(r); });
  const forget = document.createElement('button'); forget.className = 'ck-forget'; forget.textContent = '✕'; forget.title = tr('cockpit.forget');
  forget.addEventListener('click', (e) => { e.stopPropagation(); forgetSession(r); });
  el.querySelector('.ck-prev-acts')!.append(pin, forget);
  el.addEventListener('click', () => void restoreSession(r));
  return el;
}

function row(s: CockpitSession): HTMLElement {
  const a: ActivityState = s.activity;
  const isPinned = live.get(s.id)?.pinned ?? false;
  const el = document.createElement('div');
  el.className = `ck-row act-${a}${s.id === selectedId ? ' sel' : ''}${isPinned ? ' pinned' : ''}`;
  const dirty = s.dirty > 0 ? ` ✎${s.dirty}` : '';
  // Line 1 = name + right-aligned context % (ck-ctx-col); line 2 (.mt) = branch/agent/model only — the
  // 🧠 context indicator moved up to line 1, so it's no longer appended to .mt.
  el.innerHTML = `<span class="ck-ind"></span><div class="ck-row-main"><div class="ck-line1"><span class="nm"></span><span class="ck-ctx-col"></span></div><div class="mt"></div></div><span class="ck-row-acts"></span>`;
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
  const mt = el.querySelector('.mt') as HTMLElement;
  mt.textContent = `${s.branch ?? '-'}${dirty} · ${s.agentId}${rowModel ? ` · ${rowModel}` : ''}`;
  // Per-session context % on line 1 (next to the name), tinted as it nears compaction — with many
  // concurrent sessions this answers "which one is about to compact" at a glance (the header shows it
  // only for the selected one).
  const rowCtx = contextPercent(live.get(s.id)?.meta?.contextTokens ?? 0, contextWindow);
  const ctxCol = el.querySelector('.ck-ctx-col') as HTMLElement;
  if (rowCtx !== null) {
    ctxCol.textContent = `🧠${rowCtx}%`;
    ctxCol.className = `ck-ctx-col sev-${contextSeverity(rowCtx)}`;
    ctxCol.title = tr('cockpit.context');
  }
  el.title = tr('cockpit.st_' + a);
  el.addEventListener('click', () => { if (editingId !== s.id) select(s.id); });
  const pin = document.createElement('button'); pin.className = 'ck-pin'; pin.textContent = '📌'; pin.title = tr(isPinned ? 'cockpit.unpin' : 'cockpit.pin'); // 📌 pins to the top group (hover-only unless pinned)
  pin.addEventListener('click', (e) => { e.stopPropagation(); togglePin(s.id); });
  const rename = document.createElement('button'); rename.className = 'ck-rename'; rename.textContent = '✎'; rename.title = tr('cockpit.rename'); // …or the ✎ on hover
  rename.addEventListener('click', (e) => { e.stopPropagation(); beginRename(s.id); });
  const close = document.createElement('button'); close.className = 'ck-close'; close.textContent = '✕'; close.title = tr('cockpit.close'); // ✕ closes the session (with confirm)
  close.addEventListener('click', (e) => { e.stopPropagation(); void requestClose(s.id); });
  el.querySelector('.ck-row-acts')!.append(pin, rename, close);
  return el;
}

/** Toggle a session's pin (top "고정" group); persist so it survives restart + update auto-restore. */
function togglePin(id: string): void {
  const l = live.get(id); if (!l) return;
  l.pinned = !l.pinned;
  persist(); renderList();
}

/** Toggle the pin of a not-yet-restored (previous) entry — pins must be manageable across a restart. */
function togglePrevPin(r: PersistedSession): void {
  r.pinned = r.pinned === true ? undefined : true;
  persist(); renderList();
}

/** OS toast for "this session needs you" — clicking it raises the window and jumps to the session. */
function notifyAttention(l: Live): void {
  const name = liveLabels.get(l.session.id) ?? l.customLabel ?? l.session.name;
  try {
    const n = new Notification(name, { body: tr('cockpit.notify_attention'), tag: `devdeck-attn-${l.session.id}` });
    n.onclick = () => {
      void window.devdeck.windowControls.show();
      document.querySelector<HTMLButtonElement>('.rail-item[data-view="cockpit"]')?.click();
      if (live.has(l.session.id)) select(l.session.id);
    };
  } catch { /* notifications unavailable (rare) — the tray dot still alerts */ }
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
  if (!headerEl) return; // may be called (via setCockpitContextWindow) before mountCockpit wired the DOM
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
  const ctxPct = contextPercent(l.meta?.contextTokens ?? 0, contextWindow);
  if (ctxPct !== null) { const cp = document.createElement('span'); cp.className = 'ck-pill'; cp.textContent = `🧠 ${ctxPct}%`; cp.title = tr('cockpit.context'); pills.push(cp); }
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
  // Carry the user-given label + pin into the re-created session — ⟳ must not silently reset them.
  const p: OpenReq = { path: l.session.projectPath, name: l.session.name, staleLevel: l.session.staleLevel, branch: l.session.branch, dirty: l.session.dirty, label: l.customLabel, pinned: l.pinned };
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
  try {
    const active = await window.devdeck.getAgent();
    // Reopen the tile's OWN conversation when it still exists on disk — so a project's distinct
    // conversations each keep their own tile instead of every tile collapsing onto the newest one or
    // two (the "3rd session vanished" bug). Only when the saved id is gone (deleted) or already open in
    // another tile do we fall back to the project's newest not-live session. A null result (no sessions
    // on disk) falls through to the main process's continue/new resolution.
    let sessionId: string | null = null;
    if (entry.agentId === active) {
      const liveIds = new Set([...live.values()].map((l) => l.openedSessionId).filter((x): x is string => !!x));
      let ids: string[] = [];
      try { ids = await window.devdeck.cockpit.sessionIds(entry.projectPath); } catch { ids = []; }
      sessionId = resolveRestoreSessionId(entry.sessionId, ids, liveIds);
    }
    const ok = await createSession({ path: entry.projectPath, name: entry.name, staleLevel: 'neutral', branch: null, dirty: 0, sessionId, label: entry.label ?? null, pinned: entry.pinned });
    if (ok) return;
  } catch { /* fall through to re-list the entry */ }
  // A failed restore must NOT silently drop the entry (it was removed above so a success doesn't
  // duplicate) — put it back so the user can retry, and persist so a quit doesn't lose it either.
  restorable = [entry, ...restorable];
  persist(); renderList();
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
