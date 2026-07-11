import { describe, it, expect } from 'vitest';
import { join, resolve, sep } from 'node:path';
import { isAllowedPath, isAllowedFilePath, resolveAgentFilePath, AGENT_OPEN_EXT } from './pathGuard';

// Build OS-native absolute paths so the test exercises the same separator/`resolve`
// semantics the guard uses on whatever platform runs it (CI runs ubuntu/macos/windows).
const root = resolve(sep, 'work');
const repo = resolve(sep, 'spike');
const folders = [
  { path: root, kind: 'root' as const },
  { path: repo, kind: 'repo' as const },
];

describe('isAllowedPath', () => {
  it('allows a path under a root', () => {
    expect(isAllowedPath(folders, join(root, 'projA'))).toBe(true);
    expect(isAllowedPath(folders, root)).toBe(true);
  });
  it('rejects a sibling that merely shares a prefix', () => {
    expect(isAllowedPath(folders, resolve(sep, 'work2', 'projA'))).toBe(false);
  });
  it('matches a repo entry only by exact path, not its children', () => {
    expect(isAllowedPath(folders, repo)).toBe(true);
    expect(isAllowedPath(folders, join(repo, 'sub'))).toBe(false);
  });
  it('rejects anything when no folders are configured', () => {
    expect(isAllowedPath([], join(root, 'projA'))).toBe(false);
  });
});

describe('isAllowedFilePath', () => {
  // FILE access (e.g. click-to-open an image the agent printed) differs from PROJECT identity:
  // a file inside a registered individual repo is fair game even though the repo entry itself
  // only matches exactly for project-level actions.
  it('allows files under a root AND under a repo entry', () => {
    expect(isAllowedFilePath(folders, join(root, 'projA', 'img.png'))).toBe(true);
    expect(isAllowedFilePath(folders, join(repo, 'assets', 'img.png'))).toBe(true);
  });
  it('still rejects anything outside every configured folder', () => {
    expect(isAllowedFilePath(folders, resolve(sep, 'elsewhere', 'img.png'))).toBe(false);
    expect(isAllowedFilePath([], join(root, 'img.png'))).toBe(false);
  });

  const scratch = resolve(sep, 'tmp-root');
  it('with extraRoots, also allows files under an extra root (e.g. the OS temp/scratchpad dir)', () => {
    expect(isAllowedFilePath(folders, join(scratch, 'claude', 'a.png'), [scratch])).toBe(true);
    expect(isAllowedFilePath(folders, scratch, [scratch])).toBe(true);
  });
  it('extraRoots does not widen access beyond itself plus the configured folders', () => {
    expect(isAllowedFilePath(folders, resolve(sep, 'elsewhere', 'img.png'), [scratch])).toBe(false);
  });
  it('omitting extraRoots preserves prior behavior exactly', () => {
    expect(isAllowedFilePath(folders, join(root, 'projA', 'img.png'))).toBe(true);
  });
});

describe('resolveAgentFilePath', () => {
  const home = resolve(sep, 'home', 'demo');
  const proj = resolve(sep, 'work', 'projA');

  it('resolves a plain relative path against the project dir (unchanged behavior)', () => {
    expect(resolveAgentFilePath(proj, join('assets', 'a.png'), home)).toBe(join(proj, 'assets', 'a.png'));
  });
  it('expands a leading ~ to the home dir instead of the project dir', () => {
    expect(resolveAgentFilePath(proj, '~/AppData/Local/Temp/claude/a.png', home))
      .toBe(join(home, 'AppData', 'Local', 'Temp', 'claude', 'a.png'));
    expect(resolveAgentFilePath(proj, '~\\AppData\\Local\\Temp\\claude\\a.png', home))
      .toBe(join(home, 'AppData', 'Local', 'Temp', 'claude', 'a.png'));
  });
  it('expands ~ for a CROSS-PROJECT path clicked from another project (wishing-stones bug report)', () => {
    // "> [image] ~\Documents\GitHub\wishing-stones\…\T_Stone_BC.png" clicked while in another project.
    // Pre-v1.19.2 this resolved against the project dir → …\<project>\~\Documents\… → "Image not found".
    expect(resolveAgentFilePath(proj, '~\\Documents\\GitHub\\wishing-stones\\RawAssets\\T_Stone_BC.png', home))
      .toBe(join(home, 'Documents', 'GitHub', 'wishing-stones', 'RawAssets', 'T_Stone_BC.png'));
  });
  it('bare ~ resolves to exactly the home dir', () => {
    expect(resolveAgentFilePath(proj, '~', home)).toBe(home);
  });
  it('does not treat a path merely starting with a tilde-prefixed segment as home-relative', () => {
    // "~foo" (no separator) is a literal relative filename, not shorthand for the home dir.
    expect(resolveAgentFilePath(proj, '~foo.png', home)).toBe(join(proj, '~foo.png'));
  });
});

describe('AGENT_OPEN_EXT (click-to-open allowlist)', () => {
  it('accepts raster images, audio, video, and inert documents, case-insensitively', () => {
    for (const f of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.bmp', 'shot.PNG',
      's.wav', 'S_Perfect.WAV', 'song.mp3', 'x.ogg', 'y.flac', 'z.m4a', 'w.aac', 'v.opus', 'm.mid',
      'clip.mp4', 'v.webm', 'v.mov', 'v.mkv', 'v.avi',
      'doc.pdf', 'notes.txt', 'readme.md', 'run.log', 'data.csv', 'data.tsv', 'x.json', 'x.jsonl', 'c.yaml', 'c.yml', 'c.toml']) {
      expect(AGENT_OPEN_EXT.test(f), f).toBe(true);
    }
  });
  it('REFUSES executable / script-capable extensions so shell.openPath cannot run them', () => {
    for (const f of ['evil.svg', 'x.SVG', 'icon.ico', 'app.exe', 'setup.bat', 'run.cmd', 'h.ps1', 'v.vbs',
      's.scr', 'l.lnk', 'u.url', 'page.html', 'p.htm', 'x.xml', 'j.js', 'p.py', 'archive.png.svg', 'a.zip', 'x.jar']) {
      expect(AGENT_OPEN_EXT.test(f), f).toBe(false);
    }
  });
});
