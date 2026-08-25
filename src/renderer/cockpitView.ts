import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { activityOrderStamp, filterSessions, groupByActivity, needsAttentionCount, numberCollidingNames, cockpitListSignature, shouldNotifyAttention, foldProjectActivity, sessionNavigationItem, tileHoldingSession, type CockpitSession } from '../shared/cockpitModel';
import type { ShellSessionAction, ShellSessionInput } from '../shared/shellNavigation';
import { computeActivity, stripAnsi, type ActivityState } from '../shared/sessionStatus';
import { friendlyModel, contextPercent, contextSeverity } from '../shared/sessionMeta';
import { formatDuration } from '../shared/usage';
import { decideKeyAction, selectionCellLength } from '../shared/terminalKeys';
import { unwrapCopiedUrl } from '../shared/urlCopy';
import { findUrlLinks, findFilePathLinks, type BufferRow } from '../shared/linkWrap';
import { cockpitNavigationId, cockpitNavigationIdForRuntime, createCockpitTileId, legacyCockpitNavigationId, persistedSessionKey, removeAutoRestoreMatches, sanitizePersistedList, resolveRestoreTarget, adoptRestorableMatch, type PersistedSession } from '../shared/cockpitPersist';
import { toAgentId, type AgentId, type OpenMode, type StaleLevel } from '../shared/types';
import { createProviderLogo, providerName } from './providerLogo';
import { tr, currentLang } from './i18n-runtime';
import { toast } from './loadError';
import { setActiveUsageProvider } from './usageBar';
import { reportShutdownActivity } from './shutdown';
import { createIcon, type IconName } from './icons';
import { deckFor, machineName, machineState, onMachineConnected, LOCAL_MACHINE_ID } from './machineDeck';
import { parseRemoteId } from '../shared/link/machine';
import { basename } from '../shared/paths';
import type { PtySessionInfo as RunningSession } from '../main/ptyHost';

/** What cockpit:sessionMeta answers with: the log-derived facts plus the ready-made summary line. */
type SessionMetaView = { model: string | null; activeMs: number; contextTokens: number; contextWindow?: number; summary: string | null };
interface Live {
  /** The machine this tile's terminal actually runs on. */ machineId: string;
  tileId: string; session: CockpitSession; term: Terminal; fit: FitAddon; search: SearchAddon; el: HTMLElement;
  lastDataAt: number; lastInputAt: number; recentOutput: string;
  openedSessionId: string | null; openedAt: number; idCheckAt: number;
  customLabel: string | null; meta: SessionMetaView | null; pinned: boolean; lastSelectedAt: number;
  /**
   * Output held back while this tile is being repainted from the machine's scrollback, or null when
   * it is writing straight through.
   *
   * A tile that binds to an ALREADY-RUNNING terminal starts receiving live bytes the moment it is in
   * `live` — which is before the round trip that fetches the screen to paint under them has come
   * back. Written in arrival order that produces the exact artifact reported: the newest output, and
   * then the whole scrollback dumped ON TOP of it, the overlap appearing twice.
   */
  replayPending: string[] | null;
}
/** The renderer's display metadata plus the explicit provider launch intent. */
export interface OpenReq { path: string; name: string; staleLevel: StaleLevel; branch: string | null; dirty: number; tileId?: string; sessionId?: string | null; mode: OpenMode; label?: string | null; pinned?: boolean; agentId: AgentId; /** Which machine the project lives on; absent means this one. */ machineId?: string; /** Bind to a terminal that is ALREADY running under this id instead of starting one. */ adoptId?: string; }

const live = new Map<string, Live>();
const navigationListeners = new Set<(items: readonly ShellSessionInput[]) => void>();
const sessionSelectionListeners = new Set<(id: string) => void>();
const sessionsLoadedListeners = new Set<(items: readonly ShellSessionInput[]) => void>();
let cockpitNavigationCallback: ((id?: string) => void) | null = null;
let lastNavigationSignature = '';
let restorable: PersistedSession[] = []; // previous sessions persisted across restarts, not yet restored
let restorableLoaded = false; // guard: don't persist (and clobber the on-disk list) until the initial load resolves
/** Saved entries whose conversation is no longer on disk — their row warns BEFORE it is clicked, since
 *  restoring one opens a fresh session under the same name (see resolveRestoreTarget). */
const missingConversations = new Set<string>();
let missingCheckedAt = 0;
const prevKey = (r: PersistedSession): string => persistedSessionKey(r);
let liveLabels = new Map<string, string>(); // live session id -> display label (#N when a project has several sessions)
let lastListSig = ''; // signature of the last-rendered session list — renderList() skips a rebuild when nothing visible changed
let editingId: string | null = null; // session being inline-renamed (rendered as an <input> in its row, so re-renders keep it)
let selectedId: string | null = null;
// Context window (tokens) for the header's per-session context % — set from settings at boot + on change.
let contextWindow = 1_000_000;
/** Update the context-window basis for the 🧠 context % (called from settings + boot). */
export function setCockpitContextWindow(w: number): void { contextWindow = w === 200_000 ? 200_000 : 1_000_000; renderHeader(); lastListSig = ''; renderList(); }
/**
 * The window to measure a session's context against. Codex records the model's REAL window in its
 * rollout (e.g. 258400), so that beats the global setting; Claude sends 0 and keeps using the setting.
 */
function windowFor(meta: SessionMetaView | null | undefined): number {
  return meta?.contextWindow && meta.contextWindow > 0 ? meta.contextWindow : contextWindow;
}
// The tray-alert setting doubles as the gate for the attention OS notification — set from settings at boot + on change.
let trayAlertMode: 'off' | 'attention' | 'all' = 'attention';
export function setCockpitTrayAlert(mode: 'off' | 'attention' | 'all'): void { trayAlertMode = mode; }
// Per-session summary line ("what is this session working on"). Main decides the TEXT (and returns
// null when the setting is off); the renderer keeps the flag only to lay the row out accordingly.
let summaryEnabled = true;
let aiSummaryEnabled = false;
export function setCockpitSessionSummary(on: boolean): void {
  summaryEnabled = on !== false;
  document.getElementById('ck-list')?.classList.toggle('with-summary', summaryEnabled);
  lastListSig = ''; renderList();
  for (const id of live.keys()) void refreshMeta(id); // main re-decides the summary per the new setting
}
/** The opt-in AI refinement — the renderer needs it only to know whether a result is worth waiting for. */
export function setCockpitAiSummary(on: boolean): void { aiSummaryEnabled = on === true; }
let searchEl: HTMLInputElement, groupsEl: HTMLElement, headerEl: HTMLElement, termsEl: HTMLElement, emptyEl: HTMLElement, mainEl: HTMLElement;
let mounted = false;
// Session-sidebar collapse (terminal gets the full width) — set from settings at boot + on toggle.
let sidebarCollapsed = false;
/** Re-apply the collapsed state to the DOM (class + localized button labels). Called on toggle,
 * on boot restore, and after a language switch; safe to call before mount (no-ops). */
export function refreshCockpitSidebar(): void {
  const wrap = document.querySelector<HTMLElement>('#view-cockpit .ck-wrap');
  if (!wrap) return;
  wrap.classList.toggle('list-collapsed', sidebarCollapsed);
  const collapse = document.getElementById('ck-collapse');
  const expand = document.getElementById('ck-expand');
  if (collapse) { collapse.title = tr('cockpit.sidebar_hide'); collapse.setAttribute('aria-label', tr('cockpit.sidebar_hide')); collapse.setAttribute('aria-expanded', String(!sidebarCollapsed)); }
  if (expand) { expand.title = tr('cockpit.sidebar_show'); expand.setAttribute('aria-label', tr('cockpit.sidebar_show')); expand.setAttribute('aria-expanded', String(!sidebarCollapsed)); }
}
/** Restore the persisted sidebar state (called from boot, after mountCockpit). */
export function setCockpitSidebarCollapsed(collapsed: boolean): void { sidebarCollapsed = collapsed === true; refreshCockpitSidebar(); }

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
  // Sidebar collapse/expand: the session list folds away so the terminal gets the full width.
  // The choice persists (store) and the termsEl ResizeObserver below re-fits the terminal.
  const toggleSidebar = (collapsed: boolean): void => {
    setCockpitSidebarCollapsed(collapsed);
    void window.devdeck.setCockpitSidebar(collapsed);
  };
  document.getElementById('ck-collapse')!.addEventListener('click', () => toggleSidebar(true));
  document.getElementById('ck-expand')!.addEventListener('click', () => toggleSidebar(false));
  refreshCockpitSidebar();

  window.devdeck.cockpit.onData(({ id, chunk }) => {
    const l = live.get(id); if (!l) return;
    // Held back only while a repaint is in flight (see Live.replayPending) so the screen underneath
    // cannot land on top of newer output. Activity tracking is not gated: the session IS producing.
    if (l.replayPending) holdForReplay(l, chunk); else l.term.write(chunk);
    l.lastDataAt = Date.now();
    l.recentOutput = (l.recentOutput + stripAnsi(chunk)).slice(-4096);
  });
  window.devdeck.cockpit.onExit(({ id }) => {
    const l = live.get(id); if (!l) return;
    l.session.status = 'exited'; l.session.activity = 'exited';
    renderList(); renderHeader(); updateRailBadge();
  });
  // What is running on THIS machine, announced whenever it changes. A paired machine can start a
  // terminal here, and without adopting it the person sitting at this one would see an agent working
  // with no tile to look at — and would lose it entirely on the next restart, since only tiles are
  // persisted.
  window.devdeck.cockpit.onSessions((sessions) => { void adoptAnnounced(LOCAL_MACHINE_ID, sessions); });
  void window.devdeck.cockpit.liveSessions()
    .then((sessions) => adoptAnnounced(LOCAL_MACHINE_ID, sessions))
    .catch(() => { /* nothing running, or the pty host is unavailable on this platform */ });
  // The same announcement from a paired machine. Its terminals appear here as they are started over
  // there, which is the whole point of connecting to a machine that is already working.
  try {
    window.devdeck.link.onSessions(({ machineId, sessions }) => {
      if (machineId) void adoptAnnounced(machineId, sessions);
    });
  } catch { /* no link on this machine */ }
  // And ask outright the moment a machine becomes reachable — the announcement only covers CHANGES
  // after we are listening, so without this a machine that was already busy stays invisible until it
  // happens to start or end something.
  // Two things are owed to a machine that just came up: the sessions this deck has never seen, and a
  // repaint of the ones it already holds — everything they printed while the link was down reached
  // nobody, and re-attaching does not replay it. Resync goes first so it snapshots the tiles that
  // existed BEFORE this connect, leaving the ones adoption is about to create to paint themselves.
  onMachineConnected((machineId) => { void resyncMachineTiles(machineId); void pullMachineSessions(machineId); });
  // Re-lay-out the terminals whenever their pane changes size — NOT just on window resize. The
  // always-on usage bar appears/disappears after its async load, resizing #shell (and thus .ck-terms)
  // by ~27px while the user sits on the cockpit; without a re-fit the terminal keeps its old row count
  // and its bottom rows get clipped by #view-cockpit's overflow:hidden. Observing the pane directly
  // covers that, window resizes, and header reflow alike.
  new ResizeObserver(() => scheduleLayout()).observe(termsEl);
  setInterval(tickActivity, 1000);
  setInterval(refreshAllMeta, 30_000); // model/active-time change slowly — refresh on a slow tick (+ on open/select)
  sendTrayAlertImage(); // hand the main process a red-dotted tray icon for the attention alert
  renderAll();
  // Load previously-open sessions (from a prior quit/crash) as restorable entries. Guard persist()
  // until this resolves so a session opened during the load window can't clobber the on-disk list;
  // then persist once to capture any such session in the correct union.
  window.devdeck.cockpit.loadSessions()
    .then(async (list) => {
      restorable = sanitizePersistedList(list); restorableLoaded = true; renderList(); publishSessionsLoaded(); if (live.size > 0) persist();
      void refreshMissingConversations(); // mark entries whose conversation is gone before they're clicked
      // Seamless update: if this launch is the relaunch after an update, auto-restore the sessions that
      // were live at restart (consume clears the marker so a later normal launch won't re-trigger).
      const pending = await window.devdeck.consumeAutoRestore().catch(() => [] as PersistedSession[]);
      if (pending.length) await autoRestoreAfterUpdate(pending);
    })
    .catch(() => { restorableLoaded = true; publishSessionsLoaded(); });
}

/** After an update relaunch, re-open the sessions that were live — each resolving to its project's
 *  latest conversation (via restoreSession). They're removed from the "Previous" list first so they
 *  aren't shown as restorable AND opened. Sequential to avoid a simultaneous PTY burst. */
async function autoRestoreAfterUpdate(pending: PersistedSession[]): Promise<void> {
  restorable = removeAutoRestoreMatches(restorable, pending);
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

// Re-checking costs one pass over the flat Codex rollout store, so it is user-paced, not on a tick.
const MISSING_RECHECK_MS = 60_000;

/**
 * Re-check which saved entries' conversations still exist. ONE batched IPC for the whole list — asking
 * per entry would re-index the flat Codex store once per project. Failures leave the rows as they are:
 * an unanswered check must never be read as "gone".
 */
async function refreshMissingConversations(): Promise<void> {
  missingCheckedAt = Date.now();
  const list = restorable.filter((r) => r.sessionId);
  if (!list.length) { missingConversations.clear(); return; }
  // One batched call PER MACHINE. Asking a single machine about every entry would report another
  // machine's conversations as missing — which the row renders as "this session's history is gone".
  const byMachine = new Map<string, PersistedSession[]>();
  for (const entry of list) {
    const machineId = entry.machineId ?? LOCAL_MACHINE_ID;
    const bucket = byMachine.get(machineId);
    if (bucket) bucket.push(entry); else byMachine.set(machineId, [entry]);
  }
  const gone = new Set<string>();
  let anyAnswered = false;
  await Promise.all([...byMachine].map(async ([machineId, entries]) => {
    // An unreachable machine cannot say anything about its conversations, and silence must never be
    // read as "gone" — those rows are simply left as they are.
    if (machineId !== LOCAL_MACHINE_ID && machineState(machineId) !== 'connected') return;
    let exists: boolean[];
    try {
      exists = await deckFor(machineId).cockpit.sessionsExist(entries.map((r) => ({ projectPath: r.projectPath, sessionId: r.sessionId, agentId: r.agentId })));
    } catch { return; }
    anyAnswered = true;
    entries.forEach((r, i) => { if (exists[i] === false) gone.add(prevKey(r)); });
  }));
  if (!anyAnswered) return;
  missingConversations.clear();
  for (const key of gone) missingConversations.add(key);
  renderList();
}

/** The currently-live sessions in PersistedSession form (for saving / update auto-restore). */
export function liveSessionsForPersist(): PersistedSession[] {
  return [...live.values()].map((l) => ({ tileId: l.tileId, projectPath: l.session.projectPath, name: l.session.name, sessionId: l.openedSessionId, agentId: l.session.agentId, label: l.customLabel, pinned: l.pinned, lastActiveMs: liveActivityAt(l), machineId: l.machineId === LOCAL_MACHINE_ID ? undefined : l.machineId }));
}
/** How many cockpit sessions are live right now (for the update-restart button label). */
export function liveSessionCount(): number { return live.size; }

function navigationIdentity(liveSession: Live): { tileId: string; projectPath: string; sessionId: string | null; runtimeId: string } {
  return { tileId: liveSession.tileId, projectPath: liveSession.session.projectPath, sessionId: liveSession.openedSessionId, runtimeId: liveSession.session.id };
}

function navigationIdForLive(liveSession: Live): string {
  return cockpitNavigationId(navigationIdentity(liveSession));
}

/** "Last time anything happened here" — agent output, the user typing, or the user opening the tile. */
function liveActivityAt(liveSession: Live): number {
  return Math.max(liveSession.openedAt, liveSession.lastDataAt, liveSession.lastInputAt, liveSession.lastSelectedAt);
}

export function cockpitNavigationItems(): ShellSessionInput[] {
  const liveItems = [...live.values()];
  const liveConversationIds = new Set(liveItems.map((item) => item.openedSessionId).filter((id): id is string => !!id));
  const previousItems = restorable.filter((item) => !(item.sessionId && liveConversationIds.has(item.sessionId)));
  const union = [
    ...liveItems.map((item) => item.customLabel || item.session.name),
    ...previousItems.map((item) => item.label || item.name),
  ];
  const labels = numberCollidingNames(union);
  const current = liveItems.map((item, index) => {
    const session = item.session;
    // The same facts the old cockpit row carried: branch (+ uncommitted count), provider, model, and
    // context %. Dropping the model made two sessions of the same repo indistinguishable at a glance.
    const detailBits = [`${session.branch ?? '—'}${session.dirty > 0 ? ` ✎${session.dirty}` : ''}`, providerName(session.agentId)];
    // Which machine this terminal is actually on — shown ONLY when it is not this one, so a
    // single-machine sidebar reads exactly as it did before. Without it two sessions of the same
    // repository on two machines are indistinguishable, and typing into the wrong one is silent.
    if (item.machineId !== LOCAL_MACHINE_ID) detailBits.unshift(`⇄ ${machineName(item.machineId)}`);
    const model = friendlyModel(item.meta?.model ?? null);
    if (model) detailBits.push(model);
    const context = contextPercent(item.meta?.contextTokens ?? 0, windowFor(item.meta));
    if (context != null) detailBits.push(`${context}%`);
    return sessionNavigationItem(
      { ...session, id: navigationIdForLive(item) }, labels[index], detailBits.join(' · '), item.pinned,
      summaryEnabled ? item.meta?.summary ?? null : null,
      activityOrderStamp(liveActivityAt(item)),
    );
  });
  const previous = previousItems.map((entry, index): ShellSessionInput => ({
    id: cockpitNavigationId(entry),
    projectPath: entry.projectPath,
    label: labels[liveItems.length + index],
    detail: `${providerName(toAgentId(entry.agentId) ?? 'claude')} · ${missingConversations.has(prevKey(entry)) ? tr('cockpit.prev_gone') : tr('cockpit.restore')}`,
    activity: 'idle',
    pinned: entry.pinned === true,
    lastActiveMs: entry.lastActiveMs ?? null,
    previous: true,
    conversationGone: missingConversations.has(prevKey(entry)),
  }));
  return [...current, ...previous];
}

/** One-release migration map for shell contexts saved before opaque tile identities existed. */
export function cockpitNavigationAliases(): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  const ambiguous = new Set<string>();
  const add = (entry: { tileId?: string; projectPath: string; sessionId: string | null; runtimeId?: string }): void => {
    const legacy = legacyCockpitNavigationId(entry);
    const current = cockpitNavigationId(entry);
    if (aliases.has(legacy) && aliases.get(legacy) !== current) { aliases.delete(legacy); ambiguous.add(legacy); }
    else if (!ambiguous.has(legacy)) aliases.set(legacy, current);
  };
  for (const item of live.values()) add(navigationIdentity(item));
  for (const item of restorable) add(item);
  return aliases;
}

export function onCockpitNavigationChange(listener: (items: readonly ShellSessionInput[]) => void): () => void {
  navigationListeners.add(listener);
  listener(cockpitNavigationItems());
  return () => navigationListeners.delete(listener);
}

export function onCockpitSessionsLoaded(listener: (items: readonly ShellSessionInput[]) => void): () => void {
  sessionsLoadedListeners.add(listener);
  if (restorableLoaded) listener(cockpitNavigationItems());
  return () => sessionsLoadedListeners.delete(listener);
}

export function onCockpitSessionSelected(listener: (id: string) => void): () => void {
  sessionSelectionListeners.add(listener);
  return () => sessionSelectionListeners.delete(listener);
}

export function setCockpitNavigationCallback(callback: (id?: string) => void): void {
  cockpitNavigationCallback = callback;
}

function publishSessionsLoaded(): void {
  const items = cockpitNavigationItems();
  for (const listener of sessionsLoadedListeners) listener(items);
}

function publishCockpitNavigation(): void {
  const items = cockpitNavigationItems();
  const signature = JSON.stringify(items);
  if (signature === lastNavigationSignature) return;
  lastNavigationSignature = signature;
  for (const listener of navigationListeners) listener(items);
}

export function activateCockpitSession(id: string): void {
  const current = [...live.values()].find((entry) => navigationIdForLive(entry) === id || legacyCockpitNavigationId(navigationIdentity(entry)) === id);
  if (current) { select(current.session.id); return; }
  const previous = restorable.find((entry) => cockpitNavigationId(entry) === id || legacyCockpitNavigationId(entry) === id);
  if (previous) void restoreSession(previous);
}

/** Per-project live status for the deck's summary + card stripes (no IPC — renderer-shared). */
export function liveProjectActivity(): Map<string, 'attention' | 'working'> {
  return foldProjectActivity([...live.values()].map((l) => ({ projectPath: l.session.projectPath, activity: l.session.activity })));
}

/** Advisory provider presence for open-control copy; click-time routing still rechecks real history. */
export function liveProjectProviders(projectPath: string): AgentId[] {
  return [...new Set([...live.values()]
    .filter((l) => l.session.projectPath === projectPath && l.session.status !== 'exited')
    .map((l) => l.session.agentId))];
}

/** Re-fit the active terminal when the cockpit becomes visible (xterm can't size while hidden). */
export function showCockpit(): void {
  if (selectedId) { scheduleLayout(); requestAnimationFrame(() => live.get(selectedId!)?.term.focus()); }
  // Transcripts disappear WHILE the app runs (Claude Code prunes them on its own startup), so re-check
  // when the user comes back to this view — throttled, since each check re-indexes the Codex store.
  if (restorableLoaded && Date.now() - missingCheckedAt > MISSING_RECHECK_MS) void refreshMissingConversations();
}

/**
 * Which live tile this open request would land on top of, if any.
 *
 * A deck/board "open" carries no session id, so the main process resolves it to the project's NEWEST
 * conversation — exactly the one a tile is most likely to already hold. Without this, opening a project
 * you are already working in spawned a SECOND agent on the same session log: two tiles, two names, one
 * transcript shown twice, and two processes appending to one file.
 *
 * `mode: new` ("+ New session") is an explicit fork and never dedupes. If the ids can't be read — including
 * when the caller sent no provider and the globally selected one owns a different store — this answers
 * null and the open proceeds as before: a missed dedupe, never a wrong one.
 */
async function duplicateTileFor(p: OpenReq): Promise<string | null> {
  if (p.mode === 'new') return null;
  const tiles = [...live.entries()]
    .filter(([, l]) => l.session.projectPath === p.path && l.session.agentId === p.agentId)
    .map(([id, l]) => ({ id, sessionId: l.openedSessionId, agentId: l.session.agentId, exited: l.session.status === 'exited' }));
  if (!tiles.length) return null; // nothing of this project is open — no lookup needed at all
  let target = p.sessionId ?? null;
  if (!target) {
    try {
      const ids = await window.devdeck.cockpit.sessionIds(p.path, p.agentId);
      target = ids[0] ?? null; // newest-first — what the main process's continue path resolves to
    } catch { return null; }
  }
  return tileHoldingSession(tiles, target, p.agentId);
}

/** Called by Projects "open": switch to the cockpit FIRST (so terminals fit a visible pane), then create a session per project. */
export async function openProjectsInCockpit(projects: OpenReq[]): Promise<void> {
  cockpitNavigationCallback?.();
  for (const p of projects) {
    const dup = await duplicateTileFor(p);
    if (dup) {
      // Already open: go to it. Named, because the tile the user renamed no longer says the folder name.
      select(dup);
      toast(tr('cockpit.already_open', { name: liveLabels.get(dup) || live.get(dup)?.session.name || p.name }));
      continue;
    }
    await createSession(p);
  }
}

/** Open a session for the request; false = refused or failed (already cleaned up + reported via toast). */
/**
 * Send a clipboard image to the machine running this session, then inject the path it landed at.
 *
 * Every failure is reported. A silently-not-pasted screenshot is the worst outcome here: the person
 * carries on describing an image the agent was never given, and only finds out several turns later.
 */
async function pasteImageToRemote(machineId: string, term: Terminal): Promise<void> {
  let payload: { tooLarge: boolean; bytes: string | null } | null = null;
  try { payload = await window.devdeck.clipboard.readImageBytes(); } catch { payload = null; }
  if (!payload) { toast(tr('cockpit.remote_image_failed')); return; }
  if (payload.tooLarge || !payload.bytes) { toast(tr('cockpit.remote_image_too_large')); return; }
  let remotePath: string | null = null;
  try { remotePath = await window.devdeck.machine(machineId).cockpit.receiveImage(payload.bytes); } catch { remotePath = null; }
  if (!remotePath) { toast(tr('cockpit.remote_image_failed')); return; }
  term.paste(remotePath + ' ');
  toast(tr('cockpit.image_pasted'));
}

/**
 * Build a tile — spawning its terminal, or binding to one that is already running.
 *
 * Serialized per machine against that machine's session announcements (see `onMachineQueue`), because
 * opening a session and being told what is running are two views of the SAME event and must not
 * interleave.
 */
async function createSession(p: OpenReq): Promise<boolean> {
  // Adoption already runs on the machine's queue — it IS the announcement handler — so re-entering
  // the queue here would deadlock waiting for the run that is calling us.
  if (p.adoptId) return buildTile(p);
  return onMachineQueue(p.machineId ?? LOCAL_MACHINE_ID, () => buildTile(p));
}

async function buildTile(p: OpenReq): Promise<boolean> {
  const el = document.createElement('div'); el.className = 'ck-term'; termsEl.appendChild(el);
  // Make this terminal visible BEFORE fitting: FitAddon measures 0 on a display:none element,
  // which would spawn the PTY at the wrong size. select() below re-affirms the show/hide state.
  // Hidden by DOM query rather than by walking `live`: a terminal that lost its place in the map is
  // exactly the one that must not be left showing, and the map can no longer reach it.
  hideAllTerminals();
  el.classList.add('show');
  const term = new Terminal({ fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 12, theme: { background: '#0a0b0e' }, cursorBlink: true });
  const fit = new FitAddon(); term.loadAddon(fit); term.open(el); fit.fit();
  // Make http(s) links clickable → open via a scheme-guarded IPC. Custom provider instead of the
  // WebLinksAddon: Claude's renderer HARD-wraps long URLs at its own inner width (real newlines +
  // indentation), which the addon can't join — clicking then opened only the first fragment. Our
  // provider (shared findUrlLinks) joins soft-wrapped rows by ground truth and hard-wrapped rows via
  // the same conservative fragment heuristic as unwrapCopiedUrl.
  const LINK_CONTEXT_ROWS = 6;
  /** Ceiling on how far the soft-wrap walk above may run, so a pathological line cannot make a hover
   *  scan the whole scrollback. 2000 characters at 40 columns still fits inside it. */
  const LINK_SCAN_LIMIT_ROWS = 64;
  const linkProvider = {
    provideLinks(bufferLineNumber: number, callback: (links: { range: { start: { x: number; y: number }; end: { x: number; y: number } }; text: string; activate: (e: MouseEvent, text: string) => void }[] | undefined) => void) {
      const buf = term.buffer.active;
      const hoveredIdx = bufferLineNumber - 1; // 0-based buffer row
      // The window has to REACH the row the URL starts on. A URL can be thousands of characters and
      // occupy dozens of rows, and a fixed ±6 meant that hovering anywhere past the sixth row handed
      // the finder a window that begins mid-URL — so it either found nothing or built a link out of
      // the tail. `isWrapped` says a row continues the one above it, which is ground truth, so the
      // window follows the logical line to both of its ends and only then adds the fixed context that
      // covers a TUI's own hard wraps. Bounded, because this runs on every hover.
      // A row continues a URL either because xterm wrapped it (isWrapped — ground truth) or because
      // the TUI printed its own newline mid-URL, which leaves a bare run of URL characters. Both are
      // walked; findUrlLinks re-validates every join, so a row that merely looks like one costs
      // nothing but a slightly wider scan.
      const continuesUrl = (i: number): boolean => {
        const line = buf.getLine(i);
        if (!line) return false;
        if (line.isWrapped) return true;
        const t = line.translateToString(true).trim();
        return t.length > 0 && !/\s/.test(t) && !/^https?:\/\//i.test(t);
      };
      let first = hoveredIdx;
      for (let i = 0; i < LINK_SCAN_LIMIT_ROWS && first > 0 && continuesUrl(first); i++) first--;
      first = Math.max(0, first - LINK_CONTEXT_ROWS);
      let last = hoveredIdx;
      for (let i = 0; i < LINK_SCAN_LIMIT_ROWS && last + 1 < buf.length && continuesUrl(last + 1); i++) last++;
      last = Math.min(buf.length - 1, last + LINK_CONTEXT_ROWS);
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
        // Local file paths the agent printed (e.g. "> [image] assets\a.png", "› [file] SFX\bell.wav")
        // — click opens the OS default app (inert-content extensions only, re-checked in main).
        ...findFilePathLinks(rows).filter(onRow).map((h) => ({
          range: toRange(h), text: h.url,
          activate: (_e: MouseEvent, text: string) => {
            // A remote session's paths belong to the OTHER machine. Opening them here would either
            // fail the allowlist or — far worse — open a same-named file that exists locally and is
            // entirely unrelated work. Refuse and say why rather than open the wrong thing.
            if (machineId !== LOCAL_MACHINE_ID) { toast(tr('cockpit.remote_file_unavailable', { machine: machineName(machineId) })); return; }
            void window.devdeck.cockpit.openFile(p.path, text);
          },
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
        // A local paste writes the temp file here and injects its path. For a session on another
        // machine that path resolves to nothing, so the BYTES travel and the file is written where
        // the agent can actually read it — then that machine's path is what gets injected.
        if (imgPath && machineId !== LOCAL_MACHINE_ID) { void pasteImageToRemote(machineId, term); return; }
        if (imgPath) { term.paste(imgPath + ' '); toast(tr('cockpit.image_pasted')); return; }
        window.devdeck.clipboard.readText().then((t) => { if (t) term.paste(t); });
      });
      return false;
    }
    if (action === 'find') { e.preventDefault(); openFindBar(); return false; } // Ctrl+F searches scrollback, never reaches the PTY
    // Swallowed here so the PTY never sees it; the shell's own document listener does the focusing
    // (the DOM event still bubbles — returning false only stops xterm from forwarding it).
    if (action === 'quickopen') { e.preventDefault(); return false; }
    return true;
  });
  const search = new SearchAddon(); term.loadAddon(search);
  // Copy-on-select: selecting text copies it right away (like Claude Code's own auto-copy / classic
  // Windows quick-edit). This matters most while a TUI has mouse tracking ON — a plain drag goes to the
  // TUI, so the user selects with Shift+drag, and requiring another Ctrl+C afterwards was exactly the
  // step that intermittently turned into a SIGINT. Debounced so mid-drag updates don't spam the
  // clipboard; skipped for the programmatic re-select in layoutTerminals (guard below) so a background fit
  // can't clobber whatever the user copied elsewhere in the meantime.
  // Triggered by the mouse GESTURE itself (mouseup after a drag / double-click word select), never by
  // xterm's selection events: those also fire for programmatic select() (layoutTerminals' restore) and
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
  const machineId = p.machineId ?? LOCAL_MACHINE_ID;
  // Main answers a failed open with id:'' (allowlist refusal / pty spawn error) — but guard the invoke
  // itself too, so a reject can't leak the terminal we already mounted or abort a restore-all loop.
  let res: { id: string; agentId: AgentId; sessionId: string | null };
  if (p.adoptId) {
    // Binding to a terminal that is already running — started by the person at that machine, or by
    // this one before a restart. Nothing is spawned; the tile simply takes ownership of the stream.
    res = { id: p.adoptId, agentId: p.agentId, sessionId: p.sessionId ?? null };
  } else {
    try {
      // The machine that owns the project opens it. A remote answer carries an id already qualified
      // with that machine, which is what lets input/resize/close below stay machine-agnostic.
      res = await deckFor(machineId).cockpit.open({ projectPath: p.path, sessionId: p.sessionId ?? null, cols, rows, mode: p.mode, agentId: p.agentId });
    } catch {
      res = { id: '', agentId: 'claude', sessionId: null };
    }
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
  const adopted = adoptRestorableMatch(restorable, res.sessionId ?? null, { tileId: p.tileId, label: p.label ?? null, pinned: !!p.pinned });
  restorable = adopted.rest;
  // Whatever else reached this id loses its terminal here rather than being left stacked over this
  // one. A tile evicted from `live` can never be hidden again (hiding needs the map to find it) and
  // .ck-term is absolutely positioned, so the evicted one would sit on top, blank, forever.
  const displaced = live.get(res.id);
  if (displaced && displaced.el !== el) { displaced.el.remove(); displaced.term.dispose(); }
  live.set(res.id, {
    machineId, tileId: adopted.tileId ?? createCockpitTileId(), session, term, fit, search, el,
    lastDataAt: Date.now(), lastInputAt: 0, recentOutput: '',
    openedSessionId: res.sessionId ?? null, openedAt: Date.now(), idCheckAt: Date.now(),
    customLabel: adopted.label, meta: null, pinned: adopted.pinned, lastSelectedAt: Date.now(),
    // A terminal we are BINDING to is already producing, and its screen has yet to be fetched. Hold
    // its output until the screen is under it (replayInto releases). A terminal we started has no
    // history to paint, so it writes through from the first byte.
    replayPending: p.adoptId ? [] : null,
  });
  // Repaint what is already on that terminal. Without this, attaching to work in progress shows a
  // blank rectangle until the agent next speaks — which, while it is thinking, can be minutes, and
  // reads as a dead session rather than a busy one.
  //
  // Started on the very next statement after the tile is registered, and paired with the hold armed
  // there: nothing between the two can throw and leave a terminal holding its output forever. It is a
  // round trip, so the sooner it is asked for, the less has to be held.
  if (p.adoptId) void replayInto(res.id, machineId, term);
  // Tell the owning machine what this tile is called, so a deck on the OTHER side of a link shows the
  // session's name rather than re-deriving the repository folder.
  if (adopted.label) noteLabelOnOwner(res.id, adopted.label);
  select(res.id);
  updateRailBadge();
  persist();
  // Attaching does not itself tell the host our size; a resize does, and it is also what starts the
  // stream flowing for a session this viewer did not open.
  if (p.adoptId) window.devdeck.cockpit.resize(res.id, term.cols, term.rows);
  void refreshMeta(res.id);
  void refreshGit(res.id);
  return true;
}

/**
 * One queue per machine, shared by OPENING a session there and by handling what that machine says it
 * is running.
 *
 * These two must never interleave, and that is not a subtlety — it is the whole correctness of both.
 * A machine publishes its new pty to every listener BEFORE the open call it came from has answered,
 * so the announcement lands while the tile being opened is not yet in `live`. Handled concurrently,
 * the announcement reads that session as one nobody is showing and builds a SECOND tile for the very
 * terminal that is opening: two terminals for one pty, only one of which receives its output.
 *
 * Queuing makes the ordering the code always assumed — the tile is registered, then the announcement
 * is reconciled against it and finds nothing to adopt.
 */
const machineQueues = new Map<string, Promise<unknown>>();
function onMachineQueue<T>(machineId: string, task: () => Promise<T>): Promise<T> {
  const previous = machineQueues.get(machineId) ?? Promise.resolve();
  const next = previous.catch(() => { /* a failed run must not wedge the queue */ }).then(task);
  // The queue follows the SETTLED task, so one rejection can't strand every later open behind it.
  machineQueues.set(machineId, next.catch(() => undefined));
  return next;
}

/**
 * Handle an announcement of what is running on a machine: adopt the unknown, retire the vanished.
 *
 * Serialized per machine. Two announcements arriving close together (a session opens while another
 * exits) would otherwise both see the same "unknown" id and each create a tile for it.
 */
function adoptAnnounced(machineId: string, sessions: readonly RunningSession[]): Promise<void> {
  return onMachineQueue(machineId, async () => {
    const adopted = await syncMachineSessions(machineId, sessions);
    noteSessionsGone(machineId, sessions.map((info) => info.id));
    if (adopted > 0 && machineId !== LOCAL_MACHINE_ID) {
      toast(tr('cockpit.adopted_remote', { n: adopted, machine: machineName(machineId) }));
    }
  });
}

/** Ask a machine what it is running, then reconcile. Used when a link comes up. */
export async function pullMachineSessions(machineId: string): Promise<void> {
  let sessions: RunningSession[] = [];
  try {
    sessions = machineId === LOCAL_MACHINE_ID
      ? await window.devdeck.cockpit.liveSessions()
      : await window.devdeck.machine(machineId).cockpit.liveSessions();
  } catch { return; }
  await adoptAnnounced(machineId, sessions);
}

/**
 * Bring this deck in line with what is ACTUALLY running on a machine.
 *
 * A terminal can be started by the person sitting at a machine or by a paired one, and whoever did not
 * start it would otherwise never learn it exists — the host would show an agent working with no tile,
 * and a viewer would connect to a busy machine and see nothing going on. The pty table on each machine
 * is the source of truth, and both sides reconcile against it through this one function.
 *
 * Adoption only ADDS. A session missing from the list is not closed here: the list arrives from one
 * machine and this deck may hold tiles from several, and an absent entry is far more often "not that
 * machine's session" than "gone".
 */
export async function syncMachineSessions(machineId: string, sessions: readonly RunningSession[]): Promise<number> {
  const known = new Set(live.keys());
  let adopted = 0;
  for (const info of sessions) {
    const id = info.id; // already qualified by the link when it came from another machine
    if (known.has(id)) { syncAdoptedLabel(machineId, id, info.label ?? null); continue; }
    // A tile this deck is still holding as "previous" for the same conversation should become live
    // rather than sit next to it as a stale duplicate.
    const saved = restorable.find((r) => r.sessionId && r.sessionId === info.sessionId);
    const ok = await createSession({
      path: info.projectPath,
      name: saved?.name ?? basename(info.projectPath),
      staleLevel: 'neutral', branch: null, dirty: 0,
      sessionId: info.sessionId,
      mode: 'auto',
      agentId: toAgentId(info.agentId) ?? 'claude',
      machineId,
      adoptId: id,
      tileId: saved?.tileId,
      // What the machine running it calls the session. Without this every session on one repository
      // arrives under that repository's folder name, so sessions the user deliberately named apart
      // are indistinguishable here — the exact problem adoption was supposed to solve.
      label: info.label ?? saved?.label ?? null,
      pinned: saved?.pinned,
    });
    if (ok) adopted += 1;
  }
  return adopted;
}

/**
 * Follow a rename made on the machine that runs the session.
 *
 * Only for tiles belonging to ANOTHER machine: for a local one this deck is the source of truth and
 * the announcement is merely the echo of its own write, which would otherwise race a rename the user
 * is still typing. Renaming a remote session from here writes through to its machine
 * (`noteLabelOnOwner`), so both decks converge on the same name either way.
 */
function syncAdoptedLabel(machineId: string, id: string, label: string | null): void {
  if (machineId === LOCAL_MACHINE_ID || editingId === id) return;
  const l = live.get(id);
  if (!l || l.customLabel === label) return;
  l.customLabel = label;
  persist(); renderList(); renderHeader();
}

/** Mark a tile whose terminal is gone on the machine that owned it. */
export function noteSessionsGone(machineId: string, aliveIds: readonly string[]): void {
  const alive = new Set(aliveIds);
  for (const [id, l] of live) {
    if (l.machineId !== machineId || l.session.status === 'exited') continue;
    if (alive.has(id)) continue;
    l.session.status = 'exited';
    l.session.activity = 'exited';
  }
  renderAll();
  updateRailBadge();
}

/**
 * Bytes a tile produced while its repaint was in flight.
 *
 * Capped at the same size as the machine-side scrollback: a session streaming hard through a slow
 * round trip must not grow this without bound, and once it has produced more than a whole screen's
 * worth the older held bytes no longer matter.
 */
const REPLAY_HOLD_BYTES = 256 * 1024;

function holdForReplay(l: Live, chunk: string): void {
  const held = l.replayPending!;
  held.push(chunk);
  let total = held.reduce((n, part) => n + part.length, 0);
  while (total > REPLAY_HOLD_BYTES && held.length > 1) total -= held.shift()!.length;
}

/** Release held output, in order, and go back to writing straight through. */
function flushReplayHold(l: Live): void {
  const held = l.replayPending;
  l.replayPending = null;
  if (held?.length) l.term.write(held.join(''));
}

/** Write a running session's recent output into a freshly attached terminal. */
async function replayInto(id: string, machineId: string, term: Terminal): Promise<void> {
  let buffer = '';
  try {
    buffer = await sessionScrollback(id, machineId);
  } finally {
    // The hold is released on EVERY path. A tile whose repaint failed must go back to writing what
    // its session says — a terminal that silently stopped printing is worse than one missing history.
    const l = live.get(id);
    if (l && l.term === term) {
      if (buffer) term.write(buffer);
      flushReplayHold(l);
    }
  }
}

/** The recent output a machine is holding for one of its sessions — its screen, near enough. */
async function sessionScrollback(id: string, machineId: string): Promise<string> {
  try {
    return machineId === LOCAL_MACHINE_ID
      ? await window.devdeck.cockpit.sessionBuffer(id)
      : await window.devdeck.machine(machineId).cockpit.sessionBuffer(parseRemoteId(id).hostId);
  } catch { return ''; }
}

/**
 * Repaint the tiles of a machine that has just (re)connected.
 *
 * A dropped link does not stop its sessions: they keep running and keep producing output that nobody
 * is there to forward, and re-attaching replays none of it. So a tile that was mid-turn came back
 * frozen at the instant of the drop, with the rest of that turn lost — looking exactly like a session
 * that had gone quiet. The host also hangs up on a viewer outright when its output backlog overflows,
 * telling it to "reattach to resync"; nothing ever did. The host's own scrollback IS that screen, so
 * reset and repaint from it.
 *
 * The snapshot of `live` is taken synchronously, before any await, so tiles that the connect handler
 * is concurrently ADOPTING (which paint themselves) are never repainted twice.
 */
async function resyncMachineTiles(machineId: string): Promise<void> {
  // A tile already mid-repaint (one being adopted as this connect is handled) is skipped: it is
  // fetching the very same screen, and painting it twice is the duplication this all exists to stop.
  const tiles = [...live.values()].filter((l) => l.machineId === machineId && l.session.status !== 'exited' && !l.replayPending);
  for (const tile of tiles) {
    const id = tile.session.id;
    // Re-assert our size first: attaching does not carry it, and the host re-attaches at whatever was
    // recorded when the link dropped.
    window.devdeck.cockpit.resize(id, tile.term.cols, tile.term.rows);
    tile.replayPending = []; // hold the resumed stream until the screen is back under it
    let buffer = '';
    try {
      buffer = await sessionScrollback(id, machineId);
    } finally {
      const still = live.get(id);
      if (still && still.term === tile.term) {
        if (buffer) { still.term.reset(); still.term.write(buffer); }
        flushReplayHold(still);
      } else {
        tile.replayPending = null; // the tile was closed or rebuilt while we asked
      }
    }
  }
}

/** Pull a session's model + active-time + summary from its log (for the header/list). Cheap; called on open/select + a slow tick. */
async function refreshMeta(id: string): Promise<void> {
  const l = live.get(id); if (!l || !l.openedSessionId) return;
  let meta: SessionMetaView;
  // Only ask the (opt-in, paid) AI summarizer to generate once the turn is over: mid-turn the log is
  // half-written and every 30s tick would spend another call. Main still returns the cached line.
  const wantAi = l.session.activity !== 'working';
  try { meta = await deckFor(l.machineId).cockpit.sessionMeta(l.session.projectPath, l.openedSessionId, l.session.agentId, wantAi); } catch { return; }
  if (l.meta?.model === meta.model && l.meta?.activeMs === meta.activeMs && l.meta?.contextTokens === meta.contextTokens
    && l.meta?.summary === meta.summary) return; // unchanged → no re-render
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
  const l = live.get(id); if (!l || (l.session.agentId !== 'claude' && l.session.agentId !== 'codex') || l.session.status === 'exited') return;
  const since = l.idCheckAt;
  if (l.lastDataAt <= since) return; // no output since the last check — nothing moved on our behalf
  l.idCheckAt = Date.now(); // advance BEFORE the async hop so overlapping calls can't double-adopt
  const claimedIds = [...live.values()].filter((o) => o !== l).map((o) => o.openedSessionId).filter((x): x is string => !!x);
  let next: string | null = null;
  try {
    next = await deckFor(l.machineId).cockpit.liveSessionId(l.session.projectPath, {
      currentId: l.openedSessionId, claimedIds, openedAtMs: l.openedAt, sinceMs: since, lastDataAtMs: l.lastDataAt, agentId: l.session.agentId,
      // The bare id the owning machine minted, so it can record the drift against its own pty.
      ptyId: parseRemoteId(id).hostId,
    });
  } catch { return; }
  if (!next || next === l.openedSessionId || !live.has(id)) return; // tile may have closed mid-await
  l.openedSessionId = next;
  persist(); // the drifted id is exactly what a quit would have frozen — save the corrected one now
  publishCockpitNavigation();
  if (selectedId === id) publishSessionSelection(l);
  void refreshMeta(id); // model/context % must now read the NEW conversation, not the stale file
}

/** Re-detect WHICH AGENT a live tile is running. The tile's shell outlives the agent (`-NoExit`), so a
 *  user can finish one agent and type another at the leftover prompt — the tile then kept its launch-time
 *  provider forever, mislabeling the conversation and sending its usage/session reads to the wrong
 *  store. Main answers from the pty's process tree; null (bare prompt / probe failed) keeps what we have.
 *  On a change the tile's session id is dropped: it named a conversation in the OLD provider's store,
 *  and the id probe re-adopts the new provider's live one on the next tick. */
async function refreshProvider(id: string): Promise<void> {
  const l = live.get(id); if (!l || l.session.status === 'exited') return;
  let actual: AgentId | null = null;
  try { actual = await deckFor(l.machineId).cockpit.liveAgent(id); } catch { return; }
  if (!actual || actual === l.session.agentId || !live.has(id)) return; // tile may have closed mid-await
  l.session.agentId = actual;
  l.openedSessionId = null;
  l.meta = null;
  persist();
  publishCockpitNavigation();
  if (selectedId === id) publishSessionSelection(l);
  if (selectedId === id) setActiveUsageProvider(actual); // the footer must follow the tile's REAL provider
  if (!editingId) renderList();
  renderHeader();
}

/** Await a provider + drift check for every live tile — the update-restart path calls this right before
 *  it snapshots liveSessionsForPersist, so the relaunch restores each tile under the agent it is
 *  ACTUALLY running, pointed at the post-/clear conversation. */
export async function refreshLiveSessionIds(): Promise<void> {
  await Promise.all([...live.keys()].map(async (id) => { await refreshProvider(id); await refreshSessionId(id); }));
}

/** Pull a session's CURRENT git branch + dirty count by project path, so a RESTORED session — which is
 *  re-created with no branch — and in-terminal branch switches both show the live branch instead of "-". */
async function refreshGit(id: string): Promise<void> {
  const l = live.get(id); if (!l) return;
  let info: { branch: string | null; dirty: number } | null;
  try { info = await deckFor(l.machineId).cockpit.gitInfo(l.session.projectPath); } catch { return; }
  if (!info) return; // main refused the path (allowlist guard)
  if (l.session.branch === info.branch && l.session.dirty === info.dirty) return; // unchanged → no re-render
  l.session.branch = info.branch;
  l.session.dirty = info.dirty;
  if (!editingId) renderList();
  renderHeader();
}
// The 30s tick: skip exited sessions — their model/branch can't change, so re-reading their log +
// re-spawning git every tick is pure waste (matters most with many concurrent sessions).
// The provider check runs BEFORE the id check so a re-attributed tile resolves its new id against the
// right store on the same tick (one process listing in main is shared by every tile).
function refreshAllMeta(): void { if (editingId) return; for (const [id, l] of live) { if (l.session.status === 'exited') continue; void refreshProvider(id).then(() => refreshSessionId(id)); void refreshMeta(id); void refreshGit(id); } }

/**
 * Hide every terminal in the pane, by DOM rather than by walking `live`.
 *
 * The terminals are stacked (`position: absolute; inset: 0`), so anything left showing covers the
 * selected one. Walking the map cannot hide a terminal the map has lost — and that is precisely the
 * one that would otherwise be drawn, blank, over the session the user is looking at.
 */
function hideAllTerminals(): void {
  termsEl.querySelectorAll('.ck-term').forEach((el) => el.classList.remove('show'));
}

function select(id: string): void {
  if (selectedId !== id && findBar && !findBar.classList.contains('hidden')) closeFindBar(); // find decorations belong to the previous session
  selectedId = id;
  const selected = live.get(id);
  // Opening a session counts as activity for the sidebar's recency order even when nothing is typed —
  // "the one I was last in" is exactly what the user is looking for at the top of a group.
  if (selected) { selected.lastSelectedAt = Date.now(); publishSessionSelection(selected); }
  // The always-on usage footer reports the provider of the session you're working in — hand it over
  // on every selection change (a Claude tile must not be captioned with Codex's percentage).
  setActiveUsageProvider(live.get(id)?.session.agentId ?? null);
  hideAllTerminals();
  selected?.el.classList.add('show');
  mainEl.classList.toggle('has-session', live.size > 0);
  renderList(); renderHeader();
  void refreshMeta(id);
  void refreshGit(id);
  // Selecting a tile is when its provider is most visible (header mark + usage footer) — re-check it
  // here too instead of waiting up to 30s for the tick. Main's listing is cached, so this is cheap.
  void refreshProvider(id);
  // Every tile is already the pane's size (layoutTerminals keeps them all there), so selecting one
  // normally resizes nothing — the schedule is here for the case where the pane changed while the
  // cockpit was off screen and nothing has measured it yet.
  scheduleLayout();
  requestAnimationFrame(() => live.get(id)?.term.focus());
}

/**
 * How long the pane must hold still before the terminals are re-sized.
 *
 * Every PTY resize makes conpty re-emit the whole screen. Two resizes close together therefore put
 * two repaints — at DIFFERENT sizes — into one buffer, and what the user is left looking at is two
 * frames drawn over each other: half-erased status lines, a separator struck through the middle of a
 * sentence, the same block twice. A window drag-resize used to fire dozens of these per second. Every
 * trigger goes through one trailing debounce so a settling layout yields ONE fit and ONE repaint.
 */
const LAYOUT_SETTLE_MS = 200;
let layoutTimer: ReturnType<typeof setTimeout> | undefined;

/** Coalesce every re-fit trigger — pane resize, view switch, session select — into one settled pass. */
function scheduleLayout(): void {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(layoutTerminals, LAYOUT_SETTLE_MS);
}

/**
 * Size EVERY open terminal to the pane, from one measurement.
 *
 * Fitting only the selected tile left every other one at whatever size the pane had when it was last
 * on screen — so clicking a session resized its pty right at that moment, and conpty answered with a
 * full repaint over whatever the agent happened to be drawing. With a dozen sessions open, one window
 * resize meant a dozen such repaints, each detonating under the user's cursor. Tiles share one pane
 * and one font, so one measurement is the correct size for all of them; applying it to all at once
 * means switching sessions resizes nothing at all.
 */
function layoutTerminals(): void {
  if (!termsEl || termsEl.clientHeight <= 0) return; // pane hidden — xterm measures 0; showCockpit() re-runs this
  // The measurement has to come from a VISIBLE tile: FitAddon reads getComputedStyle, which is 0 on a
  // display:none element. The selected tile is normally that one, but there is a window during an open
  // where the previous selection is already hidden and the new tile is not in `live` yet — measuring
  // the hidden one there would hand every terminal a size taken from nothing.
  const selected = selectedId ? live.get(selectedId) : null;
  const shown = selected?.el.classList.contains('show') ? selected : [...live.values()].find((l) => l.el.classList.contains('show'));
  if (!shown) return;
  const dims = shown.fit.proposeDimensions();
  if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return; // nothing measurable yet
  const term = shown.term;
  // xterm drops the text selection on resize, and a layout pass can fire in the background (usage-bar
  // toggle, header-pill reflow via the ResizeObserver, window resize) — silently clearing a selection
  // the user is about to Ctrl+C-copy, so the copy falls through to SIGINT. Preserve it across a
  // HEIGHT-ONLY fit (cols unchanged → buffer coords stay valid; a width change reflows the buffer).
  const colsBefore = term.cols;
  const rowsBefore = term.rows;
  const sel = term.hasSelection() ? term.getSelectionPosition() : undefined;
  shown.fit.fit();
  if (term.cols !== colsBefore || term.rows !== rowsBefore) {
    if (sel && term.cols === colsBefore) {
      const len = selectionCellLength(sel.start, sel.end, term.cols);
      if (len > 0) term.select(sel.start.x, sel.start.y, len); // copy-on-select ignores this (no mouse gesture)
    }
    window.devdeck.cockpit.resize(shown.session.id, term.cols, term.rows);
  }
  for (const l of live.values()) {
    if (l === shown || (l.term.cols === term.cols && l.term.rows === term.rows)) continue; // already right — never make conpty repaint for nothing
    l.term.resize(term.cols, term.rows);
    window.devdeck.cockpit.resize(l.session.id, term.cols, term.rows);
  }
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
      if (next === 'turn' && prev === 'working') {
        void refreshSessionId(l.session.id); void refreshMeta(l.session.id);
        // The AI summary is generated off this very refresh and takes ~8-10s to come back. Ask once
        // more when it should be ready, so the row updates now instead of on the next 30s tick.
        if (aiSummaryEnabled && summaryEnabled) {
          const sid = l.session.id;
          setTimeout(() => { if (live.has(sid)) void refreshMeta(sid); }, 15_000);
        }
      }
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
  publishCockpitNavigation();

  // Skip the full DOM rebuild when nothing the list shows has changed (this runs on every 1s activity
  // tick + per-session meta/git refresh, so most calls become no-ops once the deck settles).
  const sig = cockpitListSignature(
    liveLive.map((l) => ({
      id: l.session.id, activity: l.session.activity, label: liveLabels.get(l.session.id) ?? '', dirty: l.session.dirty,
      branch: l.session.branch, model: friendlyModel(l.meta?.model ?? null), agentId: l.session.agentId, selected: l.session.id === selectedId, pinned: l.pinned,
      ctx: contextPercent(l.meta?.contextTokens ?? 0, windowFor(l.meta)),
      summary: l.meta?.summary ?? null,
    })),
    prev.map((r, i) => ({ key: r.tileId, label: prevLabels[i], agentId: r.agentId, pinned: r.pinned === true, gone: missingConversations.has(prevKey(r)) })),
    currentLang(), search,
  ) + `\nedit:${editingId ?? ''}`; // a row being renamed becomes an <input> — also part of what the list renders
  if (sig === lastListSig) return;
  lastListSig = sig;

  // #ck-empty and the "+ New session" label live in the terminal pane and are still shown; the group
  // list below is the hidden compatibility surface (features/cockpit/cockpit.css) that the shared shell
  // replaced. Rebuilding its rows from scratch on every activity tick — one provider SVG, three text
  // nodes and four buttons per session, for every session — is pure waste while it is not displayed.
  if (legacyListVisible()) renderLegacyList(liveSessions, prev, prevLabels);
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

/** Is the pre-redesign session list on screen? It is hidden today, and this is the single question
 *  every legacy-list code path asks before doing DOM work for it. */
function legacyListVisible(): boolean {
  return (document.getElementById('ck-list')?.getClientRects().length ?? 0) > 0;
}

function renderLegacyList(liveSessions: CockpitSession[], prev: PersistedSession[], prevLabels: string[]): void {
  const liveLive = [...live.values()];
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
}

/** Long names are clamped to two lines (the sidebar stays 250px), so the COMPLETE name must stay
 *  reachable without resizing: expose it to assistive tech via aria-label and to sighted pointer AND
 *  keyboard users via a CSS tooltip. The tooltip is `position: fixed` (it must escape .ck-list's
 *  overflow), so its anchor is measured here and handed to CSS as custom properties. */
function applyFullName(nm: HTMLElement, fullName: string): void {
  nm.textContent = fullName;
  nm.tabIndex = 0;
  nm.dataset.fullName = fullName;
  nm.setAttribute('aria-label', fullName);
  const place = (): void => {
    const r = nm.getBoundingClientRect();
    nm.style.setProperty('--tt-x', `${Math.round(r.left)}px`);
    nm.style.setProperty('--tt-y', `${Math.round(r.bottom + 4)}px`);
  };
  nm.addEventListener('pointerenter', place);
  nm.addEventListener('focus', place);
}

function prevRow(r: PersistedSession, label: string): HTMLElement {
  const isPinned = r.pinned === true;
  const el = document.createElement('div'); el.className = `ck-row ck-row-prev${isPinned ? ' pinned' : ''}`;
  el.innerHTML = `<span class="ck-ind"><span class="ck-dot"></span></span><div class="ck-row-main"><div class="nm"></div><div class="mt"></div></div><span class="ck-prev-acts"></span>`;
  applyFullName(el.querySelector('.nm') as HTMLElement, label);
  // The provider is now shown as a mark in its own column, so the metadata line no longer repeats it.
  el.insertBefore(createProviderLogo(toAgentId(r.agentId) ?? 'claude'), el.querySelector('.ck-row-main'));
  // Say up front when this entry's conversation is gone: restoring it opens a FRESH session under the
  // same name, and finding that out only after the click reads as "my session lost its history".
  const gone = missingConversations.has(prevKey(r));
  el.querySelector('.mt')!.textContent = gone ? `⚠ ${tr('cockpit.prev_gone')}` : tr('cockpit.restore');
  el.querySelector('.mt')!.classList.toggle('gone', gone);
  el.title = gone ? tr('cockpit.prev_gone_tip') : tr('cockpit.restore');
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
  el.innerHTML = `<span class="ck-ind"></span><div class="ck-row-main"><div class="ck-line1"><span class="nm"></span><span class="ck-ctx-col"></span></div><div class="mt"></div><div class="sm"></div></div><span class="ck-row-acts"></span>`;
  el.insertBefore(createProviderLogo(s.agentId), el.querySelector('.ck-row-main'));
  const ind = el.querySelector('.ck-ind')!;
  if (a === 'working') ind.innerHTML = '<span class="ck-spin"></span>';
  else if (a === 'attention') ind.textContent = '❓';
  else ind.innerHTML = '<span class="ck-dot"></span>';
  const nm = el.querySelector('.nm') as HTMLElement;
  if (s.id === editingId && legacyListVisible()) {
    nm.replaceChildren(renameInput(s.id, live.get(s.id)?.customLabel ?? s.name));
  } else {
    applyFullName(nm, liveLabels.get(s.id) ?? s.name);
    nm.addEventListener('dblclick', (e) => { e.stopPropagation(); beginRename(s.id); }); // rename: double-click the name…
  }
  const rowModel = friendlyModel(live.get(s.id)?.meta?.model ?? null);
  const mt = el.querySelector('.mt') as HTMLElement;
  mt.textContent = `${s.branch ?? '-'}${dirty}${rowModel ? ` · ${rowModel}` : ''}`; // provider moved to its logo column
  // Per-session context % on line 1 (next to the name), tinted as it nears compaction — with many
  // concurrent sessions this answers "which one is about to compact" at a glance (the header shows it
  // only for the selected one).
  const rowCtx = contextPercent(live.get(s.id)?.meta?.contextTokens ?? 0, windowFor(live.get(s.id)?.meta));
  const ctxCol = el.querySelector('.ck-ctx-col') as HTMLElement;
  if (rowCtx !== null) {
    ctxCol.textContent = `🧠${rowCtx}%`;
    ctxCol.className = `ck-ctx-col sev-${contextSeverity(rowCtx)}`;
    ctxCol.title = tr('cockpit.context');
  }
  // Line 3 = what this session is actually working on, refreshed every turn. This is what keeps a
  // long-running session readable without renaming it by hand; the row clips it to one line and the
  // tooltip carries the full text.
  const summary = live.get(s.id)?.meta?.summary ?? '';
  const sm = el.querySelector('.sm') as HTMLElement;
  if (summary) {
    sm.textContent = summary;
    sm.title = `${tr('cockpit.summary')}: ${summary}`;
  } else {
    sm.remove(); // nothing to say yet — don't reserve the line
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
      const target = cockpitNavigationIdForRuntime([...live.values()].map(navigationIdentity), l.session.id);
      if (target) cockpitNavigationCallback?.(target);
    };
  } catch { /* notifications unavailable (rare) — the tray dot still alerts */ }
}

/** Shared-shell row actions route to the same state mutations the old cockpit list row buttons used.
 *  A LIVE session resolves to its tile (pin / rename / close); a not-yet-restored entry resolves to
 *  the persisted record (pin / forget). Renaming a live session needs its editor on screen, so it
 *  brings the cockpit forward first — the same navigation an attention notification click performs. */
export function manageCockpitSessionAction(id: string, action: ShellSessionAction): void {
  const current = [...live.values()].find((entry) => navigationIdForLive(entry) === id || legacyCockpitNavigationId(navigationIdentity(entry)) === id);
  if (current) {
    const sid = current.session.id;
    if (action === 'close') { void requestClose(sid); return; }
    if (action === 'rename') { cockpitNavigationCallback?.(navigationIdForLive(current)); beginRename(sid); return; }
    if (current.pinned !== (action === 'pin')) togglePin(sid);
    return;
  }
  const entry = restorable.find((item) => cockpitNavigationId(item) === id || legacyCockpitNavigationId(item) === id);
  if (!entry) return;
  if (action === 'forget') { forgetSession(entry); return; }
  if (action === 'rename' || action === 'close') return; // no terminal to rename or close yet
  entry.pinned = action === 'pin' ? true : undefined;
  persist(); renderList();
}

export function restoreAllCockpitSessions(): void { void restoreAll(); }

function publishSessionSelection(liveSession: Live): void {
  const navigationId = navigationIdForLive(liveSession);
  for (const listener of sessionSelectionListeners) listener(navigationId);
}

function updateRailBadge(): void {
  const sessions = [...live.values()].map((l) => l.session);
  const attention = needsAttentionCount(sessions); // genuine agent questions only
  // In-app, attention is surfaced by the sidebar's own "needs you" group (and its collapsed pill) —
  // there is no separate cockpit rail item to badge since the shared shell replaced the icon rail.
  // Tray attention indicator: send both counts; the main process reddens the tray per the user's setting.
  const turn = sessions.filter((s) => s.activity === 'turn').length;
  window.devdeck.setTrayCounts({ attention, turn });
  // Idle-shutdown busy signal + record summary (only crosses IPC when the summary changes).
  reportShutdownActivity(
    sessions.filter((s) => s.activity === 'working').length,
    sessions.map((s) => ({ project: s.name, activity: s.activity })),
  );
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
  const title = document.createElement('span'); title.className = 'title';
  const fullName = liveLabels.get(s.id) ?? s.name;
  if (editingId === s.id) title.appendChild(renameInput(s.id, l.customLabel ?? s.name));
  else title.textContent = fullName;
  title.setAttribute('aria-label', fullName);
  title.title = tr('cockpit.rename');
  title.addEventListener('dblclick', () => beginRename(s.id)); // edits in the session's list row (single editor, survives re-render)
  const branch = document.createElement('span'); branch.className = 'ck-pill'; branch.textContent = `${s.branch ?? '-'}${s.dirty > 0 ? ` · ✎${s.dirty}` : ''}`;
  // Same mark component as the rows; the localized provider name rides along as alt/title, so identity
  // never depends on the logo's color alone.
  const ag = document.createElement('span'); ag.className = 'ck-pill ck-pill-provider';
  ag.append(createProviderLogo(s.agentId, 'ck-provider-logo sm'), providerName(s.agentId));
  const pills: HTMLElement[] = [title, branch, ag];
  const model = friendlyModel(l.meta?.model ?? null);
  if (model) { const mp = document.createElement('span'); mp.className = 'ck-pill'; mp.textContent = model; pills.push(mp); }
  const ctxPct = contextPercent(l.meta?.contextTokens ?? 0, windowFor(l.meta));
  if (ctxPct !== null) { const cp = document.createElement('span'); cp.className = 'ck-pill'; cp.append(createIcon('brain'), `${ctxPct}%`); cp.title = tr('cockpit.context'); pills.push(cp); }
  if (l.meta && l.meta.activeMs > 0) { const tp = document.createElement('span'); tp.className = 'ck-pill'; tp.append(createIcon('clock'), formatDuration(l.meta.activeMs)); pills.push(tp); }
  const sp = document.createElement('span'); sp.className = 'sp';
  const newSession = actBtn('plus', tr('cockpit.new_session'), () => void addSessionToCurrentProject());
  const pin = actBtn('pin', tr(l.pinned ? 'cockpit.unpin' : 'cockpit.pin'), () => togglePin(s.id));
  const rename = actBtn('edit', tr('cockpit.rename'), () => beginRename(s.id));
  const folder = actBtn('folder', tr('cockpit.open_folder'), () => {
    // The folder is on the machine running this terminal. Opening the local file manager at that path
    // would show either nothing or somebody else's work that happens to live there.
    const owner = live.get(s.id)?.machineId ?? LOCAL_MACHINE_ID;
    if (owner !== LOCAL_MACHINE_ID) { toast(tr('cockpit.remote_file_unavailable', { machine: machineName(owner) })); return; }
    void window.devdeck.openFolder(s.projectPath);
  });
  const restart = actBtn('restart', tr('cockpit.restart'), () => restartSession(s.id));
  const close = actBtn('close', tr('cockpit.close'), () => void requestClose(s.id));
  headerEl.append(...pills, sp, newSession, pin, rename, folder, restart, close);
}

/** "+ New session": spawn another, fresh conversation in the SAME project as the selected session. */
async function addSessionToCurrentProject(): Promise<void> {
  const l = selectedId ? live.get(selectedId) : null; if (!l) return;
  const s = l.session;
  await createSession({ path: s.projectPath, name: s.name, staleLevel: s.staleLevel, branch: s.branch, dirty: s.dirty, mode: 'new', agentId: s.agentId });
}

function actBtn(icon: IconName, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button'); b.className = 'ck-act'; b.appendChild(createIcon(icon)); b.title = title; b.setAttribute('aria-label', title); b.addEventListener('click', onClick); return b;
}

async function restartSession(id: string): Promise<void> {
  const l = live.get(id); if (!l) return;
  // Carry the user-given label + pin into the re-created session — ⟳ must not silently reset them.
  const p: OpenReq = { path: l.session.projectPath, name: l.session.name, staleLevel: l.session.staleLevel, branch: l.session.branch, dirty: l.session.dirty, mode: 'auto', label: l.customLabel, pinned: l.pinned, agentId: l.session.agentId };
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
    else { setActiveUsageProvider(null); renderAll(); mainEl.classList.toggle('has-session', false); } // no session → footer goes back to the cross-provider max
  } else renderList();
}

// Restores in flight, keyed by project + saved id. A "Previous" row stays clickable for as long as
// the PTY takes to spawn, so a second click would restore the SAME entry twice — once as a duplicate
// tile, and now that an unopenable conversation comes back fresh, as an empty one.
const restoring = new Set<string>();

/** Bring a previous session back to life via its resume command — under the SAME provider it was
 *  opened with, whatever the globally selected agent is now (a Claude conversation must never be
 *  handed to `codex`). Unrecognized legacy ids fall back to the active agent, as they always did. */
async function restoreSession(entry: PersistedSession): Promise<void> {
  const key = persistedSessionKey(entry);
  if (restoring.has(key)) return;
  restoring.add(key);
  restorable = restorable.filter((r) => r !== entry);
  try {
    const owner = toAgentId(entry.agentId) ?? await window.devdeck.getAgent();
    // Reopen the tile's OWN conversation, or — when it is gone from disk / already open elsewhere —
    // a FRESH one under the same name. Never a substitute: this tile carries the user's own label and
    // pin, and handing it someone else's conversation is what made a renamed tile come back showing
    // unrelated work (and silently ate the entry that really owned that conversation).
    const liveIds = new Set([...live.values()].map((l) => l.openedSessionId).filter((x): x is string => !!x));
    // Conversations the other not-yet-restored entries are waiting for — an id-less entry must not
    // take one of those out from under them.
    const reserved = new Set(restorable.map((r) => r.sessionId).filter((x): x is string => !!x));
    // A saved entry names a project by PATH, and the same path exists on both machines — so the
    // conversation list has to come from the machine the tile actually ran on. Reading it locally
    // would resolve the tile against unrelated work that happens to live at the same path.
    const machineId = entry.machineId ?? LOCAL_MACHINE_ID;
    if (machineId !== LOCAL_MACHINE_ID && machineState(machineId) !== 'connected') {
      // Its machine is not reachable. Leave the entry saved and say so, rather than opening a local
      // terminal in a path that means something different here.
      toast(tr('cockpit.restore_machine_offline', { name: entry.label || entry.name, machine: machineName(machineId) }));
      throw new Error('machine offline');
    }
    let ids: string[] = [];
    try { ids = await deckFor(machineId).cockpit.sessionIds(entry.projectPath, owner); } catch { ids = []; }
    const target = resolveRestoreTarget(entry, ids, liveIds, reserved);
    const ok = await createSession({ path: entry.projectPath, name: entry.name, staleLevel: 'neutral', branch: null, dirty: 0, tileId: entry.tileId, sessionId: target.sessionId, mode: target.fresh ? 'new' : 'auto', label: entry.label ?? null, pinned: entry.pinned, agentId: owner, machineId });
    if (ok) {
      // Say why the tile is empty — whether its conversation was deleted or was never recorded.
      // Silence here would read as "my session lost its history".
      if (target.fresh) toast(tr('cockpit.restore_gone', { name: entry.label || entry.name }));
      return;
    }
  } catch { /* fall through to re-list the entry */ } finally {
    restoring.delete(key);
  }
  // A failed restore must NOT silently drop the entry (it was removed above so a success doesn't
  // duplicate) — put it back so the user can retry, and persist so a quit doesn't lose it either.
  restorable = [entry, ...restorable];
  persist(); renderList();
}

/** Set a live session's custom name (empty → revert to the auto label); persist so it survives restart. */
function renameSession(id: string, label: string): void {
  const l = live.get(id); if (!l) return;
  l.customLabel = label.trim() || null;
  noteLabelOnOwner(id, l.customLabel);
  persist(); renderList(); renderHeader();
}

/**
 * Carry a session's name to the machine that RUNS it.
 *
 * The name is what tells two sessions on one repository apart, so a deck that only knows its own
 * renames shows a remote machine's sessions as several identical folder-name rows. The owning machine
 * keeps the name with the session, and hands it to every deck that asks what it is running — including
 * this one after a restart. Fire-and-forget: a name is worth nothing to block a rename on.
 */
function noteLabelOnOwner(id: string, label: string | null): void {
  try { window.devdeck.cockpit.noteLabel(id, label); } catch { /* older main process, or no pty host */ }
}

// Editing is RENDER STATE (editingId), not a mutated DOM node: a list rebuild (e.g. row click → select)
// would otherwise orphan a captured <input> and the editor would silently never appear.
function beginRename(id: string): void { editingId = id; renderList(); renderHeader(); }
function cancelRename(): void { editingId = null; renderList(); renderHeader(); }
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
