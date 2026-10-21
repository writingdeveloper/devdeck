// src/renderer/attachments.ts
// Files given to a session by dropping them on its terminal or picking them with 📎.
//
// An agent takes a file by its PATH, typed into its prompt — the same trick the Ctrl+V image paste
// uses. A local session gets the file's own path. A session on another machine cannot read this
// disk, so the file travels instead and the path it was written to over there is what gets typed:
// an image as PNG, a document (text, data, log, PDF — see shared/sentFiles) as it is.
import { MAX_SENT_FILE_BYTES, SENDABLE_FILE_RE } from '../shared/sentFiles';

/** What the host accepts per image (see cockpit:receiveImage); kept a little under it. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024 - 64 * 1024;
const IMAGE_TYPE_RE = /^image\/(?:png|jpe?g|gif|webp|bmp)$/i;
const IMAGE_NAME_RE = /\.(?:png|jpe?g|gif|webp|bmp)$/i;

export interface AttachTarget {
  local: boolean;
  /** Writes PNG bytes where the session runs and returns that path. */
  receiveImage(base64: string): Promise<string | null>;
  /** Writes a document where the session runs and returns that path; absent where it cannot. */
  receiveFile?(name: string, base64: string): Promise<string | null>;
  pathForFile(file: File): string;
}

/**
 * `skippedNonImage`: kinds that cannot travel at all. `hostTooOld`: documents the other machine
 * could not take because its DevDeck predates receiving them.
 */
export interface AttachOutcome { paths: string[]; skippedNonImage: number; failed: number; tooLarge: number; hostTooOld: number }

export function isImageFile(file: File): boolean {
  return IMAGE_TYPE_RE.test(file.type) || IMAGE_NAME_RE.test(file.name);
}

export function isSendableFile(file: File): boolean {
  return SENDABLE_FILE_RE.test(file.name);
}

/** What the 📎 picker offers for a session on another machine. */
export const REMOTE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/bmp,' +
  '.txt,.log,.md,.markdown,.json,.jsonl,.ndjson,.csv,.tsv,.yaml,.yml,.xml,.toml,.ini,.cfg,.conf,.diff,.patch,.sql,.pdf';

export async function attachFiles(files: File[], target: AttachTarget): Promise<AttachOutcome> {
  const out: AttachOutcome = { paths: [], skippedNonImage: 0, failed: 0, tooLarge: 0, hostTooOld: 0 };
  for (const file of files) {
    const own = target.local ? target.pathForFile(file) : '';
    if (own) { out.paths.push(own); continue; }
    // Remote, or dragged out of a browser with no file behind it: the file itself has to travel.
    if (!isImageFile(file)) {
      if (!target.receiveFile || !isSendableFile(file)) { out.skippedNonImage++; continue; }
      if (file.size > MAX_SENT_FILE_BYTES) { out.tooLarge++; continue; }
      let landed: string | null = null;
      try { landed = await target.receiveFile(file.name, bytesToBase64(new Uint8Array(await file.arrayBuffer()))); }
      catch (error) {
        if (/no such method/.test(error instanceof Error ? error.message : String(error))) { out.hostTooOld++; continue; }
        landed = null;
      }
      if (landed) out.paths.push(landed); else out.failed++;
      continue;
    }
    let png: string | null;
    try { png = await toPngBase64(file); } catch { png = null; }
    if (png === null) { out.tooLarge++; continue; }
    let landed: string | null = null;
    try { landed = await target.receiveImage(png); } catch { landed = null; }
    if (landed) out.paths.push(landed); else out.failed++;
  }
  return out;
}

/** Paths as one prompt fragment; a path with a space is quoted so it stays one argument. */
export function pathsAsPrompt(paths: string[]): string {
  return paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ') + ' ';
}

/**
 * The image as base64 PNG within the size the host accepts. A PNG that already fits goes as it is;
 * anything else is redrawn — and scaled down until it fits, since a phone photo as PNG is 20MB.
 * Null when it cannot be decoded or will not fit even small.
 */
async function toPngBase64(file: File): Promise<string | null> {
  if (/png$/i.test(file.type) && file.size <= MAX_IMAGE_BYTES) return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
  const bitmap = await createImageBitmap(file);
  try { return await fitPngBase64(bitmap, bitmap.width, bitmap.height); } finally { bitmap.close(); }
}

/**
 * A drawable (an image, a canvas with marks on it) as base64 PNG within the size the host accepts,
 * scaled down until it fits. Null when it will not fit even small.
 */
export async function fitPngBase64(source: CanvasImageSource, width: number, height: number): Promise<string | null> {
  let scale = 1;
  for (let attempt = 0; attempt < 6; attempt++) {
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d'); if (!ctx) return null;
    ctx.drawImage(source, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return null;
    if (blob.size <= MAX_IMAGE_BYTES) return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    scale *= Math.sqrt(MAX_IMAGE_BYTES / blob.size) * 0.9;
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000; // String.fromCharCode's argument list is bounded
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}
