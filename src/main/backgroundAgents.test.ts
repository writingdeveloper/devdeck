import { afterEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawn(...a) }));

describe('listing background sessions while Claude Code is being updated', () => {
  afterEach(async () => { const m = await import('./backgroundAgents.js'); await m.pauseBackgroundAgents(false); m._clearBackgroundAgentCache(); spawn.mockReset(); });

  it('starts no claude at all while paused — the update is replacing that executable', async () => {
    const m = await import('./backgroundAgents.js');
    await m.pauseBackgroundAgents(true);
    expect(await m.listBackgroundAgents()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });
});
