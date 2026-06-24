import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { encodeProjectPath } from '../shared/paths';
import { emptyTotals, addUsage, estimateCost, activeMsFromTimestamps, MODEL_PRICING, SYNTHETIC_MODEL, type UsageTotals, type RawUsage } from '../shared/usage';
import type { UsageReport, ProjectUsage, ModelUsage } from '../shared/types';

// Cache: filepath -> { mtime, parsed lines }. Keyed by PATH (not path+mtime), with the mtime stored
// in the value, so a modified file REPLACES its entry instead of leaking a new key per modification
// in this long-lived process. One entry per session file; bounded by the number of distinct files.
const _fileCache = new Map<string, { mtimeMs: number; lines: string[] }>();

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

/** Aggregate token usage across the given repos' Claude sessions. sinceMs filters by day (Infinity = all). */
export function scanUsage(repos: RepoRef[], claudeProjectsDir: string, sinceMs: number): UsageReport {
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
      try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { files = []; }
      for (const f of files) {
        const full = join(dir, f);
        let fileMs = Date.now();
        try { fileMs = statSync(full).mtimeMs; } catch { /* keep now */ }
        const cached = _fileCache.get(full);
        let lines: string[];
        if (cached && cached.mtimeMs === fileMs) {
          lines = cached.lines;
        } else {
          let text = '';
          try { text = readFileSync(full, 'utf8'); } catch { continue; }
          lines = text.split('\n');
          _fileCache.set(full, { mtimeMs: fileMs, lines }); // replaces any stale entry for this path
        }
        projSessions++;
        const stamps: number[] = []; // in-range message timestamps, for active-time gaps
        for (const line of lines) {
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
