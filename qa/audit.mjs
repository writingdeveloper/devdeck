// a11y (axe) + IPC-surface audit for DevDeck via Playwright Electron.
import { _electron as electron } from 'playwright';
import axeCore from 'axe-core';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'qa', 'shots');
mkdirSync(out, { recursive: true });

const userData = mkdtempSync(join(tmpdir(), 'devdeck-qa-'));
const app = await electron.launch({
  args: ['.', `--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu'],
  cwd: root,
});
const win = await app.firstWindow();

// The tray guard turns window close into hide-to-tray (and window-all-closed keeps the app alive),
// so Playwright's bare app.close() waits forever and leaks a zombie harness instance. Mark the quit
// intent in main (same flag the tray's own Quit item sets) and quit explicitly.
async function closeApp() {
  await app.evaluate(({ app: a }) => { a.isQuitting = true; setImmediate(() => a.quit()); }).catch(() => {});
  await app.close().catch(() => {});
}
await win.waitForSelector('#cards .card, #cards .empty', { timeout: 30000 }).catch(() => {});

// --- IPC surface checks ---
const ipc = {};
ipc.projectsIsArray = await win.evaluate(async () => Array.isArray(await window.devdeck.listProjects()));
ipc.language = await win.evaluate(async () => window.devdeck.getLanguage());
ipc.langRoundTrip = await win.evaluate(async () => {
  const before = await window.devdeck.getLanguage();
  await window.devdeck.setLanguage('en');
  const after = await window.devdeck.getLanguage();
  await window.devdeck.setLanguage(before);
  return after === 'en';
});
// cockpit.gitInfo must resolve the real branch by project path — the fix for restored cockpit
// sessions (and in-terminal branch switches) showing "-" instead of the live branch.
// The handler is allowlist-guarded, so register this checkout as an allowed folder first
// (on CI the checkout lives outside the default ~/Documents/GitHub scan root).
await win.evaluate(async (p) => window.devdeck.addFolder(p), root);
const gitInfoRaw = await win.evaluate(async (p) => (await window.devdeck.cockpit.gitInfo(p)) ?? null, root);
ipc.cockpitGitInfo = typeof gitInfoRaw?.branch === 'string' && gitInfoRaw.branch.length > 0;
ipc.usageShape = await win.evaluate(async () => {
  const r = await window.devdeck.usageReport(0);
  return { hasGlobal: !!r.global, hasByProject: Array.isArray(r.byProject), hasByModel: Array.isArray(r.byModel) };
});
ipc.appName = await app.evaluate(({ app: a }) => a.getName());
ipc.windowCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
// onError -> toast round-trip
ipc.errorToast = await (async () => {
  const p = win.evaluate(() => new Promise((res) => window.devdeck.onError(res)));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('devdeck:error', 'qa-test-error'));
  const msg = await p;
  const toastVisible = await win.locator('.toast').first().isVisible().catch(() => false);
  return { received: msg === 'qa-test-error', toastVisible };
})();

ipc.surface = await win.evaluate(() => ({
  openFolder: typeof window.devdeck.openFolder === 'function',
  windowControls: !!window.devdeck.windowControls &&
    ['minimize', 'toggleMaximize', 'close', 'isMaximized', 'onMaximizeChange']
      .every((k) => typeof window.devdeck.windowControls[k] === 'function'),
}));
ipc.titlebar = await win.evaluate(() => ({
  logo: !!document.querySelector('.tb-logo'),
  controls: ['win-min', 'win-max', 'win-close'].every((id) => !!document.getElementById(id)),
  closeLabeled: document.getElementById('win-close')?.getAttribute('aria-label') === 'Close',
}));

// --- axe a11y per view (inject axe-core source directly; Electron CDP lacks Target.createTarget) ---
const a11y = {};
// next + cockpit included — the two newest, most dynamic views were previously never axe-checked.
// cockpit's rail item only exists on win32, so absent views are skipped (CI runs this on Linux).
for (const view of ['projects', 'usage', 'settings', 'next', 'cockpit']) {
  const present = await win.evaluate((v) => !!document.querySelector(`.rail-item[data-view="${v}"]`), view);
  if (!present) continue;
  await win.click(`.rail-item[data-view="${view}"]`);
  await win.waitForTimeout(600);
  await win.evaluate(axeCore.source);
  const res = await win.evaluate(async () =>
    // eslint-disable-next-line no-undef
    await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }),
  );
  a11y[view] = res.violations.map((v) => ({
    id: v.id, impact: v.impact, n: v.nodes.length, help: v.help,
    targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')), // which elements — otherwise a violation is undebuggable from CI logs
  }));
}

writeFileSync(join(out, '_audit.json'), JSON.stringify({ ipc, a11y }, null, 2));
console.log('IPC:', JSON.stringify(ipc));
for (const v of Object.keys(a11y)) console.log(`a11y ${v}: ${a11y[v].length} violations`, a11y[v].map((x) => `${x.id}(${x.impact},${x.n})`).join(', '));
await closeApp();

const criticalViolations = Object.entries(a11y).flatMap(([view, viols]) =>
  viols.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => ({ view, ...v }))
);
const surfaceFails = Object.entries(ipc.surface).filter(([, v]) => v === false);
const titlebarFails = Object.entries(ipc.titlebar).filter(([, v]) => v === false);
const gitInfoFail = ipc.cockpitGitInfo !== true;

if (criticalViolations.length > 0 || surfaceFails.length > 0 || titlebarFails.length > 0 || gitInfoFail) {
  console.error('QA FAILED:');
  if (criticalViolations.length > 0) console.error('  a11y critical/serious:', JSON.stringify(criticalViolations, null, 2));
  if (surfaceFails.length > 0) console.error('  ipc.surface checks failed:', surfaceFails.map(([k]) => k).join(', '));
  if (titlebarFails.length > 0) console.error('  ipc.titlebar checks failed:', titlebarFails.map(([k]) => k).join(', '));
  if (gitInfoFail) console.error('  cockpit.gitInfo did not resolve a branch for the repo root:', ipc.cockpitGitInfo, '· raw gitInfo:', JSON.stringify(gitInfoRaw));
  process.exit(1);
}
console.log('done');
