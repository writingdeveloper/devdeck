// src/renderer/quickReplyMenu.ts
// The cockpit's quick replies: the phrases the person keeps typing, sent with one click from a menu
// in the session header or with Ctrl+Shift+<n> in the terminal. Edited in Settings.
import { MAX_QUICK_REPLIES } from '../shared/quickReplies';
import { tr } from './i18n-runtime';

const DEFAULT_KEYS = ['cockpit.quick_default_1', 'cockpit.quick_default_2', 'cockpit.quick_default_3', 'cockpit.quick_default_4'];

let custom: string[] | null = null;
let menu: HTMLElement | null = null;
let closeMenu: (() => void) | null = null;

/** The person's own list; null or empty means the defaults for the current language. */
export function setQuickReplies(list: string[] | null): void { custom = list; }

export function quickReplies(): string[] {
  return (custom && custom.length ? custom : DEFAULT_KEYS.map((k) => tr(k))).slice(0, MAX_QUICK_REPLIES);
}

export function isQuickReplyMenuOpen(): boolean { return menu !== null; }

/** A menu under `anchor`; picking a phrase hands it to `send`. A second call closes it. */
export function toggleQuickReplyMenu(anchor: HTMLElement, send: (text: string) => void): void {
  if (closeMenu) { closeMenu(); return; }
  const list = quickReplies();
  const el = document.createElement('div'); el.className = 'ck-qr-menu'; el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', tr('cockpit.quick_replies'));
  const items: HTMLButtonElement[] = list.map((text, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ck-qr-item'; b.setAttribute('role', 'menuitem');
    const t = document.createElement('span'); t.className = 'ck-qr-text'; t.textContent = text;
    const k = document.createElement('kbd'); k.className = 'ck-qr-key'; k.textContent = `Ctrl+Shift+${i + 1}`;
    b.append(t, k); b.title = text;
    b.addEventListener('click', () => { done(); send(text); });
    return b;
  });
  const hint = document.createElement('div'); hint.className = 'ck-qr-hint'; hint.textContent = tr('cockpit.quick_replies_hint');
  el.append(...items, hint);
  const r = anchor.getBoundingClientRect();
  el.style.top = `${Math.round(r.bottom + 4)}px`;
  el.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); anchor.focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[to]?.focus();
  };
  const onDown = (e: PointerEvent): void => { if (!el.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) done(); };
  const done = (): void => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
    el.remove(); menu = null; closeMenu = null;
    anchor.setAttribute('aria-expanded', 'false');
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  document.body.appendChild(el);
  menu = el; closeMenu = done;
  anchor.setAttribute('aria-expanded', 'true');
  items[0]?.focus();
}
