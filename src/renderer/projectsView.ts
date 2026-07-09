import { tr, localeTag } from './i18n-runtime';
import { shouldAutoRefresh } from '../shared/autoRefresh';
import { projectSignature, diffCards, type SignatureUiState } from '../shared/deckReconcile';
import { openNewProjectModal } from './newProjectModal';
import { type OpenReq, liveProjectActivity } from './cockpitView';
import { openInTerminal } from './openRouter';
import { presetBoardProject } from './nextView';
import { taskCounts } from '../shared/tasks';
import { renderLoadError } from './loadError';

const AUTO_REFRESH_MS = 45_000;

type ProjectViewModel = Awaited<ReturnType<Window['devdeck']['listProjects']>>[number];

const selected = new Set<string>();
const expanded = new Set<string>();
let projects: ProjectViewModel[] = [];
let agentLabel = 'claude';
let showHidden = false;
// Per-project estimated cost, filled asynchronously after the list renders so a
// (potentially slow) full token scan never blocks the project list.
const costByPath = new Map<string, number | null>();
let lastLoadMs = 0;
// Path-keyed cache of rendered card/row nodes. Background refreshes reconcile against this
// (see shared/deckReconcile) so the deck reuses the exact DOM node for any project whose
// displayed values are unchanged — no flicker, scroll/focus/hover preserved — and only
// rebuilds the cards that actually changed.
const cardCache = new Map<string, { el: HTMLElement; sig: string }>();
let hasRenderedOnce = false;

type SortMode = 'activity' | 'uncommitted' | 'name' | 'opened';
let searchQuery = '';
let sortMode: SortMode = 'activity';
let viewMode: 'cards' | 'list' = 'cards';

let cardsEl: HTMLElement;
let neglectedOnly: HTMLInputElement;
let showHiddenBtn: HTMLButtonElement;
let hiddenCountEl: HTMLElement;
let openBtn: HTMLButtonElement;
let searchEl: HTMLInputElement | null = null;
let sortEl: HTMLSelectElement | null = null;
let viewCardsBtn: HTMLButtonElement | null = null;
let viewListBtn: HTMLButtonElement | null = null;

function fmtTime(ms: number | null): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString(localeTag(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function usdShort(n: number | null | undefined): string { return n == null ? '' : ` · ~$${n.toFixed(2)}`; }
function isNoRecord(p: ProjectViewModel): boolean { return p.sessionCount === 0 && p.lastCommitMs == null; }

/** Compact task badge for a card/row (`☑ done/total · 🔴overdue`); null when the project has no tasks.
 *  Click jumps to the Next task board. */
function taskBadge(p: ProjectViewModel): HTMLElement | null {
  if (!p.todos.length) return null;
  const c = taskCounts(p.todos, Date.now());
  const b = document.createElement('button');
  b.className = 'task-badge' + (c.overdue ? ' has-overdue' : '');
  b.textContent = `☑ ${c.done}/${c.total}` + (c.overdue ? ` · 🔴${c.overdue}` : '');
  b.title = tr('tasks.badge_tip').replace('{done}', String(c.done)).replace('{total}', String(c.total)).replace('{overdue}', String(c.overdue));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    presetBoardProject(p.path); // land on the board already narrowed to this project
    document.querySelector<HTMLButtonElement>('.rail-item[data-view="next"]')?.click();
  });
  return b;
}
function toOpenReq(p: ProjectViewModel, sessionId: string | null = null): OpenReq {
  return { path: p.path, name: p.name, staleLevel: p.stale.level, branch: p.branch, dirty: p.uncommitted, sessionId };
}


const LEVEL_EMOJI: Record<string, string> = { fresh: '🟢', neutral: '⚪', warn: '🟡', neglected: '🔴' };
function badgeText(p: ProjectViewModel): string {
  if (isNoRecord(p) || p.stale.ageDays == null) return tr('proj.no_record');
  const age = p.stale.ageDays < 1 ? tr('badge.today') : tr('badge.days', { n: p.stale.ageDays });
  return `${LEVEL_EMOJI[p.stale.level] ?? ''} ${age}`;
}

function truncateCue(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

// `suppressCue`: the card already shows the resume cue up top in its own `.card-cue`
// element (see makeCard) — when true, fall back to the plain ghost here instead of
// repeating the same cue text a second time. Defaults to false so callers that don't
// render `.card-cue` (list view has none) keep the original ghost-cue behavior.
function makeNote(p: ProjectViewModel, suppressCue = false): HTMLElement {
  const wrap = document.createElement('div');
  const showRead = () => {
    wrap.replaceChildren();
    const el = document.createElement('div');
    if (p.note) {
      el.className = 'note-preview'; el.textContent = p.note;
      el.addEventListener('click', () => showEdit());
    } else if (p.resumeCue && !suppressCue) {
      const cueText = p.resumeCue.text;
      el.className = 'note-ghost has-cue';
      el.textContent = `↩ ${tr('proj.resume_prefix')}: ${truncateCue(cueText)}`;
      el.title = cueText;
      el.addEventListener('click', () => showEdit(cueText));
    } else {
      el.className = 'note-ghost'; el.textContent = tr('proj.next_todo');
      el.addEventListener('click', () => showEdit());
    }
    wrap.appendChild(el);
  };
  const showEdit = (prefill?: string) => {
    const original = p.note;
    wrap.replaceChildren();
    const ta = document.createElement('textarea');
    ta.className = 'note-edit'; ta.rows = 2; ta.value = prefill ?? p.note; ta.placeholder = tr('proj.next_todo_ph');
    let cancelling = false;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        cancelling = true;
        p.note = original;
        ta.blur();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        ta.blur();
      }
    });
    ta.addEventListener('blur', () => {
      if (!cancelling && ta.value !== p.note) { p.note = ta.value; window.devdeck.setNote(p.path, ta.value); }
      showRead();
    });
    wrap.appendChild(ta); ta.focus();
  };
  showRead();
  return wrap;
}

// The card's headline affordance: "what to pick back up." Prefers the harvested resume
// cue, falls back to the most recent session's first message, and renders nothing at all
// when neither exists (an empty `.card-cue` would just be dead space above the git line).
function cardCueText(p: ProjectViewModel): string | null {
  return p.resumeCue?.text ?? p.sessions[0]?.firstMessage ?? null;
}
function makeCue(p: ProjectViewModel): HTMLElement | null {
  const text = cardCueText(p);
  if (!text) return null;
  const el = document.createElement('div'); el.className = 'card-cue';
  el.textContent = text;
  el.title = text;
  return el;
}

function makeSessions(p: ProjectViewModel, render: () => void): HTMLElement {
  const wrap = document.createElement('div'); wrap.className = 'sessions';
  const head = document.createElement('div');
  head.className = 'sessions-head' + (expanded.has(p.path) ? ' open' : '');
  const label = document.createElement('span');
  label.textContent = `${agentLabel} ${fmtTime(p.lastSessionMs)}${p.sessionCount ? ` · ${p.sessionCount} ${tr('proj.sessions')}` : ''}${usdShort(costByPath.get(p.path))}`;
  head.appendChild(label);
  if (p.sessionCount > 1) {
    const caret = document.createElement('span'); caret.className = 'caret'; caret.textContent = '⌄';
    head.appendChild(caret);
    head.addEventListener('click', () => { expanded.has(p.path) ? expanded.delete(p.path) : expanded.add(p.path); render(); });
  }
  wrap.appendChild(head);
  if (expanded.has(p.path)) {
    const latest = p.sessions[0];
    if (latest?.firstMessage) {
      const prev = document.createElement('div'); prev.className = 'preview'; prev.textContent = `↳ ${latest.firstMessage}`;
      wrap.appendChild(prev);
    }
    if (p.sessionCount > 1) {
      const list = document.createElement('div'); list.className = 'session-list'; list.setAttribute('role', 'list');
      for (const s of p.sessions) {
        const row = document.createElement('div'); row.className = 'session-row'; row.setAttribute('role', 'listitem');
        const when = document.createElement('span'); when.className = 'when'; when.textContent = fmtTime(s.mtimeMs);
        const msg = document.createElement('span'); msg.className = 'msg'; msg.textContent = s.firstMessage ?? tr('proj.no_message');
        const open = document.createElement('button'); open.className = 'chip'; open.textContent = tr('proj.open'); open.setAttribute('aria-label', 'open session');
        open.addEventListener('click', () => openInTerminal([toOpenReq(p, s.id)]));
        row.append(when, msg, open); list.appendChild(row);
      }
      wrap.appendChild(list);
    }
  }
  return wrap;
}

// The GitHub "mark" (octocat) as an inline SVG so it inherits the icon button color.
function octocatIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '14'); svg.setAttribute('height', '14'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z');
  svg.appendChild(path);
  return svg;
}

// Octocat icon button shown only when the project has a github.com remote; opens the
// repo page. Passes the path (not a URL) so main re-derives + validates the URL.
function githubBtn(p: ProjectViewModel): HTMLButtonElement {
  const b = document.createElement('button'); b.className = 'iconbtn gh-btn';
  b.appendChild(octocatIcon());
  b.title = `GitHub: ${p.repoUrl!.replace('https://github.com/', '')}`;
  b.setAttribute('aria-label', tr('proj.open_github'));
  b.addEventListener('click', (e) => { e.stopPropagation(); window.devdeck.openRepo(p.path); });
  return b;
}

// Pin/hide "⋯" menu, shared by card and list-row so the management actions match.
function makeMenuWrap(p: ProjectViewModel): HTMLElement {
  const menuWrap = document.createElement('div'); menuWrap.className = 'menu-wrap';
  const menuBtn = document.createElement('button');
  menuBtn.className = 'iconbtn'; menuBtn.textContent = '⋯';
  menuBtn.setAttribute('aria-label', 'more options');
  menuBtn.setAttribute('aria-haspopup', 'menu');
  menuBtn.setAttribute('aria-expanded', 'false');

  const menu = document.createElement('div');
  menu.className = 'menu hidden'; menu.setAttribute('role', 'menu');

  const pinItem = document.createElement('button');
  pinItem.className = 'menu-item'; pinItem.setAttribute('role', 'menuitem');
  pinItem.textContent = p.pinned ? tr('proj.unpin') : tr('proj.pin');
  pinItem.addEventListener('click', () => { window.devdeck.setPinned(p.path, !p.pinned); reload(); });

  const hideItem = document.createElement('button');
  hideItem.className = 'menu-item'; hideItem.setAttribute('role', 'menuitem');
  hideItem.textContent = tr('proj.hide');
  hideItem.addEventListener('click', () => { window.devdeck.setHidden(p.path, true); reload(); });

  menu.append(pinItem, hideItem);

  const openMenu = (): void => { menu.classList.remove('hidden'); menuBtn.setAttribute('aria-expanded', 'true'); pinItem.focus(); };
  const closeMenu = (): void => { menu.classList.add('hidden'); menuBtn.setAttribute('aria-expanded', 'false'); };
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) openMenu();
    else { closeMenu(); menuBtn.focus(); }
  });
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); menuBtn.focus(); } });

  menuWrap.append(menuBtn, menu);
  return menuWrap;
}

function makeCard(p: ProjectViewModel, render: () => void, live: '' | 'attention' | 'working' = ''): HTMLElement {
  const card = document.createElement('div');
  const noRecord = isNoRecord(p);
  const liveCls = live === 'attention' ? ' live-attention' : live === 'working' ? ' live-working' : '';
  card.className = 'card lvl-' + p.stale.level + (noRecord ? ' norecord' : '') + (selected.has(p.path) ? ' selected' : '') + liveCls;
  card.setAttribute('role', 'listitem');

  const headRow = document.createElement('div'); headRow.className = 'card-head';
  const title = document.createElement('span'); title.className = 'card-title'; title.textContent = p.name; title.title = p.name;
  const badge = document.createElement('span');
  // Live cockpit status (attention/working) takes over the badge while a session is open;
  // otherwise it falls back to the usual staleness badge (fresh/warn/neglected/no-record).
  badge.className = 'badge ' + (liveCls ? liveCls.trim() : (noRecord ? 'norecord' : 'lvl-' + p.stale.level));
  badge.textContent = live === 'attention' ? tr('deck.badge_attn') : live === 'working' ? tr('deck.badge_work') : badgeText(p);

  const menuWrap = makeMenuWrap(p);

  headRow.append(title, badge, menuWrap);

  // Resume cue leads the card: "what to pick back up," ahead of git/session chrome.
  const cue = makeCue(p);

  const gitLine = document.createElement('div'); gitLine.className = 'card-git';
  const branch = document.createElement('span'); branch.className = 'branch'; branch.textContent = p.branch ?? tr('proj.no_branch');
  gitLine.appendChild(branch);
  if (p.uncommitted > 0) {
    const dirty = document.createElement('span'); dirty.className = 'dirty' + (p.stale.level === 'neglected' ? ' alarm' : '');
    dirty.textContent = ` · ✎${p.uncommitted}`; gitLine.appendChild(dirty);
  }
  if (p.ahead && p.ahead > 0) {
    const ahead = document.createElement('span'); ahead.className = 'ahead';
    ahead.textContent = ` · ↑${p.ahead}`;
    ahead.title = tr('proj.unpushed', { n: p.ahead });
    gitLine.appendChild(ahead);
  }
  const commitSpan = document.createElement('span');
  const subjectText = p.lastSubject ? `"${p.lastSubject}"` : tr('proj.no_commits');
  commitSpan.textContent = ` · ${fmtTime(p.lastCommitMs)} ${subjectText}`;
  if (p.lastSubject) commitSpan.title = p.lastSubject;
  gitLine.appendChild(commitSpan);

  const foot = document.createElement('div'); foot.className = 'cardfoot';
  const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selected.has(p.path); check.setAttribute('aria-label', 'select');
  check.addEventListener('change', () => {
    check.checked ? selected.add(p.path) : selected.delete(p.path);
    card.classList.toggle('selected', check.checked);
    syncOpenBtn();
  });
  const spacer = document.createElement('span'); spacer.className = 'spacer';
  const editorBtn = document.createElement('button'); editorBtn.className = 'iconbtn';
  editorBtn.textContent = '{ }'; editorBtn.title = tr('proj.open_editor');
  editorBtn.setAttribute('aria-label', tr('proj.open_editor'));
  editorBtn.addEventListener('click', () => window.devdeck.openEditor(p.path));
  const folderBtn = document.createElement('button'); folderBtn.className = 'iconbtn';
  folderBtn.textContent = '📁'; folderBtn.title = tr('proj.open_folder');
  folderBtn.setAttribute('aria-label', tr('proj.open_folder'));
  folderBtn.addEventListener('click', () => window.devdeck.openFolder(p.path));
  // Compact glance strip near the primary action: session count · last activity · est. cost.
  const footMeta = document.createElement('span'); footMeta.className = 'foot-meta';
  const footBits: string[] = [];
  if (p.sessionCount) footBits.push(`${p.sessionCount} ${tr('proj.sessions')}`);
  footBits.push(fmtTime(p.lastSessionMs));
  const cost = costByPath.get(p.path);
  if (cost != null) footBits.push(`~$${cost.toFixed(2)}`);
  footMeta.textContent = footBits.join(' · ');
  const open = document.createElement('button'); open.className = 'primary'; open.textContent = '▶ ' + tr('proj.open');
  open.addEventListener('click', () => openInTerminal([toOpenReq(p)]));
  foot.append(check);
  const tb = taskBadge(p);
  if (tb) foot.append(tb);
  foot.append(spacer, editorBtn, folderBtn);
  if (p.repoUrl) foot.append(githubBtn(p));
  foot.append(footMeta, open);

  card.append(headRow);
  if (cue) card.append(cue);
  card.append(gitLine, makeSessions(p, render), makeNote(p, !!p.resumeCue), foot);
  return card;
}

// One dense line per project for the "list" view — name + git state + last activity
// + GitHub + open + the shared ⋯ menu, tuned for scanning many projects fast.
function makeRow(p: ProjectViewModel): HTMLElement {
  const row = document.createElement('div');
  const noRecord = isNoRecord(p);
  row.className = 'prow lvl-' + p.stale.level + (noRecord ? ' norecord' : '') + (selected.has(p.path) ? ' selected' : '');
  row.setAttribute('role', 'listitem');

  const check = document.createElement('input'); check.type = 'checkbox'; check.className = 'prow-check'; check.checked = selected.has(p.path); check.setAttribute('aria-label', 'select');
  check.addEventListener('change', () => {
    check.checked ? selected.add(p.path) : selected.delete(p.path);
    row.classList.toggle('selected', check.checked);
    syncOpenBtn();
  });

  const dot = document.createElement('span'); dot.className = 'prow-dot'; dot.textContent = LEVEL_EMOJI[p.stale.level] ?? '';
  const name = document.createElement('span'); name.className = 'prow-name'; name.textContent = p.name; name.title = p.name;

  const meta = document.createElement('span'); meta.className = 'prow-meta';
  let metaText = p.branch ?? tr('proj.no_branch');
  if (p.uncommitted > 0) metaText += ` · ✎${p.uncommitted}`;
  if (p.ahead && p.ahead > 0) metaText += ` · ↑${p.ahead}`;
  meta.textContent = metaText;

  const time = document.createElement('span'); time.className = 'prow-time'; time.textContent = fmtTime(p.activityMs);

  const open = document.createElement('button'); open.className = 'iconbtn prow-open'; open.textContent = '▶'; open.title = tr('proj.open'); open.setAttribute('aria-label', tr('proj.open'));
  open.addEventListener('click', () => openInTerminal([toOpenReq(p)]));

  row.append(check, dot, name, meta, time);
  const tb = taskBadge(p);
  if (tb) row.append(tb);
  if (p.repoUrl) row.append(githubBtn(p));
  row.append(open, makeMenuWrap(p));
  return row;
}

function syncOpenBtn(): void { openBtn.disabled = selected.size === 0; }
function syncViewToggle(): void {
  viewCardsBtn?.classList.toggle('active', viewMode === 'cards');
  viewListBtn?.classList.toggle('active', viewMode === 'list');
}
function setView(mode: 'cards' | 'list'): void {
  if (viewMode === mode) return;
  viewMode = mode;
  void window.devdeck.setViewMode(mode);
  syncViewToggle();
  cardCache.clear(); // cards and rows are different element types — rebuild for the new view
  render();
}

function render(): void {
  hiddenCountEl.textContent = String(projects.filter((p) => p.hidden).length);
  showHiddenBtn.classList.toggle('active', showHidden);
  // Computed once per render: drives the card status stripe/badge, the activity-sort
  // priority below, and the reconcile signature (so a live status flip forces a rebuild).
  const act = liveProjectActivity();
  let visible = showHidden ? projects.filter((p) => p.hidden) : projects.filter((p) => !p.hidden);
  if (neglectedOnly.checked) visible = visible.filter((p) => p.stale.level === 'neglected');

  // Search filter (case-insensitive substring match on name, branch, note)
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    visible = visible.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      (p.branch ?? '').toLowerCase().includes(q) ||
      p.note.toLowerCase().includes(q),
    );
  }

  // Sort
  const sorted = [...visible];
  if (sortMode === 'activity') {
    // already sorted by main process (pinned first, then activityMs desc); preserve
    // pinned-first only for activity sort
    sorted.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      // A project mid-attention (waiting on you in the cockpit) jumps ahead of quieter ones.
      const aa = act.get(a.path) === 'attention' ? 0 : 1;
      const bb = act.get(b.path) === 'attention' ? 0 : 1;
      if (aa !== bb) return aa - bb;
      return (b.activityMs ?? -Infinity) - (a.activityMs ?? -Infinity);
    });
  } else if (sortMode === 'uncommitted') {
    sorted.sort((a, b) => b.uncommitted - a.uncommitted);
  } else if (sortMode === 'name') {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sortMode === 'opened') {
    sorted.sort((a, b) => {
      const ta = a.lastOpened ? new Date(a.lastOpened).getTime() : -Infinity;
      const tb = b.lastOpened ? new Date(b.lastOpened).getTime() : -Infinity;
      return tb - ta;
    });
  }
  visible = sorted;

  cardsEl.classList.toggle('as-list', viewMode === 'list');
  // role=list only when there ARE listitems: an empty deck (message + hint, no items) with a list
  // role violates aria-required-children (axe critical — caught by the CI audit's empty profile).
  if (visible.length === 0) cardsEl.removeAttribute('role');
  else cardsEl.setAttribute('role', 'list');
  if (visible.length === 0) {
    cardCache.clear();
    cardsEl.replaceChildren();
    const e = document.createElement('div'); e.className = 'empty';
    e.textContent = neglectedOnly.checked ? tr('proj.empty_neglected') : (showHidden ? tr('proj.empty_hidden') : tr('proj.empty_none'));
    cardsEl.appendChild(e);
    if (!showHidden && !neglectedOnly.checked && projects.length === 0) {
      const hint = document.createElement('button');
      hint.className = 'chip';
      hint.textContent = tr('proj.empty_hint');
      hint.addEventListener('click', () => {
        document.querySelector<HTMLElement>('.rail-item[data-view=settings]')?.click();
      });
      cardsEl.appendChild(hint);
    }
    return;
  }

  // In-place reconcile: reuse the DOM node of every project whose displayed values are
  // unchanged, rebuild only changed/new cards, drop removed ones, and move nodes to match
  // order. This keeps the always-open deck from flickering on the periodic refresh.
  const desired = visible.map((p) => ({ key: p.path, sig: projectSignature(p, uiStateFor(p, act)) }));
  const prevSigs = new Map<string, string>();
  for (const [key, entry] of cardCache) prevSigs.set(key, entry.sig);
  const { reuse, remove } = diffCards(prevSigs, desired);

  const orderedEls: HTMLElement[] = [];
  visible.forEach((p, i) => {
    const cached = cardCache.get(p.path);
    // Reuse the existing node when nothing visible changed, or when the user is mid-interaction
    // inside this card (e.g. editing a note) — never yank focus out from under them.
    if (cached && (reuse.has(p.path) || cached.el.contains(document.activeElement))) {
      orderedEls.push(cached.el);
      return;
    }
    const el = viewMode === 'list' ? makeRow(p) : makeCard(p, render, act.get(p.path) ?? '');
    if (showHidden) {
      const restore = document.createElement('button'); restore.className = 'chip'; restore.textContent = tr('proj.restore');
      restore.addEventListener('click', () => { window.devdeck.setHidden(p.path, false); reload(); });
      el.appendChild(restore);
    }
    cardCache.set(p.path, { el, sig: desired[i].sig });
    orderedEls.push(el);
  });
  for (const key of remove) cardCache.delete(key);

  reconcileChildren(cardsEl, orderedEls);
}

function uiStateFor(p: ProjectViewModel, act: Map<string, 'attention' | 'working'>): SignatureUiState {
  return { expanded: expanded.has(p.path), cost: costByPath.get(p.path), showHidden, viewMode, live: act.get(p.path) ?? '' };
}

// Make `container`'s children exactly `ordered`, in order, touching only what is out of
// place: drop any stray child (first-load skeletons, removed cards), then insert/move the
// nodes that aren't already at their target index. Nodes already in place are never
// detached, so unchanged cards don't flicker and keep scroll/focus/hover.
function reconcileChildren(container: HTMLElement, ordered: HTMLElement[]): void {
  const keep = new Set<HTMLElement>(ordered);
  for (const child of Array.from(container.children)) {
    if (!keep.has(child as HTMLElement)) child.remove();
  }
  ordered.forEach((el, i) => {
    if (container.children[i] !== el) container.insertBefore(el, container.children[i] ?? null);
  });
}

function showSkeleton(): void {
  cardsEl.replaceChildren();
  for (let i = 0; i < 6; i++) { const s = document.createElement('div'); s.className = 'skeleton'; cardsEl.appendChild(s); }
}

// Toolbar summary: live cockpit status counts (attention/working) + today's est. cost.
// Purely additive — never blocks reload() and degrades to omitting the cost span on failure.
function renderDeckPulse(todayCost: number | null): void {
  const el = document.getElementById('deck-pulse'); if (!el) return;
  const act = liveProjectActivity();
  const attn = [...act.values()].filter((v) => v === 'attention').length;
  const work = act.size - attn;
  el.replaceChildren();
  const span = (cls: string, text: string) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; el.appendChild(s); };
  if (attn > 0) span('p-attn', `⚠ ${attn}`);
  if (work > 0) span('p-work', `◉ ${work}`);
  if (todayCost != null) span('', `${tr('deck.today')} ~$${todayCost.toFixed(0)}`);
}

async function reload(): Promise<void> {
  lastLoadMs = Date.now();
  // Skeleton only on the very first load. Background/manual refreshes reconcile in place,
  // so they never wipe the deck to gray placeholders.
  if (!hasRenderedOnce) showSkeleton();
  let proj, agent, settings;
  try {
    [proj, agent, settings] = await Promise.all([
      window.devdeck.listProjects(), window.devdeck.getAgent(), window.devdeck.getSettings(),
    ]);
  } catch (e) {
    console.error('DevDeck: projects load failed', e);
    // First-load failure would otherwise leave the skeleton stuck forever → offer a retry. A later
    // background/focus refresh failing keeps the last good deck on screen (don't wipe it).
    if (!hasRenderedOnce) renderLoadError(cardsEl, () => void reload());
    return;
  }
  projects = proj; agentLabel = agent;
  viewMode = settings.viewMode === 'list' ? 'list' : 'cards';
  syncViewToggle();
  render();
  hasRenderedOnce = true;
  // Surface the cross-project overdue-task count in the tray tooltip (partial update: the
  // cockpit owns attention/turn on the same channel).
  const overdue = projects.reduce((n, p) => n + taskCounts(p.todos, Date.now()).overdue, 0);
  window.devdeck.setTrayCounts({ overdue });
  // Fill in per-project cost in the background (all-time; sinceMs=0 = since epoch), then
  // the toolbar pulse summary (live status counts + today's cost). Both best-effort: any
  // failure in this chain falls back to a status-only pulse rather than blocking reload().
  void window.devdeck.usageReport(0).then(async (r) => {
    for (const pu of r.byProject) costByPath.set(pu.path, pu.costEstimate);
    render();
    const t0 = new Date();
    t0.setUTCHours(0, 0, 0, 0);
    const today = await window.devdeck.usageReport(t0.getTime());
    renderDeckPulse(today.globalCost);
  }).catch(() => { renderDeckPulse(null); /* cost is best-effort; ignore failures */ });
}

// External triggers (agent switch, settings change) should rebuild from scratch: the agent
// label and locale-baked card text aren't in the signature, so drop the cache to force it.
export function reloadProjects(): void { cardCache.clear(); reload(); }

function applyProjectLabels(): void {
  if (!searchEl || !sortEl) return;
  searchEl.placeholder = tr('proj.search_ph');
  searchEl.setAttribute('aria-label', tr('proj.search_ph'));
  sortEl.setAttribute('aria-label', tr('proj.sort'));
  sortEl.options[0].text = tr('proj.sort_activity');
  sortEl.options[1].text = tr('proj.sort_uncommitted');
  sortEl.options[2].text = tr('proj.sort_name');
  sortEl.options[3].text = tr('proj.sort_opened');
  if (viewCardsBtn) { viewCardsBtn.title = tr('proj.view_cards'); viewCardsBtn.setAttribute('aria-label', tr('proj.view_cards')); }
  if (viewListBtn) { viewListBtn.title = tr('proj.view_list'); viewListBtn.setAttribute('aria-label', tr('proj.view_list')); }
}

export function mountProjects(): void {
  cardsEl = document.getElementById('cards')!;
  neglectedOnly = document.getElementById('neglected-only') as HTMLInputElement;
  showHiddenBtn = document.getElementById('show-hidden') as HTMLButtonElement;
  hiddenCountEl = document.getElementById('hidden-count')!;
  openBtn = document.getElementById('open-selected') as HTMLButtonElement;
  searchEl = document.getElementById('proj-search') as HTMLInputElement;
  sortEl = document.getElementById('proj-sort') as HTMLSelectElement;
  viewCardsBtn = document.getElementById('view-cards') as HTMLButtonElement;
  viewListBtn = document.getElementById('view-list') as HTMLButtonElement;

  document.getElementById('refresh')!.addEventListener('click', reload);
  viewCardsBtn.addEventListener('click', () => setView('cards'));
  viewListBtn.addEventListener('click', () => setView('list'));
  neglectedOnly.addEventListener('change', render);
  showHiddenBtn.addEventListener('click', () => { showHidden = !showHidden; render(); });
  openBtn.addEventListener('click', () => {
    if (selected.size === 0) return;
    openInTerminal(projects.filter((p) => selected.has(p.path)).map((p) => toOpenReq(p)));
  });
  document.getElementById('new-project')!.addEventListener('click', () => {
    openNewProjectModal((path) => {
      openInTerminal([{ path, name: path.split(/[\\/]/).pop() ?? path, staleLevel: 'neutral', branch: null, dirty: 0 }]); // open the new project (cockpit on Windows, external terminal otherwise)
      reload();
    });
  });
  searchEl.addEventListener('input', () => { searchQuery = searchEl!.value; render(); });
  sortEl.addEventListener('change', () => { sortMode = sortEl!.value as SortMode; render(); });
  window.addEventListener('focus', () => {
    if (document.getElementById('view-projects')!.classList.contains('active') && Date.now() - lastLoadMs > 10_000) reload();
  });
  // Keep the always-open deck live: periodically re-scan while it is the focused, active view.
  setInterval(() => {
    if (shouldAutoRefresh({
      now: Date.now(),
      lastLoadMs,
      intervalMs: AUTO_REFRESH_MS,
      viewActive: document.getElementById('view-projects')!.classList.contains('active'),
      windowFocused: document.hasFocus(),
    })) reload();
  }, 15_000);
  document.addEventListener('click', () => {
    document.querySelectorAll('.menu:not(.hidden)').forEach((m) => {
      m.classList.add('hidden');
      const trigger = m.previousElementSibling as HTMLButtonElement | null;
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    });
  });
  applyProjectLabels();
  reload();
}

export function renderProjects(): void {
  applyProjectLabels();
  cardCache.clear(); // locale changed — card text is baked at build time, so rebuild every card
  render();
}
