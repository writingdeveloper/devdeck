function textOf(content: unknown): string {
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

const WRAPPER_PREFIXES = ['<command-', '<local-command', 'Caveat:', 'Base directory for this skill:'];

function isWrapper(text: string): boolean {
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
    return text;
  }
  return null;
}
