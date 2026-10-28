// src/renderer/whatsNew.ts
// Making new features visible: a "What's new" window after an update, a NEW dot on each new button
// until it is first used, and a "Show me" that takes the person to the feature and rings it.
//
// Features shipped and nobody noticed: each was one more icon in a header that already had ten. The
// dialog says what changed and where; the dot stays on the button itself until it has been tried.
import { tr } from './i18n-runtime';
import { createIcon, type IconName } from './icons';
import { toast } from './loadError';

export type FeatureView = 'cockpit' | 'settings';

export interface Feature {
  id: string;
  /** The release that brought it. */
  version: string;
  icon: IconName;
  /**
   * Where it lives on screen, for "Show me"; absent for a keyboard shortcut or a background change.
   * Its words are the i18n keys `whatsnew.f.<id>.title`, `.body` and `.where`.
   */
  target?: { view: FeatureView; selector: string };
}

/** Newest first. A feature's NEW dot is shown on its `target` until the person uses it. */
export const FEATURES: readonly Feature[] = [
  { id: 'multi-close', version: '1.49.0', icon: 'select', target: { view: 'cockpit', selector: '#shell-select-toggle' } },
  // No Show me: the ⋯ of a background row exists only while Claude has background sessions.
  { id: 'bg-close', version: '1.46.0', icon: 'close' },
  { id: 'send-any-file', version: '1.45.0', icon: 'paperclip', target: { view: 'cockpit', selector: '#ck-header .ck-attach-btn' } },
  // No Show me: the group exists only while Claude has background sessions running.
  { id: 'background-agents', version: '1.44.0', icon: 'sessions' },
  { id: 'worktree-sessions', version: '1.43.0', icon: 'branch', target: { view: 'cockpit', selector: '#ck-header .ck-wt-new' } },
  { id: 'program-status', version: '1.42.0', icon: 'terminal', target: { view: 'settings', selector: '#set-program-status' } },
  { id: 'quick-replies', version: '1.41.0', icon: 'reply', target: { view: 'cockpit', selector: '#ck-header .ck-qr-btn' } },
  { id: 'timeline', version: '1.41.0', icon: 'timeline', target: { view: 'cockpit', selector: '#ck-header .ck-tl-toggle' } },
  { id: 'image-markup', version: '1.41.0', icon: 'pen', target: { view: 'cockpit', selector: '#ck-header .ck-img-toggle' } },
  { id: 'remote-documents', version: '1.41.0', icon: 'paperclip', target: { view: 'cockpit', selector: '#ck-header .ck-attach-btn' } },
  { id: 'image-rows', version: '1.40.0', icon: 'image', target: { view: 'cockpit', selector: '#ck-header .ck-img-toggle' } },
  { id: 'prompt-jump', version: '1.40.0', icon: 'chevron-down' },
  { id: 'image-strip', version: '1.39.0', icon: 'image', target: { view: 'cockpit', selector: '#ck-header .ck-img-toggle' } },
  { id: 'update-all', version: '1.39.0', icon: 'restart' },
];

/** The oldest release the window ever lists — what came before is history, not news. */
export const FIRST_LISTED = '1.39.0';
const SEEN_KEY = 'devdeck.features.seen';
const SPOTLIGHT_MS = 4000;

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/**
 * Whether to open the window at start-up, and from which release on. `seen` is the version it was
 * last shown for (null before 1.42.0 kept one); `usedBefore` tells an upgrade from a first run, which
 * has nothing to compare against and gets no window.
 */
export function whatsNewOnStart(current: string, seen: string | null, usedBefore: boolean): { show: boolean; after: string | null } {
  if (seen) return { show: compareVersions(seen, current) < 0, after: seen };
  return { show: usedBefore, after: null };
}

/** The features newer than `after` (all of them from FIRST_LISTED when null), newest first. */
export function featuresAfter(after: string | null): Feature[] {
  return FEATURES.filter((f) => compareVersions(f.version, FIRST_LISTED) >= 0 && (after === null || compareVersions(f.version, after) > 0));
}

// ---- NEW dots ----
function readSeen(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]); } catch { return new Set(); }
}

/** Put a NEW dot on `el` for a feature not yet used, and clear it on first click. Safe to call on every render. */
export function newDot(el: HTMLElement, id: string): void {
  el.dataset.feature = id;
  if (readSeen().has(id)) return;
  el.classList.add('dd-has-new');
  if (!el.querySelector(':scope > .dd-new-dot')) {
    const dot = document.createElement('span'); dot.className = 'dd-new-dot'; dot.setAttribute('aria-hidden', 'true');
    el.appendChild(dot);
  }
  el.addEventListener('click', () => markFeatureSeen(id), { once: true });
}

/** The feature has been used: its dots go, everywhere. */
export function markFeatureSeen(id: string): void {
  const seen = readSeen();
  if (!seen.has(id)) {
    seen.add(id);
    try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen])); } catch { /* the dot simply comes back */ }
  }
  for (const el of document.querySelectorAll<HTMLElement>(`[data-feature="${id}"]`)) {
    el.classList.remove('dd-has-new');
    el.querySelector(':scope > .dd-new-dot')?.remove();
  }
}

// ---- the window ----
let overlay: HTMLElement | null = null;

/**
 * List what is new since `after` (everything listed when null). `onClose` runs when the window is
 * dismissed — the caller records that this release's news has been seen.
 */
let navigate: (view: FeatureView) => void = () => {};
/** How "Show me" switches views; set once by the app shell. */
export function setFeatureNavigator(fn: (view: FeatureView) => void): void { navigate = fn; }

export function openWhatsNew(opts: { version: string; after: string | null; onClose?: () => void }): void {
  if (overlay) return;
  const features = featuresAfter(opts.after);
  if (!features.length) { opts.onClose?.(); return; }
  const restoreFocus = document.activeElement as HTMLElement | null;
  overlay = document.createElement('div'); overlay.className = 'wn-overlay';
  const dialog = document.createElement('div'); dialog.className = 'wn-dialog ui-dialog';
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'wn-title');
  const head = document.createElement('div'); head.className = 'wn-head';
  const title = document.createElement('h2'); title.id = 'wn-title'; title.textContent = tr('whatsnew.title', { version: opts.version });
  const sub = document.createElement('p'); sub.className = 'wn-sub'; sub.textContent = tr('whatsnew.subtitle');
  const heading = document.createElement('div'); heading.className = 'wn-heading'; heading.append(title, sub);
  const close = document.createElement('button'); close.type = 'button'; close.className = 'wn-close';
  close.appendChild(createIcon('close')); close.setAttribute('aria-label', tr('whatsnew.close')); close.title = tr('whatsnew.close');
  head.append(heading, close);

  const body = document.createElement('div'); body.className = 'wn-body';
  let lastVersion = '';
  for (const f of features) {
    if (f.version !== lastVersion) {
      lastVersion = f.version;
      const v = document.createElement('h3'); v.className = 'wn-version'; v.textContent = `v${f.version}`;
      body.appendChild(v);
    }
    body.appendChild(card(f, (target) => { done(); spotlight(target); }));
  }

  const foot = document.createElement('div'); foot.className = 'wn-foot';
  const notes = document.createElement('button'); notes.type = 'button'; notes.className = 'chip';
  notes.textContent = tr('whatsnew.all_notes');
  notes.addEventListener('click', () => void window.devdeck.openExternal('https://github.com/writingdeveloper/devdeck/releases'));
  const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'chip wn-primary'; ok.textContent = tr('whatsnew.ok');
  foot.append(notes, ok);
  dialog.append(head, body, foot);
  overlay.appendChild(dialog);

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); done(); return; }
    if (e.key !== 'Tab') return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled])'));
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const done = (): void => {
    if (!overlay) return;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove(); overlay = null;
    restoreFocus?.focus?.();
    opts.onClose?.();
  };
  close.addEventListener('click', done);
  ok.addEventListener('click', done);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  ok.focus();
}

export function isWhatsNewOpen(): boolean { return overlay !== null; }

function card(f: Feature, showMe: (target: NonNullable<Feature['target']>) => void): HTMLElement {
  const el = document.createElement('article'); el.className = 'wn-card';
  const icon = document.createElement('span'); icon.className = 'wn-icon'; icon.appendChild(createIcon(f.icon));
  const text = document.createElement('div'); text.className = 'wn-text';
  const h = document.createElement('h4'); h.textContent = tr(`whatsnew.f.${f.id}.title`);
  const p = document.createElement('p'); p.textContent = tr(`whatsnew.f.${f.id}.body`);
  const where = document.createElement('p'); where.className = 'wn-where'; where.textContent = tr(`whatsnew.f.${f.id}.where`);
  text.append(h, p, where);
  el.append(icon, text);
  if (f.target) {
    const target = f.target;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip wn-show'; b.textContent = tr('whatsnew.show_me');
    b.addEventListener('click', () => showMe(target));
    el.appendChild(b);
  }
  return el;
}

/** Go to where a feature lives and ring it for a moment. */
export function spotlight(target: NonNullable<Feature['target']>): void {
  navigate(target.view);
  // The view draws on the next frames (the settings form loads asynchronously); look for a while.
  const started = Date.now();
  const find = (): void => {
    const el = document.querySelector<HTMLElement>(target.selector);
    if (el && el.offsetParent !== null) {
      const ring = el.closest<HTMLElement>('.set-row') ?? el;
      ring.scrollIntoView({ block: 'center', behavior: 'smooth' });
      ring.classList.remove('dd-spotlight'); void ring.offsetWidth; ring.classList.add('dd-spotlight');
      setTimeout(() => ring.classList.remove('dd-spotlight'), SPOTLIGHT_MS);
      return;
    }
    if (Date.now() - started < 3000) { setTimeout(find, 100); return; }
    toast(tr(target.view === 'cockpit' ? 'whatsnew.need_session' : 'whatsnew.not_found'));
  };
  requestAnimationFrame(find);
}
