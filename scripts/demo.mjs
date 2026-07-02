// Marketing demo renderer (free/OSS): turns app screenshots into a polished reel
// — gradient bg + padding + rounded corners + soft shadow + per-scene captions
// and intro/outro title cards (sharp), stitched with crossfades into MP4 + GIF
// (ffmpeg). Dev-only:  npm i -D sharp ffmpeg-static
import sharp from 'sharp';
import ffmpegPath from 'ffmpeg-static';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shotsDir = join(root, 'qa', 'shots');
const outDir = join(root, 'docs', 'demo');
const tmp = join(outDir, '_frames');
const logo = join(root, 'build', 'icon.png');

const CANVAS_W = 1360, CANVAS_H = 1040, PAD_X = 80, TOP = 54, BAND = 150, RADIUS = 16;
const HOLD = 2.5, XFADE = 0.55, FPS = 30;

// scene file -> caption
const SCENES = [
  ['demo-projects.png', 'Every Claude Code project at a glance'],
  ['demo-sessions.png', 'Resume your last session in one click'],
  ['demo-neglected.png', 'Catch neglected & dirty repos'],
  ['demo-tasks.png', 'Tasks & deadlines across all projects'],
  ['demo-usage.png', 'Local token & cost analytics'],
  ['demo-settings.png', 'Point it at your repos — that’s it'],
];

function bg(w = CANVAS_W, h = CANVAS_H) {
  return Buffer.from(
    `<svg width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#23264a"/><stop offset="0.55" stop-color="#15172b"/><stop offset="1" stop-color="#0c0d12"/>` +
    `</linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`,
  );
}
function captionSvg(text) {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return Buffer.from(
    `<svg width="${CANVAS_W}" height="${CANVAS_H}"><text x="${CANVAS_W / 2}" y="${CANVAS_H - BAND / 2 + 12}" ` +
    `font-family="Segoe UI, Arial, sans-serif" font-size="32" font-weight="600" fill="#e8eaf2" text-anchor="middle">${esc}</text></svg>`,
  );
}

async function beautifyScene(srcPath, caption, outPath) {
  const innerW = CANVAS_W - PAD_X * 2;
  const innerH = CANVAS_H - TOP - BAND;
  const scaled = await sharp(srcPath).resize({ width: innerW, height: innerH, fit: 'inside' }).png().toBuffer();
  const { width: w, height: h } = await sharp(scaled).metadata();
  const mask = Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${RADIUS}" ry="${RADIUS}"/></svg>`);
  const rounded = await sharp(scaled).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  const sp = 46;
  const shadow = await sharp(Buffer.from(
    `<svg width="${w + sp * 2}" height="${h + sp * 2}"><rect x="${sp}" y="${sp}" width="${w}" height="${h}" rx="${RADIUS}" fill="black" fill-opacity="0.55"/></svg>`,
  )).blur(24).png().toBuffer();
  const x = Math.round((CANVAS_W - w) / 2), y = TOP;
  await sharp(bg())
    .composite([
      { input: shadow, left: x - sp, top: y - sp + 16 },
      { input: rounded, left: x, top: y },
      { input: captionSvg(caption), left: 0, top: 0 },
    ])
    .png()
    .toFile(outPath);
}

async function titleCard(title, subtitle, outPath, withLogo) {
  const comps = [];
  if (withLogo && existsSync(logo)) {
    const L = 150;
    const lg = await sharp(logo).resize(L, L).png().toBuffer();
    comps.push({ input: lg, left: Math.round((CANVAS_W - L) / 2), top: 330 });
  }
  const t = title.replace(/&/g, '&amp;');
  const s = subtitle.replace(/&/g, '&amp;');
  const txt = Buffer.from(
    `<svg width="${CANVAS_W}" height="${CANVAS_H}">` +
    `<text x="${CANVAS_W / 2}" y="560" font-family="Segoe UI, Arial, sans-serif" font-size="66" font-weight="700" fill="#f2f3f8" text-anchor="middle">${t}</text>` +
    `<text x="${CANVAS_W / 2}" y="620" font-family="Segoe UI, Arial, sans-serif" font-size="30" fill="#aab0c0" text-anchor="middle">${s}</text></svg>`,
  );
  comps.push({ input: txt, left: 0, top: 0 });
  await sharp(bg()).composite(comps).png().toFile(outPath);
}

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
mkdirSync(outDir, { recursive: true });

const frames = [];
const intro = join(tmp, 'a_intro.png');
await titleCard('DevDeck', 'A command deck for your Claude Code projects', intro, true);
frames.push(intro);

let i = 0;
for (const [file, cap] of SCENES) {
  const src = join(shotsDir, file);
  if (!existsSync(src)) { console.warn('skip (missing):', src); continue; }
  const out = join(tmp, `s${String(i).padStart(2, '0')}.png`);
  await beautifyScene(src, cap, out);
  frames.push(out);
  console.log('scene', file);
  i++;
}
const outro = join(tmp, 'z_outro.png');
await titleCard('Free & open-source', 'github.com/writingdeveloper/devdeck', outro, false);
frames.push(outro);

// poster = the hero scene
if (frames[1]) await sharp(frames[1]).toFile(join(outDir, 'poster.png'));

// xfade chain: k-th transition offset = k*(HOLD - XFADE)
const inputs = frames.flatMap((p) => ['-loop', '1', '-t', String(HOLD), '-i', p]);
let filter = '', last = '0:v';
for (let k = 1; k < frames.length; k++) {
  const off = (k * (HOLD - XFADE)).toFixed(3);
  const lbl = k === frames.length - 1 ? 'v' : `v${k}`;
  filter += `[${last}][${k}:v]xfade=transition=fade:duration=${XFADE}:offset=${off}[${lbl}];`;
  last = lbl;
}
filter = filter.replace(/;$/, '');

const mp4 = join(outDir, 'demo.mp4');
execFileSync(ffmpegPath, ['-y', ...inputs, '-filter_complex', filter, '-map', '[v]',
  '-r', String(FPS), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', mp4], { stdio: 'inherit' });
console.log('wrote', mp4);

const gif = join(outDir, 'demo.gif');
execFileSync(ffmpegPath, ['-y', '-i', mp4,
  '-vf', 'fps=14,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3', gif], { stdio: 'inherit' });
console.log('wrote', gif);

rmSync(tmp, { recursive: true, force: true });
console.log('done — docs/demo/demo.mp4, demo.gif, poster.png');
