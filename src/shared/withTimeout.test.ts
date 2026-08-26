import { describe, it, expect, vi } from 'vitest';
import { withTimeout, TimeoutError } from './withTimeout';

describe('withTimeout', () => {
  it('passes a result straight through when it arrives in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });

  it('passes a rejection through unchanged — a real error must not be reported as a timeout', async () => {
    const boom = new Error('git exploded');
    await expect(withTimeout(Promise.reject(boom), 1000)).rejects.toBe(boom);
  });

  it('rejects when the work does not answer, naming what it was waiting on', async () => {
    // The state this exists for: a load that never settles leaves a skeleton on screen for the rest
    // of the session, which is what users report as infinite loading.
    const never = new Promise<never>(() => { /* deliberately never settles */ });
    await expect(withTimeout(never, 5, 'project list')).rejects.toThrow(TimeoutError);
    await expect(withTimeout(never, 5, 'project list')).rejects.toThrow(/project list did not answer/);
  });

  it('clears its timer once the work settles, so nothing keeps the process awake', async () => {
    // A leaked timer in the renderer is a leaked wakeup on every load, forever.
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    clear.mockClear();
    await withTimeout(Promise.resolve(1), 60_000);
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it('does not reject a second time after the work resolves late', async () => {
    // The scan is not cancelled — it cannot be — so its answer arrives after the deadline. That must
    // be a dropped value, not an unhandled rejection in the renderer.
    let settle: (v: string) => void = () => {};
    const late = new Promise<string>((r) => { settle = r; });
    const guarded = withTimeout(late, 5, 'late work');
    await expect(guarded).rejects.toThrow(TimeoutError);
    settle('arrived eventually');
    await expect(late).resolves.toBe('arrived eventually');
  });
});
