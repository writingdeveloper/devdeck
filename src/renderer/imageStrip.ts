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
import { toast } from './loadError';
import { fitPngBase64 } from './attachments';
import { ImageMarkup, type MarkTool } from './imageMarkup';

/** Everything the strip needs to know about one session — where its images come from. */
export interface ImageSource {
  /** Stable per session; a change of key is a change of session. */
  key: string;
  list(): Promise<SessionImageRef[]>;
  get(id: string, size: 'thumb' | 'full'): Promise<ViewImage | null>;
  /** Open an image FILE in this machine's viewer; absent for a session on another machine. */
  openFile?(path: string): void;
  /** Whether the row this image was shown on is still in the session's terminal. */
  canReveal?(id: string): boolean;
  /** Scroll the session's terminal to the row this image was shown on. */
  reveal?(id: string): void;
  /** Give a picture (base64 PNG) to the session, as a pasted image; false when it did not arrive. */
  attach?(pngBase64: string): Promise<boolean>;
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
let onRefsChange: () => void = () => {};
let refreshSeq = 0;
let popupHost: HTMLElement | null = null;

function readOpenPref(): boolean {
  try { return localStorage.getItem(OPEN_PREF) === '1'; } catch { return false; }
}
function writeOpenPref(v: boolean): void {
  try { localStorage.setItem(OPEN_PREF, v ? '1' : '0'); } catch { /* a private window simply forgets */ }
}

/**
 * `popupIn` is where a new image is previewed while the strip is closed (over the terminal);
 * `refsChanged` fires whenever the selected session's list changes, for whoever marks the terminal.
 */
export function initImageStrip(el: HTMLElement, countChanged: () => void, opts: { popupIn?: HTMLElement; refsChanged?: () => void } = {}): void {
  stripEl = el;
  onCountChange = countChanged;
  popupHost = opts.popupIn ?? null;
  if (opts.refsChanged) onRefsChange = opts.refsChanged;
  render();
}

/** Which session the strip's list belongs to right now. */
export function currentImageSourceKey(): string | null { return source?.key ?? null; }

/** The selected session's images, oldest first. */
export function currentImageRefs(): readonly SessionImageRef[] { return refs; }

/** Open the viewer on one of the selected session's images. */
export function openImageById(id: string): boolean {
  const src = source; if (!src) return false;
  const at = refs.findIndex((r) => r.id === id);
  if (at < 0) return false;
  openViewer(src, refs, at);
  return true;
}

/** A small thumbnail of one of the selected session's images, for a hover preview. */
export function imageThumbUrl(id: string): Promise<string | null> {
  const src = source; const ref = refs.find((r) => r.id === id);
  return src && ref ? thumbUrl(src, ref) : Promise.resolve(null);
}

/** Point the strip at a session (or none). Cheap to call on every selection change. */
export function showImagesFor(next: ImageSource | null): void {
  if (next?.key === source?.key) { source = next; return; }
  source = next;
  refs = [];
  dismissPreview(); // it was about the session being left
  render();
  onRefsChange();
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
  const known = refs.length > 0 ? new Set(refs.map((r) => r.id)) : null;
  refs = list;
  const newest = list.length ? list[list.length - 1].id : null;
  if (!seenId.has(src.key)) seenId.set(src.key, newest); // what was there before we looked is not "new"
  if (open) seenId.set(src.key, newest);
  if (changed) {
    render();
    onRefsChange();
    // Only what arrived while this session was being watched: the first list of a session is history.
    // The person's own pastes are not news to them.
    const arrived = known ? list.filter((r) => !known.has(r.id) && r.kind !== 'pasted') : [];
    if (!open && arrived.length) previewArrival(src, arrived);
  }
  onCountChange();
}

// ---- arrival preview: a new screenshot shows up briefly over the terminal while the strip is closed ----
const PREVIEW_MS = 4000;
let previewEl: HTMLElement | null = null;
let previewTimer: ReturnType<typeof setTimeout> | null = null;

function previewArrival(src: ImageSource, arrived: SessionImageRef[]): void {
  if (!popupHost) return;
  const ref = arrived[arrived.length - 1];
  const extra = Number(previewEl?.dataset.count ?? 0) + arrived.length;
  previewEl?.remove();
  const b = document.createElement('button'); b.type = 'button'; b.className = 'ck-img-preview';
  b.dataset.count = String(extra);
  const label = describe(ref);
  b.title = `${label}\n${tr('cockpit.image_preview_hint')}`; b.setAttribute('aria-label', label);
  const img = document.createElement('img'); img.alt = '';
  const cap = document.createElement('span'); cap.className = 'ck-img-preview-cap';
  cap.textContent = extra > 1 ? tr('cockpit.image_preview_many', { count: String(extra) }) : tr('cockpit.image_preview_one');
  b.append(img, cap);
  void thumbUrl(src, ref).then((url) => { if (url) img.src = url; else b.remove(); });
  const id = ref.id;
  b.addEventListener('click', () => { dismissPreview(); if (source?.key === src.key) openViewer(src, refs, refs.findIndex((r) => r.id === id)); });
  // Kept while the pointer is on it, so it can be reached before it goes.
  b.addEventListener('mouseenter', () => { if (previewTimer) clearTimeout(previewTimer); });
  b.addEventListener('mouseleave', () => armPreview());
  popupHost.appendChild(b);
  previewEl = b;
  armPreview();
}

function armPreview(): void {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(dismissPreview, PREVIEW_MS);
}

function dismissPreview(): void {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = null;
  previewEl?.remove(); previewEl = null;
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
  if (open) dismissPreview();
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
    b.title = [label, ...contextLines(ref)].join('\n'); b.setAttribute('aria-label', label);
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

/**
 * What was going on when the image was made, from the transcript: what the tool was pointed at, the
 * page its browser was on, and what the agent had just said (or the person, for a paste).
 */
function contextLines(ref: SessionImageRef): string[] {
  const out: string[] = [];
  if (ref.detail && ref.detail !== ref.path) out.push(`▸ ${ref.detail}`);
  if (ref.page && ref.page !== ref.detail) out.push(`🌐 ${ref.page}`);
  if (ref.said) out.push(`“${ref.said}”`);
  return out;
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
  const headline = document.createElement('span'); headline.className = 'ck-img-headline';
  const context = document.createElement('span'); context.className = 'ck-img-context';
  caption.append(headline, context);
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
  const copy = mk('copy', tr('cockpit.image_copy'), () => {
    if (!img.src) return;
    const marked = markup.count > 0 ? markup.composite() : null;
    void (marked ? Promise.resolve(marked.toDataURL('image/png')) : toPngDataUrl(img)).then((url) => window.devdeck.clipboard.writeImage(url))
      .then((ok) => toast(tr(ok ? 'cockpit.image_copied' : 'cockpit.image_copy_failed')))
      .catch(() => toast(tr('cockpit.image_copy_failed')));
  });
  // Where in the conversation this was: the row of the terminal it was shown on.
  const reveal = mk('terminal', tr('cockpit.image_reveal'), () => {
    const id = list[index].id;
    if (!src.canReveal?.(id)) return;
    done();
    src.reveal?.(id);
  });
  // Mark it up, then hand it back: "this, here" as a picture rather than a paragraph.
  const markup = new ImageMarkup(img, stage, () => syncMarkup());
  const tools = document.createElement('div'); tools.className = 'ck-img-tools'; tools.setAttribute('role', 'toolbar');
  tools.setAttribute('aria-label', tr('cockpit.image_markup'));
  const toolBtns = new Map<MarkTool, HTMLButtonElement>();
  for (const [tool, icon, key] of [['box', 'square', 'cockpit.markup_box'], ['arrow', 'arrow', 'cockpit.markup_arrow'], ['pen', 'pen', 'cockpit.markup_pen']] as const) {
    const b = mk(icon, tr(key), () => { markup.tool = tool; syncMarkup(); });
    toolBtns.set(tool, b); tools.appendChild(b);
  }
  const undo = mk('undo', tr('cockpit.markup_undo'), () => markup.undo());
  const clear = mk('trash', tr('cockpit.markup_clear'), () => markup.clear());
  tools.append(undo, clear);
  const markBtn = mk('pen', tr('cockpit.image_markup'), () => { markup.setEnabled(!markup.active); syncMarkup(); });
  let sending = false;
  const send = mk('send', tr('cockpit.image_attach'), () => {
    if (!img.src || sending || !src.attach) return;
    sending = true; syncMarkup();
    const marked = markup.count > 0 ? markup.composite() : null;
    void (async () => {
      let ok = false;
      try {
        await img.decode().catch(() => undefined);
        const png = marked ? await fitPngBase64(marked, marked.width, marked.height) : await fitPngBase64(img, img.naturalWidth, img.naturalHeight);
        ok = !!png && await src.attach!(png);
      } catch { ok = false; }
      sending = false;
      if (ok) { toast(tr(marked ? 'cockpit.image_attached_marked' : 'cockpit.image_attached')); done(false); }
      else { toast(tr('cockpit.image_attach_failed')); syncMarkup(); }
    })();
  });
  const syncMarkup = (): void => {
    tools.hidden = !markup.active;
    markBtn.classList.toggle('on', markup.active); markBtn.setAttribute('aria-pressed', String(markup.active));
    for (const [tool, b] of toolBtns) { b.classList.toggle('on', markup.tool === tool); b.setAttribute('aria-pressed', String(markup.tool === tool)); }
    undo.disabled = clear.disabled = markup.count === 0;
    send.hidden = !src.attach; send.disabled = sending;
    send.title = tr(markup.count > 0 ? 'cockpit.image_attach_marked' : 'cockpit.image_attach');
    send.setAttribute('aria-label', send.title);
    prev.disabled = markup.active || index >= list.length - 1; next.disabled = markup.active || index <= 0;
  };
  const close = mk('close', tr('cockpit.close'), () => done());
  bar.append(prev, counter, next, caption, tools, markBtn, send, reveal, copy, save, openBtn, close);
  overlay.append(stage, bar);

  let seq = 0;
  const show = (): void => {
    const ref = list[index];
    const my = ++seq;
    headline.textContent = describe(ref);
    const lines = contextLines(ref);
    context.textContent = lines.join('  ·  '); context.title = lines.join('\n');
    counter.textContent = `${list.length - index} / ${list.length}`; // counted newest-first, like the strip
    openBtn.hidden = !(ref.kind === 'file' && src.openFile);
    const locatable = !!src.canReveal?.(ref.id);
    reveal.hidden = !src.canReveal; // a lone image opened from a path has no place in a conversation
    reveal.disabled = !locatable;
    reveal.title = tr(locatable ? 'cockpit.image_reveal' : 'cockpit.image_reveal_gone');
    reveal.setAttribute('aria-label', reveal.title);
    prev.disabled = index >= list.length - 1; next.disabled = index <= 0; // prev = newer, next = older
    syncMarkup();
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
    if (to < 0 || to >= list.length || markup.active) return;
    markup.clear(); // marks belong to the picture they were drawn on
    index = to; show();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (markup.active) {
      if (e.key === 'Escape') { e.preventDefault(); markup.setEnabled(false); syncMarkup(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); markup.undo(); return; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return;
    }
    if (e.key === 'Escape') { e.preventDefault(); done(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(-1); }
  };
  const restoreFocus = document.activeElement as HTMLElement | null;
  /** `refocus` = false when the session's terminal has just been given the focus instead. */
  const done = (refocus = true): void => {
    document.removeEventListener('keydown', onKey, true); markup.dispose(); overlay.remove();
    if (refocus) restoreFocus?.focus?.();
  };
  overlay.addEventListener('click', (e) => { if (!markup.active && (e.target === overlay || e.target === stage || e.target === markup.canvas)) done(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  close.focus();
  show();
}

/** The shown image in a form Electron decodes (PNG or JPEG pass through; anything else is redrawn as PNG). */
async function toPngDataUrl(img: HTMLImageElement): Promise<string> {
  if (/^data:image\/(?:png|jpeg);/.test(img.src)) return img.src;
  await img.decode().catch(() => undefined);
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d')?.drawImage(img, 0, 0);
  return c.toDataURL('image/png');
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
