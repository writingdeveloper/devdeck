import { describe, it, expect } from 'vitest';
import { friendlyModel, parseSessionMeta } from './sessionMeta';

describe('friendlyModel', () => {
  it('maps known model ids to short names', () => {
    expect(friendlyModel('claude-opus-4-8')).toBe('Opus 4.8');
    expect(friendlyModel('claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(friendlyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(friendlyModel('opus')).toBe('Opus');
    expect(friendlyModel('sonnet')).toBe('Sonnet');
  });
  it('hides synthetic/empty, passes through unknown', () => {
    expect(friendlyModel('<synthetic>')).toBeNull();
    expect(friendlyModel(null)).toBeNull();
    expect(friendlyModel('')).toBeNull();
    expect(friendlyModel('gpt-5')).toBe('gpt-5');
  });
});

describe('parseSessionMeta', () => {
  const line = (o: object) => JSON.stringify(o);
  it('takes the last main-chain model, ignoring sidechain + synthetic, and sums active time', () => {
    const raw = [
      line({ type: 'user', timestamp: '2026-06-15T07:28:30.000Z' }),
      line({ type: 'assistant', timestamp: '2026-06-15T07:28:40.000Z', message: { model: 'claude-opus-4-8' } }),
      line({ type: 'assistant', timestamp: '2026-06-15T07:29:00.000Z', isSidechain: true, message: { model: 'claude-sonnet-4-6' } }), // subagent — ignored for model
      line({ type: 'assistant', timestamp: '2026-06-15T07:29:10.000Z', message: { model: '<synthetic>' } }),                          // synthetic — ignored
      line({ type: 'assistant', timestamp: '2026-06-15T07:29:20.000Z', message: { model: 'claude-opus-4-8' } }),
    ].join('\n');
    const r = parseSessionMeta(raw);
    expect(r.model).toBe('claude-opus-4-8');
    expect(r.activeMs).toBe(50_000); // 07:28:30 → 07:29:20 = 50s, all gaps < 5min cap
  });
  it('tolerates blank/garbage lines and an empty file', () => {
    expect(parseSessionMeta('')).toEqual({ model: null, activeMs: 0 });
    expect(parseSessionMeta('not json\n\n{bad')).toEqual({ model: null, activeMs: 0 });
  });
});
