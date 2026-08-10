import { describe, expect, it } from 'vitest';
import { projectRowModel } from './projectOverview';
import type { ProjectViewModel } from '../shared/types';

describe('projectRowModel', () => {
  it('keeps the resume cue primary and moves cost/providers to secondary metadata', () => {
    const project = {
      name: 'checkout-api',
      branch: 'main',
      uncommitted: 3,
      ahead: 1,
      resumeCue: { kind: 'lastMessage', text: 'review migration output' },
      sessionCount: 2,
      agentIds: ['codex'],
    } as unknown as ProjectViewModel;

    expect(projectRowModel(project, 'attention', 1.34)).toMatchObject({
      headline: 'checkout-api',
      cue: 'review migration output',
      state: 'attention',
      primaryLabelKey: 'common.open',
    });
    expect(projectRowModel(project, 'attention', 1.34).secondary).toContain('~$1.34');
  });

  it('falls back to a useful quiet-state cue without inventing session content', () => {
    const project = {
      name: 'docs',
      branch: null,
      uncommitted: 0,
      ahead: null,
      resumeCue: null,
      sessionCount: 0,
      agentIds: [],
      stale: { level: 'neutral', ageDays: null },
    } as unknown as ProjectViewModel;

    expect(projectRowModel(project, '', null)).toMatchObject({
      branchLine: '—',
      cue: '',
      state: 'neutral',
      secondary: '',
    });
  });
});
