// src/shared/sessionImages.ts
// What a Claude session has LOOKED AT, read off its transcript: the screenshots its tools returned,
// the images pasted into it, and the image files it wrote or read.
//
// Claude Desktop shows those inline; a terminal cannot, so the cockpit shows them beside it. The
// transcript is the only record that covers every source — a screenshot from an MCP tool exists
// nowhere else on disk, only as a base64 block inside the tool result that carried it.

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
}

const IMAGE_FILE_RE = /\.(?:png|jpe?g|gif|webp|bmp)$/i;
/** Tool-input fields that name a file the tool reads or writes. */
const PATH_FIELDS = ['file_path', 'path', 'filePath', 'output_path', 'outputPath', 'filename'];
/** How long a tool name is worth remembering for: tool results follow their call within a few lines. */
const TOOL_NAME_MEMORY = 256;
const TOOL_USE_RE = /"type":"tool_use","id":"([^"]{1,100})","name":"([^"]{1,200})"/g;

/** Cheap pre-filter on the raw bytes of a line, so most lines are never JSON-parsed at all. */
export function lineMayHoldImage(line: string): boolean {
  return line.includes('"type":"image"') || (line.includes('"tool_use"') && /\.(?:png|jpe?g|gif|webp|bmp)"/i.test(line));
}

interface Block { type?: unknown; source?: unknown; content?: unknown; tool_use_id?: unknown; id?: unknown; name?: unknown; input?: unknown }

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
  private toolNames = new Map<string, string>();

  /** `line` is one complete transcript line; `offset` is the byte offset it starts at. */
  add(line: string, offset: number): SessionImageRef[] {
    // Tool calls are named on every line that makes one — most never hold an image, so this is a
    // regex over the raw text rather than a parse.
    if (line.includes('"tool_use"')) {
      for (const m of line.matchAll(TOOL_USE_RE)) this.remember(m[1], m[2]);
    }
    if (!lineMayHoldImage(line)) return [];
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { return []; }
    const tsRaw = (entry as { timestamp?: unknown }).timestamp;
    const parsedTs = typeof tsRaw === 'string' ? Date.parse(tsRaw) : NaN;
    const ts = Number.isFinite(parsedTs) ? parsedTs : null;
    const refs: SessionImageRef[] = [];

    const content = (entry as { message?: { content?: unknown } })?.message?.content;
    if (Array.isArray(content)) {
      for (const raw of content) {
        const b = (raw ?? {}) as Block;
        if (b.type !== 'tool_use' || typeof b.name !== 'string') continue;
        if (typeof b.id === 'string') this.remember(b.id, b.name);
        const input = (b.input ?? {}) as Record<string, unknown>;
        for (const field of PATH_FIELDS) {
          const p = input[field];
          if (typeof p === 'string' && p.length < 1024 && IMAGE_FILE_RE.test(p)) {
            refs.push({ id: `f:${p}`, kind: 'file', ts, tool: b.name, path: p });
            break;
          }
        }
      }
    }
    embeddedImageBlocks(entry).forEach((img, n) => {
      refs.push({ id: `${offset}.${n}`, kind: img.kind, ts, tool: img.toolUseId ? this.toolNames.get(img.toolUseId) ?? null : null, path: null });
    });
    return refs;
  }

  private remember(id: string, name: string): void {
    this.toolNames.set(id, name);
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
