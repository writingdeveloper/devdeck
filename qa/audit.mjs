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
await win.click('.rail-item[data-view="projects"]');
await win.waitForTimeout(150);
const displayTrigger = win.locator('#project-display');
const displayMenu = win.locator('#project-display-menu');
const displayItem = (id) => win.locator(`#${id}`);
const displayState = () => win.evaluate(() => {
  const trigger = document.getElementById('project-display');
  const menu = document.getElementById('project-display-menu');
  return { open: trigger?.getAttribute('aria-expanded') === 'true' && !menu?.classList.contains('hidden'), focusId: document.activeElement?.id ?? '' };
});
const displayModel = await win.evaluate(() => {
  const menu = document.getElementById('project-display-menu');
  const items = Array.from(menu?.querySelectorAll('[role^="menuitem"]') ?? [])
    // The composite itself is closed while its static model is inspected. Exclude only choices in
    // a nested hidden group; the menu's own `.hidden` state must not erase its actionable model.
    .filter((item) => item instanceof HTMLButtonElement && !item.disabled && !item.closest('#agent-select-control.hidden'));
  const selected = items.find((item) => item.getAttribute('role') === 'menuitemradio' && item.getAttribute('aria-checked') === 'true');
  return {
    actionableIds: items.map((item) => item.id),
    initialFocusId: selected?.id ?? items[0]?.id ?? '',
    menuRole: menu?.getAttribute('role') === 'menu',
    labeledItems: items.length >= 3 && items.every((item) => !!item.textContent?.trim()),
    providerLabel: !!menu?.querySelector('#agent-select-label')?.textContent?.trim(),
    providerGroup: menu?.querySelector('#agent-select-control')?.getAttribute('role') === 'group',
  };
});

await displayTrigger.focus();
await win.keyboard.press('Space');
let state = await displayState();
const spaceOpened = state.open;
const focusOnOpen = state.focusId === displayModel.initialFocusId;
const rovingFocus = await win.evaluate(() => {
  const items = Array.from(document.querySelectorAll('#project-display-menu [role^="menuitem"]')).filter((item) => !item.closest('.hidden'));
  return items.filter((item) => item.tabIndex === 0).length === 1 && items.filter((item) => item.tabIndex === -1).length === items.length - 1;
});
await win.keyboard.press('ArrowDown');
state = await displayState();
const arrowDown = state.focusId === displayModel.actionableIds[(displayModel.actionableIds.indexOf(displayModel.initialFocusId) + 1) % displayModel.actionableIds.length];
await win.keyboard.press('ArrowUp');
state = await displayState();
const arrowUp = state.focusId === displayModel.initialFocusId;
await win.keyboard.press('Home');
state = await displayState();
const home = state.focusId === displayModel.actionableIds[0];
await win.keyboard.press('End');
state = await displayState();
const end = state.focusId === displayModel.actionableIds.at(-1);

await displayItem('view-cards').focus();
await win.keyboard.press('Enter');
state = await displayState();
const itemActivateCloseFocus = !state.open && state.focusId === 'project-display';

await displayTrigger.click();
await displayItem('view-list').click();
state = await displayState();
const itemClickCloseFocus = !state.open && state.focusId === 'project-display';

await displayTrigger.click();
await win.locator('#proj-search').click();
state = await displayState();
const outsideClosed = !state.open;

await displayTrigger.focus();
await win.keyboard.press('Space');
const agentSelect = win.locator('#agent-select');
const agentOptions = await agentSelect.locator('option').count();
const hiddenNativeBridge = await agentSelect.evaluate((select) => select.hidden && select.tabIndex === -1 && select.getAttribute('aria-hidden') === 'true');
let providerProxySelection = agentOptions < 2 && await win.locator('#agent-select-control').evaluate((control) => control.classList.contains('hidden'));
if (agentOptions >= 2) {
  const before = await agentSelect.inputValue();
  const target = win.locator(`#agent-select-options [role="menuitemradio"]:not([data-agent-id="${before}"])`).first();
  const targetId = await target.getAttribute('data-agent-id');
  await target.focus();
  await win.keyboard.press('Enter');
  await win.waitForTimeout(200); // the real provider-change handler refreshes the deck asynchronously
  state = await displayState();
  providerProxySelection = !state.open && state.focusId === 'project-display' && await agentSelect.inputValue() === targetId
    && await win.locator(`#agent-select-options [data-agent-id="${targetId}"]`).getAttribute('aria-checked') === 'true';
}
await displayTrigger.focus();
await win.keyboard.press('Space');
await win.keyboard.press('Escape');
state = await displayState();
const escapeClosed = !state.open && state.focusId === 'project-display';

ipc.projectDisplay = {
  trigger: await displayTrigger.count() === 1,
  hasPopup: await displayTrigger.getAttribute('aria-haspopup') === 'menu',
  initialExpanded: await displayTrigger.getAttribute('aria-expanded') === 'false',
  spaceOpened,
  menuRole: displayModel.menuRole,
  labeledItems: displayModel.labeledItems,
  providerLabel: displayModel.providerLabel,
  providerGroup: displayModel.providerGroup,
  hiddenNativeBridge,
  providerProxySelection,
  showHiddenRole: await displayItem('show-hidden').getAttribute('role') === 'menuitemcheckbox',
  focusOnOpen,
  rovingFocus,
  arrowDown,
  arrowUp,
  home,
  end,
  itemActivateCloseFocus,
  itemClickCloseFocus,
  outsideClosed,
  escapeClosed,
};
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
  noCockpitDestination: document.querySelectorAll('.rail-item[data-view="cockpit"]').length === 0,
  windowControls: !!window.devdeck.windowControls &&
    ['minimize', 'toggleMaximize', 'close', 'isMaximized', 'onMaximizeChange']
      .every((k) => typeof window.devdeck.windowControls[k] === 'function'),
}));
// xvfb-run provides a display but no window manager, so BrowserWindow.maximize() may never change
// state or emit `maximize` on Linux CI. Drive Electron's real main -> preload -> renderer event path
// directly; the IPC methods themselves are covered by `ipc.surface.windowControls` above.
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('unmaximize'));
await win.waitForTimeout(50);
const maximizeLabel = await win.evaluate(() => ({ title: document.getElementById('win-max')?.title, aria: document.getElementById('win-max')?.getAttribute('aria-label') }));
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('maximize'));
await win.waitForTimeout(50);
const restoreLabel = await win.evaluate(() => ({ title: document.getElementById('win-max')?.title, aria: document.getElementById('win-max')?.getAttribute('aria-label') }));
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('unmaximize'));
ipc.titlebar = {
  ...await win.evaluate(() => ({
  logo: !!document.querySelector('.tb-logo'),
  controls: ['win-min', 'win-max', 'win-close'].every((id) => !!document.getElementById(id)),
  closeLabeled: document.getElementById('win-close')?.getAttribute('aria-label') === 'Close',
  })),
  maximizeStates: !!maximizeLabel.title && maximizeLabel.aria === maximizeLabel.title && !!restoreLabel.title && restoreLabel.aria === restoreLabel.title && maximizeLabel.title !== restoreLabel.title,
};

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
// Cockpit is internal: audit it only through a shared-shell session route when the Windows-only
// implementation is available. The other views retain their rail destinations.
const viewCandidates = ['projects', 'usage', 'settings', 'next'];
const viewStates = await Promise.all(viewCandidates.map(async (view) => ({
  view,
  selector: `.rail-item[data-view="${view}"]`,
  visible: await win.locator(`.rail-item[data-view="${view}"]`).isVisible().catch(() => false),
})));
const cockpitAvailable = await win.evaluate(() => !document.getElementById('shell-session-section')?.classList.contains('hidden'));
if (cockpitAvailable) {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('devdeck:qa-shell-sessions', { detail: [
    { id: 'qa-audit-cockpit', projectPath: 'C:/qa/cockpit', label: 'QA Cockpit route', detail: 'main · Claude', activity: 'idle', pinned: false },
  ] })));
  viewStates.push({ view: 'cockpit', selector: '#shell-session-groups .shell-session', visible: await win.locator('#shell-session-groups .shell-session').first().isVisible().catch(() => false) });
}
for (const { view, selector } of viewStates.filter(({ visible }) => visible)) {
  await win.click(selector);
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

// Project Memory is an on-demand modal surface. Exercise the real IPC against this checkout, audit it
// while open, then verify Escape closes it and returns focus to the card/row trigger.
await win.click('.rail-item[data-view="projects"]');
// The checkout was added after the first empty-deck render above; drive the same refresh control a
// user would use so this audit inspects the newly allowed project instead of stale initial DOM.
await win.click('#refresh');
await win.waitForSelector('.project-memory-button', { timeout: 10000 }).catch(() => {});
const memoryTrigger = win.locator('.project-memory-button').first();
const memoryTriggerPresent = await memoryTrigger.count() > 0;
if (memoryTriggerPresent) {
  await memoryTrigger.focus();
  await memoryTrigger.click();
  await win.waitForSelector('.pm-modal:not(.loading)', { timeout: 10000 }).catch(() => {});
}
ipc.memoryDialog = await win.evaluate(() => {
  const d = document.querySelector('.pm-modal');
  return {
    present: !!d,
    role: d?.getAttribute('role') === 'dialog',
    ariaModal: d?.getAttribute('aria-modal') === 'true',
    titleLabelled: !!d?.getAttribute('aria-labelledby'),
    snapshotRowsAtLeast: document.querySelectorAll('.pm-snapshot-row').length >= 1,
    timelineRowsAtLeast: document.querySelectorAll('.pm-timeline-item').length >= 1,
    closeLabelled: !!document.querySelector('.pm-close')?.getAttribute('aria-label'),
    escapeClosed: false,
    focusRestored: false,
  };
});
if (ipc.memoryDialog.present) {
  const providerButton = win.locator('.pm-modal .provider-open-menu-button');
  await providerButton.focus();
  await providerButton.click();
  await win.waitForSelector('.pm-modal .provider-open-menu:not(.hidden)', { timeout: 3000 }).catch(() => {});
  await win.keyboard.press('Escape');
  ipc.memoryDialog.innerEscapePriority = await win.locator('.pm-modal').count() === 1
    && await win.locator('.pm-modal .provider-open-menu.hidden').count() === 1
    && await providerButton.evaluate((button) => document.activeElement === button);
  await providerButton.focus();
  await win.keyboard.press('Tab');
  ipc.memoryDialog.forwardTabWrap = await win.locator('.pm-refresh').evaluate((button) => document.activeElement === button);
  await win.keyboard.press('Shift+Tab');
  ipc.memoryDialog.reverseTabWrap = await providerButton.evaluate((button) => document.activeElement === button);
  await win.evaluate(axeCore.source);
  const res = await win.evaluate(async () =>
    // eslint-disable-next-line no-undef
    await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }),
  );
  a11y['project-memory-dialog'] = res.violations.map((v) => ({
    id: v.id, impact: v.impact, n: v.nodes.length, help: v.help,
    targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
  }));
  await win.keyboard.press('Escape');
  await win.waitForTimeout(100);
  ipc.memoryDialog.escapeClosed = await win.locator('.pm-modal').count() === 0;
  ipc.memoryDialog.focusRestored = await memoryTrigger.evaluate((el) => document.activeElement === el).catch(() => false);
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
const projectDisplayFail = Object.values(ipc.projectDisplay ?? {}).some((value) => value !== true);
const memoryDialogFail = Object.values(ipc.memoryDialog ?? {}).some((v) => v !== true);

if (criticalViolations.length > 0 || surfaceFails.length > 0 || titlebarFails.length > 0 || gitInfoFail || dialogFails.length > 0 || providerOpenFail || projectDisplayFail || memoryDialogFail) {
  console.error('QA FAILED:');
  if (criticalViolations.length > 0) console.error('  a11y critical/serious:', JSON.stringify(criticalViolations, null, 2));
  if (surfaceFails.length > 0) console.error('  ipc.surface checks failed:', surfaceFails.map(([k]) => k).join(', '));
  if (titlebarFails.length > 0) console.error('  ipc.titlebar checks failed:', titlebarFails.map(([k]) => k).join(', '));
  if (gitInfoFail) console.error('  cockpit.gitInfo did not resolve a branch for the repo root:', ipc.cockpitGitInfo, '· raw gitInfo:', JSON.stringify(gitInfoRaw));
  if (dialogFails.length > 0) console.error('  usage dialog checks failed:', JSON.stringify(ipc.usageDialog));
  if (providerOpenFail) console.error('  provider open control missing or unlabeled:', JSON.stringify(ipc.providerOpen));
  if (projectDisplayFail) console.error('  project Display menu is inaccessible or incomplete:', JSON.stringify(ipc.projectDisplay));
  if (memoryDialogFail) console.error('  project memory dialog checks failed:', JSON.stringify(ipc.memoryDialog));
  process.exit(1);
}
console.log('done');
