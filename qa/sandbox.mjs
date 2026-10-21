// Temp folders a harness run works in. Every run used to leave its own behind (about 5 GB after a
// few weeks). A passing run removes them on exit; a failing one keeps them and says where.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = [];

/** A new folder in the OS temp directory, named `<prefix><random>`, removed when the run passes. */
export function sandboxDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

process.on('exit', (code) => {
  if (code) {
    if (made.length) console.log('kept for inspection: ' + made.join(', '));
    return;
  }
  for (const dir of made) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* still held; temp is swept by the OS */ }
  }
});
