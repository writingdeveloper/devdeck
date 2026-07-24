type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function* rolloutRecords(raw: string): Generator<JsonRecord> {
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) yield value;
    } catch {
      // Rollouts are append-only JSONL and may contain incomplete or corrupt lines.
    }
  }
}

function trimmedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function userMessage(record: JsonRecord): string | null {
  const payload = record.payload;
  if (!isRecord(payload)) return null;

  if (record.type === 'event_msg' && payload.type === 'user_message') {
    return trimmedText(payload.message);
  }

  if (record.type !== 'response_item' || payload.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) {
    return null;
  }

  for (const item of payload.content) {
    if (!isRecord(item) || item.type !== 'input_text') continue;
    const text = trimmedText(item.text);
    if (text) return text;
  }
  return null;
}

export function codexSessionMeta(raw: string): { id: string; cwd: string } | null {
  for (const record of rolloutRecords(raw)) {
    if (record.type !== 'session_meta' || !isRecord(record.payload)) continue;
    const { id, cwd } = record.payload;
    if (typeof id === 'string' && typeof cwd === 'string') return { id, cwd };
  }
  return null;
}

export function codexFirstUserMessage(raw: string): string | null {
  for (const record of rolloutRecords(raw)) {
    const message = userMessage(record);
    if (message) return message;
  }
  return null;
}

export function codexLastUserMessage(raw: string): string | null {
  let last: string | null = null;
  for (const record of rolloutRecords(raw)) {
    const message = userMessage(record);
    if (message) last = message;
  }
  return last;
}
