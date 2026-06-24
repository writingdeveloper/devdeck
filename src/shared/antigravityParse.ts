/**
 * Pure parsers for Antigravity (agy CLI / IDE) on-disk data under ~/.gemini/antigravity.
 * The conversation .db is a SQLite file full of protobuf blobs; we do NOT decode protobuf
 * (no .proto available) — we only pull the workspace path, which protobuf stores as a
 * length-prefixed `file:///c:/...` string, so the byte before the marker is its exact length.
 */
const MARKER = 'file:///';

export function extractCwdFromDbBuffer(buf: Buffer): string | null {
  // latin1 = 1 byte per char, so string indices equal byte offsets (safe to map back into buf).
  const text = buf.toString('latin1');
  const at = text.indexOf(MARKER);
  if (at < 1) return null;
  const len = buf[at - 1]; // protobuf length prefix (1 byte for paths < 128 bytes)
  if (len < MARKER.length || len > 250 || at + len > buf.length) return null;
  const uri = buf.subarray(at, at + len).toString('utf8'); // byte-exact slice, then decode
  const m = /^file:\/\/\/([a-zA-Z]):\/(.*)$/.exec(uri);
  if (!m) return null;
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
}

function userRequest(content: unknown): string | null {
  if (typeof content !== 'string') return null;
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content);
  const t = (m ? m[1] : content).trim();
  return t.length ? t : null;
}

function isUserInput(o: unknown): o is { content: unknown } {
  return !!o && typeof o === 'object' && (o as { type?: unknown }).type === 'USER_INPUT';
}

function* transcriptLines(raw: string): Generator<unknown> {
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { yield JSON.parse(s); } catch { /* skip non-json */ }
  }
}

export function firstUserMessageFromTranscript(raw: string): string | null {
  for (const o of transcriptLines(raw)) {
    if (isUserInput(o)) { const t = userRequest(o.content); if (t) return t; }
  }
  return null;
}

export function lastUserMessageFromTranscript(raw: string): string | null {
  let found: string | null = null;
  for (const o of transcriptLines(raw)) {
    if (isUserInput(o)) { const t = userRequest(o.content); if (t) found = t; }
  }
  return found;
}
