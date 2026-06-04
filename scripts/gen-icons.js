// Generate all icon assets from design/logos/mark.svg.
// Run via `npm run icons` (which runs tsc first so dist/shared/ico.js exists).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { packIco } = require('../dist/shared/ico.js');

const ROOT = path.join(__dirname, '..');
const MARK = fs.readFileSync(path.join(ROOT, 'design', 'logos', 'mark.svg'), 'utf8');

function svgAt512({ withDot = true, flat = false } = {}) {
  let s = MARK.replace('width="256" height="256"', 'width="1024" height="1024"');
  if (!withDot) s = s.replace(/<circle data-role="dot"[^>]*\/>/, ''); // tiny sizes stay crisp
  // The soft drop shadow looks great large but muddies into a faint horizontal
  // band under the card at tray sizes (≤32px) — strip it so small icons stay crisp.
  if (flat) s = s.replace(/ filter="url\(#sh\)"/, '');
  return s;
}

async function capture512(win, opts, tag) {
  const tmp = path.join(os.tmpdir(), `devdeck-icon-${tag}.html`);
  try {
    fs.writeFileSync(tmp, `<!doctype html><meta charset="utf-8">` +
      `<style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}svg{display:block}</style>${svgAt512(opts)}`);
    await win.loadFile(tmp);
    await new Promise((r) => setTimeout(r, 400)); // let the SVG rasterise before capture
    return await win.webContents.capturePage();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  const full = await capture512(win, { withDot: true, flat: false }, 'full'); // 48px+: shadow reads fine
  const flat = await capture512(win, { withDot: true, flat: true }, 'flat'); // 24/32 + tray: crisp, no shadow band
  const tiny = await capture512(win, { withDot: false, flat: true }, 'tiny'); // ≤16: drop the dot too
  win.destroy();

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const pngAt = (size) => {
    const src = size <= 16 ? tiny : size <= 32 ? flat : full;
    return src.resize({ width: size, height: size, quality: 'best' }).toPNG();
  };
  const png = {};
  for (const s of [...icoSizes, 512, 1024]) { png[s] = pngAt(s); console.log('made', s, png[s].length, 'bytes'); }

  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'src', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), png[1024]);
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), packIco(icoSizes.map((s) => png[s]), icoSizes));
  fs.writeFileSync(path.join(ROOT, 'src', 'assets', 'icon-256.png'), png[256]);
  fs.writeFileSync(path.join(ROOT, 'src', 'assets', 'tray.png'), png[32]);
  console.log('icons written: build/icon.png, build/icon.ico, src/assets/icon-256.png, src/assets/tray.png');
  app.quit();
});
