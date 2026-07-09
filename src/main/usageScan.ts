import { existsSync, createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { encodeProjectPath } from '../shared/paths';
import { emptyTotals, addUsage, addTotals, estimateCost, activeMsFromTimestamps, MODEL_PRICING, SYNTHETIC_MODEL, type UsageTotals, type RawUsage } from '../shared/usage';
import type { UsageReport, ProjectUsage, ModelUsage } from '../shared/types';

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
    const c = estimateCost(totals, MODEL_PRICING[model]);
    if (c != null) { any = true; sum += c; }
  }
  return any ? sum : null;
}

/**
 * One full parse of a session file into its digest (the only place raw lines are ever walked).
 * STREAMED line by line: readFile'ing a multi-hundred-MB transcript spiked the main process to a
 * ~2.5GB RSS during the cold scan (the whole file as one string plus its split array) - the same
 * memory shape that OOM-aborted the process back in v1.12.2. A stream holds one line at a time, and
 * its async iterator naturally yields the event loop between chunks (no manual yield needed).
 * Returns null when the file is unreadable (caller skips it, like the old readFile-failure path).
 */
async function parseDigest(fullPath: string, fileMs: number, mtimeMs: number): Promise<FileDigest | null> {
  const rollup = new Map<string, DigestEntry>(); // `${day} ${model}`
  const stamps: number[] = [];
  const stampDayMs: number[] = [];
  try {
    const rl = createInterface({ input: createReadStream(fullPath, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let o: { type?: string; timestamp?: string; message?: { model?: string; usage?: RawUsage & { server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } } } };
      try { o = JSON.parse(line); } catch { continue; }
      const day = dayKey(o.timestamp, fileMs);
      const dayMs = new Date(day + 'T00:00:00.000Z').getTime();
      // Collect every line's timestamp (user + assistant + tool) so gaps reflect real wall-clock activity.
      if (o.timestamp) {
        const ms = new Date(o.timestamp).getTime();
        if (!Number.isNaN(ms)) { stamps.push(ms); stampDayMs.push(dayMs); }
      }
      const u = o.message?.usage;
      if (o.type !== 'assistant' || !u) continue;
      const model = o.message?.model ?? 'unknown';
      // Claude Code emits <synthetic> assistant lines (API errors, interrupts) with a zero usage block -
      // not a real model. Skip them so they don't show as a phantom model row or trip the unknown warning.
      if (model === SYNTHETIC_MODEL) continue;
      const key = day + ' ' + model;
      let e = rollup.get(key);
      if (!e) { e = { dayMs, day, model, totals: emptyTotals(), webSearch: 0, webFetch: 0, unknown: !MODEL_PRICING[model] }; rollup.set(key, e); }
      e.totals = addUsage(e.totals, u);
      e.webSearch += u.server_tool_use?.web_search_requests ?? 0;
      e.webFetch += u.server_tool_use?.web_fetch_requests ?? 0;
    }
  } catch {
    return null; // unreadable / vanished mid-read - skip this file
  }
  const entries = [...rollup.values()];
  return { mtimeMs, entries, stamps, stampDayMs, bytes: digestBytes(entries.length, stamps.length) };
}

/** Aggregate token usage across the given repos' Claude sessions. sinceMs filters by day (Infinity = all). */
export async function scanUsage(repos: RepoRef[], claudeProjectsDir: string, sinceMs: number): Promise<UsageReport> {
  const global = emptyTotals();
  const perModelGlobal = new Map<string, UsageTotals>();
  const perDay = new Map<string, UsageTotals>();
  const byProject: ProjectUsage[] = [];
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
        try { fileMs = (await stat(full)).mtimeMs; } catch { /* keep default */ }
        let digest = _fileCache.get(full);
        if (digest && digest.mtimeMs === fileMs) {
          cacheTouch(full); // keep the hot file at the recent end of the LRU order
        } else {
          const parsed = await parseDigest(full, fileMs, fileMs);
          if (!parsed) continue; // unreadable — skip, don't poison the cache
          digest = parsed;
          cacheSet(full, digest);
        }
        projSessions++;
        for (const e of digest.entries) {
          if (!inRange(e.dayMs)) continue;
          if (e.unknown) { hasUnknownModel = true; projUnknown = true; }
          Object.assign(global, addTotals(global, e.totals));
          Object.assign(projTotals, addTotals(projTotals, e.totals));
          projByModel.set(e.model, addTotals(projByModel.get(e.model) ?? emptyTotals(), e.totals));
          perModelGlobal.set(e.model, addTotals(perModelGlobal.get(e.model) ?? emptyTotals(), e.totals));
          perDay.set(e.day, addTotals(perDay.get(e.day) ?? emptyTotals(), e.totals));
          webSearch += e.webSearch;
          webFetch += e.webFetch;
        }
        const stampsInRange = sinceMs === Infinity ? digest.stamps : digest.stamps.filter((_, i) => digest!.stampDayMs[i] >= sinceMs);
        projActiveMs += activeMsFromTimestamps(stampsInRange);
      }
    }

    sessions += projSessions;
    globalActiveMs += projActiveMs;
    byProject.push({
      path: repo.path, name: repo.name, sessions: projSessions,
      totals: projTotals, costEstimate: sumModelCost(projByModel), hasUnknownModel: projUnknown,
      activeMs: projActiveMs, status: repo.status ?? 'active',
    });
  }

  const byModel: ModelUsage[] = [...perModelGlobal.entries()].map(([model, totals]) => ({
    model, totals, costEstimate: estimateCost(totals, MODEL_PRICING[model]),
  }));
  const daily = [...perDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, t]) => ({
    day, tokens: tokensOf(t), cost: null as number | null,
  }));

  return { global, globalCost: sumModelCost(perModelGlobal), hasUnknownModel, webSearch, webFetch, sessions, activeMs: globalActiveMs, byModel, byProject, daily };
}
