import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeSessionMeta, emptySessionMeta, _cachedTimestampCount } from './sessionMeta';
import { encodeProjectPath } from '../shared/paths';
import { activeMsFromTimestamps } from '../shared/usage';

describe('readClaudeSessionMeta', () => {
  it('rejects a traversal sessionId — no path escape (returns an empty meta)', async () => {
    expect(await readClaudeSessionMeta('C:/a/b', '../../../../etc/passwd', '/tmp/claude')).toEqual(emptySessionMeta());
    expect(await readClaudeSessionMeta('C:/a/b', 'a/../../b', '/tmp/claude')).toEqual(emptySessionMeta());
  });
  it('returns an empty meta for a valid id whose file is missing', async () => {
    expect(await readClaudeSessionMeta('C:/a/b', 'a0b1c2d3-e4f5-6789-abcd-ef0123456789', '/no/such/dir')).toEqual(emptySessionMeta());
  });
  it('the empty meta is well-formed (callers destructure it without guards)', async () => {
    expect(emptySessionMeta()).toEqual({ model: null, activeMs: 0, contextTokens: 0, assistantText: null, editedFiles: [], userText: null, mtimeMs: 0 });
  });
});

// Session logs are append-only and reach hundreds of MB — one on this machine is 547 MiB, past Node's
// 512 MiB maximum string, so the old whole-file read threw and that session showed nothing at all.
// These cover what the chunked, resumable read has to get right instead.
describe('readClaudeSessionMeta over an append-only log', () => {
  const PROJECT = 'C:\\repo\\demo';
  const ID = 'a0b1c2d3-e4f5-6789-abcd-ef0123456789';
  let dir: string;
  let file: string;

  const at = (min: number) => new Date(Date.UTC(2026, 7, 4, 10, min)).toISOString();
  const userLine = (text: string, min: number) => JSON.stringify({ type: 'user', timestamp: at(min), message: { content: text } });
  const asstLine = (text: string, min: number, model: string, ctx: number) => JSON.stringify({
    type: 'assistant', timestamp: at(min),
    message: { model, usage: { input_tokens: ctx }, content: [{ type: 'text', text }] },
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'devdeck-meta-'));
    const projDir = join(dir, encodeProjectPath(PROJECT));
    mkdirSync(projDir, { recursive: true });
    file = join(projDir, `${ID}.jsonl`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

  const read = async () => readClaudeSessionMeta(PROJECT, ID, dir);
  /** Append, then force a distinct mtime — same-millisecond writes are legitimately cache hits. */
  const append = (extra: string) => {
    appendFileSync(file, extra);
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
  };

  it('picks up ONLY what was appended, and keeps the earlier turns in the totals', async () => {
    writeFileSync(file, `${userLine('add the migration', 0)}\n${asstLine('Reading the schema', 2, 'claude-opus-5', 1000)}\n`);
    const first = await read();
    expect(first).toMatchObject({ model: 'claude-opus-5', contextTokens: 1000, assistantText: 'Reading the schema', userText: 'add the migration' });
    expect(first.activeMs).toBe(2 * 60_000);

    append(`${asstLine('Migration written', 4, 'claude-sonnet-5', 4200)}\n`);
    const second = await read();
    // Last-wins fields follow the new lines; activeMs keeps accumulating across BOTH reads — that is
    // the field a bounded tail read could not have produced.
    expect(second).toMatchObject({ model: 'claude-sonnet-5', contextTokens: 4200, assistantText: 'Migration written' });
    expect(second.activeMs).toBe(4 * 60_000);
  });

  it('two reads of the same grown log at once fold the appended lines once, not twice', async () => {
    // The cockpit tick and a paired machine's poll ask about the same session concurrently; both
    // used to resume from the one cached state and append the same lines to it.
    writeFileSync(file, `${userLine('start', 0)}
`);
    await read();
    let tail = '';
    for (let i = 1; i <= 500; i++) tail += `${asstLine(`step ${i}`, i % 50, 'claude-opus-5', i)}
`;
    append(tail);
    const [a, b] = await Promise.all([read(), read()]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ contextTokens: 500, assistantText: 'step 500' });
    expect(_cachedTimestampCount(file)).toBe(501);
  });

  it('never consumes a half-written last line, and reads it once the rest lands', async () => {
    const whole = asstLine('Whole line', 3, 'claude-fable-5', 999);
    const cut = Math.floor(whole.length / 2);
    writeFileSync(file, `${asstLine('First reply', 0, 'claude-opus-5', 100)}\n${whole.slice(0, cut)}`);
    // The torn line is not JSON yet — parsing it would drop the turn on the floor.
    expect(await read()).toMatchObject({ model: 'claude-opus-5', contextTokens: 100, assistantText: 'First reply' });

    append(`${whole.slice(cut)}\n`);
    // Resumed from the START of that line, so it parses exactly once, now that it is complete.
    expect(await read()).toMatchObject({ model: 'claude-fable-5', contextTokens: 999, assistantText: 'Whole line' });
  });

  it('reparses from zero when the log SHRANK (rewritten, not appended to)', async () => {
    writeFileSync(file, `${asstLine('Old conversation', 0, 'claude-opus-5', 5000)}\n${asstLine('More of it', 6, 'claude-opus-5', 9000)}\n`);
    expect((await read()).contextTokens).toBe(9000);

    writeFileSync(file, `${asstLine('Brand new', 0, 'claude-sonnet-5', 300)}\n`);
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    // Carrying the old state forward would leave the stale 9000 and the old model in place.
    expect(await read()).toMatchObject({ model: 'claude-sonnet-5', contextTokens: 300, assistantText: 'Brand new' });
  });

  it('an unchanged mtime is answered from cache, without re-reading the log', async () => {
    writeFileSync(file, `${asstLine('Reply', 0, 'claude-opus-5', 42)}\n`);
    expect(await read()).toMatchObject({ contextTokens: 42 });

    const { atime, mtime } = statSync(file);
    writeFileSync(file, `${asstLine('Rewritten behind our back', 0, 'claude-sonnet-5', 777)}\n`);
    utimesSync(file, atime, mtime); // same mtime as the cached parse
    expect(await read()).toMatchObject({ model: 'claude-opus-5', contextTokens: 42 });
  });

  // Active time is tallied as the log is read forward instead of re-sorting every timestamp each tick.
  // Whatever order lines land in — including one far back, before most of the log —
  // it must equal the batch answer over the whole log.
  it('keeps active time exact across resumed reads, even for a line far out of order', async () => {
    const t0 = Date.UTC(2026, 7, 4, 9);
    const stamps: number[] = [];
    const line = (ms: number) => { stamps.push(ms); return JSON.stringify({ type: 'user', timestamp: new Date(ms).toISOString(), message: { content: 'x' } }); };
    const lines: string[] = [];
    for (let i = 0; i < 1500; i++) lines.push(line(t0 + i * 170_000 - (i % 13 === 0 ? 200_000 : 0)));
    writeFileSync(file, lines.join('\n') + '\n');
    let tick = Date.now();
    // Each append gets its own mtime: two landing in the same millisecond are, rightly, a cache hit.
    const grow = (extra: string) => { appendFileSync(file, extra); tick += 5000; utimesSync(file, new Date(tick), new Date(tick)); };
    expect((await read()).activeMs).toBe(activeMsFromTimestamps(stamps));
    grow(line(t0 + 1500 * 170_000) + '\n');
    expect((await read()).activeMs).toBe(activeMsFromTimestamps(stamps));
    grow(line(t0 + 1500 * 170_000 - 90_000) + '\n'); // slightly late
    expect((await read()).activeMs).toBe(activeMsFromTimestamps(stamps));
    grow(line(t0 + 10_000) + '\n'); // days before most of the log (a clock set back)
    expect((await read()).activeMs).toBe(activeMsFromTimestamps(stamps));
    expect(_cachedTimestampCount(file)).toBe(stamps.length);
  });

  it('handles a multi-byte character split across a read boundary', async () => {
    // 4 MiB read chunk: pad the first line past it so the next line's CJK text straddles the boundary.
    const pad = 'x'.repeat(4 * 1024 * 1024);
    writeFileSync(file, `${asstLine(pad, 0, 'claude-opus-5', 10)}\n${asstLine('세션 요약 줄 확인', 2, 'claude-opus-5', 20)}\n`);
    expect(await read()).toMatchObject({ assistantText: '세션 요약 줄 확인', contextTokens: 20 });
  });
});
