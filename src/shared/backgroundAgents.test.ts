import { describe, expect, it } from 'vitest';
import { FAILED_SHOWN_MS, isBackgroundAgentId, parseBackgroundAgents } from './backgroundAgents';

const NOW = 1_800_000_000_000;
// The shape `claude agents --json --all` printed on Claude Code 2.1.306.
const sample = JSON.stringify([
  { id: '09644674', cwd: 'C:\g\a', kind: 'background', startedAt: NOW - 1000, sessionId: '09644674-b035-46c9-a894-aa6733d64119', name: 'customer support response', state: 'blocked' },
  { id: 'b54cc363', cwd: 'C:\g\b', kind: 'background', startedAt: NOW - 2000, sessionId: 'b54cc363-4978-4ff3-965a-21d575a0c3d0', name: 'upscaler review', state: 'failed' },
  { id: 'aaaabbbb', cwd: 'C:\g\c', kind: 'background', startedAt: NOW - FAILED_SHOWN_MS - 1, sessionId: 'aaaabbbb-4978-4ff3-965a-21d575a0c3d0', name: 'old failure', state: 'failed' },
  { id: 'ccccdddd', cwd: 'C:\g\d', kind: 'background', startedAt: NOW - 500, sessionId: 'ccccdddd-4978-4ff3-965a-21d575a0c3d0', name: 'finished', state: 'done' },
  { pid: 19736, cwd: 'C:\g\devdeck', kind: 'interactive', startedAt: NOW, sessionId: '565a8bf4-9834-472a-aac7-e2664fa8db6f', name: 'devdeck-8d', status: 'busy' },
  { id: '; rm -rf /', cwd: 'C:\g\e', kind: 'background', startedAt: NOW, sessionId: '565a8bf4-9834-472a-aac7-e2664fa8db6f', state: 'running' },
]);

describe('parseBackgroundAgents', () => {
  it('keeps live background sessions, newest first; drops interactive ones, finished ones and old failures', () => {
    expect(parseBackgroundAgents(sample, NOW).map((b) => [b.id, b.state])).toEqual([['09644674', 'blocked'], ['b54cc363', 'failed']]);
  });

  it('never lets anything but a short hex id through — it goes on a command line', () => {
    expect(isBackgroundAgentId('09644674')).toBe(true);
    for (const bad of ['; rm -rf /', '0964 4674', '', 'xyz', 42, null]) expect(isBackgroundAgentId(bad)).toBe(false);
  });

  it('is empty for anything that is not the list it expects', () => {
    for (const junk of ['', 'not json', '{}', 'null']) expect(parseBackgroundAgents(junk, NOW)).toEqual([]);
  });
});
