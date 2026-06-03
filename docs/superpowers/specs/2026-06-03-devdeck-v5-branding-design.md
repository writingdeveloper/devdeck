# DevDeck v5 — Branding, Custom Title Bar, Open-Folder (Design)

**Date:** 2026-06-03 · **Branch:** `feat/devdeck-v5-branding`

## Goal

Give DevDeck a real identity and a polished chrome:

1. **Logo (F-Resume)** — a custom app mark, applied everywhere an icon is shown (exe/installer, window/taskbar, tray, in-app title bar, favicon).
2. **Discord-style custom title bar** — replace the doubled-up "native Windows title bar + app header" with a single frameless, themed bar carrying the logo, a draggable region, and custom window controls.
3. **Open-folder** — a one-click button on each project card that opens the project folder in the OS file manager.

Non-goals: installer/signing changes, macOS/Linux packaging, new views, dependency additions.

## Current state (for reference)

- `main.ts` `BrowserWindow` has no `frame`/`icon` option → native Windows title bar + default Electron icon. The renderer draws its own `#topbar` below it (so the user sees two bars).
- `tray.ts` uses a 1×1 transparent placeholder PNG.
- `package.json > build` has no `icon` field.
- Card actions: footer `▶ open` launches Windows Terminal `claude -c` resume (`projects:open` → `launcher.openProjects`). The `⋯` menu holds Pin/Hide. No way to open the folder itself.
- Theme accent is `#5558ef` (blurple); staleness traffic-light (green/amber/red) is the app's signature visual.

---

## ① Logo: design + asset pipeline

### Mark (final F-Resume, refined)

A rounded-square ("squircle") app tile, blurple vertical gradient `#6d70f5 → #4a3fd6`, `rx ≈ 22%`. Centered white rounded **card** (rx ~16). A **blurple `#5558ef` play triangle** sits in the card, **optically centered** (shifted ~6px right of geometric center so it reads centered), with slightly rounded vertices (`stroke-linejoin: round` on a filled triangle, or small corner radius) for a soft modern look. A small **green `#36d399` "active/resume" status dot** at the card's top-right corner ties the mark to the staleness signal and the resume action.

Rationale for "most recommended" refinements: optical centering + rounded triangle are the standard fixes that separate a hand-drawn play glyph from a polished product mark; the green dot is the one piece of brand color beyond blurple and connects directly to DevDeck's status concept.

A single master SVG (`design/logos/mark.svg`, also embedded in the renderer) is the source of truth. A simplified variant (card + play, **no dot**) is used at ≤16px so the tray icon stays crisp.

### Asset pipeline (no new dependencies)

`scripts/gen-icons.mjs` (run via `npx electron`) renders the master SVG to PNGs at **16, 24, 32, 48, 64, 128, 256, 512** using the existing offscreen-`capturePage` approach (proven in `design/logos/render-logos*.js`). It writes:

- `build/icon.png` (512²) — electron-builder app icon source.
- `build/icon.ico` — packed from the 16/24/32/48/64/128/256 PNGs by a tiny dependency-free ICO writer (`scripts/pack-ico.mjs`; ICO = 6-byte header + 16-byte dir entries + PNG-encoded images, which Windows Vista+ supports). This is pure byte assembly and is unit-testable.
- `src/assets/tray.png` (32²) and a 16² simplified variant — copied into `dist` by `copy-assets.mjs` and loaded by the tray at runtime.

### Application points

| Target | How |
|---|---|
| exe / installer icon | `package.json > build.win.icon = "build/icon.ico"` (+ `build.icon` for cross-platform) |
| window / taskbar (dev & packaged) | `new BrowserWindow({ icon: <dist/assets/icon.png> })` |
| tray (replace placeholder) | `nativeImage.createFromPath(<dist/assets/tray.png>)` in `tray.ts` |
| in-app title bar | inline SVG mark in `index.html` (vector, crisp, themable) |
| favicon / page title | `index.html` (already titled "DevDeck") |

`build/` is committed (source icons). Generated `dist/assets` is not.

---

## ② Discord-style custom title bar

Merge the two bars into one frameless, themed bar.

### Main process (`main.ts`)
- `BrowserWindow({ frame: false, icon, minWidth: 720, minHeight: 480, backgroundColor: '#0d0e12', ... })`.
- The existing close-to-tray behavior (in `tray.ts`) is unchanged.

### Window-control IPC (`ipc.ts`, needs the `BrowserWindow`)
`registerIpc` gains a `getWindow()` (or `win`) handle. New channels:
- `win:minimize` → `win.minimize()`
- `win:toggleMaximize` → `win.isMaximized() ? unmaximize() : maximize()`
- `win:close` → `win.close()` (the `tray.ts` `close` handler hides to tray, preserving current behavior)
- `win:isMaximized` → boolean (initial state)
- Main pushes `win:maximize-changed` (boolean) on `win.on('maximize'|'unmaximize')` so the renderer swaps the maximize/restore glyph.

### Preload / `global.d.ts`
Expose `windowControls: { minimize(), toggleMaximize(), close(), isMaximized(): Promise<boolean>, onMaximizeChange(cb) }`.

### Renderer (`index.html` + `styles.css`)
`#topbar` (height **40px**, kept in sync with `#shell { height: calc(100vh - 40px) }`) becomes a flex row:
- **Left** (`no-drag` on interactive bits): inline SVG logo mark (20px) + "DevDeck" wordmark.
- **Center**: draggable spacer (`-webkit-app-region: drag`); double-click toggles maximize.
- **Right**: existing `↻ refresh` + `🌐 lang` actions, then the **window controls** group `─ ☐ ✕`.

Window controls styling (Discord-like): 46×40 hit targets, transparent → `--surface-hover` on hover, **close** turns red (`#e0623f`) with white glyph on hover. All control buttons carry `-webkit-app-region: no-drag` and `aria-label`s. Maximize button shows `☐` (restore: `❐`). Respect `prefers-reduced-motion`.

### Trade-offs considered
Chosen: `frame:false` + custom HTML controls (full Discord look). Rejected: `titleBarStyle:'hidden'+titleBarOverlay` (keeps native button shapes, recolor only — not the requested look). Frameless still supports edge-resize and Windows Snap; we add double-click-to-maximize and the explicit controls to cover what the native frame provided.

---

## ③ Open-folder feature

- **`ipc.ts`**: `ipcMain.handle('project:openFolder', (_e, p: string) => shell.openPath(p))` (import `shell`). Returns the empty string on success or an error string (shell.openPath contract); on non-empty, surface via `sendError`.
- **`preload.ts` / `global.d.ts`**: `openFolder(path: string): Promise<void>`.
- **`projectsView.ts`**: in `makeCard` footer, add a **📁 folder button** (`iconbtn`, `aria-label`/`title` = `tr('proj.open_folder')`) before the `▶ open` button. Click → `window.devdeck.openFolder(p.path)`.
- **locales** (`ko/en/ja/zh`): add `proj.open_folder` — ko "폴더 열기", en "Open folder", ja "フォルダを開く", zh "打开文件夹".

Role split stays clear: **📁** = file manager at the project; **▶ open** = Windows Terminal `claude -c` resume.

---

## Testing & verification

- **Pure/unit (Vitest, TDD):** `pack-ico.mjs` byte layout (header magic `00 00 01 00`, image count, per-entry offsets) → a known set of PNGs produces a valid ICO directory.
- **Wiring:** `project:openFolder` handler calls the injected `shell.openPath` with the given path (inject shell in tests as the IPC layer already injects deps).
- **QA harness (`qa/`):** screenshot the new title bar (default + maximized) across locales; `qa/audit.mjs` confirms title-bar controls have `aria-label`s and 0 serious a11y violations; verify the in-app logo renders.
- **Manual:** icons show on exe/taskbar/tray/title bar; min/max(/restore)/close work; double-click bar maximizes; close still hides to tray; 📁 opens Explorer at the project.
- Existing gates stay green: `npm test`, `npx tsc --noEmit`, `npm run build` (renderer IIFE). Repackage via `npm run dist` (note: winCodeSign signing step fails on this machine without Developer Mode, but `win-unpacked` — including the new exe icon — still builds; see project memory).

## File touch-list

`design/logos/mark.svg` (new) · `scripts/gen-icons.mjs` (new) · `scripts/pack-ico.mjs` (+`.test`) · `scripts/copy-assets.mjs` · `build/icon.png`,`build/icon.ico` (new) · `src/assets/*` (new) · `package.json` (build.icon) · `src/main/main.ts` · `src/main/ipc.ts` (+`.test`) · `src/main/tray.ts` · `src/preload/preload.ts` · `src/renderer/global.d.ts` · `src/renderer/index.html` · `src/renderer/styles.css` · `src/renderer/projectsView.ts` · `src/renderer/locales/{ko,en,ja,zh}.json`
