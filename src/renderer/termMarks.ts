// src/renderer/termMarks.ts
// Ties the selected session's images to the terminal rows they were shown on, and finds the person's
// earlier prompts — so "which step was this screenshot?" and "where did I ask that?" are one click
// or one key away instead of a scroll through thousands of rows.
//
// The rows are found by what Claude Code prints (see shared/terminalMarks); each is then held by an
// xterm marker, which follows its row as output scrolls it up and is disposed when the scrollback
// drops it.
import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';
import type { SessionImageRef } from '../shared/sessionImages';
import { findImagePlaceholders, findPromptRows, nextPromptRow, pairPlaceholders, type PromptRowInput } from '../shared/terminalMarks';

const MARK_BG = '#1f3352';
const MARK_FG = '#a8cdff';
const FLASH_BG = '#4a4220';
const FLASH_MS = 1600;
/** Rows of context kept above a row scrolled to, so the call that led to it is on screen too. */
const REVEAL_CONTEXT_ROWS = 4;

interface Mark { id: string; marker: IMarker; deco: IDecoration | undefined; col: number; len: number }

class TermMarks {
  private marks: Mark[] = [];
  private sig = '';
  constructor(private readonly term: Terminal) {}

  /** Re-find the placeholders on screen and pair them with `refs`. Cheap to call when nothing moved. */
  update(refs: readonly SessionImageRef[]): void {
    const buf = this.term.buffer.active;
    if (buf.type !== 'normal' || refs.length === 0) { this.clear(); return; }
    const rows = readRows(this.term);
    const found = findImagePlaceholders(rows);
    const pairs = pairPlaceholders(refs, found, (r) => rows[r] ?? '');
    const wanted = [...pairs].map(([mi, id]) => ({ ...found[mi], id }));
    const sig = wanted.map((w) => `${w.row}:${w.col}:${w.id}`).join('|');
    if (sig === this.sig && this.marks.every((m) => !m.marker.isDisposed)) return;
    this.clear();
    this.sig = sig;
    const cursorRow = buf.baseY + buf.cursorY;
    for (const w of wanted) {
      const marker = this.term.registerMarker(w.row - cursorRow);
      if (!marker) continue;
      const deco = this.term.registerDecoration({ marker, x: w.col, width: w.len, backgroundColor: MARK_BG, foregroundColor: MARK_FG, layer: 'top' });
      // Colour only: the link under it has to keep getting the pointer.
      deco?.onRender((el) => { el.style.pointerEvents = 'none'; });
      this.marks.push({ id: w.id, marker, deco, col: w.col, len: w.len });
    }
  }

  /** The image shown at buffer cell (row, col), 0-based. */
  idAt(row: number, col: number): string | null {
    for (const m of this.marks) if (!m.marker.isDisposed && m.marker.line === row && col >= m.col && col < m.col + m.len) return m.id;
    return null;
  }

  locate(id: string): number | null {
    const m = this.marks.find((x) => x.id === id && !x.marker.isDisposed);
    return m ? m.marker.line : null;
  }

  reveal(id: string): boolean {
    const row = this.locate(id);
    if (row === null) return false;
    this.term.scrollToLine(Math.max(0, row - REVEAL_CONTEXT_ROWS));
    flashRow(this.term, row);
    return true;
  }

  clear(): void {
    for (const m of this.marks) { m.deco?.dispose(); m.marker.dispose(); }
    this.marks = []; this.sig = '';
  }
}

const byTerm = new WeakMap<Terminal, TermMarks>();
export function marksFor(term: Terminal): TermMarks {
  let m = byTerm.get(term);
  if (!m) { m = new TermMarks(term); byTerm.set(term, m); }
  return m;
}

function readRows(term: Terminal): string[] {
  const buf = term.buffer.active;
  const rows = new Array<string>(buf.length);
  for (let i = 0; i < buf.length; i++) rows[i] = buf.getLine(i)?.translateToString(true) ?? '';
  return rows;
}

/** Highlight a row for a moment, so the eye lands on it after a jump. */
export function flashRow(term: Terminal, row: number): void {
  const buf = term.buffer.active;
  const marker = term.registerMarker(row - (buf.baseY + buf.cursorY));
  if (!marker) return;
  const deco = term.registerDecoration({ marker, x: 0, width: term.cols, backgroundColor: FLASH_BG, layer: 'bottom' });
  setTimeout(() => { deco?.dispose(); marker.dispose(); }, FLASH_MS);
}

/**
 * Scroll to the previous (-1) or next (+1) prompt the person sent, from the top of the viewport.
 * Past the last one is the bottom. Returns false when the screen holds no prompt to go to.
 */
export function jumpToPrompt(term: Terminal, dir: -1 | 1): boolean {
  const buf = term.buffer.active;
  if (buf.type !== 'normal') return false;
  const rows: PromptRowInput[] = new Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    const text = line?.translateToString(true) ?? '';
    // The pointer is the first non-blank cell; its background is what tells a sent prompt from text.
    const at = text.search(/\S/);
    const cell = at >= 0 ? line?.getCell(at) : undefined;
    rows[i] = { text, shaded: !!cell && !cell.isBgDefault() };
  }
  const prompts = findPromptRows(rows);
  if (prompts.length === 0) return false;
  // At the bottom, the newest prompt may be on screen already — going back starts from it, not above it.
  const from = dir < 0 && buf.viewportY >= buf.baseY ? buf.length : buf.viewportY;
  const to = nextPromptRow(prompts, from, dir);
  if (to === null) { term.scrollToBottom(); return true; }
  term.scrollToLine(to);
  flashRow(term, to);
  return true;
}
