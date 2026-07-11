import { resolve, sep } from 'node:path';
import type { Folder } from './types';

/**
 * PROJECT-identity guard: a renderer-supplied path names a valid project only if it is a child of a
 * root folder or exactly a registered repo — a repo's SUBDIRECTORY is not itself a project, so it
 * doesn't match here.
 */
export function isAllowedPath(folders: Folder[], incoming: string): boolean {
  const r = resolve(incoming);
  return folders.some((f) => {
    const base = resolve(f.path);
    return f.kind === 'repo'
      ? r === base
      : r === base || r.startsWith(base + sep);
  });
}

/**
 * FILE-access guard: a file may be acted on (e.g. click-to-open an image the agent printed) when it
 * lives anywhere under a configured folder — including inside a registered individual repo, which
 * isAllowedPath deliberately matches only exactly (project identity ≠ file containment) — or under
 * one of `extraRoots` (e.g. the OS temp dir, where agent tooling writes cross-project scratch files).
 */
export function isAllowedFilePath(folders: Folder[], incoming: string, extraRoots: string[] = []): boolean {
  const r = resolve(incoming);
  const bases = [...folders.map((f) => f.path), ...extraRoots];
  return bases.some((base) => {
    const b = resolve(base);
    return r === b || r.startsWith(b + sep);
  });
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
