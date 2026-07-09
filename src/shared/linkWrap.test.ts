import { describe, it, expect } from 'vitest';
import { findUrlLinks, findImagePathLinks, type BufferRow } from './linkWrap';

const row = (text: string, wrapped = false): BufferRow => ({ text, wrapped });

describe('findUrlLinks', () => {
  it('finds a plain single-line URL with its column range', () => {
    const hits = findUrlLinks([row('see https://example.com/a?b=1 now')]);
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('https://example.com/a?b=1');
    expect(hits[0].start).toEqual({ row: 0, col: 4 });
    expect(hits[0].end).toEqual({ row: 0, col: 29 }); // exclusive
  });

  it('strips trailing punctuation that is prose, not URL', () => {
    const hits = findUrlLinks([row('read https://example.com/x.')]);
    expect(hits[0].url).toBe('https://example.com/x');
  });

  it('joins a SOFT-wrapped URL (xterm wrapped rows are ground truth, no heuristic needed)', () => {
    // 20-col terminal: the URL continues onto a wrapped row.
    const hits = findUrlLinks([row('https://example.com/'), row('path/abcdef?q=12345', true)]);
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('https://example.com/path/abcdef?q=12345');
    expect(hits[0].start).toEqual({ row: 0, col: 0 });
    expect(hits[0].end).toEqual({ row: 1, col: 19 });
  });

  it('joins a HARD-wrapped URL (TUI printed its own newline + indent) when the continuation is a bare URL fragment', () => {
    // Claude's renderer breaks the URL at ITS inner width and indents the continuation.
    const hits = findUrlLinks([
      row('  https://accounts.example.com/oauth?state=abc123def456'),
      row('  ghij789klm&redirect_uri=https%3A%2F%2Fapp'),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('https://accounts.example.com/oauth?state=abc123def456ghij789klm&redirect_uri=https%3A%2F%2Fapp');
    expect(hits[0].start).toEqual({ row: 0, col: 2 });
    expect(hits[0].end.row).toBe(1);
  });

  it('does NOT join a following prose word onto a URL (no URL-ish chars, short)', () => {
    const hits = findUrlLinks([row('https://example.com'), row('done')]);
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('https://example.com');
  });

  it('does NOT merge two stacked URLs', () => {
    const hits = findUrlLinks([row('https://one.example.com/aa'), row('https://two.example.com/bb')]);
    expect(hits.map((h) => h.url)).toEqual(['https://one.example.com/aa', 'https://two.example.com/bb']);
  });

  it('does NOT join when the continuation row has inner whitespace (prose)', () => {
    const hits = findUrlLinks([row('https://example.com/path'), row('and then we did more')]);
    expect(hits[0].url).toBe('https://example.com/path');
  });

  it('joins across several hard-wrapped rows (very long URL)', () => {
    const hits = findUrlLinks([
      row('https://example.com/very/long/path/segment-one-'),
      row('segment-two-segment-three?query=aaaabbbbcccc'),
      row('&more=ddddeeeeffff#fragment-part'),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('https://example.com/very/long/path/segment-one-segment-two-segment-three?query=aaaabbbbcccc&more=ddddeeeeffff#fragment-part');
    expect(hits[0].end.row).toBe(2);
  });

  it('multiple URLs on one line each get their own range', () => {
    const hits = findUrlLinks([row('a https://x.example.com b https://y.example.com c')]);
    expect(hits).toHaveLength(2);
  });
});

describe('findImagePathLinks', () => {
  // Claude prints artifacts like "  > [image] pinterest-assets\\en\\A1.png (95.8KB)" - clicking should
  // open the image instead of the user digging through Explorer.
  it('finds a relative Windows path ending in an image extension (size suffix excluded)', () => {
    const hits = findImagePathLinks([row('  > [image] pinterest-assets\\en\\A1.png (95.8KB)')]);
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('pinterest-assets\\en\\A1.png');
    expect(hits[0].start).toEqual({ row: 0, col: 12 });
    expect(hits[0].end).toEqual({ row: 0, col: 38 }); // exclusive: past ".png"
  });

  it('finds absolute paths and forward-slash paths', () => {
    const hits = findImagePathLinks([row('saved C:\\Users\\me\\out\\shot.jpeg and assets/logo.webp')]);
    expect(hits.map((h) => h.url)).toEqual(['C:\\Users\\me\\out\\shot.jpeg', 'assets/logo.webp']);
  });

  it('ignores non-image extensions (never click-to-run an executable)', () => {
    expect(findImagePathLinks([row('run build\\tool.exe and see notes.txt')])).toHaveLength(0);
  });

  it('ignores image paths that are part of a URL (the URL provider owns those)', () => {
    expect(findImagePathLinks([row('see https://cdn.example.com/img/a.png here')])).toHaveLength(0);
  });

  it('finds a bare filename', () => {
    const hits = findImagePathLinks([row('wrote A1.png')]);
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('A1.png');
  });
});
