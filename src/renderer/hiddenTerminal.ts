// src/renderer/hiddenTerminal.ts
// A terminal that is not on screen must not draw.
//
// Every tile is an xterm of its own, stacked in one pane with all but the selected one
// `display: none`. xterm pauses a terminal it cannot see — but only on the path output takes
// (RenderService.refreshRows). Three others go straight to the renderer whatever the pause says:
//
//  - a SCROLL. Every line that scrolls a terminal asks its selection to refresh, and the DOM
//    renderer answers a selection refresh by drawing every row again (handleSelectionChanged →
//    renderRows(0, rows - 1)). So a session working in the background redraws its whole hidden
//    screen for every line it prints.
//  - a blur, which is what selecting another session does to the one being left — after it has
//    been hidden.
//  - a resize.
//
// And drawing a hidden terminal is not merely wasted, it is the slowest thing the DOM renderer can
// do. It sizes each cell by measuring its character in a helper span (WidthCache._measure:
// textContent, then offsetWidth) and remembers the answer — unless the answer is 0, which is what
// every measurement inside a `display: none` subtree returns. Nothing is ever remembered, so each
// redraw measures every cell on the screen again, and each measurement is a write followed by a
// layout read.
//
// Measured on a deck of 20 tiles (v1.49.0, 195x55 terminals, a 21,000-node document): 0.37 ms per
// measurement, 1,400–3,800 cells per screen — 0.5 to 1.4 s of the UI thread per hidden tile per
// scrolled frame. With several sessions working in the background that was one frame every 5 to 16
// seconds: 27 to 55 seconds blocked in a minute, and a click answered 8 seconds later. The CPU
// profile of one such stall: 8.9 s of 9.0 s in `_measure`.
//
// So the renderer's `renderRows` is skipped while its tile is not drawn, and the terminal is told it
// owes a full refresh, which xterm pays when the tile comes back on screen (its
// IntersectionObserver) — or `redrawIfSkipped`, for a tile hidden and shown again inside one frame,
// which no observer reports.
//
// This reaches into xterm's internals (`_core._renderService._renderer.value`), which no type
// promises. Everything is checked before it is touched and the function says whether it took, so a
// future xterm that moved them leaves the terminal working as it did, and the performance gate
// (qa/perf-gate.mjs, `data-term-hidden-skip`) fails instead of the app.

interface RowRenderer { renderRows(start: number, end: number): void }
interface RenderServiceInternals { _renderer?: { value?: RowRenderer }; _needsFullRefresh?: boolean }

export interface HiddenRenderGuard {
  /** False when this xterm's internals were not where they were expected: nothing was changed. */
  installed: boolean;
  /** Draw what was skipped, now that the tile is on screen. A no-op when nothing was. */
  redrawIfSkipped(): void;
}

/**
 * Keep `term` from drawing rows while `isDrawn()` is false.
 * `term` is an opened xterm Terminal; taken as `unknown` because what is used of it is private.
 */
export function skipRenderWhileHidden(term: unknown, isDrawn: () => boolean): HiddenRenderGuard {
  const service = (term as { _core?: { _renderService?: RenderServiceInternals } } | null)?._core?._renderService;
  const renderer = service?._renderer?.value;
  const refresh = (term as { refresh?: (start: number, end: number) => void; rows?: number } | null);
  if (!service || !renderer || typeof renderer.renderRows !== 'function' || typeof refresh?.refresh !== 'function') {
    return { installed: false, redrawIfSkipped: () => undefined };
  }
  const draw = renderer.renderRows.bind(renderer);
  let skipped = false;
  renderer.renderRows = (start: number, end: number): void => {
    if (!isDrawn()) {
      skipped = true;
      service._needsFullRefresh = true; // paid by xterm itself when the terminal is next seen
      return;
    }
    draw(start, end);
  };
  return {
    installed: true,
    redrawIfSkipped: () => {
      if (!skipped) return;
      skipped = false;
      const rows = typeof refresh.rows === 'number' ? refresh.rows : 0;
      if (rows > 0) refresh.refresh!(0, rows - 1);
    },
  };
}

/** Is this element laid out at all — neither it nor anything above it `display: none`? */
export function isElementDrawn(el: HTMLElement): boolean {
  if (typeof el.checkVisibility === 'function') return el.checkVisibility();
  return el.getClientRects().length > 0;
}

/**
 * Is this tile on screen? Asked by every tile for every draw it is about to make, so the answer for
 * the ones that are not must be free: a hidden tile is one without `show`, which is a class lookup.
 * Asking the document instead (`checkVisibility`) makes it bring its styles up to date first — and
 * with twenty tiles scrolling behind the one that is being redrawn, that was 333 ms of every 1.7 s
 * spent answering "no" (measured on v1.49.1).
 * `paneDrawn` is only asked for the selected tile: whether the pane holding it is displayed at all.
 */
export function tileDrawn(el: { classList: { contains(name: string): boolean } }, paneDrawn: () => boolean): boolean {
  return el.classList.contains('show') && paneDrawn();
}

/**
 * `read`, asked at most once per task. A terminal draws more than once in a frame (a scroll is a
 * selection refresh and a row refresh), and a question put to the document between two of those
 * draws is answered by laying out what the first one just wrote.
 */
export function oncePerTask(read: () => boolean, later: (fn: () => void) => void = (fn) => { setTimeout(fn, 0); }): () => boolean {
  let known: boolean | null = null;
  return () => {
    if (known === null) {
      known = read();
      later(() => { known = null; });
    }
    return known;
  };
}
