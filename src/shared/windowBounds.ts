/** A saved window rectangle. Absent fields mean "let the OS decide" (first run centres the window). */
export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

export interface WorkArea { x: number; y: number; width: number; height: number }

/**
 * DevDeck opened at a fixed 1000x720 every single time, because nothing ever remembered the size the
 * user had chosen — so resizing it was a chore repeated at every launch.
 *
 * That default was also too small for what this window holds at once. Measured at 720px tall with a
 * realistic list, the rail showed TWO sessions and ONE project in full; at 920 it shows four and
 * three. The width clears the 1400px breakpoint below which the project rows start dropping columns.
 * Both are first-run values only — after that the window reopens wherever the user left it.
 */
export const WINDOW_DEFAULT_WIDTH = 1440;
export const WINDOW_DEFAULT_HEIGHT = 920;
export const WINDOW_MIN_WIDTH = 720;
export const WINDOW_MIN_HEIGHT = 480;

/** Enough of the title bar must land on a display for the window to be draggable back into view. */
const VISIBLE_MARGIN = 80;

function overlaps(bounds: Required<Pick<WindowBounds, 'x' | 'y' | 'width' | 'height'>>, area: WorkArea): boolean {
  const right = Math.min(bounds.x + bounds.width, area.x + area.width);
  const left = Math.max(bounds.x, area.x);
  const bottom = Math.min(bounds.y + bounds.height, area.y + area.height);
  const top = Math.max(bounds.y, area.y);
  return right - left >= VISIBLE_MARGIN && bottom - top >= VISIBLE_MARGIN;
}

export function sanitizeWindowBounds(value: unknown): WindowBounds | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);
  const width = num(candidate.width);
  const height = num(candidate.height);
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return null;
  const x = num(candidate.x);
  const y = num(candidate.y);
  return {
    width, height,
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
    ...(candidate.maximized === true ? { maximized: true } : {}),
  };
}

/**
 * What the window should open as.
 *
 * The saved rectangle is only honoured while it still lands on a display — unplugging the monitor it
 * was last on, or moving to a smaller screen, would otherwise open the window off-screen where it
 * cannot be reached. In that case the position is dropped (the OS centres it) but the SIZE is kept
 * where it fits, since that is the part the user actually chose.
 */
export function resolveWindowBounds(saved: unknown, displays: readonly WorkArea[]): WindowBounds {
  const area = displays[0];
  const fallbackWidth = area ? Math.min(WINDOW_DEFAULT_WIDTH, area.width) : WINDOW_DEFAULT_WIDTH;
  const fallbackHeight = area ? Math.min(WINDOW_DEFAULT_HEIGHT, area.height) : WINDOW_DEFAULT_HEIGHT;
  const clean = sanitizeWindowBounds(saved);
  if (!clean) return { width: fallbackWidth, height: fallbackHeight };

  const largest = displays.reduce<WorkArea | undefined>((best, d) => (!best || d.width * d.height > best.width * best.height ? d : best), undefined);
  const width = Math.max(WINDOW_MIN_WIDTH, Math.min(clean.width, largest?.width ?? clean.width));
  const height = Math.max(WINDOW_MIN_HEIGHT, Math.min(clean.height, largest?.height ?? clean.height));
  const placed = clean.x !== undefined && clean.y !== undefined
    && displays.some((d) => overlaps({ x: clean.x!, y: clean.y!, width, height }, d));

  return {
    width, height,
    ...(placed ? { x: clean.x, y: clean.y } : {}),
    ...(clean.maximized ? { maximized: true } : {}),
  };
}
