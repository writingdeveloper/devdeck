import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await build({
  entryPoints: [join(root, 'src', 'renderer', 'main.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  outfile: join(root, 'dist', 'renderer', 'renderer.js'),
  loader: { '.json': 'json' },
  logLevel: 'info',
});
console.log('bundled renderer -> dist/renderer/renderer.js');
