import { existsSync } from 'node:fs';
import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { join } from 'node:path';
import type { SessionMeta } from '../shared/types';
import { codexFirstUserMessage, codexLastUserMessage, codexSessionMeta, codexTailMeta, type CodexTailMeta } from '../shared/codexParse';
import { SESSION_ID_RE, cwdKey } from '../shared/paths';
import { cachedTailAnswer, findInTail } from './sessions';

const HEAD_BYTES = 64 * 1024;
const TAIL_CHUNK_BYTES = 1024 * 1024;
const TAIL_MAX_BYTES = 8 * 1024 * 1024;
/** Tail slice the summary is read from. Rollouts reach multiple GB, so this is never the whole file. */
const SUMMARY_TAIL_BYTES = 2 * 1024 * 1024;

export interface CodexRolloutHead {
  file: string;
  id: string;
  cwd: string;
  mtimeMs: number;
  birthtimeMs: number;
  size: number;
  firstMessage: string | null;
}

async function readHead(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => { /* file disappeared */ });
  }
}

/** Enumerate only rollout JSONL files, without recursively reading arbitrary files. */
async function rolloutFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop()!;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(file);
    }
  }
  return files;
}

/**
 * Heads already read, keyed by file path.
 *
 * A rollout's head is written once and never rewritten — the id, the cwd and the first user message
 * are fixed the moment the session starts, and everything after that is appended. So a file whose
 * size, mtime and birthtime are unchanged cannot have a different head, and re-reading 64 KiB from it
 * answers a question already answered.
 *
 * Measured on the machine this was reported from: 5,044 rollouts, 315 MB read on every pass, 1.73
 * seconds during which the main process did nothing else — no IPC replies, no terminal output, no
 * frames. That pass now costs one stat() per file.
 */
interface CachedHead {
  mtimeMs: number; birthtimeMs: number; size: number; head: CodexRolloutHead | null;
  /** cwdKey(head.cwd), worked out once — every per-project question compares against it. */
  key: string | null;
  /** The store the file was found under, so a lookup by id never answers from a different store. */
  root: string;
}
const _headCache = new Map<string, CachedHead>();

/** Test-only: forget every cached head so a fixture rewritten in place is re-read. */
export function _clearCodexHeadCache(): void { _headCache.clear(); _resolved.clear(); }

/** Files to touch between yields. Big enough that the syscalls dominate, small enough to stay smooth. */
const HEAD_SCAN_BATCH = 64;

type FileStat = { mtimeMs: number; birthtimeMs: number; size: number };

/**
 * One pass over the store. With `onlyKey`, the pass answers for ONE project, and skips the stat of
 * every rollout whose cached head already names a different one.
 *
 * Why that is safe: a head is written once and never rewritten (see above), and a rollout's path is
 * its timestamp plus its session uuid, so a file known to belong to another project cannot come to
 * belong to this one. Files with no usable head yet, files never seen, and this project's own files
 * are all still statted (and re-read on any change) exactly as in a full pass. The directory walk is
 * still complete, so new files are found and deleted ones still drop out of the cache.
 *
 * Why it matters: the cockpit asks this once per Codex tile per tick (drift detection), and on the
 * store this was reported from that was 5,000 stats — ~160 ms of the four-thread libuv pool, which
 * every other file read in the app queues behind — to learn about the few dozen files of one project.
 *
 * Each batch's stats go out together (in order of results, so the output order is the walk order,
 * as before): 5,000 one-at-a-time round-trips were most of a full pass's wall time.
 */
async function scanHeads(dir: string, onlyKey: string | null): Promise<CodexRolloutHead[]> {
  if (!existsSync(dir)) return [];
  const files = await rolloutFiles(dir);
  const heads: CodexRolloutHead[] = [];
  const seen = new Set<string>(files);
  for (let start = 0; start < files.length; start += HEAD_SCAN_BATCH) {
    if (start > 0) await yieldToLoop();
    const batch = files.slice(start, start + HEAD_SCAN_BATCH);
    const stats = await Promise.all(batch.map(async (file): Promise<FileStat | 'elsewhere' | null> => {
      const cached = _headCache.get(file);
      if (onlyKey !== null && cached?.head && cached.key !== onlyKey) return 'elsewhere';
      try { return await stat(file); } catch { return null; }
    }));
    for (let i = 0; i < batch.length; i++) {
      const file = batch[i];
      const st = stats[i];
      if (st === null || st === 'elsewhere') continue;
      const { mtimeMs, birthtimeMs, size } = st;
      const cached = _headCache.get(file);
      // Identity of the bytes we already read: same file, same length, same timestamps. An append
      // changes size and mtime, and a replaced file changes birthtime — neither can leave the head
      // it was parsed from intact while all three match.
      if (cached && cached.size === size && cached.mtimeMs === mtimeMs && cached.birthtimeMs === birthtimeMs) {
        if (cached.head && (onlyKey === null || cached.key === onlyKey)) heads.push({ ...cached.head, mtimeMs, birthtimeMs, size });
        continue;
      }
      const raw = await readHead(file);
      const meta = raw === null ? null : codexSessionMeta(raw);
      if (!meta || !meta.cwd || !SESSION_ID_RE.test(meta.id)) {
        // Remembered as unusable too: a file that is not a rollout stays not a rollout, and re-reading
        // 64 KiB from it every pass is the same waste as re-reading a good one.
        _headCache.set(file, { mtimeMs, birthtimeMs, size, head: null, key: null, root: dir });
        continue;
      }
      const head: CodexRolloutHead = {
        file, id: meta.id, cwd: meta.cwd, mtimeMs, birthtimeMs, size, firstMessage: codexFirstUserMessage(raw!),
      };
      const key = cwdKey(meta.cwd);
      _headCache.set(file, { mtimeMs, birthtimeMs, size, head, key, root: dir });
      if (onlyKey === null || key === onlyKey) heads.push(head);
    }
  }
  // Rollouts are deleted too; without this the cache would only ever grow.
  if (_headCache.size > seen.size) for (const key of [..._headCache.keys()]) if (!seen.has(key)) _headCache.delete(key);
  return heads;
}

/**
 * Passes in progress, by store + project. The deck's refresh asks for the whole store twice at once
 * (its session index and the usage report), and tiles restored together tick together; each used to
 * walk and stat the store on its own. A caller arriving mid-pass now shares it — and gets its own
 * copy of the array, because callers sort what they are given.
 */
const _passes = new Map<string, Promise<CodexRolloutHead[]>>();

async function sharedPass(dir: string, onlyKey: string | null): Promise<CodexRolloutHead[]> {
  const id = `${onlyKey ?? '*'}\n${dir}`;
  let pass = _passes.get(id);
  if (!pass) {
    pass = scanHeads(dir, onlyKey);
    _passes.set(id, pass);
    const started = pass;
    // Cleared on completion, never on a timer: the point is to share one walk, not to cache its answer.
    void started.catch(() => undefined).finally(() => { if (_passes.get(id) === started) _passes.delete(id); });
  }
  return (await pass).slice();
}

/** Every readable rollout's head, whatever project it belongs to (one bounded read per file). */
export async function listCodexRolloutHeads(dir: string): Promise<CodexRolloutHead[]> {
  return sharedPass(dir, null);
}

async function rolloutHeads(projectPath: string, dir: string): Promise<CodexRolloutHead[]> {
  // Match the recorded CWD as a canonical key: a rollout for a similarly named project must never
  // leak in, while the same project spelled with other separators / drive case still matches.
  return sharedPass(dir, cwdKey(projectPath));
}

/**
 * ALL Codex sessions grouped by canonical project cwd, newest-first — ONE pass over the rollout store.
 * The deck asks for every scanned project on each refresh; doing the per-project scan above 100× meant
 * re-reading the whole store 100 times, so the aggregate deck path uses this index instead.
 */
export async function indexCodexSessionsByCwd(dir: string): Promise<Map<string, SessionMeta[]>> {
  const out = new Map<string, SessionMeta[]>();
  for (const h of newestFirst(await listCodexRolloutHeads(dir))) {
    const key = cwdKey(h.cwd);
    const list = out.get(key) ?? [];
    list.push({ id: h.id, mtimeMs: h.mtimeMs, firstMessage: h.firstMessage });
    out.set(key, list);
  }
  return out;
}

function newestFirst<T extends { mtimeMs: number }>(rows: T[]): T[] {
  return rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Codex stores rollout files under nested date directories. */
export function codexAvailable(dir: string): boolean {
  return existsSync(dir);
}

/** Matching Codex sessions, newest-first, using only a bounded 64 KiB read for each preview. */
export async function listCodexSessions(projectPath: string, dir: string, limit = 5): Promise<SessionMeta[]> {
  return newestFirst(await rolloutHeads(projectPath, dir))
    .slice(0, Math.max(0, limit))
    .map(({ id, mtimeMs, firstMessage }) => ({ id, mtimeMs, firstMessage }));
}

/** Every matching on-disk session id, newest-first, for restore resolution. */
export async function listCodexSessionIds(projectPath: string, dir: string): Promise<string[]> {
  return newestFirst(await rolloutHeads(projectPath, dir)).map(({ id }) => id);
}

/** mtime and birthtime for matching sessions, used by live drift detection. */
export async function listCodexSessionStats(projectPath: string, dir: string): Promise<{ id: string; mtimeMs: number; birthtimeMs: number }[]> {
  return newestFirst(await rolloutHeads(projectPath, dir)).map(({ id, mtimeMs, birthtimeMs }) => ({ id, mtimeMs, birthtimeMs }));
}

/**
 * Resolve a session id to its rollout file, cached.
 *
 * Codex's store is flat — finding one session means reading the head of EVERY rollout (101 files on
 * a working machine). The cockpit asks per live session on a 30s tick, so without this the sidebar
 * would re-walk the whole store several times a minute. A rollout's path never changes, so the entry
 * only has to be re-validated for existence; the TTL is there for ids that appear later.
 */
const FILE_TTL_MS = 5 * 60_000;
const _resolved = new Map<string, { file: string; at: number }>();

/**
 * The rollout the head cache already knows for this id and project, when exactly one does.
 *
 * The miss path below is a pass over the store, and it was taken per PROJECT: the deck asks for every
 * project's resume cue on each refresh, and every five minutes each Codex project's entry expired and
 * walked and statted all 5,000 rollouts again — 100 projects meant 100 passes, measured at 18 seconds
 * of saturated file I/O on a synthetic store of that size. But the deck's own session index has just
 * made that same pass, so the head cache already holds the answer. Two matches (the same session id
 * in two files) are left to the walk, which picks one the way it always has.
 */
function knownRollout(dir: string, key: string, id: string): string | null {
  let found: string | null = null;
  for (const [file, entry] of _headCache) {
    if (entry.root !== dir || entry.key !== key || entry.head?.id !== id) continue;
    if (found) return null;
    found = file;
  }
  return found;
}

async function resolveRolloutFile(projectPath: string, id: string, dir: string, now = Date.now()): Promise<string | null> {
  const projectKey = cwdKey(projectPath);
  const key = `${projectKey}\u0000${id}`;
  const hit = _resolved.get(key);
  if (hit && now - hit.at < FILE_TTL_MS && existsSync(hit.file)) return hit.file;
  const known = knownRollout(dir, projectKey, id);
  const file = known && existsSync(known) ? known : (await rolloutHeads(projectPath, dir)).find((head) => head.id === id)?.file;
  if (!file) { _resolved.delete(key); return null; }
  _resolved.set(key, { file, at: now });
  return file;
}

/** Codex's answer to readClaudeSessionMeta: what the sidebar needs, plus the rollout's mtime. */
export type CodexSessionMeta = CodexTailMeta & { mtimeMs: number };

export function emptyCodexMeta(): CodexSessionMeta {
  return { assistantText: null, editedFiles: [], userText: null, model: null, contextTokens: 0, contextWindow: 0, mtimeMs: 0 };
}

// Same idea as the Claude meta cache: the tick re-asks constantly, and an unchanged rollout can only
// give the same answer. Bounded by the number of distinct sessions.
const _metaCache = new Map<string, { mtimeMs: number; value: CodexSessionMeta }>();

/**
 * Meta for one Codex session, from a bounded TAIL read of its rollout.
 * Never reads the whole file: the largest rollout observed is 2.7 GB.
 */
export async function readCodexSessionMeta(projectPath: string, id: string, dir: string): Promise<CodexSessionMeta> {
  if (!SESSION_ID_RE.test(id)) return emptyCodexMeta();
  const file = await resolveRolloutFile(projectPath, id, dir);
  if (!file) return emptyCodexMeta();
  let size: number;
  let mtimeMs: number;
  try { ({ size, mtimeMs } = await stat(file)); } catch { return emptyCodexMeta(); }
  const cached = _metaCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;
  // Async: this was a 2 MB readSync on every tick of a working Codex tile (its mtime moves each turn).
  let handle: FileHandle | null = null;
  try {
    const length = Math.min(SUMMARY_TAIL_BYTES, size);
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8', 0, bytesRead);
    // Drop the leading partial line unless we read from the very start of the file.
    const newline = text.indexOf('\n');
    const body = length === size ? text : newline < 0 ? '' : text.slice(newline + 1);
    const value = { ...codexTailMeta(body), mtimeMs };
    // `turn_context` is written when a turn STARTS, so a long turn can push it out of the tail window.
    // Fall back to the session's opening turn — the model rarely changes mid-session, and the head is
    // a 64 KiB read that only happens on a cache miss.
    if (!value.model) {
      const head = await readHead(file);
      if (head) value.model = codexTailMeta(head).model;
    }
    _metaCache.set(file, { mtimeMs, value });
    return value;
  } catch {
    return emptyCodexMeta();
  } finally {
    await handle?.close().catch(() => { /* file disappeared */ });
  }
}

/**
 * Find the last user message without trusting an id as a path component.  We locate a matching,
 * metadata-validated rollout first, then scan its final 8 MiB backward in bounded chunks — async,
 * searching each read's new lines only, and answered from cache while the rollout is unchanged
 * (see findInTail / cachedTailAnswer).
 */
export async function lastUserMessageForCodexSession(projectPath: string, id: string, dir: string): Promise<string | null> {
  if (!SESSION_ID_RE.test(id)) return null;
  const file = await resolveRolloutFile(projectPath, id, dir); // cached: the deck asks this per project
  if (!file) return null;
  return cachedTailAnswer(file, (handle, size) => findInTail(handle, size, TAIL_MAX_BYTES, TAIL_CHUNK_BYTES, codexLastUserMessage));
}
