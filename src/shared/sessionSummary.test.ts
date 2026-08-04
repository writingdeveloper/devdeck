import { describe, it, expect } from 'vitest';
import { buildAiSourceText, cleanSummaryText, firstSentence, isLowSignal, pickSessionSummary, SUMMARY_MAX } from './sessionSummary';

describe('cleanSummaryText', () => {
  it('strips markdown emphasis, code spans, headings and links', () => {
    expect(cleanSummaryText('## **v1.24.0** 출시 `완료`')).toBe('v1.24.0 출시 완료');
    expect(cleanSummaryText('[릴리스](https://example.com/r) 확인')).toBe('릴리스 확인');
  });

  it('drops fenced code blocks entirely', () => {
    expect(cleanSummaryText('실행했습니다\n```sh\nnpm run dist\n```\n끝')).toBe('실행했습니다 끝');
  });

  it('drops list/quote/table markers and collapses whitespace', () => {
    expect(cleanSummaryText('- 첫 항목\n>  인용\n| 표 |')).toBe('첫 항목 인용 표 |');
  });

  // Review-style turns often open with a bare SHA, which would eat two thirds of the row.
  it('drops full commit SHAs but keeps short hashes and other identifiers', () => {
    expect(cleanSummaryText('f79aaeced109f256d2e31cedd7338b598d4e958d Verification: 30 items'))
      .toBe('Verification: 30 items');
    expect(cleanSummaryText('reverted 8eed599 on main')).toBe('reverted 8eed599 on main');
  });

  it('returns an empty string for empty or whitespace-only input', () => {
    expect(cleanSummaryText('')).toBe('');
    expect(cleanSummaryText('   \n\n ')).toBe('');
  });
});

describe('firstSentence', () => {
  it('cuts at the first sentence boundary', () => {
    expect(firstSentence('릴리스 태그를 올렸습니다. 이제 커밋만 남았습니다.')).toBe('릴리스 태그를 올렸습니다');
    expect(firstSentence('Fixed the guard! Then shipped.')).toBe('Fixed the guard');
  });

  // A turn that opens with a heading fragment or an ack would otherwise summarize to "v3" / "모두
  // 처리했습니다" — the actual news is in the clause right after it.
  it('keeps a short-but-real headline and extends it', () => {
    expect(firstSentence('# v3 — 음악까지 들어갔습니다. 도중에 로컬 환경이 깨져 있었습니다'))
      .toBe('v3 음악까지 들어갔습니다');
  });

  it('DROPS a leading acknowledgement instead of spending the row on it', () => {
    expect(firstSentence('네, 전혀 문제없습니다. 미루셔도 손해가 없습니다 — 근거를 짚어드리겠습니다'))
      .toBe('미루셔도 손해가 없습니다');
    expect(firstSentence('모두 처리했습니다. 판단과 근거: 유지를 택했습니다'))
      .toBe('판단과 근거: 유지를 택했습니다');
  });

  it('does not extend when there is nothing after the headline', () => {
    expect(firstSentence('모두 처리했습니다')).toBe('모두 처리했습니다');
  });

  it('cuts at an em dash used as a lead-in separator', () => {
    expect(firstSentence('v1.24.0 출시 완료 — GitHub latest 확인, 3-OS 11 assets 정상')).toBe('v1.24.0 출시 완료');
  });

  it('does not cut on a decimal point or a version number', () => {
    expect(firstSentence('v1.24.0 태그를 올렸습니다')).toBe('v1.24.0 태그를 올렸습니다');
  });

  it('truncates over-long text with an ellipsis and never exceeds the cap', () => {
    const long = '가'.repeat(SUMMARY_MAX + 40);
    const out = firstSentence(long);
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(out.endsWith('…')).toBe(true);
  });

  it('truncates on a word boundary when one is near the cap', () => {
    const out = firstSentence('release the packaged windows installer and verify every asset upload again');
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/\s…$/); // no dangling space before the ellipsis
  });
});

describe('isLowSignal', () => {
  it('flags bare acknowledgements, with or without leading adverbs', () => {
    for (const s of ['모두 처리했습니다', '전부 완료', '네, 전혀 문제없습니다', '알겠습니다', 'Done', 'Got it', '이제 끝났습니다']) {
      expect(isLowSignal(s), s).toBe(true);
    }
  });

  it('flags text too short to mean anything', () => {
    expect(isLowSignal('v3')).toBe(true);
    expect(isLowSignal('')).toBe(true);
  });

  it('keeps text that names something concrete', () => {
    for (const s of ['v1.24.0 출시 완료', 'Now AGENTS.md §8', '에디터 없이 할 수 있는 일은 전부 끝냈습니다', '사이드바 요약 줄 구현']) {
      expect(isLowSignal(s), s).toBe(false);
    }
  });
});

describe('pickSessionSummary', () => {
  it('prefers the AI one-liner over every heuristic', () => {
    expect(pickSessionSummary({
      ai: '사이드바 요약 구현', activeForm: '작업 목록 정리 중',
      assistantText: 'v1.24.0 출시 완료', editedFiles: ['a.ts'], userText: '계속 진행',
    })).toEqual({ text: '사이드바 요약 구현', source: 'ai' });
  });

  it('falls back to the in-progress task activeForm', () => {
    expect(pickSessionSummary({ activeForm: 'Play Console 배포 중', assistantText: '모두 처리했습니다' }))
      .toEqual({ text: 'Play Console 배포 중', source: 'task' });
  });

  it('uses the assistant sentence when it carries signal', () => {
    expect(pickSessionSummary({ assistantText: '**v1.24.0 출시 완료** — 3-OS 11 assets 정상', editedFiles: ['store.ts'] }))
      .toEqual({ text: 'v1.24.0 출시 완료', source: 'assistant' });
  });

  it('prefers recently edited files over a low-signal assistant sentence', () => {
    expect(pickSessionSummary({ assistantText: '모두 처리했습니다', editedFiles: ['cockpitView.ts', 'styles.css', 'ko.json'] }))
      .toEqual({ text: 'cockpitView.ts +2', source: 'files' });
  });

  it('shows a single edited file without a counter', () => {
    expect(pickSessionSummary({ assistantText: '완료', editedFiles: ['store.ts'] }))
      .toEqual({ text: 'store.ts', source: 'files' });
  });

  it('falls back to the low-signal assistant sentence when nothing better exists', () => {
    expect(pickSessionSummary({ assistantText: '모두 처리했습니다', userText: '계속 진행' }))
      .toEqual({ text: '모두 처리했습니다', source: 'assistant' });
  });

  it('falls back to the last user message when the session has no assistant text yet', () => {
    expect(pickSessionSummary({ userText: '사이드바에 요약을 붙여줘' }))
      .toEqual({ text: '사이드바에 요약을 붙여줘', source: 'user' });
  });

  it('returns null when there is nothing to show', () => {
    expect(pickSessionSummary({})).toBeNull();
    expect(pickSessionSummary({ activeForm: '   ', assistantText: '```\ncode\n```' })).toBeNull();
  });

  it('builds the AI input from the ask, the files and the reply — empty when there is nothing', () => {
    const out = buildAiSourceText({ userText: '요약 붙여줘', editedFiles: ['a.ts', 'b.css'], assistantText: '**완료**' });
    expect(out).toContain('요약 붙여줘');
    expect(out).toContain('a.ts, b.css');
    expect(out).toContain('완료');
    expect(out).not.toContain('**'); // markdown is stripped before it reaches the model
    expect(buildAiSourceText({})).toBe('');
    expect(buildAiSourceText({ userText: '  ', editedFiles: [] })).toBe('');
  });

  it('cleans and caps whatever source wins', () => {
    const out = pickSessionSummary({ ai: '**' + 'x'.repeat(SUMMARY_MAX + 20) + '**' })!;
    expect(out.text.length).toBeLessThanOrEqual(SUMMARY_MAX);
  });
});
