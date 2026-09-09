import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { headingAnchors, checkLocalLinks } from '../scripts/doc-links.mjs';
it('supports repeated headings, punctuation, Unicode and ignores fenced examples', () => {
  expect([...headingAnchors('# Hello!\n## Hello!\n## 제목\n```sh\n# ignored\n```')]).toEqual(['hello', 'hello-1', '제목']);
});
it('checks HTML screenshots and same-file/cross-file headings instead of only file existence', () => {
  const root = mkdtempSync(join(tmpdir(), 'devdeck-docs-'));
  try {
    writeFileSync(join(root, 'README.md'), '# Start\n[Go](other.md#details)\n[Top](#start)\n<img src="picture.png" />');
    writeFileSync(join(root, 'other.md'), '# Details\n'); writeFileSync(join(root, 'picture.png'), 'fixture');
    expect(checkLocalLinks('README.md', root)).toBe(3);
    writeFileSync(join(root, 'other.md'), '# Renamed\n');
    expect(() => checkLocalLinks('README.md', root)).toThrow(/missing heading/);
    writeFileSync(join(root, 'README.md'), '<img src="missing.png" />');
    expect(() => checkLocalLinks('README.md', root)).toThrow(/missing local target/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
