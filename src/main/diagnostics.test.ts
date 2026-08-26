import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiagnosticsLog, adoptLegacyErrorLog, formatDiagLine } from './diagnostics';

const dir = (): string => mkdtempSync(join(tmpdir(), 'devdeck-diag-'));
const at = new Date('2026-08-26T01:02:03.000Z');

describe('formatDiagLine', () => {
  it('puts a whole entry on ONE line, stack trace and all', () => {
    // A reader (a person or an agent) scans this file line by line. A stack trace spread over
    // fifteen lines reads as fifteen unrelated events.
    const line = formatDiagLine(at, 'error', 'renderer', 'boom\n  at a()\n  at b()');
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('at a()');
    expect(line).toBe('2026-08-26T01:02:03.000Z ERROR [renderer] boom ⏎   at a() ⏎   at b()');
  });

  it('carries a memory snapshot when given one', () => {
    // The one abort that bypasses every trap is V8 running out of heap; a rising trend across
    // whatever DID get logged before it is the only way to see that afterwards.
    expect(formatDiagLine(at, 'info', 'app', 'started', { rss: 408, heap: 338 }))
      .toContain('| rss=408MB heap=338MB');
  });
});

describe('DiagnosticsLog', () => {
  it('appends entries and reads them back newest last', () => {
    const log = new DiagnosticsLog(join(dir(), 'devdeck.log'), { now: () => at, memory: () => ({ rss: 1, heap: 1 }) });
    log.write('info', 'app', 'first');
    log.write('error', 'pty', 'second');
    expect(log.tail().split('\n').map((l) => l.split('] ')[1].split(' |')[0])).toEqual(['first', 'second']);
  });

  it('rolls over instead of growing without bound, keeping one previous generation', () => {
    // A tray app runs for weeks. An uncapped log is a disk leak; a truncated one throws away the
    // lines immediately before the problem, which are the ones worth having.
    const path = join(dir(), 'devdeck.log');
    const log = new DiagnosticsLog(path, { now: () => at, memory: () => ({ rss: 1, heap: 1 }), maxBytes: 400 });
    for (let i = 0; i < 40; i++) log.write('info', 'app', `line ${i}`);
    expect(log.size()).toBeLessThan(400 + 200);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(log.tail()).toContain('line 39');
  });

  it('answers emptily rather than throwing when there is no file yet', () => {
    const log = new DiagnosticsLog(join(dir(), 'missing', 'devdeck.log'));
    expect(log.tail()).toBe('');
    expect(log.size()).toBe(0);
  });

  it('never throws out of write, whatever the path', () => {
    // Logging that can break the thing it is diagnosing is worse than no logging.
    const log = new DiagnosticsLog(join(dir()), { now: () => at }); // a directory, not a file
    expect(() => log.write('error', 'app', 'boom')).not.toThrow();
  });
});

describe('adoptLegacyErrorLog', () => {
  it('carries the old crash-only log forward once, and only into an empty file', () => {
    const root = dir();
    const legacy = join(root, 'devdeck-errors.log');
    writeFileSync(legacy, '2026-08-01 [uncaughtException] old boom\n');
    const path = join(root, 'devdeck.log');
    const log = new DiagnosticsLog(path, { now: () => at, memory: () => ({ rss: 1, heap: 1 }) });
    adoptLegacyErrorLog(log, legacy);
    expect(readFileSync(path, 'utf8')).toContain('old boom');
    const after = readFileSync(path, 'utf8');
    adoptLegacyErrorLog(log, legacy); // a second launch must not append it all again
    expect(readFileSync(path, 'utf8')).toBe(after);
  });

  it('does nothing when there is no old log', () => {
    const root = dir();
    const log = new DiagnosticsLog(join(root, 'devdeck.log'));
    expect(() => adoptLegacyErrorLog(log, join(root, 'nope.log'))).not.toThrow();
    expect(log.size()).toBe(0);
  });
});
