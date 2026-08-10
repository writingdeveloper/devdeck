import type { ProjectViewModel, StaleLevel } from '../shared/types';

export type ProjectRowState = '' | 'attention' | 'working' | StaleLevel;

export interface ProjectRowModel {
  headline: string;
  branchLine: string;
  cue: string;
  state: ProjectRowState;
  secondary: string;
  primaryLabelKey: 'common.open';
}

/**
 * Distils a dense project record into the information hierarchy used by the
 * command-center row: resume intent first, operational metadata second.
 */
export function projectRowModel(
  project: ProjectViewModel,
  live: '' | 'attention' | 'working',
  cost: number | null | undefined,
): ProjectRowModel {
  const branchBits = [project.branch ?? '—'];
  if (project.uncommitted > 0) branchBits.push(`✎${project.uncommitted}`);
  if (project.ahead && project.ahead > 0) branchBits.push(`↑${project.ahead}`);

  const secondary: string[] = [];
  if (project.agentIds.length) secondary.push(project.agentIds.join(' + '));
  if (project.sessionCount > 0) secondary.push(String(project.sessionCount));
  if (cost != null) secondary.push(`~$${cost.toFixed(2)}`);

  return {
    headline: project.name,
    branchLine: branchBits.join(' · '),
    cue: project.resumeCue?.text ?? '',
    state: live || project.stale?.level || '',
    secondary: secondary.join(' · '),
    primaryLabelKey: 'common.open',
  };
}
