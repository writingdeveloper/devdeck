# DevDeck v5 — Branding, Custom Title Bar, Open-Folder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give DevDeck a real F-Resume logo applied everywhere (exe/window/tray/title bar/favicon), replace the doubled Windows title bar with a single frameless Discord-style bar with custom window controls, and add a one-click "open folder" button to each project card.

**Architecture:** A pure `packIco` function (TDD) plus an Electron offscreen renderer turn one master `mark.svg` into all icon sizes (no new deps). The `BrowserWindow` becomes `frame:false`; window controls run over new `win:*` IPC channels; the renderer draws the bar. `shell.openPath` powers open-folder via a new `project:openFolder` channel.

**Tech Stack:** Electron 31, TypeScript (tsc → CJS main, esbuild → IIFE renderer), Vitest, Playwright `_electron` + axe-core (QA). Spec: `docs/superpowers/specs/2026-06-03-devdeck-v5-branding-design.md`.

## Conventions
- Work from `C:\Users\SIHYEONG\Documents\GitHub\devdeck` (Windows/PowerShell), branch `feat/devdeck-v5-branding` (already created).
- Commits end with (blank line before): `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- `src/shared/` is pure (no electron/node-only globals beyond `Uint8Array`/`DataView`). Renderer uses `import` (esbuild bundles to IIFE). Run one test: `npm test -- <name>`. Build: `npm run build`. Typecheck: `npx tsc --noEmit`. 56 tests currently green.
- `build/` and `src/assets/` are committed (brand sources); `dist/` is git-ignored.

## File structure
- `src/shared/ico.ts` (+`.test.ts`) — pure ICO byte packer.
- `design/logos/mark.svg` — canonical F-Resume art (single source of truth).
- `scripts/gen-icons.js` — Electron renderer: mark.svg → PNGs → `build/icon.{png,ico}`, `src/assets/{icon-256,tray}.png`.
- `scripts/copy-assets.mjs` — also copies `src/assets/*` → `dist/renderer/assets/`.
- `src/main/main.ts` — frameless window + icon + min size + passes `win` to ipc.
- `src/main/ipc.ts` — `win:*` window-control channels + `project:openFolder`.
- `src/main/tray.ts` — real tray icon from `dist/renderer/assets/tray.png`.
- `src/preload/preload.ts`, `src/renderer/global.d.ts` — expose `windowControls` + `openFolder`.
- `src/renderer/index.html`, `styles.css` — single themed title bar.
- `src/renderer/main.ts` — wire window controls.
- `src/renderer/projectsView.ts` + `locales/*.json` — 📁 button.
- `qa/audit.mjs`, `qa/screenshot.mjs` — surface/title-bar checks + maximized shot.

---

# MILESTONE 1 — Logo assets

## Task 1: ICO packer (pure, TDD)

**Files:**
- Create: `src/shared/ico.ts`
- Test: `src/shared/ico.test.ts`

- [ ] **Step 1: Write the failing test** — create `src/shared/ico.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { packIco } from './ico';

describe('packIco', () => {
  const a = new Uint8Array([1, 2, 3]);      // fake PNG #1 (len 3)
  const b = new Uint8Array([4, 5, 6, 7]);   // fake PNG #2 (len 4)

  it('writes the ICONDIR magic and image count', () => {
    const ico = packIco([a, b], [16, 32]);
    expect([...ico.slice(0, 6)]).toEqual([0, 0, 1, 0, 2, 0]); // reserved, type=1, count=2 (LE)
  });

  it('lays out directory entries and image offsets', () => {
    const ico = packIco([a, b], [16, 32]);
    const dv = new DataView(ico.buffer);
    expect(ico[6]).toBe(16);                 // entry0 width
    expect(ico[6 + 16]).toBe(32);            // entry1 width
    expect(dv.getUint32(6 + 12, true)).toBe(6 + 16 * 2);        // entry0 offset = 38
    expect(dv.getUint32(6 + 16 + 12, true)).toBe(6 + 16 * 2 + 3); // entry1 offset = 41
    expect(dv.getUint32(6 + 8, true)).toBe(3);  // entry0 bytesInRes = len(a)
    expect(ico.length).toBe(6 + 16 * 2 + 3 + 4); // 45
    expect([...ico.slice(38, 41)]).toEqual([1, 2, 3]); // image #1 bytes appended
  });

  it('encodes 256 as width/height byte 0', () => {
    const ico = packIco([a], [256]);
    expect(ico[6]).toBe(0);
    expect(ico[7]).toBe(0);
  });

  it('throws when pngs and sizes mismatch', () => {
    expect(() => packIco([a], [16, 32])).toThrow();
  });
});
```

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `npm test -- ico`
Expected: FAIL — cannot resolve `./ico` / `packIco is not a function`.

- [ ] **Step 3: Write minimal implementation** — create `src/shared/ico.ts`:
```ts
/**
 * Pack PNG-encoded images into a Windows `.ico` byte stream. Entries store the
 * PNG bytes verbatim (PNG-compressed icons, supported on Windows Vista+), so no
 * BMP conversion is needed. `sizes[i]` is the pixel dimension of `pngs[i]`.
 */
export function packIco(pngs: Uint8Array[], sizes: number[]): Uint8Array {
  if (pngs.length !== sizes.length) throw new Error('packIco: pngs and sizes length mismatch');
  const count = pngs.length;
  const dirStart = 6;
  const dataStart = dirStart + 16 * count;

  const out = new Uint8Array(dataStart + pngs.reduce((n, p) => n + p.length, 0));
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0, true); // reserved
  dv.setUint16(2, 1, true); // type: 1 = icon
  dv.setUint16(4, count, true);

  let imgOffset = dataStart;
  for (let i = 0; i < count; i++) {
    const entry = dirStart + i * 16;
    const sz = sizes[i] >= 256 ? 0 : sizes[i]; // 0 means 256 in ICO
    out[entry + 0] = sz;       // width
    out[entry + 1] = sz;       // height
    out[entry + 2] = 0;        // palette color count
    out[entry + 3] = 0;        // reserved
    dv.setUint16(entry + 4, 1, true);   // color planes
    dv.setUint16(entry + 6, 32, true);  // bits per pixel
    dv.setUint32(entry + 8, pngs[i].length, true);  // bytes in resource
    dv.setUint32(entry + 12, imgOffset, true);      // offset to image data
    out.set(pngs[i], imgOffset);
    imgOffset += pngs[i].length;
  }
  return out;
}
```

- [ ] **Step 4: Run the test — verify it PASSES**

Run: `npm test -- ico`
Expected: PASS (4).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` → clean.
```bash
git add src/shared/ico.ts src/shared/ico.test.ts
git commit -m "feat(ico): pure PNG-compressed .ico packer (TDD)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Master mark + icon generator

**Files:**
- Create: `design/logos/mark.svg`
- Create: `scripts/gen-icons.js`
- Modify: `package.json` (add `icons` script)
- Generated (commit): `build/icon.png`, `build/icon.ico`, `src/assets/icon-256.png`, `src/assets/tray.png`

- [ ] **Step 1: Create `design/logos/mark.svg`** (the finalized F-Resume art — white card, optically-centered rounded play triangle, green active dot):
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6d70f5"/>
      <stop offset="1" stop-color="#4a3fd6"/>
    </linearGradient>
    <filter id="sh" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#000" flood-opacity="0.22"/>
    </filter>
  </defs>
  <rect x="0" y="0" width="256" height="256" rx="58" fill="url(#bg)"/>
  <g filter="url(#sh)">
    <rect x="70" y="54" width="116" height="148" rx="20" fill="#ffffff"/>
    <path d="M116,98 L116,158 L160,128 Z" fill="#5558ef" stroke="#5558ef"
      stroke-width="12" stroke-linejoin="round" stroke-linecap="round"/>
  </g>
  <circle data-role="dot" cx="168" cy="74" r="9" fill="#36d399"/>
</svg>
```

- [ ] **Step 2: Create `scripts/gen-icons.js`** (Electron offscreen render → all sizes; strips the dot at ≤16px; packs the `.ico` with the Task-1 packer from compiled `dist`):
```js
// Generate all icon assets from design/logos/mark.svg.
// Run via `npm run icons` (which runs tsc first so dist/shared/ico.js exists).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { packIco } = require('../dist/shared/ico.js');

const ROOT = path.join(__dirname, '..');
const MARK = fs.readFileSync(path.join(ROOT, 'design', 'logos', 'mark.svg'), 'utf8');

function svgFor(size) {
  let s = MARK.replace('width="256" height="256"', `width="${size}" height="${size}"`);
  if (size <= 16) s = s.replace(/<circle data-role="dot"[^>]*\/>/, ''); // keep tiny sizes crisp
  return s;
}

async function render(win, size) {
  const tmp = path.join(ROOT, 'design', 'logos', `_g${size}.html`);
  fs.writeFileSync(tmp, `<!doctype html><meta charset="utf-8">` +
    `<style>html,body{margin:0;padding:0;background:transparent}</style>${svgFor(size)}`);
  win.setSize(size, size);
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 350));
  const img = (await win.webContents.capturePage()).resize({ width: size, height: size, quality: 'best' });
  fs.unlinkSync(tmp);
  return img.toPNG();
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512, height: 512, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const png = {};
  for (const s of [...icoSizes, 512]) { png[s] = await render(win, s); console.log('rendered', s); }
  win.destroy();

  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'src', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), png[512]);
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), packIco(icoSizes.map((s) => png[s]), icoSizes));
  fs.writeFileSync(path.join(ROOT, 'src', 'assets', 'icon-256.png'), png[256]);
  fs.writeFileSync(path.join(ROOT, 'src', 'assets', 'tray.png'), png[32]);
  console.log('icons written: build/icon.png, build/icon.ico, src/assets/icon-256.png, src/assets/tray.png');
  app.quit();
});
```

- [ ] **Step 3: Add the `icons` script to `package.json`** — in `"scripts"`, after the `"dist"` line, add:
```json
    "icons": "tsc && npx electron scripts/gen-icons.js",
```

- [ ] **Step 4: Generate the icons**

Run: `npm run icons`
Expected: logs `rendered 16 … rendered 512` then `icons written: …`, exit 0. (Note: `tsc` runs first to produce `dist/shared/ico.js` that the script requires.)

- [ ] **Step 5: Verify the files exist and the .ico is valid**

Run (PowerShell):
```powershell
Get-ChildItem build/icon.png, build/icon.ico, src/assets/icon-256.png, src/assets/tray.png | Select-Object Name,Length
```
Expected: all four present, non-zero. Then sanity-check the ICO header bytes are `00 00 01 00 07 00` (icon, 7 images):
```powershell
Format-Hex build/icon.ico -Count 6
```
Expected first 6 bytes: `00 00 01 00 07 00`.

- [ ] **Step 6: Commit the generator + assets**
```bash
git add design/logos/mark.svg scripts/gen-icons.js package.json build/icon.png build/icon.ico src/assets/icon-256.png src/assets/tray.png
git commit -m "feat(brand): F-Resume mark + dependency-free icon generator

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# MILESTONE 2 — Apply logo (assets + tray + favicon)

## Task 3: Ship assets to dist, set tray + favicon + builder icon

**Files:**
- Modify: `scripts/copy-assets.mjs`
- Modify: `src/main/tray.ts:5-7`
- Modify: `src/renderer/index.html` (`<head>`)
- Modify: `package.json` (`build` block)

- [ ] **Step 1: Copy `src/assets` into `dist/renderer/assets`** — replace the body of `scripts/copy-assets.mjs` after the `outDir` line with:
```js
import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, 'src', 'renderer');
const outDir = join(root, 'dist', 'renderer');

await mkdir(outDir, { recursive: true });
for (const file of ['index.html', 'styles.css']) {
  await copyFile(join(srcDir, file), join(outDir, file));
}

const assetsSrc = join(root, 'src', 'assets');
const assetsOut = join(outDir, 'assets');
await mkdir(assetsOut, { recursive: true });
for (const f of await readdir(assetsSrc)) {
  await copyFile(join(assetsSrc, f), join(assetsOut, f));
}
console.log('copied renderer assets to dist/renderer (incl. assets/)');
```

- [ ] **Step 2: Real tray icon** — in `src/main/tray.ts`, replace the placeholder `nativeImage.createFromDataURL(...)` (lines 5-7) with a load from the packaged asset, and import `join`:
```ts
import { app, Tray, Menu, nativeImage, type BrowserWindow } from 'electron';
import { join } from 'node:path';
```
```ts
  const icon = nativeImage.createFromPath(join(__dirname, '..', 'renderer', 'assets', 'tray.png'));
```
(Keep the rest of `setupTray` unchanged.)

- [ ] **Step 3: Favicon** — in `src/renderer/index.html`, add inside `<head>` (after the stylesheet `<link>`):
```html
    <link rel="icon" href="./assets/icon-256.png" />
```

- [ ] **Step 4: electron-builder icon** — in `package.json`, add an `"icon"` key to the `"build"` object (after `"productName"`):
```json
    "icon": "build/icon.ico",
```

- [ ] **Step 5: Build and verify assets land in dist**

Run: `npm run build`
Then (PowerShell):
```powershell
Get-ChildItem dist/renderer/assets | Select-Object Name
```
Expected: `icon-256.png`, `tray.png` present. `npx tsc --noEmit` clean; `npm test` 56 pass.

- [ ] **Step 6: Commit**
```bash
git add scripts/copy-assets.mjs src/main/tray.ts src/renderer/index.html package.json
git commit -m "feat(brand): real tray icon, favicon, builder icon, ship assets to dist

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# MILESTONE 3 — Custom title bar + open-folder IPC

## Task 4: Window-control + openFolder IPC + preload surface

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/renderer/global.d.ts`

- [ ] **Step 1: Extend `IpcConfig` and imports in `src/main/ipc.ts`.** Change the import on line 1 to add `shell` and the `BrowserWindow` type:
```ts
import { ipcMain, dialog, shell, type BrowserWindow } from 'electron';
```
Add `win` to `IpcConfig`:
```ts
export interface IpcConfig {
  win: BrowserWindow;
  defaultBaseDir: string;
  store: Store;
  sendError: (msg: string) => void;
  defaultLanguage: string;
}
```

- [ ] **Step 2: Register the new handlers** — at the end of `registerIpc`, before the closing brace, add:
```ts
  // Open the project folder in the OS file manager.
  ipcMain.handle('project:openFolder', async (_e, p: string) => {
    const err = await shell.openPath(p);
    if (err) cfg.sendError(err);
  });

  // Frameless-window controls (the title bar draws its own buttons).
  ipcMain.handle('win:minimize', () => cfg.win.minimize());
  ipcMain.handle('win:toggleMaximize', () => {
    cfg.win.isMaximized() ? cfg.win.unmaximize() : cfg.win.maximize();
  });
  ipcMain.handle('win:close', () => cfg.win.close());
  ipcMain.handle('win:isMaximized', () => cfg.win.isMaximized());
  cfg.win.on('maximize', () => cfg.win.webContents.send('win:maximize-changed', true));
  cfg.win.on('unmaximize', () => cfg.win.webContents.send('win:maximize-changed', false));
```

- [ ] **Step 3: Expose them in `src/preload/preload.ts`** — add inside the `exposeInMainWorld('devdeck', { … })` object:
```ts
  openFolder: (path: string) => ipcRenderer.invoke('project:openFolder', path),
  windowControls: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggleMaximize'),
    close: () => ipcRenderer.invoke('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
    onMaximizeChange: (cb: (maximized: boolean) => void) =>
      ipcRenderer.on('win:maximize-changed', (_e, m: boolean) => cb(m)),
  },
```

- [ ] **Step 4: Type them in `src/renderer/global.d.ts`** — add inside the `devdeck` interface (after `pickFolder`):
```ts
      openFolder(path: string): Promise<void>;
      windowControls: {
        minimize(): Promise<void>;
        toggleMaximize(): Promise<void>;
        close(): Promise<void>;
        isMaximized(): Promise<boolean>;
        onMaximizeChange(cb: (maximized: boolean) => void): void;
      };
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: one error in `src/main/main.ts` (registerIpc now requires `win`). That is fixed in Task 5 — proceed.

---

## Task 5: Frameless window + icon + min size

**Files:**
- Modify: `src/main/main.ts:11-23`, `:37-49`

- [ ] **Step 1: Make the window frameless with an icon and min size** — replace `createWindow` (lines 11-23):
```ts
function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    frame: false,
    backgroundColor: '#0d0e12',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  w.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return w;
}
```

- [ ] **Step 2: Pass `win` to `registerIpc`** — in the `app.whenReady().then(...)` block (lines 37-49), capture the window in a non-null local and pass it:
```ts
  app.whenReady().then(() => {
    const store = new Store(path.join(app.getPath('userData'), 'state.json'));
    const w = createWindow();
    win = w;
    registerIpc({
      win: w,
      defaultBaseDir: DEFAULT_BASE_DIR,
      store,
      sendError: (msg) => w.webContents.send('devdeck:error', msg),
      defaultLanguage: app.getLocale().split('-')[0] || 'en',
    });
    setupTray(w);
    globalShortcut.register('Control+Alt+D', showWindow);
    app.on('activate', () => { if (!win) win = createWindow(); });
  });
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit` → clean. `npm run build` → succeeds.

- [ ] **Step 4: Commit (IPC + frameless together — they depend on each other)**
```bash
git add src/main/ipc.ts src/preload/preload.ts src/renderer/global.d.ts src/main/main.ts
git commit -m "feat(window): frameless window + window-control & openFolder IPC

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Title-bar markup + styles

**Files:**
- Modify: `src/renderer/index.html:10-15`
- Modify: `src/renderer/styles.css:27-31`

- [ ] **Step 1: Rebuild the title bar markup** — replace the `<header id="topbar">…</header>` block (index.html lines 10-15) with:
```html
    <header id="topbar">
      <div class="tb-brand">
        <img class="tb-logo" src="./assets/icon-256.png" alt="" />
        <span class="tb-title">DevDeck</span>
      </div>
      <div class="tb-drag"></div>
      <div class="top-actions">
        <button id="refresh" class="iconbtn" title="새로고침">↻</button>
      </div>
      <div class="win-controls">
        <button id="win-min" class="winbtn" aria-label="Minimize" title="Minimize">─</button>
        <button id="win-max" class="winbtn" aria-label="Maximize" title="Maximize">☐</button>
        <button id="win-close" class="winbtn winbtn-close" aria-label="Close" title="Close">✕</button>
      </div>
    </header>
```

- [ ] **Step 2: Title-bar CSS** — replace styles.css lines 27-31 (the `#topbar`, `#topbar h1`, `.top-actions`, and `#shell` rules) with:
```css
#topbar { -webkit-app-region: drag; position: sticky; top: 0; z-index: 10; display: flex; align-items: center; height: 40px; padding-left: 12px; background: #0b0c10; border-bottom: 1px solid var(--border); user-select: none; }
.tb-brand { display: flex; align-items: center; gap: 8px; -webkit-app-region: no-drag; }
.tb-logo { width: 20px; height: 20px; border-radius: 5px; display: block; }
.tb-title { font-size: 13px; font-weight: 600; letter-spacing: .2px; color: var(--text); }
.tb-drag { flex: 1; align-self: stretch; -webkit-app-region: drag; }
.top-actions { display: flex; gap: 6px; align-items: center; -webkit-app-region: no-drag; padding-right: 4px; }
.win-controls { display: flex; align-items: stretch; height: 100%; -webkit-app-region: no-drag; }
.winbtn { width: 46px; height: 40px; border: 0; border-radius: 0; background: transparent; color: var(--text-dim); font-size: 12px; line-height: 1; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.winbtn:hover { background: var(--surface-hover); color: var(--text); }
.winbtn-close:hover { background: var(--bad); color: #fff; }

#shell { display: flex; height: calc(100vh - 40px); }
```

- [ ] **Step 3: Build (no TS — html/css only need the copy step)**

Run: `npm run build`
Expected: succeeds; `dist/renderer/index.html` and `styles.css` updated.

- [ ] **Step 4: Commit**
```bash
git add src/renderer/index.html src/renderer/styles.css
git commit -m "feat(ui): single Discord-style title bar (logo, drag, window controls)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Wire the window controls in the renderer

**Files:**
- Modify: `src/renderer/main.ts`

- [ ] **Step 1: Add a `mountTitlebar` function** — in `src/renderer/main.ts`, add this function above `boot()`:
```ts
function mountTitlebar(): void {
  const wc = window.devdeck.windowControls;
  document.getElementById('win-min')!.addEventListener('click', () => void wc.minimize());
  document.getElementById('win-close')!.addEventListener('click', () => void wc.close());
  const maxBtn = document.getElementById('win-max')!;
  maxBtn.addEventListener('click', () => void wc.toggleMaximize());
  document.querySelector<HTMLElement>('.tb-drag')!.addEventListener('dblclick', () => void wc.toggleMaximize());
  const setGlyph = (m: boolean) => { maxBtn.textContent = m ? '❐' : '☐'; maxBtn.title = m ? 'Restore' : 'Maximize'; };
  wc.onMaximizeChange(setGlyph);
  void wc.isMaximized().then(setGlyph);
}
```

- [ ] **Step 2: Call it from `boot()`** — add `mountTitlebar();` as the first line inside `boot()` (before `setLanguage(...)`):
```ts
async function boot(): Promise<void> {
  mountTitlebar();
  setLanguage(await window.devdeck.getLanguage());
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit` → clean. `npm run build` → succeeds, renderer stays IIFE.
Verify: `Get-Content dist/renderer/renderer.js -TotalCount 2` shows `"use strict";` / `(() => {`.

- [ ] **Step 4: Commit**
```bash
git add src/renderer/main.ts
git commit -m "feat(ui): wire frameless window controls + dbl-click maximize

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# MILESTONE 4 — Open-folder button

## Task 8: 📁 button on project cards + locales

**Files:**
- Modify: `src/renderer/projectsView.ts:128-138`
- Modify: `src/renderer/locales/{ko,en,ja,zh}.json`

- [ ] **Step 1: Add the folder button to the card footer** — in `makeCard`, in the footer block (lines 128-138), insert the folder button before `open` and append it:
```ts
  const foot = document.createElement('div'); foot.className = 'cardfoot';
  const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selected.has(p.path); check.setAttribute('aria-label', 'select');
  check.addEventListener('change', () => {
    check.checked ? selected.add(p.path) : selected.delete(p.path);
    card.classList.toggle('selected', check.checked);
    syncOpenBtn();
  });
  const spacer = document.createElement('span'); spacer.className = 'spacer';
  const folderBtn = document.createElement('button'); folderBtn.className = 'iconbtn';
  folderBtn.textContent = '📁'; folderBtn.title = tr('proj.open_folder');
  folderBtn.setAttribute('aria-label', tr('proj.open_folder'));
  folderBtn.addEventListener('click', () => window.devdeck.openFolder(p.path));
  const open = document.createElement('button'); open.className = 'primary'; open.textContent = '▶ ' + tr('proj.open');
  open.addEventListener('click', () => openItems([{ path: p.path, sessionId: p.sessions[0]?.id ?? null }]));
  foot.append(check, spacer, folderBtn, open);
```

- [ ] **Step 2: Add `proj.open_folder` to all four locales.** Insert after the `"proj.open"` line in each file (keep valid JSON — add the trailing comma to the `proj.open` line):
  - `ko.json`: `"proj.open_folder": "폴더 열기",`
  - `en.json`: `"proj.open_folder": "Open folder",`
  - `ja.json`: `"proj.open_folder": "フォルダを開く",`
  - `zh.json`: `"proj.open_folder": "打开文件夹",`

- [ ] **Step 3: Build + verify all tests/types green**

Run: `npm run build` → succeeds. `npx tsc --noEmit` → clean. `npm test` → 56+? (still 60 with ico's 4) pass.

- [ ] **Step 4: Commit**
```bash
git add src/renderer/projectsView.ts src/renderer/locales
git commit -m "feat(projects): one-click open-folder button on cards

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# MILESTONE 5 — QA harness + verification

## Task 9: Extend QA checks, run, and verify end-to-end

**Files:**
- Modify: `qa/audit.mjs`
- Modify: `qa/screenshot.mjs`

- [ ] **Step 1: Add preload-surface + title-bar checks to `qa/audit.mjs`** — after the `ipc.errorToast = …` block (around line 45), add:
```js
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
```
(The existing `a11y` loop already scans `document`, so it now also covers the title bar — confirm controls keep 0 serious violations.)

- [ ] **Step 2: Add a maximized title-bar screenshot to `qa/screenshot.mjs`** — after the `projects-narrow` shot (line 71), before the `_console.json` write, add:
```js
// Title bar: maximized state (restore glyph)
await win.setViewportSize({ width: 1000, height: 720 }).catch(() => {});
await win.evaluate(() => window.devdeck.windowControls.toggleMaximize());
await win.waitForTimeout(400);
await shot('titlebar-maximized');
await win.evaluate(() => window.devdeck.windowControls.toggleMaximize());
```

- [ ] **Step 3: Run the audit**

Run: `node qa/audit.mjs` then read `qa/shots/_audit.json`.
Expected: `ipc.surface` → `{ openFolder: true, windowControls: true }`; `ipc.titlebar` → `{ logo: true, controls: true, closeLabeled: true }`; `a11y.projects/usage/settings` → **0 serious violations** (empty arrays). If the title bar introduces a contrast/label violation, fix the offending token/attribute until 0 remain.

- [ ] **Step 4: Run the screenshots and vision-review**

Run: `node qa/screenshot.mjs`.
Review `qa/shots/projects-{ko,en,ja,zh}.png`: single themed title bar (logo + "DevDeck" + ─ ☐ ✕), no native Windows chrome above it; the 📁 button sits left of ▶ in each card footer. `titlebar-maximized.png`: max button shows the restore glyph `❐`.

- [ ] **Step 5: Final verification gates**

Run, expecting all green:
```
npx tsc --noEmit      # clean
npm test              # all pass (60)
npm run build         # succeeds; dist/renderer/renderer.js is an IIFE
```

- [ ] **Step 6: Commit the QA changes**
```bash
git add qa/audit.mjs qa/screenshot.mjs
git commit -m "chore(qa): assert preload surface + title bar; maximized shot

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Repackage (optional, environment-limited)**

Run: `npm run dist`.
Expected: `release/win-unpacked/DevDeck.exe` rebuilds **with the new icon**. The winCodeSign signing step may exit 1 on this machine (no Developer Mode) — that does not affect the unpacked exe or its icon (see project memory `dist-wincodesign-symlink`). If a prior `DevDeck.exe` is running and locks DLLs, run `taskkill /IM DevDeck.exe /F` first. Manually confirm: exe/taskbar/tray icons show the mark; min/max(/restore)/close work; double-clicking the bar maximizes; close hides to tray; 📁 opens Explorer at the project.

---

## Final verification (orchestrator)
- `npm test` all pass; `npx tsc --noEmit` clean; `npm run build` IIFE.
- `node qa/audit.mjs` → `_audit.json`: `surface`/`titlebar` all true; **0 serious a11y violations** across the three views.
- `node qa/screenshot.mjs` → single themed title bar across locales; 📁 present in card footers; maximized shot shows restore glyph.
- Manual: icons everywhere; window controls + drag + dbl-click-maximize; close→tray; 📁→Explorer.

## Self-review notes (applied)
- **Spec coverage:** ① logo mark + asset pipeline (T1 packer, T2 mark/generator) + application (T3 tray/favicon/builder, T5 window icon, T6 title-bar `<img>`) · ② frameless Discord title bar (T4 IPC, T5 frame, T6 markup/CSS, T7 wiring) · ③ open-folder (T4 IPC/preload, T8 button+locales). QA (T9). Non-goals (signing, mac/linux, deps) absent.
- **Type consistency:** `packIco(pngs: Uint8Array[], sizes: number[]): Uint8Array` identical across T1 def, test, and T2 caller. `IpcConfig.win: BrowserWindow` added in T4 and supplied in T5. `windowControls` method set (`minimize/toggleMaximize/close/isMaximized/onMaximizeChange`) identical across preload (T4-S3), global.d.ts (T4-S4), and renderer use (T7) + QA assertion (T9). `openFolder(path)` consistent across preload/global/projectsView/audit. Asset paths: generator writes `src/assets/{icon-256,tray}.png`; copy-assets ships to `dist/renderer/assets/`; main/tray/index.html all read `…/renderer/assets/…`.
- **Test placement:** only `src/shared/ico.ts` is pure-testable (matches repo's shared-test convention); IPC/window behavior is global-`ipcMain`/Electron and is verified via the QA harness + manual steps rather than a non-existent electron-mock layer.
