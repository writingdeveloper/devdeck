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

/**
 * The agent's final message from `codex exec --json` output (JSONL of thread/turn/item events).
 * Its schema is NOT the rollout's: `{"type":"item.completed","item":{"type":"agent_message","text":…}}`.
 */
export function codexExecFinalMessage(raw: string): string | null {
  let last: string | null = null;
  for (const record of rolloutRecords(raw)) {
    if (record.type !== 'item.completed' || !isRecord(record.item)) continue;
    const item = record.item;
    if (item.type !== 'agent_message') continue;
    const text = trimmedText(item.text);
    if (text) last = text;
  }
  return last;
}

/** Last path segment, without node:path (this module is bundled into the renderer too). */
function baseName(p: string): string {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
}

/** Retained-text cap — only the opening sentence ever reaches the sidebar row. */
const TEXT_CAP = 400;
const EDITED_SHOWN = 4;

export interface CodexTailMeta {
  assistantText: string | null;
  editedFiles: string[];
  userText: string | null;
  /** Model of the most recent turn, e.g. "gpt-5.6-sol" (turn_context.model). */
  model: string | null;
  /** Context sent on the last turn (last_token_usage.input_tokens — cached tokens are a subset of it). */
  contextTokens: number;
  /** The model's real context window, as Codex recorded it (model_context_window). 0 when unknown. */
  contextWindow: number;
}

function positive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * What a Codex session's rollout TAIL can tell us: the summary sources, plus the model and context
 * size the sidebar shows.
 *
 * Rollouts are not like Claude's logs: the largest on this machine is 2.7 GB, so nothing here may
 * read a whole file. The events we need are all late-in-file anyway:
 *  - `task_complete.last_agent_message` / `agent_message.message` → what the agent just reported,
 *  - `patch_apply_end.changes` → the files it actually edited (keyed by absolute path),
 *  - a user message → resets the edited list, so it describes the CURRENT turn,
 *  - `token_count.info` → the last turn's input tokens AND the model's real context window, so a
 *    Codex row can show the same 🧠 % as a Claude one without guessing the window,
 *  - `turn_context.model` → the model of the most recent turn.
 * Codex has no plan/task-list events, so there is no activeForm equivalent to pick up.
 */
export function codexTailMeta(raw: string): CodexTailMeta {
  let assistantText: string | null = null;
  let userText: string | null = null;
  let model: string | null = null;
  let contextTokens = 0;
  let contextWindow = 0;
  let edited: string[] = [];
  for (const record of rolloutRecords(raw)) {
    if (record.type === 'turn_context' && isRecord(record.payload)) {
      const m = trimmedText(record.payload.model);
      if (m) model = m;
    }
    const user = userMessage(record);
    if (user) {
      userText = user.slice(0, TEXT_CAP);
      edited = []; // a fresh ask — the previous turn's edits no longer describe the work
      continue;
    }
    const payload = record.payload;
    if (!isRecord(payload)) continue;
    if (record.type === 'event_msg') {
      if (payload.type === 'task_complete') {
        const text = trimmedText(payload.last_agent_message);
        if (text) assistantText = text.slice(0, TEXT_CAP);
      } else if (payload.type === 'agent_message') {
        const text = trimmedText(payload.message);
        if (text) assistantText = text.slice(0, TEXT_CAP);
      } else if (payload.type === 'patch_apply_end' && isRecord(payload.changes)) {
        for (const file of Object.keys(payload.changes)) {
          const name = baseName(file);
          if (name) edited.push(name);
        }
      } else if (payload.type === 'token_count' && isRecord(payload.info)) {
        const info = payload.info;
        // input_tokens is the FULL input of that turn; cached_input_tokens is a subset of it
        // (input + output == total_tokens in the same record), so it must not be added on top.
        if (isRecord(info.last_token_usage)) {
          const used = positive(info.last_token_usage.input_tokens);
          if (used > 0) contextTokens = used;
        }
        const window = positive(info.model_context_window);
        if (window > 0) contextWindow = window;
      }
    } else if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant' && Array.isArray(payload.content)) {
      for (const item of payload.content) {
        if (!isRecord(item) || (item.type !== 'output_text' && item.type !== 'text')) continue;
        const text = trimmedText(item.text);
        if (text) { assistantText = text.slice(0, TEXT_CAP); break; }
      }
    }
  }
  const editedFiles: string[] = [];
  for (let i = edited.length - 1; i >= 0 && editedFiles.length < EDITED_SHOWN; i--) {
    if (!editedFiles.includes(edited[i])) editedFiles.push(edited[i]);
  }
  return { assistantText, editedFiles, userText, model, contextTokens, contextWindow };
}
