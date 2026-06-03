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

// --- axe a11y per view (inject axe-core source directly; Electron CDP lacks Target.createTarget) ---
const a11y = {};
for (const view of ['projects', 'usage', 'settings']) {
  await win.click(`.rail-item[data-view="${view}"]`);
  await win.waitForTimeout(600);
  await win.evaluate(axeCore.source);
  const res = await win.evaluate(async () =>
    // eslint-disable-next-line no-undef
    await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }),
  );
  a11y[view] = res.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, help: v.help }));
}

writeFileSync(join(out, '_audit.json'), JSON.stringify({ ipc, a11y }, null, 2));
console.log('IPC:', JSON.stringify(ipc));
for (const v of Object.keys(a11y)) console.log(`a11y ${v}: ${a11y[v].length} violations`, a11y[v].map((x) => `${x.id}(${x.impact},${x.n})`).join(', '));
await app.close();
console.log('done');
