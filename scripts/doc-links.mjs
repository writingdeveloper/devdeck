import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import assert from 'node:assert/strict';

export function headingAnchors(text) {
  const ids = new Set(); const counts = new Map();
  // Current operating docs use ATX headings; ignore code fences when extracting anchors.
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const match = /^#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(line);
    if (!match) continue;
    const slug = match[1].toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = counts.get(slug) ?? 0; counts.set(slug, count + 1); ids.add(count ? slug + '-' + count : slug);
  }
  for (const match of text.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) ids.add(match[1]);
  return ids;
}
export function checkLocalLinks(file, root = process.cwd()) {
  const source = readFileSync(resolve(root, file), 'utf8'); let count = 0;
  const targets = [...source.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)].map(m => m[1]);
  for (const match of source.matchAll(/<(?:img|a)\b[^>]*\b(?:src|href)=["']([^"']+)["'][^>]*>/g)) targets.push(match[1]);
  for (const target of targets) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
    const [path, fragment] = target.split('#');
    const destination = path ? resolve(root, dirname(file), decodeURIComponent(path)) : resolve(root, file);
    assert.ok(existsSync(destination), `${file}: missing local target ${target}`);
    if (fragment && extname(destination).toLowerCase() === '.md') {
      assert.ok(headingAnchors(readFileSync(destination, 'utf8')).has(decodeURIComponent(fragment)), `${file}: missing heading ${target}`);
    }
    count++;
  }
  return count;
}
