/**
 * URL detection over terminal buffer rows, including URLs BROKEN ACROSS ROWS.
 *
 * Two distinct wrap kinds:
 * - SOFT wrap: xterm wrapped the row itself (`wrapped: true` on the continuation row). Joining is
 *   ground truth — the row is one logical line.
 * - HARD wrap: a TUI (e.g. Claude Code's renderer) printed its own newline + indentation because the
 *   URL exceeded ITS inner width. The buffer has separate logical lines, so joining needs the same
 *   conservative heuristic as `unwrapCopiedUrl`: the continuation row, trimmed, must be a bare
 *   whitespace-free fragment that actually looks like URL innards — otherwise clicking a link that
 *   happens to sit above prose would corrupt the URL instead of fixing it.
 */

export interface BufferRow { text: string; wrapped: boolean }
export interface UrlHit {
  url: string;
  start: { row: number; col: number }; // 0-based, inclusive
  end: { row: number; col: number };   // 0-based, col exclusive
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
// Chars that are almost certainly trailing prose punctuation, not part of the URL.
const TRAILING_PUNCT = /[.,;:!?'"\)\]]+$/;
// A bare continuation fragment must look like URL innards: path/query/encoding chars, or be long.
const FRAGMENT_URLISH = /[/?&=%#._~-]/;
const MIN_BARE_FRAGMENT = 16;
const MAX_JOIN_ROWS = 6;

function stripTrailing(url: string): string {
  return url.replace(TRAILING_PUNCT, '');
}

/** True when `frag` (a trimmed, whitespace-free row) plausibly continues a URL rather than starting prose. */
function isContinuationFragment(frag: string): boolean {
  if (!frag || /\s/.test(frag)) return false;
  if (/^https?:\/\//i.test(frag)) return false; // a NEW url, not a continuation
  return FRAGMENT_URLISH.test(frag) || frag.length >= MIN_BARE_FRAGMENT;
}

/**
 * Find every URL across the given rows (0-based coordinates into those rows). Soft-wrapped rows are
 * joined unconditionally; hard-wrapped continuations only via the conservative fragment heuristic.
 */
// Image files only — click-to-open runs the OS default handler, so this list must never include
// anything executable. (Claude prints artifacts like "> [image] pinterest-assets\en\A1.png (95.8KB)".)
const IMAGE_PATH_RE = /(?:[A-Za-z]:)?[^\s"'`<>|*?:]+\.(?:png|jpe?g|gif|webp|bmp|svg|ico)\b/gi;

/**
 * Local image paths in terminal rows (relative or absolute, either slash), so a printed artifact can be
 * clicked open instead of hunted down in Explorer. URLs are excluded — the URL provider owns those.
 */
export function findImagePathLinks(rows: BufferRow[]): UrlHit[] {
  const hits: UrlHit[] = [];
  for (let r = 0; r < rows.length; r++) {
    const text = rows[r].text;
    IMAGE_PATH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMAGE_PATH_RE.exec(text)) !== null) {
      const token = m[0];
      // Part of a URL, not a filesystem path (the drive-letter prefix can even eat the 's' of 'https',
      // matching "s://cdn/…" — hence the '://' check): the URL provider owns those.
      if (token.includes('://') || token.startsWith('//') || /https?:$/i.test(text.slice(0, m.index))) continue;
      hits.push({ url: token, start: { row: r, col: m.index }, end: { row: r, col: m.index + token.length } });
    }
  }
  return hits;
}

export function findUrlLinks(rows: BufferRow[]): UrlHit[] {
  const hits: UrlHit[] = [];
  const consumed = new Set<number>(); // rows already used as a continuation of an earlier URL

  for (let r = 0; r < rows.length; r++) {
    if (consumed.has(r)) continue;
    const text = rows[r].text;
    URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(text)) !== null) {
      let url = m[0];
      const startCol = m.index;
      let endRow = r;
      let endCol = m.index + url.length;

      // Extend across following rows while the URL runs to the end of its row.
      let lastRowText = text;
      while (endRow - r < MAX_JOIN_ROWS - 1 && endCol === lastRowText.trimEnd().length && endRow + 1 < rows.length) {
        const next = rows[endRow + 1];
        const nextTrimmed = next.text.trimEnd();
        if (next.wrapped) {
          // Soft wrap: the row IS the same logical line — take its leading non-space run.
          const fragMatch = nextTrimmed.match(/^[^\s<>"'`]+/);
          if (!fragMatch) break;
          url += fragMatch[0];
          endRow += 1;
          endCol = fragMatch[0].length;
          lastRowText = nextTrimmed;
        } else {
          // Hard wrap: only join a bare, URL-ish fragment (may carry the message's indentation).
          const frag = nextTrimmed.trim();
          if (!isContinuationFragment(frag)) break;
          url += frag;
          endRow += 1;
          endCol = nextTrimmed.length; // fragment ends where the trimmed row ends (indent included before it)
          consumed.add(endRow);
          lastRowText = nextTrimmed;
        }
      }

      const stripped = stripTrailing(url);
      const strippedLoss = url.length - stripped.length;
      if (strippedLoss > 0) {
        // Pull the end column back by what we stripped (stripping never crosses a row boundary in practice;
        // if it would, fall back to keeping the range end — the URL string itself is already correct).
        endCol = Math.max(0, endCol - strippedLoss);
      }
      if (/^https?:\/\/[^/]+/i.test(stripped)) {
        hits.push({ url: stripped, start: { row: r, col: startCol }, end: { row: endRow, col: endCol } });
      }
    }
  }
  return hits;
}
