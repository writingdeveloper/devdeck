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

export type ProjectStateShape = 'diamond' | 'ring' | 'dot' | 'bar' | 'triangle' | 'square' | 'hollow';
export interface ProjectStatePresentation { labelKey: string; shape: ProjectStateShape; }

export function projectStatePresentation(state: ProjectRowState, noRecord: boolean): ProjectStatePresentation {
  if (noRecord) return { labelKey: 'proj.state_no_record', shape: 'hollow' };
  if (state === 'attention') return { labelKey: 'proj.state_attention', shape: 'diamond' };
  if (state === 'working') return { labelKey: 'proj.state_working', shape: 'ring' };
  if (state === 'fresh') return { labelKey: 'proj.state_fresh', shape: 'dot' };
  if (state === 'warn') return { labelKey: 'proj.state_warning', shape: 'triangle' };
  if (state === 'neglected') return { labelKey: 'proj.state_neglected', shape: 'square' };
  return { labelKey: 'proj.state_stale', shape: 'bar' };
}

export function openSelectedPresentation(selectionCount: number): { hidden: boolean; disabled: boolean } {
  const inactive = selectionCount === 0;
  return { hidden: inactive, disabled: inactive };
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
