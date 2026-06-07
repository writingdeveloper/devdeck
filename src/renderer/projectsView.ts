import { tr, localeTag } from './i18n-runtime';
import { shouldAutoRefresh } from '../shared/autoRefresh';

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

type SortMode = 'activity' | 'uncommitted' | 'name' | 'opened';
let searchQuery = '';
let sortMode: SortMode = 'activity';

let cardsEl: HTMLElement;
let neglectedOnly: HTMLInputElement;
let showHiddenBtn: HTMLButtonElement;
let hiddenCountEl: HTMLElement;
let openBtn: HTMLButtonElement;
let searchEl: HTMLInputElement | null = null;
let sortEl: HTMLSelectElement | null = null;

function fmtTime(ms: number | null): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString(localeTag(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function usdShort(n: number | null | undefined): string { return n == null ? '' : ` · ~$${n.toFixed(2)}`; }
function isNoRecord(p: ProjectViewModel): boolean { return p.sessionCount === 0 && p.lastCommitMs == null; }
function openItems(items: { path: string; sessionId: string | null }[]): void { window.devdeck.open(items); }

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

function makeNote(p: ProjectViewModel): HTMLElement {
  const wrap = document.createElement('div');
  const showRead = () => {
    wrap.replaceChildren();
    const el = document.createElement('div');
    if (p.note) {
      el.className = 'note-preview'; el.textContent = p.note;
      el.addEventListener('click', () => showEdit());
    } else if (p.resumeCue) {
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
        open.addEventListener('click', () => openItems([{ path: p.path, sessionId: s.id }]));
        row.append(when, msg, open); list.appendChild(row);
      }
      wrap.appendChild(list);
    }
  }
  return wrap;
}

function makeCard(p: ProjectViewModel, render: () => void): HTMLElement {
  const card = document.createElement('div');
  const noRecord = isNoRecord(p);
  card.className = 'card lvl-' + p.stale.level + (noRecord ? ' norecord' : '') + (selected.has(p.path) ? ' selected' : '');
  card.setAttribute('role', 'listitem');

  const headRow = document.createElement('div'); headRow.className = 'card-head';
  const title = document.createElement('span'); title.className = 'card-title'; title.textContent = p.name; title.title = p.name;
  const badge = document.createElement('span');
  badge.className = 'badge ' + (noRecord ? 'norecord' : 'lvl-' + p.stale.level);
  badge.textContent = badgeText(p);

  const menuWrap = document.createElement('div'); menuWrap.className = 'menu-wrap';
  const menuBtn = document.createElement('button');
  menuBtn.className = 'iconbtn';
  menuBtn.textContent = '⋯';
  menuBtn.setAttribute('aria-label', 'more options');
  menuBtn.setAttribute('aria-haspopup', 'menu');
  menuBtn.setAttribute('aria-expanded', 'false');

  const menu = document.createElement('div');
  menu.className = 'menu hidden';
  menu.setAttribute('role', 'menu');

  const pinItem = document.createElement('button');
  pinItem.className = 'menu-item';
  pinItem.setAttribute('role', 'menuitem');
  pinItem.textContent = p.pinned ? tr('proj.unpin') : tr('proj.pin');
  pinItem.addEventListener('click', () => { window.devdeck.setPinned(p.path, !p.pinned); reload(); });

  const hideItem = document.createElement('button');
  hideItem.className = 'menu-item';
  hideItem.setAttribute('role', 'menuitem');
  hideItem.textContent = tr('proj.hide');
  hideItem.addEventListener('click', () => { window.devdeck.setHidden(p.path, true); reload(); });

  menu.append(pinItem, hideItem);

  const openMenu = (): void => {
    menu.classList.remove('hidden');
    menuBtn.setAttribute('aria-expanded', 'true');
    pinItem.focus();
  };
  const closeMenu = (): void => {
    menu.classList.add('hidden');
    menuBtn.setAttribute('aria-expanded', 'false');
  };

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) openMenu();
    else { closeMenu(); menuBtn.focus(); }
  });

  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeMenu(); menuBtn.focus(); }
  });

  menuWrap.append(menuBtn, menu);

  headRow.append(title, badge, menuWrap);

  const meta = document.createElement('div'); meta.className = 'meta';
  const branch = document.createElement('span'); branch.className = 'branch'; branch.textContent = p.branch ?? tr('proj.no_branch');
  meta.appendChild(branch);
  if (p.uncommitted > 0) {
    const dirty = document.createElement('span'); dirty.className = 'dirty' + (p.stale.level === 'neglected' ? ' alarm' : '');
    dirty.textContent = ` · ✎${p.uncommitted}`; meta.appendChild(dirty);
  }
  if (p.ahead && p.ahead > 0) {
    const ahead = document.createElement('span'); ahead.className = 'ahead';
    ahead.textContent = ` · ↑${p.ahead}`;
    ahead.title = tr('proj.unpushed', { n: p.ahead });
    meta.appendChild(ahead);
  }
  meta.appendChild(document.createElement('br'));
  const commitLine = document.createElement('span');
  const subjectText = p.lastSubject ? `"${p.lastSubject}"` : tr('proj.no_commits');
  commitLine.textContent = `git ${fmtTime(p.lastCommitMs)} ${subjectText}`;
  if (p.lastSubject) commitLine.title = p.lastSubject;
  meta.appendChild(commitLine);

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
  const open = document.createElement('button'); open.className = 'primary'; open.textContent = '▶ ' + tr('proj.open');
  open.addEventListener('click', () => openItems([{ path: p.path, sessionId: null }]));
  foot.append(check, spacer, editorBtn, folderBtn, open);

  card.append(headRow, meta, makeSessions(p, render), makeNote(p), foot);
  return card;
}

function syncOpenBtn(): void { openBtn.disabled = selected.size === 0; }

function render(): void {
  hiddenCountEl.textContent = String(projects.filter((p) => p.hidden).length);
  showHiddenBtn.classList.toggle('active', showHidden);
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

  cardsEl.replaceChildren();
  cardsEl.setAttribute('role', 'list');
  if (visible.length === 0) {
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
  for (const p of visible) {
    if (showHidden) {
      const card = makeCard(p, render);
      const restore = document.createElement('button'); restore.className = 'chip'; restore.textContent = tr('proj.restore');
      restore.addEventListener('click', () => { window.devdeck.setHidden(p.path, false); reload(); });
      card.appendChild(restore);
      cardsEl.appendChild(card);
    } else cardsEl.appendChild(makeCard(p, render));
  }
}

function showSkeleton(): void {
  cardsEl.replaceChildren();
  for (let i = 0; i < 6; i++) { const s = document.createElement('div'); s.className = 'skeleton'; cardsEl.appendChild(s); }
}

async function reload(): Promise<void> {
  lastLoadMs = Date.now();
  showSkeleton();
  [projects, agentLabel] = await Promise.all([window.devdeck.listProjects(), window.devdeck.getAgent()]);
  render();
  // Fill in per-project cost in the background (all-time; sinceMs=0 = since epoch).
  void window.devdeck.usageReport(0).then((r) => {
    for (const pu of r.byProject) costByPath.set(pu.path, pu.costEstimate);
    render();
  }).catch(() => { /* cost is best-effort; ignore failures */ });
}

export function reloadProjects(): void { reload(); }

function applyProjectLabels(): void {
  if (!searchEl || !sortEl) return;
  searchEl.placeholder = tr('proj.search_ph');
  searchEl.setAttribute('aria-label', tr('proj.search_ph'));
  sortEl.setAttribute('aria-label', tr('proj.sort'));
  sortEl.options[0].text = tr('proj.sort_activity');
  sortEl.options[1].text = tr('proj.sort_uncommitted');
  sortEl.options[2].text = tr('proj.sort_name');
  sortEl.options[3].text = tr('proj.sort_opened');
}

export function mountProjects(): void {
  cardsEl = document.getElementById('cards')!;
  neglectedOnly = document.getElementById('neglected-only') as HTMLInputElement;
  showHiddenBtn = document.getElementById('show-hidden') as HTMLButtonElement;
  hiddenCountEl = document.getElementById('hidden-count')!;
  openBtn = document.getElementById('open-selected') as HTMLButtonElement;
  searchEl = document.getElementById('proj-search') as HTMLInputElement;
  sortEl = document.getElementById('proj-sort') as HTMLSelectElement;

  document.getElementById('refresh')!.addEventListener('click', reload);
  neglectedOnly.addEventListener('change', render);
  showHiddenBtn.addEventListener('click', () => { showHidden = !showHidden; render(); });
  openBtn.addEventListener('click', () => {
    if (selected.size === 0) return;
    openItems(projects.filter((p) => selected.has(p.path)).map((p) => ({ path: p.path, sessionId: null })));
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
  render();
}
