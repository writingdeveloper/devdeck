// macOS-only CI check: validate that the AppleScript DevDeck actually generates
// COMPILES on a real Mac (via osacompile) — no GUI/window server required. Imports
// the real builder so the check can never drift from the shipped code.
import { buildMacLaunch } from '../dist/shared/posixLaunch.js';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [cmd] = buildMacLaunch([{ name: 'x', dir: '/tmp/x', command: 'claude -c' }]);
// Re-extract the `-e <script>` pairs (everything before the trailing dir+command argv).
const eArgs = [];
for (let i = 0; i < cmd.args.length - 2; i++) {
  if (cmd.args[i] === '-e') eArgs.push('-e', cmd.args[i + 1]);
}
if (eArgs.length === 0) { console.error('no -e script bodies found'); process.exit(1); }

execFileSync('osacompile', [...eArgs, '-o', join(tmpdir(), 'devdeck-check.scpt')], { stdio: 'inherit' });
console.log('AppleScript compiled OK (' + eArgs.filter((a) => a !== '-e').length + ' lines)');
