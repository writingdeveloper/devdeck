// Tray icon + tooltip state, pure so it's unit-testable without electron.

import type { ShutdownPhase } from './shutdownIdle';

export type TrayAlertMode = 'off' | 'attention' | 'all';
export interface TrayCounts { attention: number; turn: number; overdue: number; }

/**
 * `red` drives the red-dot alert icon: agent needs-you counts only, gated by the user's alert mode.
 * Overdue TASKS never redden the tray (a deadline is not an agent waiting on input) but always show
 * in the tooltip — including with alerts 'off', since 'off' disables the dot, not information.
 */
export function trayState(counts: TrayCounts, mode: TrayAlertMode): { red: number; tooltip: string } {
  const red = mode === 'off' ? 0 : mode === 'all' ? counts.attention + counts.turn : counts.attention;
  const parts: string[] = [];
  if (red > 0) parts.push(`${red} waiting`);
  if (counts.overdue > 0) parts.push(`${counts.overdue} overdue`);
  return { red, tooltip: parts.length ? `DevDeck — ${parts.join(' · ')}` : 'DevDeck' };
}

/** Which idle-shutdown items the tray context menu shows per phase (pure — tray.ts maps to MenuItems). */
export function shutdownMenuShape(phase: ShutdownPhase | null): Array<{ key: 'toggle' | 'now' | 'cancel'; checked?: boolean }> {
  if (phase === null) return [];
  if (phase === 'countdown') return [{ key: 'cancel' }];
  return [{ key: 'toggle', checked: phase === 'armed' }, { key: 'now' }];
}
