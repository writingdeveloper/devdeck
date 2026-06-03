// Non-module renderer: derive the type from the global devdeck API (never `import`).
type ProjectViewModel = Awaited<ReturnType<Window['devdeck']['listProjects']>>[number];

const cardsEl = document.getElementById('cards')!;
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement;
const openBtn = document.getElementById('open-selected') as HTMLButtonElement;
const neglectedOnly = document.getElementById('neglected-only') as HTMLInputElement;
const showHiddenBtn = document.getElementById('show-hidden') as HTMLButtonElement;
const hiddenCountEl = document.getElementById('hidden-count')!;
const toastHost = document.getElementById('toast-host')!;

let projects: ProjectViewModel[] = [];
const selected = new Set<string>();
const expanded = new Set<string>();
let showHidden = false;

function fmtTime(ms: number | null): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString('ko-KR', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function isNoRecord(p: ProjectViewModel): boolean {
  return p.sessionCount === 0 && p.lastCommitMs == null;
}

function openItems(items: { path: string; sessionId: string | null }[]): void {
  window.devdeck.open(items);
}

function makeNote(p: ProjectViewModel): HTMLElement {
  const wrap = document.createElement('div');
  const showRead = () => {
    wrap.replaceChildren();
    const el = document.createElement('div');
    if (p.note) { el.className = 'note-preview'; el.textContent = p.note; }
    else { el.className = 'note-ghost'; el.textContent = '+ 다음 할 일…'; }
    el.addEventListener('click', showEdit);
    wrap.appendChild(el);
  };
  const showEdit = () => {
    wrap.replaceChildren();
    const ta = document.createElement('textarea');
    ta.className = 'note-edit'; ta.rows = 2; ta.value = p.note;
    ta.placeholder = '다음 할 일…';
    ta.addEventListener('blur', () => {
      if (ta.value !== p.note) { p.note = ta.value; window.devdeck.setNote(p.path, ta.value); }
      showRead();
    });
    wrap.appendChild(ta);
    ta.focus();
  };
  showRead();
  return wrap;
}

function makeSessions(p: ProjectViewModel): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'sessions';

  const head = document.createElement('div');
  head.className = 'sessions-head' + (expanded.has(p.path) ? ' open' : '');
  const latest = p.sessions[0];
  const label = document.createElement('span');
  label.textContent = `claude ${fmtTime(p.lastSessionMs)}${p.sessionCount ? ` · ${p.sessionCount} sessions` : ''}`;
  head.appendChild(label);
  if (p.sessionCount > 1) {
    const caret = document.createElement('span');
    caret.className = 'caret'; caret.textContent = '⌄';
    head.appendChild(caret);
    head.addEventListener('click', () => {
      if (expanded.has(p.path)) expanded.delete(p.path); else expanded.add(p.path);
      render();
    });
  }
  wrap.appendChild(head);

  if (latest?.firstMessage) {
    const prev = document.createElement('div');
    prev.className = 'preview'; prev.textContent = `↳ ${latest.firstMessage}`;
    wrap.appendChild(prev);
  }

  if (expanded.has(p.path) && p.sessionCount > 1) {
    const list = document.createElement('div');
    list.className = 'session-list';
    for (const s of p.sessions) {
      const row = document.createElement('div');
      row.className = 'session-row';
      const when = document.createElement('span');
      when.className = 'when'; when.textContent = fmtTime(s.mtimeMs);
      const msg = document.createElement('span');
      msg.className = 'msg'; msg.textContent = s.firstMessage ?? '(no message)';
      const open = document.createElement('button');
      open.className = 'iconbtn'; open.textContent = 'open';
      open.addEventListener('click', () => openItems([{ path: p.path, sessionId: s.id }]));
      row.append(when, msg, open);
      list.appendChild(row);
    }
    wrap.appendChild(list);
  }
  return wrap;
}

function makeCard(p: ProjectViewModel): HTMLElement {
  const card = document.createElement('div');
  const noRecord = isNoRecord(p);
  card.className = 'card lvl-' + p.stale.level + (noRecord ? ' norecord' : '') + (selected.has(p.path) ? ' selected' : '');

  const head = document.createElement('div');
  head.className = 'card-head';
  const title = document.createElement('span');
  title.className = 'card-title'; title.textContent = p.name;
  const badge = document.createElement('span');
  badge.className = 'badge ' + (noRecord ? 'norecord' : 'lvl-' + p.stale.level);
  badge.textContent = noRecord ? '∅ 기록 없음' : p.stale.badge;
  const pin = document.createElement('button');
  pin.className = 'iconbtn' + (p.pinned ? ' pin-on' : ''); pin.textContent = '📌'; pin.title = p.pinned ? '고정 해제' : '고정';
  pin.addEventListener('click', () => { window.devdeck.setPinned(p.path, !p.pinned); load(); });
  const hide = document.createElement('button');
  hide.className = 'iconbtn'; hide.textContent = '🙈'; hide.title = '숨기기';
  hide.addEventListener('click', () => { window.devdeck.setHidden(p.path, true); load(); });
  head.append(title, badge, pin, hide);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const branch = document.createElement('span');
  branch.className = 'branch'; branch.textContent = p.branch ?? '(no branch)';
  meta.appendChild(branch);
  if (p.uncommitted > 0) {
    const dirty = document.createElement('span');
    dirty.className = 'dirty' + (p.stale.level === 'neglected' ? ' alarm' : '');
    dirty.textContent = ` · ✎${p.uncommitted}`;
    meta.appendChild(dirty);
  }
  meta.appendChild(document.createElement('br'));
  meta.appendChild(document.createTextNode(
    `git ${fmtTime(p.lastCommitMs)} ${p.lastSubject ? `"${p.lastSubject}"` : '(no commits)'}`,
  ));

  const foot = document.createElement('div');
  foot.className = 'cardfoot';
  const check = document.createElement('input');
  check.type = 'checkbox'; check.checked = selected.has(p.path);
  check.addEventListener('change', () => {
    if (check.checked) selected.add(p.path); else selected.delete(p.path);
    card.classList.toggle('selected', check.checked);
  });
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  const open = document.createElement('button');
  open.className = 'primary'; open.textContent = '▶ Open';
  open.addEventListener('click', () => openItems([{ path: p.path, sessionId: p.sessions[0]?.id ?? null }]));
  foot.append(check, spacer, open);

  card.append(head, meta, makeSessions(p), makeNote(p), foot);
  return card;
}

function render(): void {
  hiddenCountEl.textContent = String(projects.filter((p) => p.hidden).length);
  let visible = showHidden ? projects.filter((p) => p.hidden) : projects.filter((p) => !p.hidden);
  if (neglectedOnly.checked) visible = visible.filter((p) => p.stale.level === 'neglected');

  cardsEl.replaceChildren();
  if (visible.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty'; e.textContent = '표시할 프로젝트가 없습니다.';
    cardsEl.appendChild(e);
    return;
  }
  for (const p of visible) {
    if (showHidden) {
      const card = makeCard(p);
      const restore = document.createElement('button');
      restore.textContent = '↩ 복원';
      restore.addEventListener('click', () => { window.devdeck.setHidden(p.path, false); load(); });
      card.appendChild(restore);
      cardsEl.appendChild(card);
    } else {
      cardsEl.appendChild(makeCard(p));
    }
  }
}

async function load(): Promise<void> {
  projects = await window.devdeck.listProjects();
  render();
}

refreshBtn.addEventListener('click', load);
neglectedOnly.addEventListener('change', render);
showHiddenBtn.addEventListener('click', () => { showHidden = !showHidden; render(); });
openBtn.addEventListener('click', () => {
  if (selected.size === 0) return;
  const items = projects
    .filter((p) => selected.has(p.path))
    .map((p) => ({ path: p.path, sessionId: p.sessions[0]?.id ?? null }));
  openItems(items);
});
window.addEventListener('focus', load);

window.devdeck.onError((msg) => {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  toastHost.appendChild(t);
  setTimeout(() => t.remove(), 6000);
});

load();
