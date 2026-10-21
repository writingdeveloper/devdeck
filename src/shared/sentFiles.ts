// src/shared/sentFiles.ts
// Which files besides images may be sent to a session on another machine, and how one is checked
// before it is written there.
//
// The host writes what it is sent into its temp directory for the agent to read off a path, on
// behalf of a device that merely holds "type in sessions". So the kinds are documents an agent reads
// — text, data, logs, PDF — and never anything a double-click would run: no scripts, no
// executables, no HTML.

/** File kinds that travel; checked on the sender (to say so up front) and again on the host. */
export const SENDABLE_FILE_RE = /\.(?:txt|log|md|markdown|json|jsonl|ndjson|csv|tsv|ya?ml|xml|toml|ini|cfg|conf|diff|patch|sql|pdf)$/i;
/** What a sent file may weigh. A log or a PDF spec fits; the link's frame (8MB) holds it base64'd. */
export const MAX_SENT_FILE_BYTES = 5 * 1024 * 1024;
const NAME_MAX = 80;

/**
 * The sender's file name, made safe to write as the tail of a temp file name: no directories, no
 * characters Windows refuses, at most NAME_MAX characters with the extension kept. Null for a kind
 * that does not travel.
 */
export function safeSentFileName(name: string): string | null {
  const base = String(name).split(/[\\/]/).pop() ?? '';
  let clean = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  if (!SENDABLE_FILE_RE.test(clean)) return null;
  if (clean.length > NAME_MAX) {
    const ext = /\.[^.]+$/.exec(clean)?.[0] ?? '';
    clean = clean.slice(0, NAME_MAX - ext.length) + ext;
  }
  return clean;
}

/**
 * Whether the bytes are what the name says: a PDF starts with `%PDF-`, and everything else is text,
 * which never holds a NUL byte. A renamed executable is neither.
 */
export function sentFileContentOk(name: string, bytes: Uint8Array): boolean {
  if (bytes.length > MAX_SENT_FILE_BYTES) return false;
  if (/\.pdf$/i.test(name)) return bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';
  return !bytes.includes(0);
}
