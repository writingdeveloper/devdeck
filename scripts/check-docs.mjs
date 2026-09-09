import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { checkLocalLinks } from './doc-links.mjs';

// Current operating documents only; historical design plans keep their original context.
const files = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs/README.md',
  'docs/quality.md', 'docs/privacy.md', 'docs/backlog.md', 'docs/quality-review-2026-09-08.md',
  'docs/state-consistency.md', 'docs/session-sync-review-2026-09-08.md'];
const links = files.reduce((count, file) => count + checkLocalLinks(file), 0);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
for (const command of ['qa:maintenance', 'qa:resilience', 'qa:session-sync', 'check:docs']) assert.ok(pkg.scripts[command], command);
assert.equal(readFileSync('.nvmrc', 'utf8').trim(), '24');
for (const file of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
  const text = readFileSync(file, 'utf8');
  assert.ok(!/node-version:\s*20\b/.test(text), `${file}: EOL Node20`);
  assert.ok(text.includes('node qa/maintenance.mjs'), `${file}: maintenance gate missing`);
  assert.ok(text.includes('node qa/session-sync.mjs'), `${file}: shared state gate missing`);
}
assert.ok(!readFileSync('README.md', 'utf8').includes('badge/tests-'), 'do not hard-code passing test totals');
console.log(`PASS ${files.length} current documents, ${links} local links/images/anchors, scripts and CI shared-state gates`);
