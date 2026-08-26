/**
 * Give a promise a deadline.
 *
 * The views that load data had none, and a request that never answers is exactly what the user sees
 * as infinite loading: the skeleton stays on screen, forever, with no way back short of restarting.
 * The main process is the thing being waited on and it can genuinely stall — a git command with no
 * limit of its own, a store being walked, a paired machine that stopped replying.
 *
 * A rejection is not a silent failure: every caller already has an error path that offers a retry,
 * which is a far better answer than a grey rectangle.
 *
 * The underlying work is NOT cancelled — nothing here can cancel a scan already running in another
 * process, and pretending otherwise would be worse. It finishes and its answer is dropped, which is
 * why callers must be safe against a late result (they check what they asked for is still wanted).
 */
export class TimeoutError extends Error {
  constructor(public readonly ms: number, label?: string) {
    super(`${label ?? 'operation'} did not answer within ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(work: Promise<T>, ms: number, label?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
