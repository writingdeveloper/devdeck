import { describe, it, expect } from 'vitest';
import { recoverProjectFromLines, classifyUsageProjects, normPath } from './usageProjects';

describe('recoverProjectFromLines', () => {
  it('recovers {path,name} from the first line carrying a string cwd', () => {
    const lines = [
      JSON.stringify({ type: 'summary', sessionId: 'x' }),                                   // no cwd
      JSON.stringify({ type: 'user', cwd: 'C:\\Users\\me\\Documents\\GitHub\\healframe', gitBranch: 'master' }),
    ];
    expect(recoverProjectFromLines(lines)).toEqual({ path: 'C:\\Users\\me\\Documents\\GitHub\\healframe', name: 'healframe' });
  });
  it('handles non-ASCII paths and forward slashes', () => {
    expect(recoverProjectFromLines([JSON.stringify({ cwd: '/home/me/проект-1' })]))
      .toEqual({ path: '/home/me/проект-1', name: 'проект-1' });
  });
  it('skips blank/unparseable lines; null when no cwd anywhere', () => {
    expect(recoverProjectFromLines(['', 'not json', JSON.stringify({ type: 'x' })])).toBeNull();
  });
});

describe('classifyUsageProjects', () => {
  const scanned = [{ path: 'C:\\g\\devdeck', name: 'devdeck' }, { path: 'C:\\g\\ga', name: 'ga' }];
  it('tags scanned deck repos active', () => {
    const r = classifyUsageProjects({ scanned, claudeProjects: [], exists: () => true });
    expect(r).toEqual([
      { path: 'C:\\g\\devdeck', name: 'devdeck', status: 'active' },
      { path: 'C:\\g\\ga', name: 'ga', status: 'active' },
    ]);
  });
  it('includes a not-in-deck project whose folder is gone, as deleted', () => {
    const r = classifyUsageProjects({ scanned, claudeProjects: [{ path: 'C:\\g\\healframe', name: 'healframe' }], exists: () => false });
    expect(r).toContainEqual({ path: 'C:\\g\\healframe', name: 'healframe', status: 'deleted' });
  });
  it('EXCLUDES a not-in-deck project whose folder still exists (unscanned, out of scope)', () => {
    const r = classifyUsageProjects({ scanned, claudeProjects: [{ path: 'C:\\elsewhere\\ComfyUI', name: 'ComfyUI' }], exists: () => true });
    expect(r.find((x) => x.name === 'ComfyUI')).toBeUndefined();
  });
  it('does not duplicate a claude project already active in the deck (case/sep-insensitive)', () => {
    const r = classifyUsageProjects({ scanned, claudeProjects: [{ path: 'c:/g/DEVDECK', name: 'DEVDECK' }], exists: () => false });
    expect(r.filter((x) => normPath(x.path) === 'c:/g/devdeck').length).toBe(1);
    expect(r.some((x) => x.status === 'deleted')).toBe(false);
  });
});
