import { describe, it, expect } from 'vitest';
import { makeAiSummarizer, buildSummaryPrompt, normalizeAiSummary } from './aiSummary';

const SID = 'a0b1c2d3-e4f5-6789-abcd-ef0123456789';
const OTHER = 'b0b1c2d3-e4f5-6789-abcd-ef0123456789';

describe('buildSummaryPrompt', () => {
  it('carries the activity and caps runaway input', () => {
    expect(buildSummaryPrompt('styles.css 수정 중')).toContain('styles.css 수정 중');
    expect(buildSummaryPrompt('x'.repeat(5000)).length).toBeLessThan(2000);
  });
});

describe('normalizeAiSummary', () => {
  it('takes the first meaningful line and strips markdown', () => {
    expect(normalizeAiSummary('\n\n**사이드바 요약 구현**\n부연 설명은 버린다')).toBe('사이드바 요약 구현');
  });
  it('caps over-long answers and tolerates an empty one', () => {
    expect(normalizeAiSummary('가'.repeat(200)).length).toBeLessThanOrEqual(60);
    expect(normalizeAiSummary('   ')).toBe('');
  });
});

describe('makeAiSummarizer', () => {
  it('does nothing at all while disabled', async () => {
    let calls = 0;
    const s = makeAiSummarizer({ runners: { claude: async () => { calls++; return 'x'; } } });
    expect(s.get(SID, 1, 'some work')).toBeNull();
    await s.idle();
    expect(calls).toBe(0);
  });

  it('returns null on the first ask, then the generated line', async () => {
    const s = makeAiSummarizer({ runners: { claude: async () => '사이드바 요약 구현' } });
    s.setEnabled(true);
    expect(s.get(SID, 1, 'cockpitView.ts 수정')).toBeNull();
    await s.idle();
    expect(s.get(SID, 1, 'cockpitView.ts 수정')).toBe('사이드바 요약 구현');
  });

  it('does not re-run for an unchanged log mtime', async () => {
    let calls = 0;
    const s = makeAiSummarizer({ runners: { claude: async () => { calls++; return `r${calls}`; } } });
    s.setEnabled(true);
    s.get(SID, 5, 'work'); await s.idle();
    s.get(SID, 5, 'work'); s.get(SID, 5, 'work'); await s.idle();
    expect(calls).toBe(1);
  });

  it('regenerates when the log advanced, once the cooldown has passed', async () => {
    let calls = 0;
    let clock = 1_000_000;
    const s = makeAiSummarizer({
      runners: { claude: async () => { calls++; return `r${calls}`; } },
      now: () => clock,
      cooldownMs: 90_000,
    });
    s.setEnabled(true);
    s.get(SID, 1, 'work'); await s.idle();
    expect(s.get(SID, 1, 'work')).toBe('r1');

    clock += 10_000; // still cooling down → keeps showing the previous line, no new call
    expect(s.get(SID, 2, 'more work')).toBe('r1');
    await s.idle();
    expect(calls).toBe(1);

    clock += 90_000; // cooldown elapsed → regenerate
    s.get(SID, 2, 'more work'); await s.idle();
    expect(s.get(SID, 2, 'more work')).toBe('r2');
  });

  it('caches a failure so a missing CLI is not retried every tick', async () => {
    let calls = 0;
    const s = makeAiSummarizer({ runners: { claude: async () => { calls++; throw new Error('claude exited 1'); } } });
    s.setEnabled(true);
    s.get(SID, 1, 'work'); await s.idle();
    expect(s.get(SID, 1, 'work')).toBeNull();
    await s.idle();
    expect(calls).toBe(1);
  });

  it('never runs two generations at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const s = makeAiSummarizer({
      runners: {
        claude: async () => {
          inFlight++; peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--; return 'ok';
        },
      },
    });
    s.setEnabled(true);
    s.get(SID, 1, 'a'); s.get(OTHER, 1, 'b');
    await s.idle();
    expect(peak).toBe(1);
    expect(s.get(SID, 1, 'a')).toBe('ok');
    expect(s.get(OTHER, 1, 'b')).toBe('ok');
  });

  it('with queue:false reads the cache only — and keeps showing the previous line mid-turn', async () => {
    let calls = 0;
    const s = makeAiSummarizer({ runners: { claude: async () => { calls++; return `r${calls}`; } } });
    s.setEnabled(true);
    s.get(SID, 1, 'work'); await s.idle();
    expect(calls).toBe(1);
    // The log grew (the session is mid-turn) but the caller isn't asking for a new summary yet.
    expect(s.get(SID, 2, 'more work', { queue: false })).toBe('r1');
    await s.idle();
    expect(calls).toBe(1);
  });

  it('skips sessions with no activity text and drops queued work when switched off', async () => {
    let calls = 0;
    const s = makeAiSummarizer({ runners: { claude: async () => { calls++; return 'x'; } } });
    s.setEnabled(true);
    expect(s.get(SID, 1, '   ')).toBeNull();
    await s.idle();
    expect(calls).toBe(0);

    s.get(OTHER, 1, 'real work');
    s.setEnabled(false);
    await s.idle();
    expect(calls).toBe(0);
  });

  // A multi-provider tool must not spend one vendor's quota on another's work — and must still work
  // for someone who installed only Codex.
  it('summarizes each session with ITS OWN provider CLI', async () => {
    const used: string[] = [];
    const s = makeAiSummarizer({
      runners: {
        claude: async () => { used.push('claude'); return 'from claude'; },
        codex: async () => { used.push('codex'); return 'from codex'; },
      },
    });
    s.setEnabled(true);
    s.get(SID, 1, 'claude work', { provider: 'claude' });
    s.get(OTHER, 1, 'codex work', { provider: 'codex' });
    await s.idle();

    expect(s.get(SID, 1, 'claude work', { provider: 'claude' })).toBe('from claude');
    expect(s.get(OTHER, 1, 'codex work', { provider: 'codex' })).toBe('from codex');
    expect(used.sort()).toEqual(['claude', 'codex']);
  });

  it('queues nothing for a provider with no summarizer', async () => {
    let calls = 0;
    const s = makeAiSummarizer({ runners: { claude: async () => { calls++; return 'x'; } } });
    s.setEnabled(true);
    expect(s.get(SID, 1, 'agy work', { provider: 'antigravity' })).toBeNull();
    await s.idle();
    expect(calls).toBe(0);
  });

  it('works with only Codex installed (no Claude runner configured)', async () => {
    const s = makeAiSummarizer({ runners: { codex: async () => 'codex만 있어도 동작' } });
    s.setEnabled(true);
    s.get(SID, 1, 'work', { provider: 'codex' });
    await s.idle();
    expect(s.get(SID, 1, 'work', { provider: 'codex' })).toBe('codex만 있어도 동작');
  });
});
