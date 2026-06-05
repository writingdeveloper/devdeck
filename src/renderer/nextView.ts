import { tr } from './i18n-runtime';
import { collectNextItems, type NextItem } from '../shared/nextItems';

let viewEl: HTMLElement;

async function load(): Promise<void> {
  const projects = await window.devdeck.listProjects();
  render(collectNextItems(projects));
}

function render(items: NextItem[]): void {
  viewEl.replaceChildren();

  const head = document.createElement('div'); head.className = 'next-head';
  head.textContent = `${tr('next.title')} · ${items.length}`;
  viewEl.appendChild(head);

  if (items.length === 0) {
    const e = document.createElement('div'); e.className = 'empty'; e.textContent = tr('next.empty');
    viewEl.appendChild(e);
    return;
  }

  const list = document.createElement('div'); list.className = 'next-list'; list.setAttribute('role', 'list');
  for (const it of items) {
    const row = document.createElement('div'); row.className = 'next-row'; row.setAttribute('role', 'listitem');
    const main = document.createElement('div'); main.className = 'next-main';
    const name = document.createElement('span'); name.className = 'next-name'; name.textContent = it.name;
    const text = document.createElement('span');
    text.className = 'next-text' + (it.kind === 'cue' ? ' next-text--cue' : '');
    text.textContent = (it.kind === 'cue' ? '↩ ' : '') + it.text;
    text.title = it.text;
    main.append(name, text);
    const open = document.createElement('button'); open.className = 'primary'; open.textContent = '▶ ' + tr('proj.open');
    open.addEventListener('click', () => window.devdeck.open([{ path: it.path, sessionId: null }]));
    row.append(main, open);
    list.appendChild(row);
  }
  viewEl.appendChild(list);
}

export function mountNext(): void { viewEl = document.getElementById('view-next')!; }
export function showNext(): void { void load(); }
