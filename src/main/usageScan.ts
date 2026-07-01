import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeProjectPath } from '../shared/paths';
import { emptyTotals, addUsage, estimateCost, activeMsFromTimestamps, MODEL_PRICING, SYNTHETIC_MODEL, type UsageTotals, type RawUsage } from '../shared/usage';
import type { UsageReport, ProjectUsage, ModelUsage } from '../shared/types';

// Cache: filepath -> { mtime, parsed lines }. Keyed by PATH (not path+mtime), with the mtime stored
// in the value, so a modified file REPLACES its entry instead of leaking a new key per modification
// in this long-lived process. Bounded by the number of distinct files — BUT that bound is only on
// entry COUNT, not total bytes: a power user's ~/.claude/projects can hold thousands of session
// files, some hundreds of MB (one real transcript was 347MB). Caching every one's full text forever
// ballooned the main process to several GB within ~1 minute of a cold start (projectsView.ts's
// per-project cost fill calls usage:report(0) = every file, all time, unconditionally on every deck
// load) and crashed it with a V8 "out of memory" abort that bypasses every JS exception handler.
// Files over MAX_CACHED_FILE_BYTES are still read and aggregated correctly — just never RETAINED.
export const MAX_CACHED_FILE_BYTES = 5 * 1024 * 1024; // 5MB — generous for the vast majority of sessions
// The per-file cap alone still allows unbounded AGGREGATE growth (thousands of just-under-cap
// sessions = multiple GB over this long-lived process), so the cache is also bounded as a whole:
// least-recently-used files are evicted once the on-disk-bytes total passes the budget. Sized so
// the hot working set (recently active sessions) stays cached while cold history is re-read on demand.
export const MAX_CACHE_TOTAL_BYTES = 200 * 1024 * 1024; // 200MB of on-disk bytes (in-memory strings cost ~2-3x)
let _cacheBudget = MAX_CACHE_TOTAL_BYTES;
let _cacheBytes = 0;
const _fileCache = new Map<string, { mtimeMs: number; lines: string[]; bytes: number }>(); // Map iteration order = insertion order = LRU order

function cacheDelete(path: string): void {
  const e = _fileCache.get(path);
  if (e) { _cacheBytes -= e.bytes; _fileCache.delete(path); }
}
function cacheSet(path: string, entry: { mtimeMs: number; lines: string[]; bytes: number }): void {
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
/** Test-only: shrink the total-bytes budget so eviction is exercisable without writing 200MB. */
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

// The scan is ASYNC on purpose: usage:report(0) runs on every deck load, and a synchronous pass
// over ~/.claude (2.5GB across 5,000+ files in the real dataset) froze all IPC and live cockpit
// PTY output for its whole duration. Async fs I/O lets other main-process work interleave between
// files, and the parse loop yields every YIELD_EVERY_LINES lines so even a cached multi-hundred-MB
// transcript can't monopolize the event loop.
const YIELD_EVERY_LINES = 20_000;
const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Aggregate token usage across the given repos' Claude sessions. sinceMs filters by day (Infinity = all). */
export async function scanUsage(repos: RepoRef[], claudeProjectsDir: string, sinceMs: number): Promise<UsageReport> {
  const global = emptyTotals();
  const perModelGlobal = new Map<string, UsageTotals>();
  const perDay = new Map<string, UsageTotals>();
  const byProject: ProjectUsage[] = [];
  let webSearch = 0, webFetch = 0, sessions = 0, hasUnknownModel = false, globalActiveMs = 0;

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
        let fileMs = Date.now(), fileSize = 0;
        try { const st = await stat(full); fileMs = st.mtimeMs; fileSize = st.size; } catch { /* keep defaults */ }
        const cached = _fileCache.get(full);
        let lines: string[];
        if (cached && cached.mtimeMs === fileMs) {
          lines = cached.lines;
          cacheTouch(full); // keep the hot file at the recent end of the LRU order
        } else {
          let text = '';
          try { text = await readFile(full, 'utf8'); } catch { continue; }
          lines = text.split('\n');
          if (fileSize <= MAX_CACHED_FILE_BYTES) cacheSet(full, { mtimeMs: fileMs, lines, bytes: fileSize }); // replaces any stale entry
          else cacheDelete(full); // a previously-small, now-grown file must not linger in the cache
        }
        projSessions++;
        const stamps: number[] = []; // in-range message timestamps, for active-time gaps
        let lineNo = 0;
        for (const line of lines) {
          if (++lineNo % YIELD_EVERY_LINES === 0) await yieldLoop(); // cached files skip fs awaits, but their parse loop must breathe too
          if (!line.trim()) continue;
          let o: { type?: string; timestamp?: string; message?: { model?: string; usage?: RawUsage & { server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } } } };
          try { o = JSON.parse(line); } catch { continue; }
          const day = dayKey(o.timestamp, fileMs);
          if (sinceMs !== Infinity && new Date(day + 'T00:00:00.000Z').getTime() < sinceMs) continue;
          // Collect every line's timestamp (user + assistant + tool) so gaps reflect real wall-clock activity.
          if (o.timestamp) { const ms = new Date(o.timestamp).getTime(); if (!Number.isNaN(ms)) stamps.push(ms); }
          const u = o.message?.usage;
          if (o.type !== 'assistant' || !u) continue;
          const model = o.message?.model ?? 'unknown';
          // Claude Code emits <synthetic> assistant lines (API errors, interrupts) with a zero usage
          // block — not a real model. Skip them so they don't show as a phantom 0% model row or wrongly
          // trip the unknown-model cost warning (the cockpit's session meta skips them the same way).
          if (model === SYNTHETIC_MODEL) continue;
          if (!MODEL_PRICING[model]) { hasUnknownModel = true; projUnknown = true; }
          Object.assign(global, addUsage(global, u));
          Object.assign(projTotals, addUsage(projTotals, u));
          projByModel.set(model, addUsage(projByModel.get(model) ?? emptyTotals(), u));
          perModelGlobal.set(model, addUsage(perModelGlobal.get(model) ?? emptyTotals(), u));
          perDay.set(day, addUsage(perDay.get(day) ?? emptyTotals(), u));
          webSearch += u.server_tool_use?.web_search_requests ?? 0;
          webFetch += u.server_tool_use?.web_fetch_requests ?? 0;
        }
        projActiveMs += activeMsFromTimestamps(stamps);
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
