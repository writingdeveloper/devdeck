import { resolve, sep } from 'node:path';
import type { Folder } from './types';

// Windows compares paths case-insensitively; every other platform DevDeck runs on does not. Folding
// case on win32 is required for correctness, not politeness: the paths these guards receive come from
// different producers with different casing — the folder list from the native picker, project paths
// from the scanner, and file paths from whatever text the AGENT printed into the terminal. A file the
// agent wrote as `e:\studios\shot.png` under a folder registered as `E:\` is the same file, and a
// case-sensitive compare refused to open it.
const FOLD_CASE = process.platform === 'win32';

/**
 * Canonical form for comparison: resolved, stripped of the trailing separator a FILESYSTEM ROOT keeps
 * (`E:\`, `\\srv\share\`, `/`), and case-folded where the OS is case-insensitive.
 *
 * The trailing-separator strip is what makes a whole drive usable as a scan folder. Without it the
 * containment test built the prefix `E:\` + `\` = `E:\\`, which no real child path can ever start
 * with, so every project under the drive was rejected with "Path outside allowed folders" even though
 * the scanner had just listed it. Non-root paths never end in a separator and pass through unchanged.
 *
 * A POSIX root canonicalises to '' — intentional: '' + '/' === '/' prefixes every absolute path,
 * which is exactly what registering `/` means. A Windows drive canonicalises to `E:`, so `E:` + `\`.
 */
function canon(p: string): string {
  const stripped = resolve(p).replace(/[\\/]+$/, '');
  return FOLD_CASE ? stripped.toLowerCase() : stripped;
}

/** True when `incoming` is `base` itself or lives underneath it. */
function isWithin(base: string, incoming: string): boolean {
  const b = canon(base);
  const r = canon(incoming);
  return r === b || r.startsWith(b + sep);
}

/**
 * PROJECT-identity guard: a renderer-supplied path names a valid project only if it is a child of a
 * root folder or exactly a registered repo — a repo's SUBDIRECTORY is not itself a project, so it
 * doesn't match here.
 */
export function isAllowedPath(folders: Folder[], incoming: string): boolean {
  return folders.some((f) => (f.kind === 'repo'
    ? canon(incoming) === canon(f.path)
    : isWithin(f.path, incoming)));
}

/**
 * FILE-access guard: a file may be acted on (e.g. click-to-open an image the agent printed) when it
 * lives anywhere under a configured folder — including inside a registered individual repo, which
 * isAllowedPath deliberately matches only exactly (project identity ≠ file containment) — or under
 * one of `extraRoots` (e.g. the OS temp dir, where agent tooling writes cross-project scratch files).
 */
export function isAllowedFilePath(folders: Folder[], incoming: string, extraRoots: string[] = []): boolean {
  const bases = [...folders.map((f) => f.path), ...extraRoots];
  return bases.some((base) => isWithin(base, incoming));
}

/**
 * File extensions the terminal click-to-open accepts (opened via the OS DEFAULT handler, so this is
 * a strict inert-content allowlist): raster images, audio, video, and plain documents. Deliberately
 * excluded, because a click-to-open file must never be script-capable or executable:
 * `.svg`/`.ico`/`.html`/`.xml` (open in a browser; SVG/HTML can carry `<script>` in a file://
 * origin), and every executable/script/shortcut form (`.exe .bat .cmd .ps1 .vbs .js .lnk .url …` —
 * simply not listed). Widen this ONLY to formats that can't carry active content.
 */
export const AGENT_OPEN_EXT = /\.(?:png|jpe?g|gif|webp|bmp|wav|mp3|ogg|flac|m4a|aac|opus|midi?|mp4|webm|mov|mkv|avi|pdf|txt|md|log|csv|tsv|jsonl?|ya?ml|toml)$/i;

/**
 * Resolve a path an agent printed in the terminal (e.g. "> [image] ~\AppData\...\a.png" or
 * "› [file] RawAssets\Audio\S_Perfect.wav") against the session's project dir — except a leading `~`
 * (home-dir shorthand some tools print; Node's `path` module, unlike a shell, never expands it),
 * which resolves against `homeDir` instead of the project.
 *
 * Backslashes are normalized to `/` before resolving. The cockpit is Windows-only, so agents print
 * Windows `\` paths — but the default `resolve` only treats `\` as a separator ON Windows, which made
 * this host-OS-dependent (its unit tests split backslash paths only on the Windows CI runner, red on
 * Linux/macOS). `/` is a valid separator for both path flavors, so normalizing first makes the result
 * identical on every host; on Windows the output is byte-for-byte unchanged (win32 resolve emits `\`).
 */
export function resolveAgentFilePath(projectPath: string, imagePath: string, homeDir: string): string {
  const p = String(imagePath).replace(/\\/g, '/');
  if (p === '~' || p.startsWith('~/')) {
    return resolve(homeDir, p.slice(1).replace(/^\//, ''));
  }
  return resolve(projectPath, p);
}
