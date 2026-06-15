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
console.log('copied renderer assets to dist/renderer (incl. assets/)');
