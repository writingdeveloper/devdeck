import { describe, it, expect } from 'vitest';
import { unwrapCopiedUrl } from './urlCopy';

describe('unwrapCopiedUrl', () => {
  it('rejoins a hard-wrapped, indented URL into a single clean URL (the real Stripe OAuth case)', () => {
    // Exactly how Claude Code's CLI renders a long URL: broken across rows, each row re-indented.
    const seg = [
      'https://access.stripe.com/mcp/oauth2/authorize?response_type=code&client_id=oacli_Ul4r82AQMVfWj4&code_challenge=DKWbgo94HCywm54XzV2ViOV',
      'oD8FdN4mT51_n2lih7OU&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A39824%2Fcallback&state=C0KqV-sjg7h9MarOtgg7P5WQLR',
      'VTEqsJzD2WpTXj58M&scope=mcp&resource=https%3A%2F%2Fmcp.stripe.com%2F',
    ];
    const clean = seg.join('');
    const wrapped = seg.map((s) => '  ' + s).join('\n'); // 2-space indent per row, like the transcript
    expect(unwrapCopiedUrl(wrapped)).toBe(clean);
  });

  it('rejoins a wrapped URL with no indentation (plain soft-wrap-style split)', () => {
    const wrapped = 'https://example.com/very/long/path/that/got/\nbroken/across/two/lines';
    expect(unwrapCopiedUrl(wrapped)).toBe('https://example.com/very/long/path/that/got/broken/across/two/lines');
  });

  it('handles http as well as https', () => {
    expect(unwrapCopiedUrl('http://localhost:39824/cal\n  lback?code=oac_123')).toBe('http://localhost:39824/callback?code=oac_123');
  });

  it('trims trailing CR and blank lines around the URL', () => {
    expect(unwrapCopiedUrl('  https://a.example/x\r\n  yz\r\n')).toBe('https://a.example/xyz');
  });

  it('leaves a single-line URL untouched', () => {
    const url = 'https://example.com/already/one/line?x=1';
    expect(unwrapCopiedUrl(url)).toBe(url);
  });

  it('leaves ordinary single-line text untouched', () => {
    expect(unwrapCopiedUrl('npm run dist')).toBe('npm run dist');
  });

  it('leaves multi-line indented CODE untouched (whitespace there is meaningful)', () => {
    const code = '  if (x) {\n    doThing();\n  }';
    expect(unwrapCopiedUrl(code)).toBe(code);
  });

  it('does NOT merge two distinct URLs on separate lines', () => {
    const two = 'https://a.example/one\nhttps://b.example/two';
    expect(unwrapCopiedUrl(two)).toBe(two);
  });

  it('does NOT touch a selection that is a URL followed by prose', () => {
    const mixed = 'https://a.example/x\nand more text here';
    expect(unwrapCopiedUrl(mixed)).toBe(mixed);
  });

  it('leaves a non-http token split across lines untouched (only http/https are unwrapped)', () => {
    const token = 'C0KqV-sjg7h9MarOtgg7P5WQLR\n  VTEqsJzD2WpTXj58M';
    expect(unwrapCopiedUrl(token)).toBe(token);
  });

  it('returns empty / whitespace-only input unchanged', () => {
    expect(unwrapCopiedUrl('')).toBe('');
    expect(unwrapCopiedUrl('   \n  ')).toBe('   \n  ');
  });
});
