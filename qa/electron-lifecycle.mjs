import assert from 'node:assert/strict';

/** A passing UI run with a crashing main process is a failed run. */
export async function closeElectron(app) {
  const proc = app.process();
  const exit = proc.exitCode !== null || proc.signalCode !== null
    ? Promise.resolve({ code: proc.exitCode, signal: proc.signalCode })
    : new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })));
  await app.evaluate(({ app: a }) => { a.isQuitting = true; setImmediate(() => a.quit()); }).catch(() => {});
  await app.close().catch(() => {});
  const result = await exit;
  assert.equal(result.signal, null, `Electron terminated by ${result.signal}`);
  assert.equal(result.code, 0, `Electron exited abnormally: ${result.code}`);
}
