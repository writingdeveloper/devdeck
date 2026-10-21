// src/main/sessionImages.ts
// The images a Claude session handled, indexed incrementally off its transcript (see shared/sessionImages).
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeProjectPath, isValidSessionId } from '../shared/paths';
import { SessionImageCollector, embeddedImageBlocks, mergeImageRefs, parseEmbeddedImageId, type SessionImageRef, type SessionTurn } from '../shared/sessionImages';

/** How far back the first look reaches. Transcripts reach 500MB; the images worth seeing are recent. */
const FIRST_SCAN_TAIL_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 512 * 1024;
/** One line holding a screenshot is a few MB; past this it is not a line worth buffering. */
const MAX_LINE_BYTES = 48 * 1024 * 1024;
export const MAX_SESSION_IMAGES = 300;

interface Index { size: number; mtimeMs: number; offset: number; refs: SessionImageRef[]; collector: SessionImageCollector; head: string }
const cache = new Map<string, Index>();
const building = new Map<string, Promise<SessionImageRef[]>>();

export function claudeTranscriptPath(projectPath: string, sessionId: string, claudeProjectsDir: string): string | null {
  if (!isValidSessionId(sessionId)) return null; // never let a crafted id leave ~/.claude/projects
  return join(claudeProjectsDir, encodeProjectPath(projectPath), sessionId + '.jsonl');
}

/** The session's image references, oldest first. Reads only what was appended since the last call. */
export async function listSessionImages(file: string): Promise<SessionImageRef[]> {
  for (let inFlight = building.get(file); inFlight; inFlight = building.get(file)) await inFlight.catch(() => undefined);
  const work = refresh(file);
  building.set(file, work);
  try { return await work; } finally { if (building.get(file) === work) building.delete(file); }
}

/**
 * The person's prompts in the same session, oldest first — read in the same pass as the images, so
 * the timeline costs no second walk of a transcript that can reach hundreds of megabytes.
 */
export async function listSessionTurns(file: string): Promise<SessionTurn[]> {
  await listSessionImages(file);
  const idx = cache.get(file);
  return idx ? idx.collector.turns.map((t) => ({ ...t })) : [];
}

async function refresh(file: string): Promise<SessionImageRef[]> {
  let size: number; let mtimeMs: number;
  try { ({ size, mtimeMs } = await stat(file)); } catch { cache.delete(file); return []; }
  let idx = cache.get(file);
  if (idx && idx.size === size && idx.mtimeMs === mtimeMs) return idx.refs;
  const fh = await open(file, 'r');
  try {
    // A transcript is append-only. One that shrank, or whose first bytes changed, was replaced:
    // start over rather than read new bytes against offsets that no longer mean anything.
    const headBuf = Buffer.alloc(Math.min(256, size));
    await fh.read(headBuf, 0, headBuf.length, 0);
    const head = headBuf.toString('latin1');
    if (idx && (size < idx.offset || !head.startsWith(idx.head))) idx = undefined;
    if (!idx) {
      const start = Math.max(0, size - FIRST_SCAN_TAIL_BYTES);
      idx = { size: 0, mtimeMs: 0, offset: start, refs: [], collector: new SessionImageCollector(), head };
      // Starting mid-file lands mid-line: skip to the next line start.
      if (start > 0) idx.offset = await nextLineStart(fh, start, size);
    }
    let pos = idx.offset;
    let carry: Buffer = Buffer.alloc(0);
    let carryStart = pos;
    const added: SessionImageRef[] = [];
    while (pos < size) {
      const len = Math.min(CHUNK_BYTES, size - pos);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      let data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let lineStart = 0;
      for (let nl = data.indexOf(10, lineStart); nl !== -1; nl = data.indexOf(10, lineStart)) {
        const line = data.subarray(lineStart, nl);
        added.push(...idx.collector.add(line.toString('utf8'), carryStart + lineStart));
        lineStart = nl + 1;
      }
      carryStart += lineStart;
      data = data.subarray(lineStart);
      // A runaway "line" is dropped whole: its tail is skipped until the next newline.
      if (data.length > MAX_LINE_BYTES) {
        const resume = await nextLineStart(fh, pos, size);
        carry = Buffer.alloc(0); carryStart = resume; pos = resume;
      } else carry = Buffer.from(data);
    }
    // Only COMPLETE lines are indexed; a line still being written is read again next time.
    idx.offset = carryStart;
    idx.size = size; idx.mtimeMs = mtimeMs; idx.head = head;
    idx.refs = mergeImageRefs(idx.refs, added, MAX_SESSION_IMAGES);
    cache.set(file, idx);
    return idx.refs;
  } finally { await fh.close(); }
}

async function nextLineStart(fh: import('node:fs/promises').FileHandle, from: number, size: number): Promise<number> {
  const buf = Buffer.alloc(64 * 1024);
  for (let pos = from; pos < size;) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
    if (bytesRead <= 0) break;
    const nl = buf.subarray(0, bytesRead).indexOf(10);
    if (nl !== -1) return pos + nl + 1;
    pos += bytesRead;
  }
  return size;
}

/** The bytes of one embedded image, found again by its id. Null when the id no longer points at one. */
export async function readEmbeddedImage(file: string, id: string): Promise<{ mediaType: string; data: Buffer } | null> {
  const where = parseEmbeddedImageId(id);
  if (!where) return null;
  let fh: import('node:fs/promises').FileHandle;
  try { fh = await open(file, 'r'); } catch { return null; }
  try {
    const { size } = await fh.stat();
    if (where.offset >= size) return null;
    const parts: Buffer[] = [];
    let total = 0;
    for (let pos = where.offset; pos < size && total < MAX_LINE_BYTES;) {
      const buf = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - pos)); // most lines are small; a screenshot line takes a few reads
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead <= 0) break;
      const nl = buf.subarray(0, bytesRead).indexOf(10);
      if (nl !== -1) { parts.push(buf.subarray(0, nl)); total += nl; break; }
      parts.push(buf.subarray(0, bytesRead)); total += bytesRead; pos += bytesRead;
    }
    let entry: unknown;
    try { entry = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return null; }
    const img = embeddedImageBlocks(entry)[where.n];
    if (!img) return null;
    return { mediaType: img.block.media_type, data: Buffer.from(img.block.data, 'base64') };
  } finally { await fh.close(); }
}

export function _clearSessionImageCache(): void { cache.clear(); }
