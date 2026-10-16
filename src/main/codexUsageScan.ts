import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { basename, cwdKey } from '../shared/paths';
import {
  ACTIVE_GAP_CAP_MS, addTotals, emptyTotals, estimateProviderCost, priceForProvider,
  type UsageTotals,
} from '../shared/usage';
import { emptyProviderUsage, type LocalDailyUsage, type LocalModelUsage, type LocalProjectUsage, type ProviderUsageSlice } from '../shared/localUsage';
import {
  initialCodexUsageCursor, parseCodexUsageLine,
  type CodexUsageCursor,
} from '../shared/codexUsageParse';
import { listCodexRolloutHeads, type CodexRolloutHead } from './codexSessions';

const INDEX_VERSION = 1;
const DEFAULT_CHUNK_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;

interface IndexedBucket {
  day: string;
  dayMs: number;
  model: string;
  totals: UsageTotals;
}

interface IndexedDay {
  day: string;
  dayMs: number;
  activeMs: number;
  hadActivity: boolean;
}

interface IndexedFile {
  file: string;
  id: string;
  cwd: string;
  birthtimeMs: number;
  mtimeMs: number;
  size: number;
  offset: number;
  discardUntilNewline: boolean;
  cursor: CodexUsageCursor;
  buckets: IndexedBucket[];
  days: IndexedDay[];
  lastActivityMs: number | null;
}

interface CodexUsageIndex { version: number; files: IndexedFile[] }

export interface ScanCodexUsageOptions {
  sessionsDir: string;
  cachePath: string;
  sinceMs: number;
  exists?: (path: string) => boolean;
  yieldNow?: () => Promise<void>;
  chunkBytes?: number;
  onBytesRead?: (bytes: number) => void;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function totals(value: unknown): value is UsageTotals {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return ['input', 'output', 'cacheWrite', 'cacheRead'].every((key) => finite(v[key]) && (v[key] as number) >= 0);
}

function validCursor(value: unknown): value is CodexUsageCursor {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const cumulative = v.cumulative;
  const validCumulative = cumulative === null || (!!cumulative && typeof cumulative === 'object'
    && ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens']
      .every((key) => finite((cumulative as Record<string, unknown>)[key]) && ((cumulative as Record<string, number>)[key] >= 0)));
  return (v.model === null || (typeof v.model === 'string' && v.model.length <= 120))
    && validCumulative
    && Array.isArray(v.seenFallbackKeys) && v.seenFallbackKeys.length <= 128
    && v.seenFallbackKeys.every((key) => typeof key === 'string' && key.length <= 400);
}

function validIndexedFile(value: unknown): value is IndexedFile {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.file === 'string' && typeof v.id === 'string' && typeof v.cwd === 'string'
    && finite(v.birthtimeMs) && finite(v.mtimeMs) && finite(v.size) && finite(v.offset)
    && v.size >= 0 && v.offset >= 0 && v.offset <= v.size
    && typeof v.discardUntilNewline === 'boolean' && validCursor(v.cursor)
    && Array.isArray(v.buckets) && v.buckets.length <= 100_000
    && v.buckets.every((bucket) => {
      if (!bucket || typeof bucket !== 'object') return false;
      const b = bucket as Record<string, unknown>;
      return typeof b.day === 'string' && finite(b.dayMs) && typeof b.model === 'string' && totals(b.totals);
    })
    && Array.isArray(v.days) && v.days.length <= 20_000
    && v.days.every((day) => {
      if (!day || typeof day !== 'object') return false;
      const d = day as Record<string, unknown>;
      return typeof d.day === 'string' && finite(d.dayMs) && finite(d.activeMs) && typeof d.hadActivity === 'boolean';
    })
    && (v.lastActivityMs === null || finite(v.lastActivityMs));
}

function loadIndex(cachePath: string): CodexUsageIndex {
  try {
    const raw: unknown = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (!raw || typeof raw !== 'object') return { version: INDEX_VERSION, files: [] };
    const value = raw as Record<string, unknown>;
    if (value.version !== INDEX_VERSION || !Array.isArray(value.files)) return { version: INDEX_VERSION, files: [] };
    return { version: INDEX_VERSION, files: value.files.filter(validIndexedFile) };
  } catch {
    return { version: INDEX_VERSION, files: [] };
  }
}

/**
 * The index as the last scan left it, per cache path, plus the size and mtime of the file that scan
 * wrote.
 *
 * Every scan used to read the whole index back from disk, validate every entry, deep-clone every
 * entry through JSON, then stringify and write all of it again — all synchronous, back to back, for
 * every rollout on the machine, on every deck refresh and window focus. With 5,000 rollouts that is a
 * 4.5 MB file and a ~80 ms stretch in which the main process answered nothing, even when not one
 * rollout had changed. The index on disk is only there to survive a restart; between scans the one
 * in memory is the same thing. It is still read from disk when there is none in memory yet, or when
 * the file is no longer the one this process wrote (so an index replaced underneath us is honoured).
 */
interface LiveIndex { files: IndexedFile[]; written: { size: number; mtimeMs: number } | null }
const _live = new Map<string, LiveIndex>();

async function previousFiles(cachePath: string): Promise<IndexedFile[]> {
  const live = _live.get(cachePath);
  if (live?.written) {
    try {
      const st = await stat(cachePath);
      if (st.size === live.written.size && st.mtimeMs === live.written.mtimeMs) return live.files;
    } catch { /* gone: fall through to the same answer a fresh read gives */ }
  }
  // Stat BEFORE reading, so a write landing in between makes the next scan read again, not trust this.
  const st = await stat(cachePath).catch(() => null);
  const { files } = loadIndex(cachePath);
  _live.set(cachePath, { files, written: st ? { size: st.size, mtimeMs: st.mtimeMs } : null });
  return files;
}

/** Already read to the end of the file as it is now — exactly when updateFile would read nothing. */
function caughtUp(file: IndexedFile, head: CodexRolloutHead): boolean {
  return file.size === head.size && file.mtimeMs === head.mtimeMs && file.offset === head.size;
}

/**
 * Saves in progress, by path, chained so two scans finishing together never write the same temp
 * file at once; the later scan's save lands last, as it did when both were synchronous.
 */
const _saving = new Map<string, Promise<void>>();

function saveIndex(cachePath: string, index: CodexUsageIndex): Promise<void> {
  const run = async (): Promise<void> => {
    try {
      await mkdir(dirname(cachePath), { recursive: true });
      const temp = `${cachePath}.tmp`;
      await writeFile(temp, JSON.stringify(index), 'utf8');
      await rename(temp, cachePath);
      const st = await stat(cachePath);
      _live.set(cachePath, { files: index.files, written: { size: st.size, mtimeMs: st.mtimeMs } });
    } catch {
      // Unwritable cache: the scan's answer stands, and the next scan reads from disk again.
      _live.delete(cachePath);
    }
  };
  const next = (_saving.get(cachePath) ?? Promise.resolve()).then(run);
  _saving.set(cachePath, next);
  void next.finally(() => { if (_saving.get(cachePath) === next) _saving.delete(cachePath); });
  return next;
}

function freshFile(head: CodexRolloutHead): IndexedFile {
  return {
    file: head.file, id: head.id, cwd: head.cwd, birthtimeMs: head.birthtimeMs,
    mtimeMs: head.mtimeMs, size: head.size, offset: 0, discardUntilNewline: false,
    cursor: initialCodexUsageCursor(), buckets: [], days: [], lastActivityMs: null,
  };
}

function cloneFile(value: IndexedFile): IndexedFile {
  return JSON.parse(JSON.stringify(value)) as IndexedFile;
}

function resumable(previous: IndexedFile | undefined, head: CodexRolloutHead): boolean {
  if (!previous || previous.id !== head.id || cwdKey(previous.cwd) !== cwdKey(head.cwd)) return false;
  if (previous.birthtimeMs !== head.birthtimeMs || head.size < previous.size || previous.offset > head.size) return false;
  if (head.size === previous.size && head.mtimeMs !== previous.mtimeMs) return false;
  return true;
}

function addBucket(file: IndexedFile, day: string, dayMs: number, model: string, usage: UsageTotals): void {
  const bucket = file.buckets.find((entry) => entry.day === day && entry.model === model);
  if (bucket) bucket.totals = addTotals(bucket.totals, usage);
  else file.buckets.push({ day, dayMs, model, totals: { ...usage } });
}

function noteActivity(file: IndexedFile, timestampMs: number): void {
  const day = new Date(timestampMs).toISOString().slice(0, 10);
  const dayMs = Date.parse(`${day}T00:00:00.000Z`);
  let entry = file.days.find((candidate) => candidate.day === day);
  if (!entry) { entry = { day, dayMs, activeMs: 0, hadActivity: true }; file.days.push(entry); }
  entry.hadActivity = true;
  if (file.lastActivityMs != null) {
    const gap = timestampMs - file.lastActivityMs;
    if (gap > 0 && gap <= ACTIVE_GAP_CAP_MS) entry.activeMs += gap;
  }
  if (file.lastActivityMs == null || timestampMs > file.lastActivityMs) file.lastActivityMs = timestampMs;
}

function processLine(file: IndexedFile, bytes: Buffer): void {
  const result = parseCodexUsageLine(bytes.toString('utf8').replace(/\r$/, ''), file.cursor);
  file.cursor = result.cursor;
  if (result.entry) addBucket(file, result.entry.day, result.entry.dayMs, result.entry.model, result.entry.totals);
  if (result.activityTimestampMs != null) noteActivity(file, result.activityTimestampMs);
}

async function defaultYield(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function updateFile(file: IndexedFile, head: CodexRolloutHead, options: ScanCodexUsageOptions): Promise<void> {
  if (file.size === head.size && file.mtimeMs === head.mtimeMs && file.offset === head.size) return;
  let fd: number | null = null;
  let position = file.offset;
  let pending = Buffer.alloc(0);
  const chunkBytes = Math.max(64, Math.min(options.chunkBytes ?? DEFAULT_CHUNK_BYTES, 4 * 1024 * 1024));
  const yieldNow = options.yieldNow ?? defaultYield;
  try {
    fd = openSync(head.file, 'r');
    while (position < head.size) {
      const length = Math.min(chunkBytes, head.size - position);
      const chunk = Buffer.alloc(length);
      const bytesRead = readSync(fd, chunk, 0, length, position);
      if (bytesRead <= 0) break;
      const actual = chunk.subarray(0, bytesRead);
      const chunkStart = position;
      position += bytesRead;
      options.onBytesRead?.(bytesRead);

      if (file.discardUntilNewline) {
        const newline = actual.indexOf(0x0a);
        if (newline < 0) { file.offset = position; await yieldNow(); continue; }
        file.discardUntilNewline = false;
        file.offset = chunkStart + newline + 1;
        pending = actual.subarray(newline + 1);
      } else {
        pending = pending.length ? Buffer.concat([pending, actual]) : actual;
      }

      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        processLine(file, pending.subarray(0, newline));
        pending = pending.subarray(newline + 1);
        file.offset += newline + 1;
        newline = pending.indexOf(0x0a);
      }
      if (pending.length > MAX_LINE_BYTES) {
        file.discardUntilNewline = true;
        file.offset = position;
        pending = Buffer.alloc(0);
      }
      await yieldNow();
    }
  } finally {
    if (fd !== null) closeSync(fd);
  }
  file.size = head.size;
  file.mtimeMs = head.mtimeMs;
  file.birthtimeMs = head.birthtimeMs;
}

function tokenCount(value: UsageTotals): number {
  return value.input + value.output + value.cacheWrite + value.cacheRead;
}

function sumKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value != null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

function costFor(totalsValue: UsageTotals, model: string): { value: number | null; complete: boolean } {
  return estimateProviderCost(totalsValue, priceForProvider('codex', model));
}

function reportFromFiles(files: IndexedFile[], sinceMs: number, exists: (path: string) => boolean): ProviderUsageSlice {
  const global = emptyTotals();
  const modelTotals = new Map<string, UsageTotals>();
  const projectRows = new Map<string, { file: IndexedFile; totals: UsageTotals; models: Map<string, UsageTotals>; sessions: number; activeMs: number }>();
  const dailyTotals = new Map<string, Map<string, UsageTotals>>();
  let sessions = 0;
  let activeMs = 0;

  for (const file of files) {
    const includedDays = file.days.filter((day) => sinceMs === Infinity || day.dayMs >= sinceMs);
    const sessionActive = includedDays.some((day) => day.hadActivity);
    const fileActiveMs = includedDays.reduce((sum, day) => sum + day.activeMs, 0);
    if (sessionActive) sessions++;
    activeMs += fileActiveMs;
    const key = cwdKey(file.cwd);
    const project = projectRows.get(key) ?? { file, totals: emptyTotals(), models: new Map(), sessions: 0, activeMs: 0 };
    if (sessionActive) project.sessions++;
    project.activeMs += fileActiveMs;
    for (const bucket of file.buckets) {
      if (sinceMs !== Infinity && bucket.dayMs < sinceMs) continue;
      Object.assign(global, addTotals(global, bucket.totals));
      project.totals = addTotals(project.totals, bucket.totals);
      project.models.set(bucket.model, addTotals(project.models.get(bucket.model) ?? emptyTotals(), bucket.totals));
      modelTotals.set(bucket.model, addTotals(modelTotals.get(bucket.model) ?? emptyTotals(), bucket.totals));
      const day = dailyTotals.get(bucket.day) ?? new Map<string, UsageTotals>();
      day.set(bucket.model, addTotals(day.get(bucket.model) ?? emptyTotals(), bucket.totals));
      dailyTotals.set(bucket.day, day);
    }
    projectRows.set(key, project);
  }

  const byModel: LocalModelUsage[] = [...modelTotals].map(([model, modelUsage]) => {
    const cost = costFor(modelUsage, model);
    return { providerId: 'codex', model, totals: modelUsage, costEstimate: cost.value, hasUnknownPrice: !cost.complete };
  });
  const byProject: LocalProjectUsage[] = [...projectRows.values()].map(({ file, totals: projectTotals, models, sessions: projectSessions, activeMs: projectActiveMs }) => {
    const modelCosts = [...models].map(([model, usage]) => costFor(usage, model));
    const costEstimate = sumKnown(modelCosts.map((cost) => cost.value));
    return {
      path: file.cwd, name: basename(file.cwd), sessions: projectSessions, totals: projectTotals, costEstimate,
      hasUnknownModel: modelCosts.some((cost) => !cost.complete), activeMs: projectActiveMs,
      status: exists(file.cwd) ? 'active' : 'deleted', providerCosts: { codex: costEstimate },
    };
  });
  const daily: LocalDailyUsage[] = [...dailyTotals].sort(([a], [b]) => a.localeCompare(b)).map(([day, models]) => {
    let totalsValue = emptyTotals();
    const costs: Array<number | null> = [];
    for (const [model, usage] of models) { totalsValue = addTotals(totalsValue, usage); costs.push(costFor(usage, model).value); }
    const cost = sumKnown(costs);
    const tokens = tokenCount(totalsValue);
    return { day, tokens, cost, providerTokens: { codex: tokens }, providerCosts: { codex: cost } };
  });
  const globalCost = sumKnown(byModel.map((model) => model.costEstimate));
  return {
    providerId: 'codex', state: 'ready', global, globalCost,
    hasUnknownModel: byModel.some((model) => model.hasUnknownPrice), webSearch: 0, webFetch: 0,
    sessions, activeMs, byModel, byProject, daily,
  };
}

export async function scanCodexUsage(options: ScanCodexUsageOptions): Promise<ProviderUsageSlice> {
  const heads = await listCodexRolloutHeads(options.sessionsDir);
  if (!heads.length) return emptyProviderUsage('codex');
  const previous = await previousFiles(options.cachePath);
  const previousByFile = new Map(previous.map((file) => [file.file, file]));
  const files: IndexedFile[] = [];
  let changed = previous.length !== heads.length;
  for (const head of heads) {
    const old = previousByFile.get(head.file);
    if (old && resumable(old, head) && caughtUp(old, head)) {
      // Nothing to read, so nothing to change: the entry is shared as-is instead of deep-cloned.
      // Entries are never mutated once a scan has published them — only fresh clones are folded into.
      files.push(old);
      continue;
    }
    const file = resumable(old, head) ? cloneFile(old!) : freshFile(head);
    await updateFile(file, head, options);
    files.push(file);
    changed = true;
  }
  if (changed) await saveIndex(options.cachePath, { version: INDEX_VERSION, files });
  return reportFromFiles(files, options.sinceMs, options.exists ?? existsSync);
}
