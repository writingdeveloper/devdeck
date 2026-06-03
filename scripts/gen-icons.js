// Generate all icon assets from design/logos/mark.svg.
// Run via `npm run icons` (which runs tsc first so dist/shared/ico.js exists).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { packIco } = require('../dist/shared/ico.js');

const ROOT = path.join(__dirname, '..');
const MARK = fs.readFileSync(path.join(ROOT, 'design', 'logos', 'mark.svg'), 'utf8');

function svgAt512(withDot) {
  let s = MARK.replace('width="256" height="256"', 'width="512" height="512"');
  if (!withDot) s = s.replace(/<circle data-role="dot"[^>]*\/>/, ''); // tiny sizes stay crisp
  return s;
}

async function capture512(win, withDot, tag) {
  const tmp = path.join(ROOT, 'design', 'logos', `_g${tag}.html`);
  fs.writeFileSync(tmp, `<!doctype html><meta charset="utf-8">` +
    `<style>html,body{margin:0;padding:0;background:transparent}</style>${svgAt512(withDot)}`);
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  fs.unlinkSync(tmp);
  return img; // nativeImage at 512x512
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512, height: 512, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  const full = await capture512(win, true, 'full');
  const noDot = await capture512(win, false, 'nodot');
  win.destroy();

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const pngAt = (size) => {
    const src = size <= 16 ? noDot : full;
    return src.resize({ width: size, height: size, quality: 'best' }).toPNG();
  };
  const png = {};
  for (const s of [...icoSizes, 512]) { png[s] = pngAt(s); console.log('made', s, png[s].length, 'bytes'); }

  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'src', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), png[512]);
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), packIco(icoSizes.map((s) => png[s]), icoSizes));
  fs.writeFileSync(path.join(ROOT, 'src', 'assets', 'icon-256.png'), png[256]);
  fs.writeFileSync(path.join(ROOT, 'src', 'assets', 'tray.png'), png[32]);
  console.log('icons written: build/icon.png, build/icon.ico, src/assets/icon-256.png, src/assets/tray.png');
  app.quit();
});
