// AI-QA screenshot harness: launches DevDeck via Playwright's Electron support,
// drives each view across all 4 languages, captures screenshots + console errors.
import { _electron as electron } from 'playwright';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'qa', 'shots');
mkdirSync(out, { recursive: true });

const consoleErrors = [];
const pageErrors = [];

// Isolated user-data-dir so the single-instance lock never makes this launch quit.
const app = await electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'devdeck-qa-'))}`, '--no-sandbox', '--disable-gpu'],
  cwd: root,
});
const win = await app.firstWindow();
win.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
win.on('pageerror', (e) => pageErrors.push(String(e)));

async function shot(name) {
  await win.waitForTimeout(400);
  await win.screenshot({ path: join(out, name + '.png') });
  console.log('shot:', name);
}
async function lang() { return win.evaluate(() => document.documentElement.lang || 'ko'); }
async function showView(v) {
  await win.click(`.rail-item[data-view="${v}"]`);
  await win.waitForTimeout(300);
}

// wait for first project render (skeleton -> cards), generous for git scan
await win.waitForSelector('#cards .card, #cards .empty', { timeout: 30000 }).catch(() => {});

const LANGS = ['ko', 'en', 'ja', 'zh'];
for (let i = 0; i < LANGS.length; i++) {
  const l = await lang();
  // Projects view
  await showView('projects');
  await shot(`projects-${l}`);
  // Usage view (full scan can be slow)
  await showView('usage');
  await win.waitForSelector('.usage-summary, .usage-table', { timeout: 30000 }).catch(() => {});
  await shot(`usage-${l}`);
  // Settings view
  await showView('settings');
  await shot(`settings-${l}`);
  // cycle language for next iteration
  await win.click('#lang-btn');
  await win.waitForTimeout(300);
}

// Extra states on Projects (current language) — expanded sessions + neglected filter
await showView('projects');
const expanded = await win.evaluate(() => {
  const head = document.querySelector('.sessions-head .caret');
  if (head) { head.parentElement.click(); return true; }
  return false;
});
if (expanded) await shot('projects-session-expanded');
await win.click('#neglected-only').catch(() => {});
await shot('projects-neglected-filter');
await win.click('#neglected-only').catch(() => {});

// Narrow window to check responsive card grid
await win.setViewportSize({ width: 520, height: 760 }).catch(() => {});
await shot('projects-narrow');

// Title bar: maximized state (restore glyph)
await win.setViewportSize({ width: 1000, height: 720 }).catch(() => {});
await win.evaluate(() => window.devdeck.windowControls.toggleMaximize());
await win.waitForTimeout(400);
await shot('titlebar-maximized');
await win.evaluate(() => window.devdeck.windowControls.toggleMaximize());

writeFileSync(join(out, '_console.json'), JSON.stringify({ consoleErrors, pageErrors }, null, 2));
console.log(`\nconsole errors: ${consoleErrors.length}, page errors: ${pageErrors.length}`);

await app.close();
console.log('done');
