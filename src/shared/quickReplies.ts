// src/shared/quickReplies.ts
// The cockpit's quick replies: a handful of phrases the person sends often ("yes, go on", "commit
// it"), each one click or Ctrl+Shift+<n> away instead of retyped.

/** As many as there are digit keys for them. */
export const MAX_QUICK_REPLIES = 9;
export const QUICK_REPLY_MAX_CHARS = 500;

/**
 * The phrases as they are kept: trimmed, empty ones dropped, each one line (a newline would submit
 * half of it), at most MAX_QUICK_REPLIES. Anything that is not a list of strings is no list at all.
 */
export function sanitizeQuickReplies(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const t = v.replace(/\s*[\r\n]+\s*/g, ' ').trim().slice(0, QUICK_REPLY_MAX_CHARS);
    if (t) out.push(t);
    if (out.length === MAX_QUICK_REPLIES) break;
  }
  return out;
}

/** The settings field's text — one phrase per line — as a list. */
export function parseQuickReplyText(text: string): string[] {
  return sanitizeQuickReplies(text.split(/\r?\n/));
}

/** Ctrl+Shift+1..9 → 0..8, by the key's position (Shift turns `1` into `!` on most layouts). */
export function quickReplySlot(e: { type?: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey?: boolean; repeat?: boolean; code?: string }): number | null {
  if ((e.type && e.type !== 'keydown') || e.repeat || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return null;
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code ?? '');
  return m ? Number(m[1]) - 1 : null;
}
