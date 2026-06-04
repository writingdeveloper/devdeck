// Launches DevDeck against the isolated curated fixture (scripts/demo-fixture.mjs)
// and captures clean English marketing screenshots to qa/shots/demo-*.png.
// Overriding USERPROFILE/HOME points os.homedir() (and thus ~/.claude/projects)
// at the throwaway demo HOME, so NO real data is read. Dev-only.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'qa', 'shots');
mkdirSync(out, { recursive: true });

const HOME = join(tmpdir(), 'devdeck-demo-home');
const REPOS = join(HOME, 'Documents', 'GitHub');

const app = await electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'devdeck-demo-ud-'))}`, '--no-sandbox', '--disable-gpu'],
  cwd: root,
  env: { ...process.env, USERPROFILE: HOME, HOME, HOMEDRIVE: 'C:', HOMEPATH: HOME.slice(2) },
});
const win = await app.firstWindow();
win.on('console', (m) => { if (m.type() === 'error') console.log('renderer error:', m.text()); });

await win.waitForSelector('#cards .card, #cards .empty', { timeout: 30000 }).catch(() => {});
// Force English + point at the curated repos, then reload so the UI re-inits.
await win.evaluate((dir) => Promise.all([window.devdeck.setLanguage('en'), window.devdeck.setBaseDir(dir)]), REPOS);
await win.reload();
await win.waitForSelector('#cards .card', { timeout: 30000 }).catch(() => {});
await win.setViewportSize({ width: 1200, height: 760 }).catch(() => {});
await win.waitForTimeout(700);

async function shot(name) { await win.waitForTimeout(350); await win.screenshot({ path: join(out, name + '.png') }); console.log('shot:', name); }
async function showView(v) { await win.click(`.rail-item[data-view="${v}"]`); await win.waitForTimeout(400); }

// 1) hero deck
await showView('projects');
await shot('demo-projects');
// 2) expand a multi-session card (resume cue + session history visible)
const expanded = await win.evaluate(() => {
  const c = document.querySelector('.sessions-head .caret');
  if (c) { c.parentElement.click(); return true; } return false;
});
if (expanded) await shot('demo-sessions');
// 3) neglected-only filter (the traffic-light payoff)
await win.click('#neglected-only').catch(() => {});
await shot('demo-neglected');
await win.click('#neglected-only').catch(() => {});
// 4) usage analytics
await showView('usage');
await win.waitForSelector('.usage-summary, .usage-table', { timeout: 30000 }).catch(() => {});
await shot('demo-usage');
// 5) settings
await showView('settings');
await shot('demo-settings');

await app.close();
console.log('done — qa/shots/demo-*.png');
