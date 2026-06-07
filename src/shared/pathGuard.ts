import { resolve, sep } from 'node:path';
import type { Folder } from './types';

/** A renderer-supplied path is safe to act on only if it is the exact path of, or lives under, a configured folder. */
export function isAllowedPath(folders: Folder[], incoming: string): boolean {
  const r = resolve(incoming);
  return folders.some((f) => {
    const base = resolve(f.path);
    return f.kind === 'repo'
      ? r === base
      : r === base || r.startsWith(base + sep);
  });
}
