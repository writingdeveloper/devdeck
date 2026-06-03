import { tr, localeTag } from './i18n-runtime';

type ProjectViewModel = Awaited<ReturnType<Window['devdeck']['listProjects']>>[number];

const selected = new Set<string>();
const expanded = new Set<string>();
let projects: ProjectViewModel[] = [];
let showHidden = false;

let cardsEl: HTMLElement;
let neglectedOnly: HTMLInputElement;
let showHiddenBtn: HTMLButtonElement;
let hiddenCountEl: HTMLElement;
let openBtn: HTMLButtonElement;

function fmtTime(ms: number | null): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString(localeTag(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function isNoRecord(p: ProjectViewModel): boolean { return p.sessionCount === 0 && p.lastCommitMs == null; }
function openItems(items: { path: string; sessionId: string | null }[]): void { window.devdeck.open(items); }

function makeNote(p: ProjectViewModel): HTMLElement {
  const wrap = document.createElement('div');
  const showRead = () => {
    wrap.replaceChildren();
    const el = document.createElement('div');
    if (p.note) { el.className = 'note-preview'; el.textContent = p.note; }
    else { el.className = 'note-ghost'; el.textContent = tr('proj.next_todo'); }
    el.addEventListener('click', showEdit);
    wrap.appendChild(el);
  };
  const showEdit = () => {
    wrap.replaceChildren();
    const ta = document.createElement('textarea');
    ta.className = 'note-edit'; ta.rows = 2; ta.value = p.note; ta.placeholder = tr('proj.next_todo_ph');
    ta.addEventListener('blur', () => {
      if (ta.value !== p.note) { p.note = ta.value; window.devdeck.setNote(p.path, ta.value); }
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
  label.textContent = `claude ${fmtTime(p.lastSessionMs)}${p.sessionCount ? ` · ${p.sessionCount} ${tr('proj.sessions')}` : ''}`;
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
        const msg = document.createElement('span'); msg.className = 'msg'; msg.textContent = s.firstMessage ?? '(no message)';
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
  const title = document.createElement('span'); title.className = 'card-title'; title.textContent = p.name;
  const badge = document.createElement('span');
  badge.className = 'badge ' + (noRecord ? 'norecord' : 'lvl-' + p.stale.level);
  badge.textContent = noRecord ? tr('proj.no_record') : p.stale.badge;

  const menuWrap = document.createElement('div'); menuWrap.className = 'menu-wrap';
  const menuBtn = document.createElement('button'); menuBtn.className = 'iconbtn'; menuBtn.textContent = '⋯'; menuBtn.setAttribute('aria-label', 'more');
  const menu = document.createElement('div'); menu.className = 'menu hidden';
  const pinItem = document.createElement('button'); pinItem.className = 'menu-item'; pinItem.textContent = p.pinned ? tr('proj.unpin') : tr('proj.pin');
  pinItem.addEventListener('click', () => { window.devdeck.setPinned(p.path, !p.pinned); reload(); });
  const hideItem = document.createElement('button'); hideItem.className = 'menu-item'; hideItem.textContent = tr('proj.hide');
  hideItem.addEventListener('click', () => { window.devdeck.setHidden(p.path, true); reload(); });
  menu.append(pinItem, hideItem);
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); });
  menuWrap.append(menuBtn, menu);

  headRow.append(title, badge, menuWrap);

  const meta = document.createElement('div'); meta.className = 'meta';
  const branch = document.createElement('span'); branch.className = 'branch'; branch.textContent = p.branch ?? tr('proj.no_branch');
  meta.appendChild(branch);
  if (p.uncommitted > 0) {
    const dirty = document.createElement('span'); dirty.className = 'dirty' + (p.stale.level === 'neglected' ? ' alarm' : '');
    dirty.textContent = ` · ✎${p.uncommitted}`; meta.appendChild(dirty);
  }
  meta.appendChild(document.createElement('br'));
  meta.appendChild(document.createTextNode(`git ${fmtTime(p.lastCommitMs)} ${p.lastSubject ? `"${p.lastSubject}"` : tr('proj.no_commits')}`));

  const foot = document.createElement('div'); foot.className = 'cardfoot';
  const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selected.has(p.path); check.setAttribute('aria-label', 'select');
  check.addEventListener('change', () => {
    check.checked ? selected.add(p.path) : selected.delete(p.path);
    card.classList.toggle('selected', check.checked);
    syncOpenBtn();
  });
  const spacer = document.createElement('span'); spacer.className = 'spacer';
  const open = document.createElement('button'); open.className = 'primary'; open.textContent = '▶ ' + tr('proj.open');
  open.addEventListener('click', () => openItems([{ path: p.path, sessionId: p.sessions[0]?.id ?? null }]));
  foot.append(check, spacer, open);

  card.append(headRow, meta, makeSessions(p, render), makeNote(p), foot);
  return card;
}

function syncOpenBtn(): void { openBtn.disabled = selected.size === 0; }

function render(): void {
  hiddenCountEl.textContent = String(projects.filter((p) => p.hidden).length);
  showHiddenBtn.classList.toggle('active', showHidden);
  let visible = showHidden ? projects.filter((p) => p.hidden) : projects.filter((p) => !p.hidden);
  if (neglectedOnly.checked) visible = visible.filter((p) => p.stale.level === 'neglected');

  cardsEl.replaceChildren();
  cardsEl.setAttribute('role', 'list');
  if (visible.length === 0) {
    const e = document.createElement('div'); e.className = 'empty';
    e.textContent = neglectedOnly.checked ? tr('proj.empty_neglected') : (showHidden ? tr('proj.empty_hidden') : tr('proj.empty_none'));
    cardsEl.appendChild(e); return;
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
  showSkeleton();
  projects = await window.devdeck.listProjects();
  render();
}

export function mountProjects(): void {
  cardsEl = document.getElementById('cards')!;
  neglectedOnly = document.getElementById('neglected-only') as HTMLInputElement;
  showHiddenBtn = document.getElementById('show-hidden') as HTMLButtonElement;
  hiddenCountEl = document.getElementById('hidden-count')!;
  openBtn = document.getElementById('open-selected') as HTMLButtonElement;

  document.getElementById('refresh')!.addEventListener('click', reload);
  neglectedOnly.addEventListener('change', render);
  showHiddenBtn.addEventListener('click', () => { showHidden = !showHidden; render(); });
  openBtn.addEventListener('click', () => {
    if (selected.size === 0) return;
    openItems(projects.filter((p) => selected.has(p.path)).map((p) => ({ path: p.path, sessionId: p.sessions[0]?.id ?? null })));
  });
  window.addEventListener('focus', () => { if (document.getElementById('view-projects')!.classList.contains('active')) reload(); });
  document.addEventListener('click', () => document.querySelectorAll('.menu:not(.hidden)').forEach((m) => m.classList.add('hidden')));
  reload();
}

export function renderProjects(): void { render(); }
