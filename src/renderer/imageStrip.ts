// src/renderer/imageStrip.ts
// The cockpit's image strip: the screenshots, pasted images and image files the selected session
// handled, as thumbnails between the header and the terminal, and a full-size viewer on click.
//
// Claude Desktop shows these inline in the conversation. A terminal draws text, so the cockpit shows
// them beside it instead — the same "did it actually do what I think it did" check, at a glance.
import type { SessionImageRef } from '../shared/sessionImages';
import type { ViewImage } from '../main/imageView';
import { tr } from './i18n-runtime';
import { createIcon } from './icons';

/** Everything the strip needs to know about one session — where its images come from. */
export interface ImageSource {
  /** Stable per session; a change of key is a change of session. */
  key: string;
  list(): Promise<SessionImageRef[]>;
  get(id: string, size: 'thumb' | 'full'): Promise<ViewImage | null>;
  /** Open an image FILE in this machine's viewer; absent for a session on another machine. */
  openFile?(path: string): void;
}

const THUMB_CACHE_LIMIT = 240;
const SHOWN_LIMIT = 60;
const OPEN_PREF = 'devdeck.imageStrip.open';

let stripEl: HTMLElement | null = null;
let source: ImageSource | null = null;
let refs: SessionImageRef[] = [];
let open = readOpenPref();
/**
 * Per session: the newest image the person had seen when they last had the strip open (null = none).
 * An id rather than a count, because the list is capped — past the cap its length stops growing.
 */
const seenId = new Map<string, string | null>();
const thumbs = new Map<string, Promise<string | null>>();
let onCountChange: () => void = () => {};
let refreshSeq = 0;

function readOpenPref(): boolean {
  try { return localStorage.getItem(OPEN_PREF) === '1'; } catch { return false; }
}
function writeOpenPref(v: boolean): void {
  try { localStorage.setItem(OPEN_PREF, v ? '1' : '0'); } catch { /* a private window simply forgets */ }
}

export function initImageStrip(el: HTMLElement, countChanged: () => void): void {
  stripEl = el;
  onCountChange = countChanged;
  render();
}

/** Point the strip at a session (or none). Cheap to call on every selection change. */
export function showImagesFor(next: ImageSource | null): void {
  if (next?.key === source?.key) { source = next; return; }
  source = next;
  refs = [];
  render();
  void refreshImages();
}

export async function refreshImages(): Promise<void> {
  const src = source; if (!src) return;
  const seq = ++refreshSeq;
  let list: SessionImageRef[];
  try { list = await src.list(); } catch { return; }
  // Compared by key: the header rebuilds the source object for the SAME session on every meta or
  // git refresh, and a list arriving after one of those is still this session's list.
  if (seq !== refreshSeq || src.key !== source?.key) return;
  const changed = list.length !== refs.length || list[list.length - 1]?.id !== refs[refs.length - 1]?.id;
  refs = list;
  const newest = list.length ? list[list.length - 1].id : null;
  if (!seenId.has(src.key)) seenId.set(src.key, newest); // what was there before we looked is not "new"
  if (open) seenId.set(src.key, newest);
  if (changed) render();
  onCountChange();
}

export function imageStripState(): { total: number; unseen: number; open: boolean } {
  const total = refs.length;
  if (!source || !seenId.has(source.key)) return { total, unseen: 0, open };
  const last = seenId.get(source.key) ?? null;
  const at = last === null ? -1 : refs.findIndex((r) => r.id === last);
  // Not found: either nothing had been seen, or what was seen has scrolled past the cap — all new.
  return { total, unseen: at === -1 ? total : total - 1 - at, open };
}

export function toggleImageStrip(): void {
  open = !open;
  writeOpenPref(open);
  if (open && source) seenId.set(source.key, refs.length ? refs[refs.length - 1].id : null);
  render();
  onCountChange();
}

export function isImageStripOpen(): boolean { return open; }

function thumbUrl(src: ImageSource, ref: SessionImageRef): Promise<string | null> {
  const key = `${src.key}|${ref.id}|${ref.ts ?? ''}`;
  let hit = thumbs.get(key);
  if (!hit) {
    hit = src.get(ref.id, 'thumb').then((img) => (img ? `data:${img.mediaType};base64,${img.data}` : null)).catch(() => null);
    thumbs.set(key, hit);
    if (thumbs.size > THUMB_CACHE_LIMIT) thumbs.delete(thumbs.keys().next().value as string);
  } else { thumbs.delete(key); thumbs.set(key, hit); } // most recently used stays
  return hit;
}

function render(): void {
  if (!stripEl) return;
  const show = open && !!source && refs.length > 0;
  stripEl.classList.toggle('hidden', !show);
  stripEl.replaceChildren();
  if (!show || !source) return;
  const src = source;
  const shown = refs.slice(-SHOWN_LIMIT).reverse(); // newest first: what just happened is what you look for
  for (const ref of shown) {
    const b = document.createElement('button'); b.type = 'button'; b.className = `ck-img-thumb kind-${ref.kind}`;
    const label = describe(ref);
    b.title = label; b.setAttribute('aria-label', label);
    const img = document.createElement('img'); img.alt = ''; img.decoding = 'async'; img.loading = 'lazy';
    b.appendChild(img);
    void thumbUrl(src, ref).then((url) => {
      if (url) img.src = url;
      else { b.classList.add('missing'); b.title = `${label} · ${tr('cockpit.image_unavailable')}`; }
    });
    // Looked up by id at click time: a refresh replaces the list with fresh objects without
    // necessarily re-rendering, and the button must still open the image it shows.
    const id = ref.id;
    b.addEventListener('click', () => openViewer(src, refs, refs.findIndex((r) => r.id === id)));
    stripEl.appendChild(b);
  }
}

function describe(ref: SessionImageRef): string {
  const what = ref.kind === 'file' ? (ref.path ?? '') : ref.kind === 'pasted' ? tr('cockpit.image_pasted_kind') : prettyTool(ref.tool) || tr('cockpit.image_screenshot_kind');
  const when = ref.ts ? new Date(ref.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  return when ? `${what} · ${when}` : what;
}

/** `mcp__playwright__browser_take_screenshot` → `playwright · browser_take_screenshot`. */
function prettyTool(tool: string | null): string {
  if (!tool) return '';
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  return m ? `${m[1]} · ${m[2]}` : tool;
}

/** Full-size viewer over the whole window: ←/→ step through the session's images, Esc closes. */
function openViewer(src: ImageSource, list: SessionImageRef[], startIndex: number): void {
  let index = startIndex < 0 ? list.length - 1 : startIndex;
  const overlay = document.createElement('div'); overlay.className = 'ck-img-viewer'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
  const stage = document.createElement('div'); stage.className = 'ck-img-stage';
  const img = document.createElement('img'); img.alt = '';
  const status = document.createElement('div'); status.className = 'ck-img-status';
  stage.append(img, status);
  const bar = document.createElement('div'); bar.className = 'ck-img-bar';
  const caption = document.createElement('span'); caption.className = 'ck-img-caption';
  const counter = document.createElement('span'); counter.className = 'ck-img-counter';
  const mk = (icon: Parameters<typeof createIcon>[0], label: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ck-act'; b.title = label; b.setAttribute('aria-label', label);
    b.appendChild(createIcon(icon)); b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b;
  };
  // Spatially the same as the strip it was opened from, where the newest image is leftmost.
  const prev = mk('chevron-left', tr('cockpit.image_prev'), () => step(1));
  const next = mk('chevron-right', tr('cockpit.image_next'), () => step(-1));
  const save = mk('download', tr('cockpit.image_save'), () => {
    if (!img.src) return;
    const a = document.createElement('a'); a.href = img.src; a.download = fileNameFor(list[index], img.src); a.click();
  });
  const openBtn = mk('folder', tr('cockpit.image_open_file'), () => { const r = list[index]; if (r.path && src.openFile) src.openFile(r.path); });
  const close = mk('close', tr('cockpit.close'), () => done());
  bar.append(prev, counter, next, caption, save, openBtn, close);
  overlay.append(stage, bar);

  let seq = 0;
  const show = (): void => {
    const ref = list[index];
    const my = ++seq;
    caption.textContent = describe(ref);
    counter.textContent = `${list.length - index} / ${list.length}`; // counted newest-first, like the strip
    openBtn.hidden = !(ref.kind === 'file' && src.openFile);
    prev.disabled = index >= list.length - 1; next.disabled = index <= 0; // prev = newer, next = older
    status.textContent = tr('cockpit.image_loading'); img.removeAttribute('src');
    void src.get(ref.id, 'full').then((v) => {
      if (my !== seq) return;
      if (!v) { status.textContent = tr('cockpit.image_unavailable'); return; }
      status.textContent = '';
      img.src = `data:${v.mediaType};base64,${v.data}`;
    }).catch(() => { if (my === seq) status.textContent = tr('cockpit.image_unavailable'); });
  };
  /** +1 = one newer, -1 = one older. */
  const step = (d: number): void => {
    const to = index + d;
    if (to < 0 || to >= list.length) return;
    index = to; show();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); done(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(-1); }
  };
  const restoreFocus = document.activeElement as HTMLElement | null;
  const done = (): void => { document.removeEventListener('keydown', onKey, true); overlay.remove(); restoreFocus?.focus?.(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target === stage) done(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  close.focus();
  show();
}

function fileNameFor(ref: SessionImageRef, dataUrl: string): string {
  if (ref.path) return ref.path.split(/[\\/]/).pop() || 'image.png';
  const ext = /^data:image\/(\w+)/.exec(dataUrl)?.[1]?.replace('jpeg', 'jpg') ?? 'png';
  const t = ref.ts ? new Date(ref.ts) : new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `devdeck-${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}.${ext}`;
}

/** Show one image that is not part of a session's list — a path clicked in a remote terminal. */
export function openSingleImage(load: () => Promise<ViewImage | null>, caption: string): void {
  const ref: SessionImageRef = { id: 'single', kind: 'file', ts: null, tool: null, path: caption };
  openViewer({ key: `single:${caption}`, list: async () => [ref], get: () => load() }, [ref], 0);
}
