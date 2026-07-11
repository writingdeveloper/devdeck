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
 * Image extensions the terminal click-to-open accepts. Deliberately RASTER-ONLY: `.svg` and `.ico`
 * are excluded because they open in the OS default handler (frequently a browser) and an SVG can
 * carry a `<script>` that executes in a file:// origin — a click-to-open image must never be
 * script-capable. Widen this ONLY to formats that can't carry active content.
 */
export const AGENT_IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|bmp)$/i;

/**
 * Resolve a path an agent printed in the terminal (e.g. "> [image] ~\AppData\...\a.png") against the
 * session's project dir — except a leading `~` (home-dir shorthand some tools print; Node's `path`
 * module, unlike a shell, never expands it), which resolves against `homeDir` instead of the project.
 *
 * Backslashes are normalized to `/` before resolving. The cockpit is Windows-only, so agents print
 * Windows `\` paths — but the default `resolve` only treats `\` as a separator ON Windows, which made
 * this host-OS-dependent (its unit tests split backslash paths only on the Windows CI runner, red on
 * Linux/macOS). `/` is a valid separator for both path flavors, so normalizing first makes the result
 * identical on every host; on Windows the output is byte-for-byte unchanged (win32 resolve emits `\`).
 */
export function resolveAgentImagePath(projectPath: string, imagePath: string, homeDir: string): string {
  const p = String(imagePath).replace(/\\/g, '/');
  if (p === '~' || p.startsWith('~/')) {
    return resolve(homeDir, p.slice(1).replace(/^\//, ''));
  }
  return resolve(projectPath, p);
}
