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
 * isAllowedPath deliberately matches only exactly (project identity ≠ file containment).
 */
export function isAllowedFilePath(folders: Folder[], incoming: string): boolean {
  const r = resolve(incoming);
  return folders.some((f) => {
    const base = resolve(f.path);
    return r === base || r.startsWith(base + sep);
  });
}
