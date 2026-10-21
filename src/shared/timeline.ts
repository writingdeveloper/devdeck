// src/shared/timeline.ts
// The cockpit's session timeline: the prompts the person sent, from the transcript, each tied to the
// row of the terminal it is drawn on and to the images that turn produced. Pure, so it is testable
// without a terminal.
import type { SessionImageRef, SessionTurn } from './sessionImages';

export interface PromptRow { row: number; text: string }

/** How many transcript turns may be missing from the screen (cleared, compacted) between two that show. */
const MAX_SKIP = 6;
/** Characters compared; a prompt row is cut at the terminal's width, so its start is what is shared. */
const COMPARE_CHARS = 40;

/** A prompt's text as it is compared: pointer, image placeholders and spacing away, case folded. */
export function promptKey(text: string): string {
  return text
    .replace(/^\s*[❯>›]\s+/, '')
    .replace(/\[Image\b[^\]]*\]/gi, ' ')
    .replace(/…$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function same(screen: string, turn: string): boolean {
  if (!screen || !turn) return screen === turn;
  const k = Math.min(screen.length, turn.length, COMPARE_CHARS);
  return screen.slice(0, k) === turn.slice(0, k);
}

/**
 * Pair each turn with the prompt row it is drawn on, walking both from the newest end.
 *
 * A turn the screen no longer shows (scrolled out, cleared, a long paste Claude Code folds into
 * `[Pasted text]`) is skipped, up to MAX_SKIP in a row; a prompt row no turn matches is left alone
 * rather than given a neighbour's turn. Returns turn id → buffer row.
 */
export function pairTurnsWithRows(turns: readonly SessionTurn[], rows: readonly PromptRow[]): Map<string, number> {
  const out = new Map<string, number>();
  let ti = turns.length - 1;
  for (let ri = rows.length - 1; ri >= 0 && ti >= 0; ri--) {
    const key = promptKey(rows[ri].text);
    for (let skip = 0; skip <= MAX_SKIP && ti - skip >= 0; skip++) {
      if (same(key, promptKey(turns[ti - skip].text))) {
        out.set(turns[ti - skip].id, rows[ri].row);
        ti -= skip + 1;
        break;
      }
    }
  }
  return out;
}

/**
 * The images each turn led to: an image belongs to the newest turn sent at or before it. Images
 * older than the first known turn belong to none. Returns turn id → image ids, oldest first.
 */
export function imagesByTurn(turns: readonly SessionTurn[], refs: readonly SessionImageRef[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const timed = turns.filter((t) => t.ts !== null);
  for (const ref of refs) {
    if (ref.ts === null) continue;
    let owner: SessionTurn | null = null;
    for (let i = timed.length - 1; i >= 0; i--) if ((timed[i].ts as number) <= ref.ts) { owner = timed[i]; break; }
    if (!owner) continue;
    const list = out.get(owner.id) ?? [];
    list.push(ref.id);
    out.set(owner.id, list);
  }
  return out;
}
