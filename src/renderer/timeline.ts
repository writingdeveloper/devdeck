// src/renderer/timeline.ts
// The selected session's timeline: every prompt the person sent, when, what came back and which
// images that turn produced — a panel over the right edge of the terminal. Clicking a turn scrolls
// the terminal to where that prompt is drawn.
//
// The turns come from the transcript (the same incremental read as the images), so the panel is
// right about when and what even for turns the scrollback no longer holds; those are shown but
// cannot be jumped to.
import type { SessionImageRef, SessionTurn } from '../shared/sessionImages';
import { imagesByTurn } from '../shared/timeline';
import { tr } from './i18n-runtime';
import { createIcon } from './icons';
import { toast } from './loadError';

export interface TimelineSource {
  /** Stable per session, like the image strip's. */
  key: string;
  turns(): Promise<SessionTurn[]>;
  /** The session's images as the strip knows them. */
  images(): readonly SessionImageRef[];
  /** Where each turn's prompt is drawn in the terminal now: turn id → buffer row. */
  locate(turns: readonly SessionTurn[]): Map<string, number>;
  reveal(row: number): void;
  openImage(id: string): void;
}

const OPEN_PREF = 'devdeck.timeline.open';

let host: HTMLElement | null = null;
let panel: HTMLElement | null = null;
let source: TimelineSource | null = null;
let turns: SessionTurn[] = [];
let open = readOpenPref();
let seq = 0;
let onToggle: () => void = () => {};

function readOpenPref(): boolean {
  try { return localStorage.getItem(OPEN_PREF) === '1'; } catch { return false; }
}
function writeOpenPref(v: boolean): void {
  try { localStorage.setItem(OPEN_PREF, v ? '1' : '0'); } catch { /* a private window simply forgets */ }
}

/** `into` is the terminal pane the panel floats over; `toggled` fires when it opens or closes. */
export function initTimeline(into: HTMLElement, toggled: () => void): void {
  host = into;
  onToggle = toggled;
  render();
}

export function isTimelineOpen(): boolean { return open; }

export function toggleTimeline(force?: boolean): void {
  const next = force ?? !open;
  if (next === open) return;
  open = next;
  writeOpenPref(open);
  render();
  if (open) void refreshTimeline();
  onToggle();
}

/** Point the panel at a session (or none). Cheap to call on every selection change. */
export function showTimelineFor(next: TimelineSource | null): void {
  if (next?.key === source?.key) { source = next; return; }
  source = next;
  turns = [];
  render();
  if (open) void refreshTimeline();
}

/** Re-read the turns, while the panel is open. */
export async function refreshTimeline(): Promise<void> {
  const src = source;
  if (!src || !open) return;
  const my = ++seq;
  let list: SessionTurn[];
  try { list = await src.turns(); } catch { return; }
  if (my !== seq || src.key !== source?.key) return;
  turns = list;
  render();
}

function render(): void {
  if (!host) return;
  if (!open || !source) { panel?.remove(); panel = null; return; }
  const src = source;
  if (!panel) {
    panel = document.createElement('aside'); panel.className = 'ck-timeline';
    panel.setAttribute('aria-label', tr('cockpit.timeline'));
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); toggleTimeline(false); } });
    host.appendChild(panel);
  }
  const wasAtBottom = !panel.lastElementChild || isScrolledToEnd(panel.querySelector('.ck-tl-list'));
  const head = document.createElement('div'); head.className = 'ck-tl-head';
  const title = document.createElement('span'); title.className = 'ck-tl-title';
  title.textContent = turns.length ? tr('cockpit.timeline_count', { count: String(turns.length) }) : tr('cockpit.timeline');
  const close = document.createElement('button'); close.type = 'button'; close.className = 'ck-act';
  close.title = tr('cockpit.timeline_hide'); close.setAttribute('aria-label', close.title);
  close.appendChild(createIcon('close')); close.addEventListener('click', () => toggleTimeline(false));
  head.append(title, close);
  const list = document.createElement('ol'); list.className = 'ck-tl-list';
  if (turns.length === 0) {
    const empty = document.createElement('li'); empty.className = 'ck-tl-empty'; empty.textContent = tr('cockpit.timeline_empty');
    list.appendChild(empty);
  }
  const rows = turns.length ? src.locate(turns) : new Map<string, number>();
  const images = imagesByTurn(turns, src.images());
  let lastDay = '';
  for (const t of turns) {
    const day = t.ts ? new Date(t.ts).toLocaleDateString() : '';
    if (day && day !== lastDay) {
      lastDay = day;
      const sep = document.createElement('li'); sep.className = 'ck-tl-day'; sep.textContent = day;
      list.appendChild(sep);
    }
    list.appendChild(turnItem(src, t, rows.has(t.id), images.get(t.id) ?? []));
  }
  panel.replaceChildren(head, list);
  // Opened or grown at the end: the newest turn is what is looked for.
  if (wasAtBottom) list.scrollTop = list.scrollHeight;
}

function isScrolledToEnd(el: Element | null): boolean {
  return !el || el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
}

function turnItem(src: TimelineSource, t: SessionTurn, onScreen: boolean, imageIds: string[]): HTMLElement {
  const li = document.createElement('li'); li.className = `ck-tl-item${onScreen ? '' : ' gone'}`;
  const b = document.createElement('button'); b.type = 'button'; b.className = 'ck-tl-jump';
  const when = document.createElement('span'); when.className = 'ck-tl-time';
  when.textContent = t.ts ? new Date(t.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const text = document.createElement('span'); text.className = 'ck-tl-text';
  text.textContent = t.text || tr('cockpit.timeline_image_only');
  b.append(when, text);
  if (t.reply) {
    const reply = document.createElement('span'); reply.className = 'ck-tl-reply'; reply.textContent = t.reply;
    b.appendChild(reply);
  }
  b.title = [t.text, t.reply ? `→ ${t.reply}` : '', onScreen ? '' : tr('cockpit.timeline_gone')].filter(Boolean).join('\n');
  const id = t.id;
  b.addEventListener('click', () => {
    // Looked up again now: rows move as output scrolls and the scrollback drops its oldest.
    const row = src.locate(turns).get(id);
    if (row === undefined) { toast(tr('cockpit.timeline_gone')); return; }
    src.reveal(row);
  });
  li.appendChild(b);
  if (imageIds.length) {
    const img = document.createElement('button'); img.type = 'button'; img.className = 'ck-tl-images';
    img.append(createIcon('image'), String(imageIds.length));
    img.title = tr('cockpit.timeline_images', { count: String(imageIds.length) }); img.setAttribute('aria-label', img.title);
    img.addEventListener('click', () => src.openImage(imageIds[0]));
    li.appendChild(img);
  }
  return li;
}
