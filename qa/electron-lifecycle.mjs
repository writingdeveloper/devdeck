import assert from 'node:assert/strict';
const closing = new WeakMap();

/** A passing UI run with a crashing main process is a failed run. */
export function closeElectron(app) {
  const existing = closing.get(app);
  if (existing) return existing;
  const work = closeOnce(app);
  closing.set(app, work);
  return work;
}

async function closeOnce(app) {
  const proc = app.process();
  const exit = proc.exitCode !== null || proc.signalCode !== null
    ? Promise.resolve({ code: proc.exitCode, signal: proc.signalCode })
    : new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })));
  let timer;
  try {
    await Promise.race([
      (async () => {
        await app.evaluate(({ app: a }) => { a.isQuitting = true; setImmediate(() => a.quit()); }).catch(() => {});
        await app.close().catch(() => {});
        const result = await exit;
        assert.equal(result.signal, null, `Electron terminated by ${result.signal}`);
        assert.equal(result.code, 0, `Electron exited abnormally: ${result.code}`);
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => {
        proc.kill(); // Only this harness-owned app; a hung exit is a failure, never a passing cleanup.
        reject(new Error('Electron did not exit within 30 seconds'));
      }, 30_000); }),
    ]);
  } finally { clearTimeout(timer); }
}
