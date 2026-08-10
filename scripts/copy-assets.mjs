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

async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, target);
    else await copyFile(source, target);
  }
}

for (const dir of ['design', 'shell', 'features']) {
  try { await copyTree(join(srcDir, dir), join(outDir, dir)); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}
await copyFile(
  join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
  join(outDir, 'xterm.css'),
);

const assetsSrc = join(root, 'src', 'assets');
const assetsOut = join(outDir, 'assets');
await mkdir(assetsOut, { recursive: true });
for (const f of await readdir(assetsSrc)) {
  await copyFile(join(assetsSrc, f), join(assetsOut, f));
}
await copyFile(
  join(root, 'node_modules', '@fontsource-variable', 'geist', 'files', 'geist-latin-wght-normal.woff2'),
  join(assetsOut, 'geist-latin-wght-normal.woff2'),
);
console.log('copied renderer assets to dist/renderer (incl. assets/)');
