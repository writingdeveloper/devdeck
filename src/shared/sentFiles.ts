// src/shared/sentFiles.ts
// Files sent to a session on another machine.
//
// Since 1.45.0 any kind travels, in pieces, up to MAX_UPLOAD_BYTES (see main/fileUploads for why
// the kind is no longer checked). The list below is what a host older than that takes through
// receiveFile, one message of at most 5MB: documents an agent reads (text, data, logs, PDF) whose
// bytes must match the name. A sender talking to such a host still uses it.

/** File kinds that travel; checked on the sender (to say so up front) and again on the host. */
export const SENDABLE_FILE_RE = /\.(?:txt|log|md|markdown|json|jsonl|ndjson|csv|tsv|ya?ml|xml|toml|ini|cfg|conf|diff|patch|sql|pdf)$/i;
/** What a sent file may weigh. A log or a PDF spec fits; the link's frame (8MB) holds it base64'd. */
export const MAX_SENT_FILE_BYTES = 5 * 1024 * 1024;
const NAME_MAX = 80;

/** Largest file one upload (main/fileUploads) may be: any kind, sent in pieces. */
export const MAX_UPLOAD_BYTES = 4 * 1024 ** 3;
/** Largest piece per call, before base64: well inside the link's 8MB frame once encoded. */
export const UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
/** How the machine receiving a file answers the start of an upload. */
export type UploadStart = { id: string } | { error: 'bad-name' | 'too-large' | 'no-space' | 'busy' };

/**
 * The sender's file name, made safe to write as the tail of a temp file name: no directories, no
 * characters Windows refuses, at most NAME_MAX characters with the extension kept. Null for a kind
 * that does not travel.
 */
export function safeSentFileName(name: string): string | null {
  const clean = cleanFileName(name);
  return clean && SENDABLE_FILE_RE.test(clean) ? clean : null;
}

/** The same, for a file of any kind (see main/fileUploads): only the name is made safe. Null when nothing usable is left. */
export function safeUploadName(name: string): string | null {
  return cleanFileName(name) || null;
}

function cleanFileName(name: string): string {
  const base = String(name).split(/[\\/]/).pop() ?? '';
  let clean = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  if (clean.length > NAME_MAX) {
    const ext = /\.[^.]{1,16}$/.exec(clean)?.[0] ?? '';
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
