// src/main/fileUploads.ts
// A file of any kind and size sent to a session on this machine from another one, in pieces.
//
// The link carries at most 8MB per message, so a file travels as a series of chunks appended to a
// `.part` file in the temp directory; when the last byte is in it is renamed to its own name and
// that path is what gets typed into the session.
//
// Any kind is accepted. The device sending it holds "type in sessions", so it can already ask the
// agent here to do anything a file could; refusing an .exe in temp did not take anything away from
// it, and kept people from handing an agent a zip, a spreadsheet or a source file. What stays fixed:
// the file goes only into the temp directory, under a name DevDeck chooses and its sweeper removes
// after a day; DevDeck never opens or runs it; and on Windows it is marked as downloaded from the
// internet, so double-clicking it shows the usual warning.
import { randomUUID } from 'node:crypto';
import { open, rename, rm, statfs, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES, safeUploadName, type UploadStart } from '../shared/sentFiles';

/** An upload nobody has added to for this long is abandoned and its part file removed. */
const IDLE_MS = 5 * 60_000;
/** Uploads open at once; a sender sends one file at a time, so this is only a ceiling. */
const MAX_OPEN = 4;
/** Disk space an upload must leave free, so a large file never fills the disk the agent works on. */
const FREE_RESERVE_BYTES = 2 * 1024 ** 3;

interface Upload { file: string; handle: FileHandle; size: number; written: number; timer: ReturnType<typeof setTimeout> }

export interface UploadDeps {
  dir: string;
  /** File name prefix the temp sweeper owns. */
  prefix: string;
  /** Free bytes on the disk holding `dir`. */
  freeBytes?: (dir: string) => Promise<number>;
  platform?: NodeJS.Platform;
}

export function createUploads(deps: UploadDeps) {
  const uploads = new Map<string, Upload>();
  const freeBytes = deps.freeBytes ?? (async (dir: string) => { const s = await statfs(dir); return s.bavail * s.bsize; });
  const platform = deps.platform ?? process.platform;

  const drop = async (id: string): Promise<void> => {
    const u = uploads.get(id);
    if (!u) return;
    uploads.delete(id);
    clearTimeout(u.timer);
    await u.handle.close().catch(() => undefined);
    await rm(u.file, { force: true }).catch(() => undefined);
  };
  const touch = (id: string, u: Upload): void => {
    clearTimeout(u.timer);
    u.timer = setTimeout(() => { void drop(id); }, IDLE_MS);
    u.timer.unref?.();
  };

  return {
    async start(name: unknown, size: unknown): Promise<UploadStart> {
      const safe = typeof name === 'string' ? safeUploadName(name) : null;
      if (!safe) return { error: 'bad-name' };
      if (typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > MAX_UPLOAD_BYTES) return { error: 'too-large' };
      if (uploads.size >= MAX_OPEN) return { error: 'busy' };
      // What the uploads already open still have to write counts against the space too.
      const pending = [...uploads.values()].reduce((sum, u) => sum + (u.size - u.written), 0);
      let free: number;
      try { free = await freeBytes(deps.dir); } catch { free = Infinity; }
      if (free - pending - size < FREE_RESERVE_BYTES) return { error: 'no-space' };
      const id = randomUUID();
      const file = join(deps.dir, `${deps.prefix}${randomUUID()}-${safe}.part`);
      const handle = await open(file, 'wx');
      const u: Upload = { file, handle, size, written: 0, timer: setTimeout(() => {}, 0) };
      uploads.set(id, u);
      touch(id, u);
      return { id };
    },

    /** Append the next piece. `offset` must be where the last one ended. Answers the bytes written so far, or null. */
    async chunk(id: unknown, offset: unknown, base64: unknown): Promise<number | null> {
      const u = typeof id === 'string' ? uploads.get(id) : undefined;
      if (!u || typeof base64 !== 'string' || offset !== u.written) return null;
      if (base64.length > Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4) { await drop(id as string); return null; }
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length === 0 || u.written + bytes.length > u.size) { await drop(id as string); return null; }
      try { await u.handle.write(bytes, 0, bytes.length, u.written); } catch { await drop(id as string); return null; }
      u.written += bytes.length;
      touch(id as string, u);
      return u.written;
    },

    /** Close the file under its own name and answer its path; null unless every byte arrived. */
    async finish(id: unknown): Promise<string | null> {
      const u = typeof id === 'string' ? uploads.get(id) : undefined;
      if (!u) return null;
      if (u.written !== u.size) { await drop(id as string); return null; }
      uploads.delete(id as string);
      clearTimeout(u.timer);
      const final = u.file.slice(0, -'.part'.length);
      try {
        await u.handle.close();
        await rename(u.file, final);
      } catch { await rm(u.file, { force: true }).catch(() => undefined); return null; }
      // Mark of the Web: Windows treats it as downloaded, so opening it from Explorer warns first.
      if (platform === 'win32') await writeFile(`${final}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n').catch(() => undefined);
      return final;
    },

    async abort(id: unknown): Promise<void> { if (typeof id === 'string') await drop(id); },

    /** Remove every unfinished part file; on quit. */
    async dispose(): Promise<void> { await Promise.all([...uploads.keys()].map(drop)); },
  };
}
