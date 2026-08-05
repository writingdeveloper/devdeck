import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeSessionMeta, emptySessionMeta } from './sessionMeta';
import { encodeProjectPath } from '../shared/paths';

describe('readClaudeSessionMeta', () => {
  it('rejects a traversal sessionId — no path escape (returns an empty meta)', () => {
    expect(readClaudeSessionMeta('C:/a/b', '../../../../etc/passwd', '/tmp/claude')).toEqual(emptySessionMeta());
    expect(readClaudeSessionMeta('C:/a/b', 'a/../../b', '/tmp/claude')).toEqual(emptySessionMeta());
  });
  it('returns an empty meta for a valid id whose file is missing', () => {
    expect(readClaudeSessionMeta('C:/a/b', 'a0b1c2d3-e4f5-6789-abcd-ef0123456789', '/no/such/dir')).toEqual(emptySessionMeta());
  });
  it('the empty meta is well-formed (callers destructure it without guards)', () => {
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

  const read = () => readClaudeSessionMeta(PROJECT, ID, dir);
  /** Append, then force a distinct mtime — same-millisecond writes are legitimately cache hits. */
  const append = (extra: string) => {
    appendFileSync(file, extra);
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
  };

  it('picks up ONLY what was appended, and keeps the earlier turns in the totals', () => {
    writeFileSync(file, `${userLine('add the migration', 0)}\n${asstLine('Reading the schema', 2, 'claude-opus-5', 1000)}\n`);
    const first = read();
    expect(first).toMatchObject({ model: 'claude-opus-5', contextTokens: 1000, assistantText: 'Reading the schema', userText: 'add the migration' });
    expect(first.activeMs).toBe(2 * 60_000);

    append(`${asstLine('Migration written', 4, 'claude-sonnet-5', 4200)}\n`);
    const second = read();
    // Last-wins fields follow the new lines; activeMs keeps accumulating across BOTH reads — that is
    // the field a bounded tail read could not have produced.
    expect(second).toMatchObject({ model: 'claude-sonnet-5', contextTokens: 4200, assistantText: 'Migration written' });
    expect(second.activeMs).toBe(4 * 60_000);
  });

  it('never consumes a half-written last line, and reads it once the rest lands', () => {
    const whole = asstLine('Whole line', 3, 'claude-fable-5', 999);
    const cut = Math.floor(whole.length / 2);
    writeFileSync(file, `${asstLine('First reply', 0, 'claude-opus-5', 100)}\n${whole.slice(0, cut)}`);
    // The torn line is not JSON yet — parsing it would drop the turn on the floor.
    expect(read()).toMatchObject({ model: 'claude-opus-5', contextTokens: 100, assistantText: 'First reply' });

    append(`${whole.slice(cut)}\n`);
    // Resumed from the START of that line, so it parses exactly once, now that it is complete.
    expect(read()).toMatchObject({ model: 'claude-fable-5', contextTokens: 999, assistantText: 'Whole line' });
  });

  it('reparses from zero when the log SHRANK (rewritten, not appended to)', () => {
    writeFileSync(file, `${asstLine('Old conversation', 0, 'claude-opus-5', 5000)}\n${asstLine('More of it', 6, 'claude-opus-5', 9000)}\n`);
    expect(read().contextTokens).toBe(9000);

    writeFileSync(file, `${asstLine('Brand new', 0, 'claude-sonnet-5', 300)}\n`);
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    // Carrying the old state forward would leave the stale 9000 and the old model in place.
    expect(read()).toMatchObject({ model: 'claude-sonnet-5', contextTokens: 300, assistantText: 'Brand new' });
  });

  it('an unchanged mtime is answered from cache, without re-reading the log', () => {
    writeFileSync(file, `${asstLine('Reply', 0, 'claude-opus-5', 42)}\n`);
    expect(read()).toMatchObject({ contextTokens: 42 });

    const { atime, mtime } = statSync(file);
    writeFileSync(file, `${asstLine('Rewritten behind our back', 0, 'claude-sonnet-5', 777)}\n`);
    utimesSync(file, atime, mtime); // same mtime as the cached parse
    expect(read()).toMatchObject({ model: 'claude-opus-5', contextTokens: 42 });
  });

  it('handles a multi-byte character split across a read boundary', () => {
    // 4 MiB read chunk: pad the first line past it so the next line's CJK text straddles the boundary.
    const pad = 'x'.repeat(4 * 1024 * 1024);
    writeFileSync(file, `${asstLine(pad, 0, 'claude-opus-5', 10)}\n${asstLine('세션 요약 줄 확인', 2, 'claude-opus-5', 20)}\n`);
    expect(read()).toMatchObject({ assistantText: '세션 요약 줄 확인', contextTokens: 20 });
  });
});
