import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Check current entry points, not historical plans that intentionally retain old context.
const files = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs/README.md',
  'docs/quality.md', 'docs/privacy.md', 'docs/backlog.md', 'docs/quality-review-2026-09-08.md'];
let links = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/i.test(target)) continue;
    const path = decodeURIComponent(target.split('#')[0]);
    assert.ok(existsSync(resolve(dirname(file), path)), `${file}: missing local link ${target}`);
    links++;
  }
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
for (const command of ['qa:maintenance', 'qa:resilience', 'check:docs']) assert.ok(pkg.scripts[command], command);
assert.equal(readFileSync('.nvmrc', 'utf8').trim(), '24');
for (const file of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
  const text = readFileSync(file, 'utf8');
  assert.ok(!/node-version:\s*20\b/.test(text), `${file}: EOL Node20`);
  assert.ok(text.includes('node qa/maintenance.mjs'), `${file}: maintenance gate missing`);
}
assert.ok(!readFileSync('README.md', 'utf8').includes('badge/tests-'), 'do not hard-code passing test totals');
console.log(`PASS ${files.length} current documents, ${links} local links, scripts and CI maintenance gates`);
