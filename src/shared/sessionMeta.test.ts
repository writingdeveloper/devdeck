import { describe, it, expect } from 'vitest';
import { friendlyModel, parseSessionMeta, contextPercent, contextSeverity } from './sessionMeta';

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
      line({ type: 'assistant', timestamp: '2026-06-15T07:29:20.000Z', message: { model: 'claude-opus-4-8', usage: { input_tokens: 2, cache_read_input_tokens: 688867, cache_creation_input_tokens: 1774, output_tokens: 5692 } } }),
    ].join('\n');
    const r = parseSessionMeta(raw);
    expect(r.model).toBe('claude-opus-4-8');
    expect(r.activeMs).toBe(50_000); // 07:28:30 → 07:29:20 = 50s, all gaps < 5min cap
  });
  it('contextTokens = the LAST main-chain assistant turn\'s input+cache_read+cache_creation (current context); sidechain ignored', () => {
    const raw = [
      line({ type: 'assistant', timestamp: '2026-06-15T07:28:40.000Z', message: { model: 'claude-opus-4-8', usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } }),
      line({ type: 'assistant', timestamp: '2026-06-15T07:29:00.000Z', isSidechain: true, message: { model: 'claude-opus-4-8', usage: { input_tokens: 9, cache_read_input_tokens: 999999, cache_creation_input_tokens: 0 } } }), // subagent — ignored
      line({ type: 'assistant', timestamp: '2026-06-15T07:29:20.000Z', message: { model: 'claude-opus-4-8', usage: { input_tokens: 2, cache_read_input_tokens: 688867, cache_creation_input_tokens: 1774, output_tokens: 5692 } } }),
    ].join('\n');
    expect(parseSessionMeta(raw).contextTokens).toBe(690_643); // 2 + 688867 + 1774 (output excluded)
  });
  it('tolerates blank/garbage lines and an empty file', () => {
    expect(parseSessionMeta('')).toEqual({ model: null, activeMs: 0, contextTokens: 0 });
    expect(parseSessionMeta('not json\n\n{bad')).toEqual({ model: null, activeMs: 0, contextTokens: 0 });
  });
});

describe('contextPercent', () => {
  it('rounds tokens/window to a %, clamped to 100', () => {
    expect(contextPercent(690_643, 1_000_000)).toBe(69);
    expect(contextPercent(150_000, 200_000)).toBe(75);
    expect(contextPercent(250_000, 200_000)).toBe(100); // clamp
  });
  it('null when there is nothing to show (no tokens or bad window)', () => {
    expect(contextPercent(0, 1_000_000)).toBeNull();
    expect(contextPercent(100, 0)).toBeNull();
  });
});

describe('contextSeverity', () => {
  it("flags the compact danger zone: >=95 crit, >=80 warn, else ok", () => {
    expect(contextSeverity(79)).toBe('ok');
    expect(contextSeverity(80)).toBe('warn');
    expect(contextSeverity(94)).toBe('warn');
    expect(contextSeverity(95)).toBe('crit');
    expect(contextSeverity(100)).toBe('crit');
  });
});
