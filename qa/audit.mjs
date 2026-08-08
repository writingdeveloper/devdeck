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
// The handler is allowlist-guarded, so register this checkout as an allowed folder first (on CI the
// checkout lives outside the default ~/Documents/GitHub scan root). addFolder only accepts a directory
// blessed by the native pickFolder dialog (a renderer can't self-add one), so stub the dialog to "pick"
// this checkout, then drive the real pickFolder → addFolder handshake.
await app.evaluate(({ dialog }, p) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
}, root);
await win.evaluate(async () => window.devdeck.pickFolder());
await win.evaluate(async (p) => window.devdeck.addFolder(p), root);
const gitInfoRaw = await win.evaluate(async (p) => (await window.devdeck.cockpit.gitInfo(p)) ?? null, root);
ipc.cockpitGitInfo = typeof gitInfoRaw?.branch === 'string' && gitInfoRaw.branch.length > 0;
ipc.providerOpen = await win.evaluate(async (p) => {
  await window.devdeck.setTodos(p, [{
    id: 'qa-open', text: 'Provider open QA', done: false, due: null,
    createdAt: new Date().toISOString(),
  }]);
  document.querySelector('.rail-item[data-view="next"]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 700));
  const control = document.querySelector('#view-next .provider-open');
  const primary = control?.querySelector('.provider-open-primary');
  const menuButton = control?.querySelector('.provider-open-menu-button');
  menuButton?.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const menu = control?.querySelector('.provider-open-menu');
  const menuOpened = menuButton?.getAttribute('aria-expanded') === 'true' && !menu?.classList.contains('hidden');
  const menuItems = menu?.querySelectorAll('[role="menuitem"]').length ?? 0;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return {
    root: !!control,
    primaryLabel: primary?.getAttribute('aria-label') ?? '',
    menuLabel: menuButton?.getAttribute('aria-label') ?? '',
    menuOpened,
    menuItems,
    escapeClosed: menuButton?.getAttribute('aria-expanded') === 'false' && !!menu?.classList.contains('hidden'),
  };
}, root);
ipc.usageShape = await win.evaluate(async () => {
  const r = await window.devdeck.usageReport(0);
  return { hasGlobal: !!r.global, hasByProject: Array.isArray(r.byProject), hasByModel: Array.isArray(r.byModel), hasByProvider: Array.isArray(r.byProvider) && r.byProvider.length === 2 };
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
const localUsageReport = {
  global: { input: 300, output: 100, cacheWrite: 20, cacheRead: 120 }, globalCost: 2.5, hasUnknownModel: false,
  webSearch: 0, webFetch: 0, sessions: 2, activeMs: 1200000,
  byModel: [
    { providerId: 'claude', model: 'claude-opus-4-1', totals: { input: 100, output: 40, cacheWrite: 20, cacheRead: 40 }, costEstimate: 1, hasUnknownPrice: false },
    { providerId: 'codex', model: 'gpt-5.6-sol', totals: { input: 200, output: 60, cacheWrite: 0, cacheRead: 80 }, costEstimate: 1.5, hasUnknownPrice: false },
  ],
  byProject: [{ path: 'C:/qa/app', name: 'qa-app', sessions: 2, totals: { input: 300, output: 100, cacheWrite: 20, cacheRead: 120 }, costEstimate: 2.5, hasUnknownModel: false, activeMs: 1200000, status: 'active', providerCosts: { claude: 1, codex: 1.5 } }],
  daily: [{ day: '2026-08-08', tokens: 400, cost: 2.5, providerTokens: { claude: 140, codex: 260 }, providerCosts: { claude: 1, codex: 1.5 } }],
  byProvider: [
    { providerId: 'claude', state: 'ready', global: { input: 100, output: 40, cacheWrite: 20, cacheRead: 40 }, globalCost: 1, hasUnknownModel: false, webSearch: 0, webFetch: 0, sessions: 1, activeMs: 600000,
      byModel: [{ providerId: 'claude', model: 'claude-opus-4-1', totals: { input: 100, output: 40, cacheWrite: 20, cacheRead: 40 }, costEstimate: 1, hasUnknownPrice: false }],
      byProject: [{ path: 'C:/qa/app', name: 'qa-app', sessions: 1, totals: { input: 100, output: 40, cacheWrite: 20, cacheRead: 40 }, costEstimate: 1, hasUnknownModel: false, activeMs: 600000, status: 'active', providerCosts: { claude: 1 } }], daily: [] },
    { providerId: 'codex', state: 'ready', global: { input: 200, output: 60, cacheWrite: 0, cacheRead: 80 }, globalCost: 1.5, hasUnknownModel: false, webSearch: 0, webFetch: 0, sessions: 1, activeMs: 600000,
      byModel: [{ providerId: 'codex', model: 'gpt-5.6-sol', totals: { input: 200, output: 60, cacheWrite: 0, cacheRead: 80 }, costEstimate: 1.5, hasUnknownPrice: false }],
      byProject: [{ path: 'C:/qa/app', name: 'qa-app', sessions: 1, totals: { input: 200, output: 60, cacheWrite: 0, cacheRead: 80 }, costEstimate: 1.5, hasUnknownModel: false, activeMs: 600000, status: 'active', providerCosts: { codex: 1.5 } }], daily: [] },
  ],
};
// next + cockpit included — the two newest, most dynamic views were previously never axe-checked.
// cockpit's rail item only exists on win32, so absent views are skipped (CI runs this on Linux).
for (const view of ['projects', 'usage', 'settings', 'next', 'cockpit']) {
  const present = await win.evaluate((v) => !!document.querySelector(`.rail-item[data-view="${v}"]`), view);
  if (!present) continue;
  await win.click(`.rail-item[data-view="${view}"]`);
  await win.waitForTimeout(600);
  if (view === 'usage') {
    await win.evaluate((report) => document.dispatchEvent(new CustomEvent('devdeck:local-usage-report', { detail: report })), localUsageReport);
    await win.waitForTimeout(100);
  }
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

// The all-provider usage dialog is a modal surface — audit it OPEN, with a representative snapshot
// (the harness cannot supply real provider credentials, and an empty dialog would audit nothing).
{
  const snapshot = {
    fetchedAt: Date.now(),
    providers: [
      { providerId: 'claude', state: 'ready', planLabel: 'Max 20x', credits: { hasCredits: true, balance: 12.5, spent: 3.25, currency: 'USD' }, guidance: null, fetchedAt: Date.now(), limits: [
        { id: 'claude:session', kind: 'session', label: 'usage.limit_session', percent: 42, resetAt: Date.now() + 7200_000, modelLabel: null },
        { id: 'claude:seven_day:fable-5', kind: 'model-weekly', label: 'usage.limit_model_weekly', percent: 91, resetAt: Date.now() + 259200_000, modelLabel: 'Fable 5' },
      ] },
      { providerId: 'codex', state: 'stale', planLabel: 'plus', credits: null, guidance: null, fetchedAt: Date.now(), staleSince: Date.now() - 480_000, limits: [
        { id: 'codex:primary', kind: 'primary', label: 'usage.limit_primary', percent: 18, resetAt: Date.now() + 18000_000, modelLabel: null },
      ] },
      { providerId: 'antigravity', state: 'unsupported', planLabel: null, credits: null, fetchedAt: Date.now(), limits: [], guidance: { commands: ['/usage', '/quota', '/credits'] } },
    ],
  };
  await win.evaluate(async (s) => {
    document.dispatchEvent(new CustomEvent('devdeck:usage-open', { detail: { snapshot: s } }));
    await new Promise((r) => setTimeout(r, 300));
  }, snapshot);
  const dialog = await win.evaluate(() => {
    const d = document.querySelector('.usage-modal');
    return {
      present: !!d,
      role: d?.getAttribute('role') === 'dialog',
      ariaModal: d?.getAttribute('aria-modal') === 'true',
      closeLabelled: !!document.querySelector('.um-close')?.getAttribute('aria-label'),
      sections: document.querySelectorAll('.um-provider').length,
    };
  });
  ipc.usageDialog = dialog;
  await win.evaluate(axeCore.source);
  const res = await win.evaluate(async () =>
    // eslint-disable-next-line no-undef
    await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }),
  );
  a11y['usage-dialog'] = res.violations.map((v) => ({
    id: v.id, impact: v.impact, n: v.nodes.length, help: v.help,
    targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
  }));
  await win.evaluate(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
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
const dialogFails = Object.entries(ipc.usageDialog ?? {}).filter(([k, v]) => (k === 'sections' ? v !== 3 : v === false));
const providerOpenFail = !ipc.providerOpen?.root || !ipc.providerOpen.primaryLabel || !ipc.providerOpen.menuLabel ||
  !ipc.providerOpen.menuOpened || ipc.providerOpen.menuItems < 2 || !ipc.providerOpen.escapeClosed;

if (criticalViolations.length > 0 || surfaceFails.length > 0 || titlebarFails.length > 0 || gitInfoFail || dialogFails.length > 0 || providerOpenFail) {
  console.error('QA FAILED:');
  if (criticalViolations.length > 0) console.error('  a11y critical/serious:', JSON.stringify(criticalViolations, null, 2));
  if (surfaceFails.length > 0) console.error('  ipc.surface checks failed:', surfaceFails.map(([k]) => k).join(', '));
  if (titlebarFails.length > 0) console.error('  ipc.titlebar checks failed:', titlebarFails.map(([k]) => k).join(', '));
  if (gitInfoFail) console.error('  cockpit.gitInfo did not resolve a branch for the repo root:', ipc.cockpitGitInfo, '· raw gitInfo:', JSON.stringify(gitInfoRaw));
  if (dialogFails.length > 0) console.error('  usage dialog checks failed:', JSON.stringify(ipc.usageDialog));
  if (providerOpenFail) console.error('  provider open control missing or unlabeled:', JSON.stringify(ipc.providerOpen));
  process.exit(1);
}
console.log('done');
