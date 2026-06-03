// Derive the type from the global window.devdeck signature so this file stays a
// non-module. A runtime/type `import` makes tsc (CommonJS) emit an
// `Object.defineProperty(exports, ...)` line that throws in the classic-script
// renderer, where `exports` is undefined — which would abort the whole script.
type ProjectViewModel = Awaited<ReturnType<Window['devdeck']['listProjects']>>[number];

const cardsEl = document.getElementById('cards')!;
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement;
const openBtn = document.getElementById('open-selected') as HTMLButtonElement;
const neglectedOnly = document.getElementById('neglected-only') as HTMLInputElement;

let projects: ProjectViewModel[] = [];
const selected = new Set<string>();

function fmtTime(ms: number | null): string {
  if (ms == null) return '—';
  const d = new Date(ms);
  return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function render(): void {
  const visible = neglectedOnly.checked
    ? projects.filter((p) => p.stale.level === 'neglected')
    : projects;

  cardsEl.replaceChildren();
  if (visible.length === 0) {
    cardsEl.textContent = '표시할 프로젝트가 없습니다.';
    return;
  }

  for (const p of visible) {
    const card = document.createElement('div');
    card.className = 'card';

    const h2 = document.createElement('h2');
    const title = document.createElement('span');
    title.textContent = p.name;
    const badge = document.createElement('span');
    badge.className = `badge lvl-${p.stale.level}`;
    badge.textContent = p.stale.badge;
    h2.append(title, badge);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const dirty = p.uncommitted > 0 ? ` · ✎${p.uncommitted}` : '';
    const line1 = `${p.branch ?? '(no branch)'}${dirty}`;
    const line2 = `git ${fmtTime(p.lastCommitMs)} ${p.lastSubject ? `"${p.lastSubject}"` : '(no commits)'}`;
    const line3 = `claude ${fmtTime(p.lastSessionMs)}`;
    for (const [i, line] of [line1, line2, line3].entries()) {
      if (i > 0) meta.appendChild(document.createElement('br'));
      meta.appendChild(document.createTextNode(line));
    }

    const note = document.createElement('textarea');
    note.className = 'note';
    note.rows = 2;
    note.placeholder = '다음 할 일…';
    note.value = p.note;
    note.addEventListener('blur', () => {
      if (note.value !== p.note) {
        p.note = note.value;
        window.devdeck.setNote(p.path, note.value);
      }
    });

    const foot = document.createElement('div');
    foot.className = 'cardfoot';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = selected.has(p.path);
    check.addEventListener('change', () => {
      if (check.checked) selected.add(p.path);
      else selected.delete(p.path);
    });
    const open = document.createElement('button');
    open.textContent = '▶ Open';
    open.addEventListener('click', () => window.devdeck.open([{ path: p.path, sessionId: p.sessions[0]?.id ?? null }]));
    foot.append(check, open);

    card.append(h2, meta, note, foot);
    cardsEl.append(card);
  }
}

async function load(): Promise<void> {
  cardsEl.textContent = '로딩 중…';
  projects = await window.devdeck.listProjects();
  render();
}

refreshBtn.addEventListener('click', load);
neglectedOnly.addEventListener('change', render);
openBtn.addEventListener('click', () => {
  if (selected.size > 0) {
    window.devdeck.open([...selected].map((path) => ({ path, sessionId: null })));
  }
});
window.addEventListener('focus', load);

load();

const toastHost = document.getElementById('toast-host')!;
window.devdeck.onError((msg) => {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  toastHost.appendChild(t);
  setTimeout(() => t.remove(), 6000);
});
