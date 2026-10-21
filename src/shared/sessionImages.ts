// src/shared/sessionImages.ts
// What a Claude session has LOOKED AT, read off its transcript: the screenshots its tools returned,
// the images pasted into it, and the image files it wrote or read.
//
// Claude Desktop shows those inline; a terminal cannot, so the cockpit shows them beside it. The
// transcript is the only record that covers every source — a screenshot from an MCP tool exists
// nowhere else on disk, only as a base64 block inside the tool result that carried it.
import { isWrapper } from './sessionParse';

/** `screenshot` = an image a tool returned; `pasted` = an image the person sent; `file` = an image path a tool touched. */
export type SessionImageKind = 'screenshot' | 'pasted' | 'file';

export interface SessionImageRef {
  /** `<byte offset of the line>.<n>` for an embedded image (the n-th image block on that line); `f:<path>` for a file. */
  id: string;
  kind: SessionImageKind;
  /** Epoch ms of the transcript line, when it carried one. */
  ts: number | null;
  /** The tool that produced or touched it (`mcp__playwright__browser_take_screenshot`, `Write`, …). */
  tool: string | null;
  /** For `file`: the path exactly as the tool named it. */
  path: string | null;
  /**
   * What the tool was asked to do, as one line — the element, file or URL it was pointed at. Absent
   * from hosts older than 1.40.0, so read as optional.
   */
  detail?: string | null;
  /** The page that tool's browser was last sent to, for a screenshot from a browser tool. */
  page?: string | null;
  /** The agent's last words before this image — or, for a pasted image, what the person wrote with it. */
  said?: string | null;
}

/** One prompt the person sent, for the cockpit's timeline. */
export interface SessionTurn {
  /** `t<byte offset of the prompt's line>` — stable for as long as the transcript is. */
  id: string;
  ts: number | null;
  /** The prompt's first line; '' for a prompt that was only a pasted image. */
  text: string;
  /** How many images the person pasted with it. */
  pasted: number;
  /** The agent's last words in reply, as one line; null until it has said something. */
  reply: string | null;
}

/** How many turns a session's index keeps — far more than a terminal's scrollback shows. */
export const MAX_SESSION_TURNS = 500;

const IMAGE_FILE_RE = /\.(?:png|jpe?g|gif|webp|bmp)$/i;
/** Tool-input fields that name a file the tool reads or writes. */
const PATH_FIELDS = ['file_path', 'path', 'filePath', 'output_path', 'outputPath', 'filename'];
/** How long a tool name is worth remembering for: tool results follow their call within a few lines. */
const TOOL_NAME_MEMORY = 256;
const TOOL_USE_RE = /"type":"tool_use","id":"([^"]{1,100})","name":"([^"]{1,200})"/g;
/**
 * Lines past this are not parsed just for context: they are the ones carrying a whole file in a
 * Write call or a screenshot, and JSON-parsing megabytes per tool call would dwarf the index itself.
 */
const CONTEXT_PARSE_MAX = 64 * 1024;
const CONTEXT_MAX_CHARS = 160;
/** Tool-input fields worth showing as "what it was asked", most telling first. */
const DETAIL_FIELDS = ['url', 'element', 'selector', 'filename', 'file_path', 'path', 'filePath', 'name', 'description', 'query', 'text'];

/** Cheap pre-filter on the raw bytes of a line, so most lines are never JSON-parsed at all. */
export function lineMayHoldImage(line: string): boolean {
  return line.includes('"type":"image"') || (line.includes('"tool_use"') && /\.(?:png|jpe?g|gif|webp|bmp)"/i.test(line));
}

interface Block { type?: unknown; source?: unknown; content?: unknown; tool_use_id?: unknown; id?: unknown; name?: unknown; input?: unknown; text?: unknown }

/** One line of at most CONTEXT_MAX_CHARS: the first non-empty line of `text`, whitespace collapsed. */
export function oneLine(text: string): string | null {
  const first = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).find((l) => l.length > 0);
  if (!first) return null;
  return first.length > CONTEXT_MAX_CHARS ? first.slice(0, CONTEXT_MAX_CHARS - 1) + '…' : first;
}

/** The input field that best says what a tool call was aimed at. */
export function toolDetail(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  for (const field of DETAIL_FIELDS) {
    const v = rec[field];
    if (typeof v === 'string' && v.trim() && v.length <= 2000) return oneLine(v);
  }
  return null;
}

/** `mcp__playwright__browser_navigate` → `playwright`; a built-in tool has no server. */
export function toolServer(tool: string | null): string | null {
  return tool ? /^mcp__(.+?)__/.exec(tool)?.[1] ?? null : null;
}

function textOf(content: unknown[]): string | null {
  let out: string | null = null;
  for (const raw of content) {
    const b = (raw ?? {}) as Block;
    if (b.type === 'text' && typeof b.text === 'string') {
      const t = oneLine(stripImageNoise(b.text));
      if (t) out = t; // the LAST thing said is the one that leads into what follows
    }
  }
  return out;
}

/** The placeholders an agent writes where an image was, which say nothing on their own. */
function stripImageNoise(text: string): string {
  return text.replace(/\[Image\b[^\]]*\]/gi, ' ').replace(/\S*devdeck-paste-[0-9a-f-]+\.(?:png|jpe?g|gif|webp)/gi, ' ');
}

function isEmbeddedImage(b: Block): boolean {
  if (b.type !== 'image' || !b.source || typeof b.source !== 'object') return false;
  const s = b.source as { type?: unknown; data?: unknown };
  return s.type === 'base64' && typeof s.data === 'string' && s.data.length > 0;
}

/**
 * Every embedded image block on a parsed line, in a fixed order — the order `id`'s `n` counts in, so
 * the same walk finds a block again when its bytes are asked for.
 */
export function embeddedImageBlocks(entry: unknown): { block: { media_type: string; data: string }; kind: 'screenshot' | 'pasted'; toolUseId: string | null }[] {
  const out: { block: { media_type: string; data: string }; kind: 'screenshot' | 'pasted'; toolUseId: string | null }[] = [];
  const content = (entry as { message?: { content?: unknown } })?.message?.content;
  if (!Array.isArray(content)) return out;
  const push = (b: Block, kind: 'screenshot' | 'pasted', toolUseId: string | null): void => {
    const s = b.source as { media_type?: unknown; data: string };
    out.push({ block: { media_type: typeof s.media_type === 'string' ? s.media_type : 'image/png', data: s.data }, kind, toolUseId });
  };
  for (const raw of content) {
    const b = (raw ?? {}) as Block;
    if (isEmbeddedImage(b)) push(b, 'pasted', null);
    else if (b.type === 'tool_result' && Array.isArray(b.content)) {
      const toolUseId = typeof b.tool_use_id === 'string' ? b.tool_use_id : null;
      for (const inner of b.content) if (isEmbeddedImage((inner ?? {}) as Block)) push(inner as Block, 'screenshot', toolUseId);
    }
  }
  return out;
}

/**
 * Reads image references off transcript lines, in file order.
 *
 * Stateful only to name tools: a tool RESULT carries the call's id, not its name, so the names of
 * recent calls are remembered (boundedly) as their lines go by.
 */
export class SessionImageCollector {
  private toolNames = new Map<string, { name: string; detail: string | null }>();
  /** Per MCP server, the page its browser was last sent to. */
  private pages = new Map<string, string>();
  private lastSaid: string | null = null;
  /** The person's prompts, oldest first, at most MAX_SESSION_TURNS. */
  readonly turns: SessionTurn[] = [];

  /** `line` is one complete transcript line; `offset` is the byte offset it starts at. */
  add(line: string, offset: number): SessionImageRef[] {
    const mayHoldImage = lineMayHoldImage(line);
    // Context comes from lines that hold no image: the calls that led up to one and what the agent
    // said meanwhile. Only small lines are parsed for it; the rest are named by a regex alone.
    const small = line.length <= CONTEXT_PARSE_MAX;
    let entry: unknown;
    if (mayHoldImage || (small && (line.includes('"tool_use"') || line.includes('"type":"text"') || line.includes('"type":"user"')))) {
      try { entry = JSON.parse(line); } catch { entry = undefined; }
    }
    if (entry === undefined && line.includes('"tool_use"')) {
      for (const m of line.matchAll(TOOL_USE_RE)) this.remember(m[1], m[2], null);
    }
    const content = (entry as { message?: { role?: unknown; content?: unknown } } | undefined)?.message?.content;
    const role = (entry as { message?: { role?: unknown } } | undefined)?.message?.role;
    const blocks = Array.isArray(content) ? content : [];
    const refs: SessionImageRef[] = [];
    const tsRaw = (entry as { timestamp?: unknown } | undefined)?.timestamp;
    const parsedTs = typeof tsRaw === 'string' ? Date.parse(tsRaw) : NaN;
    const ts = Number.isFinite(parsedTs) ? parsedTs : null;

    for (const raw of blocks) {
      const b = (raw ?? {}) as Block;
      if (b.type !== 'tool_use' || typeof b.name !== 'string') continue;
      const detail = toolDetail(b.input);
      if (typeof b.id === 'string') this.remember(b.id, b.name, detail);
      const input = (b.input ?? {}) as Record<string, unknown>;
      const server = toolServer(b.name);
      if (server && typeof input.url === 'string' && /^https?:\/\//i.test(input.url)) this.pages.set(server, oneLine(input.url) ?? input.url);
      if (!mayHoldImage) continue;
      for (const field of PATH_FIELDS) {
        const p = input[field];
        if (typeof p === 'string' && p.length < 1024 && IMAGE_FILE_RE.test(p)) {
          refs.push({ id: `f:${p}`, kind: 'file', ts, tool: b.name, path: p, detail, page: null, said: this.lastSaid });
          break;
        }
      }
    }
    // What the agent said; a user line's text belongs to that user's own images, read below.
    const said = blocks.length ? textOf(blocks) : null;
    if (role === 'assistant' && said) {
      this.lastSaid = said;
      const turn = this.turns[this.turns.length - 1];
      if (turn) turn.reply = said;
    }
    if (role === 'user' && entry !== undefined) this.noteTurn(entry, content, offset, ts);

    if (mayHoldImage && entry !== undefined) {
      embeddedImageBlocks(entry).forEach((img, n) => {
        const call = img.toolUseId ? this.toolNames.get(img.toolUseId) : undefined;
        const tool = call?.name ?? null;
        const server = toolServer(tool);
        refs.push({
          id: `${offset}.${n}`, kind: img.kind, ts, tool, path: null,
          detail: call?.detail ?? null,
          page: server && /browser|chrome|playwright|puppeteer/i.test(tool ?? '') ? this.pages.get(server) ?? null : null,
          said: img.kind === 'pasted' ? said : this.lastSaid,
        });
      });
    }
    return refs;
  }

  /** A user line that is something the person typed — not a tool result, a command or a reminder. */
  private noteTurn(entry: unknown, content: unknown, offset: number, ts: number | null): void {
    const e = entry as { type?: unknown; isMeta?: unknown; isSidechain?: unknown; isCompactSummary?: unknown; isVisibleInTranscriptOnly?: unknown };
    if (e.type !== 'user' || e.isMeta === true || e.isSidechain === true) return;
    // The summary Claude Code writes when it compacts a conversation is filed as a user line.
    if (e.isCompactSummary === true || e.isVisibleInTranscriptOnly === true) return;
    let raw = '';
    let pasted = 0;
    if (typeof content === 'string') raw = content;
    else if (Array.isArray(content)) {
      for (const item of content) {
        const b = (item ?? {}) as Block;
        if (b.type === 'tool_result') return; // the agent's own tool coming back, not a prompt
        if (b.type === 'text' && typeof b.text === 'string') raw += (raw ? '\n' : '') + b.text;
        else if (isEmbeddedImage(b)) pasted++;
      }
    } else return;
    if (raw && isWrapper(raw)) return;
    if (/^\s*\[Request interrupted/.test(raw)) return;
    // Pasted text is recorded inside a <pasted_content> wrapper; what matters is what was pasted.
    raw = raw.replace(/<\/?pasted_content\b[^>]*>/g, '');
    const text = oneLine(stripImageNoise(raw)) ?? '';
    if (!text && pasted === 0) return;
    this.turns.push({ id: `t${offset}`, ts, text, pasted, reply: null });
    if (this.turns.length > MAX_SESSION_TURNS) this.turns.splice(0, this.turns.length - MAX_SESSION_TURNS);
  }

  private remember(id: string, name: string, detail: string | null): void {
    this.toolNames.set(id, { name, detail });
    if (this.toolNames.size > TOOL_NAME_MEMORY) this.toolNames.delete(this.toolNames.keys().next().value as string);
  }
}

/**
 * Keep the newest `limit` references, one per file path (a file the agent rewrote ten times is one
 * image, shown at its latest touch). Newest last, as in the transcript.
 */
export function mergeImageRefs(existing: SessionImageRef[], added: SessionImageRef[], limit: number): SessionImageRef[] {
  if (added.length === 0) return existing;
  const addedFiles = new Set(added.filter((r) => r.kind === 'file').map((r) => r.id));
  const merged = existing.filter((r) => !addedFiles.has(r.id));
  const seen = new Set<string>();
  const dedupedAdded: SessionImageRef[] = [];
  for (let i = added.length - 1; i >= 0; i--) {
    const r = added[i];
    if (r.kind === 'file') { if (seen.has(r.id)) continue; seen.add(r.id); }
    dedupedAdded.unshift(r);
  }
  const all = merged.concat(dedupedAdded);
  return all.length > limit ? all.slice(all.length - limit) : all;
}

/** Parse an embedded-image id back into where its line starts and which block it is. */
export function parseEmbeddedImageId(id: string): { offset: number; n: number } | null {
  const m = /^(\d{1,15})\.(\d{1,4})$/.exec(id);
  if (!m) return null;
  return { offset: Number(m[1]), n: Number(m[2]) };
}
