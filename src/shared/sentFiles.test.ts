import { describe, it, expect } from 'vitest';
import { MAX_SENT_FILE_BYTES, safeSentFileName, sentFileContentOk } from './sentFiles';

describe('safeSentFileName', () => {
  it('keeps only the base name and swaps out characters Windows refuses', () => {
    expect(safeSentFileName('C:\\logs\\app.log')).toBe('app.log');
    expect(safeSentFileName('../../etc/notes.md')).toBe('notes.md');
    expect(safeSentFileName('what?:"now".txt')).toBe('what___now_.txt');
    expect(safeSentFileName('보고서.pdf')).toBe('보고서.pdf');
  });

  it('refuses kinds that could run or render as a page', () => {
    for (const n of ['a.exe', 'a.bat', 'a.ps1', 'a.js', 'a.html', 'a.svg', 'a.lnk', 'noext', 'a.txt.exe', '.txt']) {
      expect(safeSentFileName(n), n).toBeNull();
    }
  });

  it('caps a long name and keeps its extension', () => {
    const out = safeSentFileName('x'.repeat(200) + '.json')!;
    expect(out.length).toBe(80);
    expect(out.endsWith('.json')).toBe(true);
  });
});

describe('sentFileContentOk', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  it('wants a PDF to start like one and text to hold no NUL', () => {
    expect(sentFileContentOk('a.pdf', bytes('%PDF-1.4 ...'))).toBe(true);
    expect(sentFileContentOk('a.pdf', bytes('MZ....'))).toBe(false);
    expect(sentFileContentOk('a.log', bytes('ok\nfine\n'))).toBe(true);
    expect(sentFileContentOk('a.log', new Uint8Array([0x4d, 0x5a, 0, 1]))).toBe(false);
  });

  it('refuses more than the limit', () => {
    expect(sentFileContentOk('a.txt', new Uint8Array(MAX_SENT_FILE_BYTES + 1).fill(65))).toBe(false);
  });
});
