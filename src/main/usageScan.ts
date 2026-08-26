import { existsSync, createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { encodeProjectPath } from '../shared/paths';

/** ASCII line feed — transcripts are newline-delimited JSON. */
const NEWLINE = 0x0a;
import { emptyTotals, addUsage, addTotals, estimateCost, activeMsFromTimestamps, priceFor, SYNTHETIC_MODEL, type UsageTotals, type RawUsage } from '../shared/usage';
import type { LocalDailyUsage, LocalModelUsage, LocalProjectUsage, ProviderUsageSlice } from '../shared/localUsage';

// Cache: filepath -> per-file DIGEST — (day × model) usage rollups + message timestamps — NOT the raw
// text. History: caching every file's full text forever ballooned the main process to several GB and
// crashed it (V8 OOM, v1.12.2); the follow-up "don't retain files over 5MB" fix then aged badly as the
// user's transcripts grew — 56 files totalling ~2GB fell over that cap and were RE-READ AND RE-PARSED
// from disk on every deck refresh (~45s), which is exactly the "everything got slower" complaint. A
// digest is a few KB even for a multi-hundred-MB transcript (it scales with turn count, not bytes), so
// EVERY file can stay cached: an unchanged mtime costs one stat() and zero parsing, for any size.
// sinceMs filtering happens at day granularity, so filtering the digest gives identical results.
interface DigestEntry { dayMs: number; day: string; model: string; totals: UsageTotals; webSearch: number; webFetch: number; unknown: boolean }
interface FileDigest {
  mtimeMs: number;
  entries: DigestEntry[]; // (day × model) rollups, synthetic lines already excluded
  stamps: number[];       // every line's timestamp (user + assistant + tool) for active-time gaps
  stampDayMs: number[];   // parallel to stamps: that line's UTC day start, for the sinceMs day filter
  bytes: number;          // estimated in-memory size, for the total-cache budget
  /**
   * How far into the file this digest has read, and what the file looked like then.
   *
   * The cache used to be keyed on mtime alone, which made it useless for the ONE file that matters
   * most: the session you are typing in right now. Its mtime changes with every turn, so every scan
   * — one per deck refresh, every 45 seconds, and again on every window focus — re-parsed the whole
   * thing. Measured on the machine this was reported from: 5.5 seconds per scan on a 564 MB live
   * transcript, forever, for the sake of the handful of lines appended since the last one.
   *
   * A transcript is append-only, so what was already folded stays true and only the tail is new.
   * `offset` is always just past a newline, so resuming there never splits a record.
   */
  offset: number;
  size: number;
  birthtimeMs: number;
}
// The digest cache is still bounded as a whole (a runaway dataset must never OOM the main process
// again), but digests are so small the working set effectively always fits.
export const MAX_CACHE_TOTAL_BYTES = 50 * 1024 * 1024;
let _cacheBudget = MAX_CACHE_TOTAL_BYTES;
let _cacheBytes = 0;
const _fileCache = new Map<string, FileDigest>(); // Map iteration order = insertion order = LRU order

function digestBytes(entries: number, stamps: number): number {
  return 200 + entries * 160 + stamps * 16; // rough JS-object overhead estimate — only the budget uses it
}
function cacheDelete(path: string): void {
  const e = _fileCache.get(path);
  if (e) { _cacheBytes -= e.bytes; _fileCache.delete(path); }
}
function cacheSet(path: string, entry: FileDigest): void {
  cacheDelete(path); // replace = remove old bytes first
  _fileCache.set(path, entry);
  _cacheBytes += entry.bytes;
  for (const oldest of _fileCache.keys()) {
    if (_cacheBytes <= _cacheBudget) break;
    cacheDelete(oldest); // evicts the just-inserted entry too if it alone exceeds the budget
  }
}
/** Re-insert a hit so Map order stays LRU (a scan that keeps re-reading the same hot files must not evict them). */
function cacheTouch(path: string): void {
  const e = _fileCache.get(path);
  if (e) { _fileCache.delete(path); _fileCache.set(path, e); }
}

/** Test-only introspection: does the cache currently hold an entry for this file path? */
export function _cacheHasFile(path: string): boolean { return _fileCache.has(path); }
/** Test-only: reset cache state between tests so assertions aren't affected by cross-test leakage. */
export function _clearFileCache(): void { _fileCache.clear(); _cacheBytes = 0; _cacheBudget = MAX_CACHE_TOTAL_BYTES; }
/** Test-only: shrink the total-bytes budget so eviction is exercisable without huge fixtures. */
export function _setCacheBudget(bytes: number): void { _cacheBudget = bytes; }

interface RepoRef { path: string; name: string; status?: 'active' | 'deleted'; }

function dayKey(ts: string | undefined, fallbackMs: number): string {
  const d = ts ? new Date(ts) : new Date(fallbackMs);
  return Number.isNaN(d.getTime()) ? new Date(fallbackMs).toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}
function tokensOf(t: UsageTotals): number { return t.input + t.output + t.cacheWrite + t.cacheRead; }

/** Sum estimated cost across a per-model totals map; null when no model has a price card. */
function sumModelCost(byModel: Map<string, UsageTotals>): number | null {
  let any = false, sum = 0;
  for (const [model, totals] of byModel) {
    const c = estimateCost(totals, priceFor(model));
    if (c != null) { any = true; sum += c; }
  }
  return any ? sum : null;
}

/** A digest holding nothing, ready to be folded into. */
function emptyDigest(mtimeMs: number, size: number, birthtimeMs: number): FileDigest {
  return { mtimeMs, entries: [], stamps: [], stampDayMs: [], bytes: digestBytes(0, 0), offset: 0, size, birthtimeMs };
}

/**
 * Can this digest be continued, or does the file have to be read from the beginning?
 *
 * Only an APPEND may be resumed. A file that shrank was truncated or replaced, a different birthtime
 * is a different file at the same path, and an offset past the end means the file was rewritten
 * shorter — in every one of those the bytes already folded are no longer the bytes that are there.
 */
function resumable(previous: FileDigest | undefined, size: number, birthtimeMs: number): previous is FileDigest {
  if (!previous) return false;
  if (previous.birthtimeMs !== birthtimeMs) return false;
  return size >= previous.size && previous.offset <= size;
}

/**
 * Fold a session file into its digest — from the beginning, or onward from where the last fold
 * stopped. The ONLY place raw lines are ever walked.
 *
 * Read in chunks and split on newlines by hand rather than through readline: resuming needs a BYTE
 * offset, and readline reports lines, not positions. Splitting on the raw bytes also keeps a
 * multi-byte character that straddles a chunk boundary intact, since only complete lines are decoded.
 * A trailing partial line — the agent is mid-write — is left unread, so `offset` stays on a record
 * boundary and the next fold picks that line up whole.
 *
 * Streamed for the same reason it always was: readFile'ing a multi-hundred-MB transcript spiked the
 * main process to ~2.5 GB RSS during a cold scan, the memory shape that OOM-aborted it in v1.12.2.
 */
/**
 * What a fold answers with.
 *
 * `durable` stops at the last complete line, which is the only place a later fold may resume from.
 * `view` is that plus the trailing line when the file does not end in a newline — a line still being
 * written, or a file whose last write was cut short. Counting it keeps the totals right; remembering
 * it would double it the moment the rest of that line arrives.
 */
/** Fold ONE transcript line into a rollup. The only place a raw record is interpreted. */
function foldLine(
  line: string, fileMs: number,
  rollup: Map<string, DigestEntry>, stamps: number[], stampDayMs: number[],
): void {
  if (!line.trim()) return;
  let o: { type?: string; timestamp?: string; message?: { model?: string; usage?: RawUsage & { server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } } } };
  try { o = JSON.parse(line); } catch { return; }
  const day = dayKey(o.timestamp, fileMs);
  const dayMs = new Date(day + 'T00:00:00.000Z').getTime();
  // Collect every line's timestamp (user + assistant + tool) so gaps reflect real wall-clock activity.
  if (o.timestamp) {
    const ms = new Date(o.timestamp).getTime();
    if (!Number.isNaN(ms)) { stamps.push(ms); stampDayMs.push(dayMs); }
  }
  const u = o.message?.usage;
  if (o.type !== 'assistant' || !u) return;
  const model = o.message?.model ?? 'unknown';
  // Claude Code emits <synthetic> assistant lines (API errors, interrupts) with a zero usage block —
  // not a real model. Skip them so they don't show as a phantom model row or trip the unknown warning.
  if (model === SYNTHETIC_MODEL) return;
  const key = day + ' ' + model;
  let e = rollup.get(key);
  if (!e) { e = { dayMs, day, model, totals: emptyTotals(), webSearch: 0, webFetch: 0, unknown: !priceFor(model) }; rollup.set(key, e); }
  e.totals = addUsage(e.totals, u);
  e.webSearch += u.server_tool_use?.web_search_requests ?? 0;
  e.webFetch += u.server_tool_use?.web_fetch_requests ?? 0;
}

interface FoldResult { durable: FileDigest; view: FileDigest }

async function foldDigest(
  fullPath: string, fileMs: number, mtimeMs: number, size: number, birthtimeMs: number, previous?: FileDigest,
): Promise<FoldResult | null> {
  const resume = resumable(previous, size, birthtimeMs);
  const base = resume ? previous : emptyDigest(mtimeMs, size, birthtimeMs);
  const rollup = new Map<string, DigestEntry>(base.entries.map((e) => [e.day + ' ' + e.model, e]));
  const stamps = base.stamps;
  const stampDayMs = base.stampDayMs;
  let offset = resume ? base.offset : 0;
  if (offset >= size) {
    const settled = { ...base, mtimeMs, size, birthtimeMs, offset };
    return { durable: settled, view: settled };
  }

  const consume = (line: string): void => foldLine(line, fileMs, rollup, stamps, stampDayMs);

  let trailing = Buffer.alloc(0);

  try {
    let pending = Buffer.alloc(0);
    const stream = createReadStream(fullPath, { start: offset, end: size - 1 });
    for await (const chunk of stream) {
      pending = pending.length === 0 ? Buffer.from(chunk as Buffer) : Buffer.concat([pending, chunk as Buffer]);
      let cut = pending.indexOf(NEWLINE);
      while (cut >= 0) {
        consume(pending.subarray(0, cut).toString('utf8'));
        offset += cut + 1;
        pending = pending.subarray(cut + 1);
        cut = pending.indexOf(NEWLINE);
      }
    }
    trailing = pending;
  } catch {
    return null; // unreadable / vanished mid-read - skip this file
  }
  const entries = [...rollup.values()];
  const durable: FileDigest = {
    mtimeMs, entries, stamps, stampDayMs,
    bytes: digestBytes(entries.length, stamps.length), offset, size, birthtimeMs,
  };
  if (trailing.length === 0) return { durable, view: durable };
  // The file does not end in a newline. Fold that last line into a SEPARATE view so the numbers
  // include it, and leave `durable` short of it: the next fold resumes at the boundary and reads
  // that line again, whole, whether it grew in the meantime or turned out to be all there was.
  const viewRollup = new Map<string, DigestEntry>(entries.map((e) => [e.day + ' ' + e.model, cloneEntry(e)]));
  const viewStamps = [...stamps];
  const viewStampDayMs = [...stampDayMs];
  foldLine(trailing.toString('utf8'), fileMs, viewRollup, viewStamps, viewStampDayMs);
  const viewEntries = [...viewRollup.values()];
  return {
    durable,
    view: {
      mtimeMs, entries: viewEntries, stamps: viewStamps, stampDayMs: viewStampDayMs,
      bytes: digestBytes(viewEntries.length, viewStamps.length), offset, size, birthtimeMs,
    },
  };
}

function cloneEntry(e: DigestEntry): DigestEntry {
  return { ...e, totals: { ...e.totals } };
}

/** Aggregate token usage across the given repos' Claude sessions. sinceMs filters by day (Infinity = all). */
export async function scanUsage(repos: RepoRef[], claudeProjectsDir: string, sinceMs: number): Promise<ProviderUsageSlice> {
  const global = emptyTotals();
  const perModelGlobal = new Map<string, UsageTotals>();
  const perDay = new Map<string, Map<string, UsageTotals>>();
  const byProject: LocalProjectUsage[] = [];
  let webSearch = 0, webFetch = 0, sessions = 0, hasUnknownModel = false, globalActiveMs = 0;
  const inRange = (dayMs: number): boolean => sinceMs === Infinity || dayMs >= sinceMs;

  for (const repo of repos) {
    const dir = join(claudeProjectsDir, encodeProjectPath(repo.path));
    const projTotals = emptyTotals();
    const projByModel = new Map<string, UsageTotals>();
    let projSessions = 0, projUnknown = false, projActiveMs = 0;

    if (existsSync(dir)) {
      let files: string[] = [];
      try { files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')); } catch { files = []; }
      for (const f of files) {
        const full = join(dir, f);
        let fileMs = Date.now();
        let size = 0;
        let birthtimeMs = 0;
        try { ({ mtimeMs: fileMs, size, birthtimeMs } = await stat(full)); } catch { /* keep defaults */ }
        let digest = _fileCache.get(full);
        // Nothing appended AND nothing left unread: the digest already answers for this file.
        if (digest && digest.mtimeMs === fileMs && digest.size === size && digest.offset >= size) {
          cacheTouch(full); // keep the hot file at the recent end of the LRU order
        } else {
          const parsed = await foldDigest(full, fileMs, fileMs, size, birthtimeMs, digest);
          if (!parsed) continue; // unreadable — skip, don't poison the cache
          cacheSet(full, parsed.durable); // only what is aligned to a record boundary may be resumed
          digest = parsed.view;           // what is counted includes a line still being written
        }
        let contributed = false;
        for (const e of digest.entries) {
          if (!inRange(e.dayMs)) continue;
          contributed = true;
          if (e.unknown) { hasUnknownModel = true; projUnknown = true; }
          Object.assign(global, addTotals(global, e.totals));
          Object.assign(projTotals, addTotals(projTotals, e.totals));
          projByModel.set(e.model, addTotals(projByModel.get(e.model) ?? emptyTotals(), e.totals));
          perModelGlobal.set(e.model, addTotals(perModelGlobal.get(e.model) ?? emptyTotals(), e.totals));
          const dayModels = perDay.get(e.day) ?? new Map<string, UsageTotals>();
          dayModels.set(e.model, addTotals(dayModels.get(e.model) ?? emptyTotals(), e.totals));
          perDay.set(e.day, dayModels);
          webSearch += e.webSearch;
          webFetch += e.webFetch;
        }
        const stampsInRange = sinceMs === Infinity ? digest.stamps : digest.stamps.filter((_, i) => digest!.stampDayMs[i] >= sinceMs);
        projActiveMs += activeMsFromTimestamps(stampsInRange);
        // Count a session only when it had activity in the selected range (an in-range usage entry, or
        // any in-range message). Counting every file regardless of range let long-dead projects render
        // as 0-value rows and inflated the summary's range-scoped "sessions" stat with lifetime files.
        if (contributed || stampsInRange.length > 0) projSessions++;
      }
    }

    sessions += projSessions;
    globalActiveMs += projActiveMs;
    const costEstimate = sumModelCost(projByModel);
    byProject.push({
      path: repo.path, name: repo.name, sessions: projSessions,
      totals: projTotals, costEstimate, hasUnknownModel: projUnknown,
      activeMs: projActiveMs, status: repo.status ?? 'active', providerCosts: { claude: costEstimate },
    });
  }

  const byModel: LocalModelUsage[] = [...perModelGlobal.entries()].map(([model, totals]) => ({
    providerId: 'claude', model, totals, costEstimate: estimateCost(totals, priceFor(model)), hasUnknownPrice: !priceFor(model),
  }));
  const daily: LocalDailyUsage[] = [...perDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, models]) => {
    let totals = emptyTotals();
    let anyCost = false, cost = 0;
    for (const [model, usage] of models) {
      totals = addTotals(totals, usage);
      const value = estimateCost(usage, priceFor(model));
      if (value != null) { anyCost = true; cost += value; }
    }
    const tokens = tokensOf(totals);
    const costEstimate = anyCost ? cost : null;
    return { day, tokens, cost: costEstimate, providerTokens: { claude: tokens }, providerCosts: { claude: costEstimate } };
  });

  return { providerId: 'claude', state: 'ready', global, globalCost: sumModelCost(perModelGlobal), hasUnknownModel, webSearch, webFetch, sessions, activeMs: globalActiveMs, byModel, byProject, daily };
}
