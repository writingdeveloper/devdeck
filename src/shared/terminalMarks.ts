// src/shared/terminalMarks.ts
// Finding things in a Claude Code screen that the transcript also knows about: the rows where an
// image was shown, and the rows where the person's own prompts are.
//
// Claude Code prints `[Image]` where a tool returned an image and `[Image #N]` where the person
// pasted one, and draws each earlier prompt as `❯ text` (`>` where the pointer glyph is not used) on
// its own background. Pure over row text so it can be tested without a terminal.
import { toolServer, type SessionImageRef } from './sessionImages';

export interface ImagePlaceholder {
  /** Buffer row (0-based, absolute). */
  row: number;
  /** Column where `[Image` starts, and how many cells the placeholder takes. */
  col: number;
  len: number;
  kind: 'screenshot' | 'pasted';
}

const PLACEHOLDER_RE = /\[Image( #\d{1,4})?\]/g;

/** Every image placeholder on `rows` (row `i` is buffer row `firstRow + i`), top to bottom. */
export function findImagePlaceholders(rows: readonly string[], firstRow = 0): ImagePlaceholder[] {
  const out: ImagePlaceholder[] = [];
  rows.forEach((text, i) => {
    if (!text.includes('[Image')) return;
    for (const m of text.matchAll(PLACEHOLDER_RE)) {
      out.push({ row: firstRow + i, col: m.index ?? 0, len: m[0].length, kind: m[1] ? 'pasted' : 'screenshot' });
    }
  });
  return out;
}

/** How far above a placeholder the call that produced it is looked for (its arguments can wrap). */
const CALL_CONTEXT_ROWS = 12;
/** How many transcript images may be missing from the screen (folded output) between two that show. */
const MAX_SKIP = 4;
/** A tool call's first line: Claude Code's bullet (`●`, `⏺` on macOS), then the tool. */
const CALL_LINE_RE = /^\s*[●⏺•]\s/;

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The words a placeholder's call line should contain for `ref` to be the image it stands for. */
function callWords(ref: SessionImageRef): string[] {
  if (!ref.tool) return [];
  const server = toolServer(ref.tool);
  return [squash(server ?? ref.tool)].filter(Boolean);
}

/**
 * Pair each placeholder with the image it shows, newest first, the way they are on screen.
 *
 * The screen and the transcript list the same images in the same order, but either can be missing
 * some: the scrollback only reaches so far back, the transcript index only so many images, and
 * Claude Code folds long tool output. So the pairing walks both from the newest end, and a
 * placeholder is paired only when the call line above it names the same tool — a ref the screen
 * does not show is skipped (up to MAX_SKIP), and a placeholder nothing matches is left unpaired
 * rather than given a neighbour's image.
 */
export function pairPlaceholders(refs: readonly SessionImageRef[], marks: readonly ImagePlaceholder[], rowText: (row: number) => string): Map<number, string> {
  const paired = new Map<number, string>(); // index into marks -> ref id
  for (const kind of ['screenshot', 'pasted'] as const) {
    const ks = refs.filter((r) => r.kind === kind);
    let ri = ks.length - 1;
    for (let mi = marks.length - 1; mi >= 0 && ri >= 0; mi--) {
      const mark = marks[mi];
      if (mark.kind !== kind) continue;
      if (kind === 'pasted') { paired.set(mi, ks[ri].id); ri--; continue; } // nothing to check a paste against
      // From the call's own bullet line down to the placeholder — not further, or the call before it
      // would vouch for this one.
      let context = '';
      for (let r = mark.row - 1; r >= Math.max(0, mark.row - CALL_CONTEXT_ROWS); r--) {
        const t = rowText(r);
        context = squash(t) + ' ' + context;
        if (CALL_LINE_RE.test(t)) break;
      }
      for (let skip = 0; skip <= MAX_SKIP && ri - skip >= 0; skip++) {
        const words = callWords(ks[ri - skip]);
        if (words.length === 0 || words.every((w) => context.includes(w))) {
          paired.set(mi, ks[ri - skip].id);
          ri -= skip + 1;
          break;
        }
      }
    }
  }
  return paired;
}

export interface PromptRowInput {
  text: string;
  /** Whether the pointer cell is drawn on a background of its own (Claude Code's prompt band). */
  shaded: boolean;
}

const PROMPT_RE = /^\s{0,2}[❯>›]\s+\S/;
const RULE_RE = /^\s*[─━-]{8,}\s*$/;

/**
 * Rows holding an earlier prompt the person sent: a pointer, then text, on the prompt band's own
 * background. The input box at the bottom is not one — it sits below the last horizontal rule.
 */
export function findPromptRows(rows: readonly PromptRowInput[], firstRow = 0): number[] {
  // The live input box sits between two rules near the bottom. Everything from its top rule down is
  // the composer, not history.
  let end = rows.length;
  let bottomRule = -1;
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 40); i--) if (RULE_RE.test(rows[i].text)) { bottomRule = i; break; }
  if (bottomRule >= 0) {
    end = bottomRule;
    for (let i = bottomRule - 1; i >= Math.max(0, bottomRule - 15); i--) if (RULE_RE.test(rows[i].text)) { end = i; break; }
  }
  const out: number[] = [];
  for (let i = 0; i < end; i++) {
    const r = rows[i];
    if (r.shaded && PROMPT_RE.test(r.text)) out.push(firstRow + i);
  }
  return out;
}

/** The prompt row to jump to from a viewport whose top is `viewportTop`; null means "to the bottom". */
export function nextPromptRow(prompts: readonly number[], viewportTop: number, dir: -1 | 1): number | null {
  if (dir < 0) {
    for (let i = prompts.length - 1; i >= 0; i--) if (prompts[i] < viewportTop) return prompts[i];
    return prompts.length ? prompts[0] : null;
  }
  for (const p of prompts) if (p > viewportTop) return p;
  return null;
}
