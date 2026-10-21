// src/shared/terminalMarks.test.ts
import { describe, it, expect } from 'vitest';
import { findImagePlaceholders, findPromptRows, nextPromptRow, pairPlaceholders } from './terminalMarks';
import type { SessionImageRef } from './sessionImages';

const ref = (id: string, kind: SessionImageRef['kind'], tool: string | null): SessionImageRef => ({ id, kind, ts: null, tool, path: null });

describe('findImagePlaceholders', () => {
  it('finds tool images and pasted ones where Claude Code printed them', () => {
    const rows = ['● playwright - browser_take_screenshot (MCP)(element: "x")', '  ⎿  [Image]', '❯ [Image #2] 이거 봐줘', 'see [Imagenet]'];
    expect(findImagePlaceholders(rows, 100)).toEqual([
      { row: 101, col: 5, len: 7, kind: 'screenshot' },
      { row: 102, col: 2, len: 10, kind: 'pasted' },
    ]);
  });
});

describe('pairPlaceholders', () => {
  const screen = [
    '● playwright - browser_navigate (MCP)(url: "http://a")', // 0
    '● playwright - browser_take_screenshot (MCP)',           // 1
    '  ⎿  [Image]',                                            // 2
    '● windows-mcp - Screenshot (MCP)',                        // 3
    '  ⎿  [Image]',                                            // 4
    '● playwright - browser_take_screenshot (MCP)',           // 5
    '  ⎿  [Image]',                                            // 6
  ];
  const text = (r: number): string => screen[r] ?? '';
  const marks = findImagePlaceholders(screen);

  it('pairs from the newest end, checking each against the tool named above it', () => {
    const refs = [ref('a', 'screenshot', 'mcp__playwright__browser_take_screenshot'), ref('b', 'screenshot', 'mcp__windows-mcp__Screenshot'), ref('c', 'screenshot', 'mcp__playwright__browser_take_screenshot')];
    expect([...pairPlaceholders(refs, marks, text)].sort()).toEqual([[0, 'a'], [1, 'b'], [2, 'c']]);
  });

  it('skips a transcript image the screen does not show instead of shifting every older one', () => {
    // 'x' (a blender look) is in the transcript but its output was folded away on screen.
    const refs = [ref('a', 'screenshot', 'mcp__playwright__browser_take_screenshot'), ref('b', 'screenshot', 'mcp__windows-mcp__Screenshot'), ref('x', 'screenshot', 'mcp__blender__look'), ref('c', 'screenshot', 'mcp__playwright__browser_take_screenshot')];
    expect([...pairPlaceholders(refs, marks, text)].sort()).toEqual([[0, 'a'], [1, 'b'], [2, 'c']]);
  });

  it('leaves a placeholder unpaired rather than giving it a neighbour\'s image', () => {
    const refs = [ref('p', 'screenshot', 'mcp__playwright__browser_take_screenshot')];
    // Only one playwright image is known: it is the newest placeholder's, and the windows one gets none.
    const pairs = pairPlaceholders(refs, marks, text);
    expect([...pairs]).toEqual([[2, 'p']]);
  });

  it('checks only the call a placeholder belongs to, not the one before it', () => {
    const top = screen.slice(0, 5); // newest image is the windows one, right under a playwright call
    const pairs = pairPlaceholders([ref('p1', 'screenshot', 'mcp__playwright__browser_take_screenshot'), ref('p2', 'screenshot', 'mcp__playwright__browser_take_screenshot')], findImagePlaceholders(top), (r) => top[r] ?? '');
    expect([...pairs]).toEqual([[0, 'p2']]);
  });

  it('pairs pasted images by order', () => {
    const rows = ['❯ [Image #1] first', 'ok', '❯ [Image #2] second'];
    const pairs = pairPlaceholders([ref('p1', 'pasted', null), ref('p2', 'pasted', null)], findImagePlaceholders(rows), (r) => rows[r]);
    expect([...pairs].sort()).toEqual([[0, 'p1'], [1, 'p2']]);
  });
});

describe('findPromptRows', () => {
  const row = (text: string, shaded = false) => ({ text, shaded });
  it('finds shaded prompt rows above the composer and ignores the composer itself', () => {
    const rows = [
      row('❯ 첫 질문', true), row('● 답변'), row('> quoted, not shaded'), row('> 두번째', true), row('● 답'),
      row('────────────────'), row('❯ typing…', true), row('────────────────'), row('  ⏵⏵ auto mode'),
    ];
    expect(findPromptRows(rows, 10)).toEqual([10, 13]);
  });

  it('steps between prompts from the viewport top, and past the last one to the bottom', () => {
    const prompts = [10, 40, 90];
    expect(nextPromptRow(prompts, 50, -1)).toBe(40);
    expect(nextPromptRow(prompts, 40, -1)).toBe(10);
    expect(nextPromptRow(prompts, 5, -1)).toBe(10);
    expect(nextPromptRow(prompts, 40, 1)).toBe(90);
    expect(nextPromptRow(prompts, 90, 1)).toBeNull();
  });
});
