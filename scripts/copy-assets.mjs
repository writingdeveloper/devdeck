import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, 'src', 'renderer');
const outDir = join(root, 'dist', 'renderer');

await mkdir(outDir, { recursive: true });
for (const file of ['index.html', 'styles.css']) {
  await copyFile(join(srcDir, file), join(outDir, file));
}
console.log('copied renderer assets to dist/renderer');
