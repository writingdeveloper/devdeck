function parseLine(raw: string): { type?: string; payload?: { type?: string; cwd?: string; message?: unknown } } | null {
  if (!raw.trim()) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** cwd from the rollout's session_meta header line, or null. */
export function codexCwd(jsonlText: string): string | null {
  for (const raw of jsonlText.split('\n')) {
    const o = parseLine(raw);
    if (o?.type === 'session_meta' && typeof o.payload?.cwd === 'string') return o.payload.cwd;
  }
  return null;
}

function userMessageText(o: ReturnType<typeof parseLine>): string | null {
  if (o?.type === 'event_msg' && o.payload?.type === 'user_message' && typeof o.payload.message === 'string') {
    const t = o.payload.message.trim();
    return t.length ? t : null;
  }
  return null;
}

/** First genuine user message in a Codex rollout, or null. */
export function codexFirstUserMessage(jsonlText: string): string | null {
  for (const raw of jsonlText.split('\n')) {
    const t = userMessageText(parseLine(raw));
    if (t) return t;
  }
  return null;
}

/** Last genuine user message in a Codex rollout, or null. */
export function codexLastUserMessage(jsonlText: string): string | null {
  const lines = jsonlText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = userMessageText(parseLine(lines[i]));
    if (t) return t;
  }
  return null;
}
