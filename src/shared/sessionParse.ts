/** Flatten a message's content (string or block array) to its plain text. Shared with the summary parser. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text'
        ? String((b as { text?: string }).text ?? '')
        : ''))
      .join('');
  }
  return '';
}

const WRAPPER_PREFIXES = ['<command-', '<local-command', 'Caveat:', 'Base directory for this skill:', '[SYSTEM NOTIFICATION', '<task-notification'];

/**
 * Remove attached-image bookkeeping from a user message.
 *
 * Pasting a screenshot leaves no prose behind: the agent records the attachment as
 * `[Image: source: C:\\…\\devdeck-paste-<uuid>.png]`, and DevDeck's own Ctrl+V handler is what writes
 * that temp path in the first place. As the newest user message it became the project's resume cue, so
 * a deck row asking "what was I doing here?" answered with a temp filename. Stripping it lets the cue
 * fall back to the last thing the user actually said.
 */
export function stripAttachmentNoise(text: string): string {
  return text
    // Both shapes the agent writes: `[Image: source: <path>]` for a pasted file and `[Image #4]` for
    // one it has already numbered. \b keeps it off words that merely start with "image".
    .replace(/\[Image\b[^\]]*\]/gi, ' ')
    .replace(/\S*devdeck-paste-[0-9a-f-]+\.(?:png|jpe?g|gif|webp)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True for harness scaffolding that is not something the user actually typed (commands, reminders, caveats). */
export function isWrapper(text: string): boolean {
  const t = text.trimStart();
  if (!t) return true;
  if (WRAPPER_PREFIXES.some((p) => t.startsWith(p))) return true;
  if (t.startsWith('<system-reminder') && t.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '').trim() === '') {
    return true;
  }
  return false;
}

/** First genuine user message in a session .jsonl, or null. */
export function firstUserMessage(jsonlText: string): string | null {
  for (const raw of jsonlText.split('\n')) {
    if (!raw.trim()) continue;
    let obj: { type?: string; message?: { content?: unknown } };
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    if (obj.type !== 'user' || !obj.message) continue;
    const text = textOf(obj.message.content).trim();
    if (!text || isWrapper(text)) continue;
    const clean = stripAttachmentNoise(text);
    if (!clean) continue; // a bare screenshot paste says nothing about what the user was doing
    return clean;
  }
  return null;
}

/** Last genuine user message in a session .jsonl, or null. Tail-scan mirror of firstUserMessage. */
export function lastUserMessage(jsonlText: string): string | null {
  const lines = jsonlText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    let obj: { type?: string; message?: { content?: unknown } };
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    if (obj.type !== 'user' || !obj.message) continue;
    const text = textOf(obj.message.content).trim();
    if (!text || isWrapper(text)) continue;
    const clean = stripAttachmentNoise(text);
    if (!clean) continue;
    return clean;
  }
  return null;
}
