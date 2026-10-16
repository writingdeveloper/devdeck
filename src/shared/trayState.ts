// Tray icon + tooltip state, pure so it's unit-testable without electron.

import type { ShutdownPhase } from './shutdownIdle';

export type TrayAlertMode = 'off' | 'attention' | 'all';
export interface TrayCounts { attention: number; turn: number; overdue: number; }
/** The tray's words, in the app's language — the main process has no translator, so the window sends them. */
export interface TrayLabels { open: string; shutdownIdle: string; shutdownNow: string; cancelShutdown: string; quit: string; waiting: string; overdue: string }
export const DEFAULT_TRAY_LABELS: TrayLabels = {
  open: 'Open DevDeck', shutdownIdle: 'Shut down PC when idle', shutdownNow: 'Shut down PC now', cancelShutdown: 'Cancel shutdown', quit: 'Quit',
  waiting: '{n} waiting', overdue: '{n} overdue',
};

/**
 * `red` drives the red-dot alert icon: agent needs-you counts only, gated by the user's alert mode.
 * Overdue TASKS never redden the tray (a deadline is not an agent waiting on input) but always show
 * in the tooltip — including with alerts 'off', since 'off' disables the dot, not information.
 */
export function trayState(counts: TrayCounts, mode: TrayAlertMode, labels: TrayLabels = DEFAULT_TRAY_LABELS): { red: number; tooltip: string } {
  const red = mode === 'off' ? 0 : mode === 'all' ? counts.attention + counts.turn : counts.attention;
  const parts: string[] = [];
  if (red > 0) parts.push(labels.waiting.replace('{n}', String(red)));
  if (counts.overdue > 0) parts.push(labels.overdue.replace('{n}', String(counts.overdue)));
  return { red, tooltip: parts.length ? `DevDeck — ${parts.join(' · ')}` : 'DevDeck' };
}

/** Which idle-shutdown items the tray context menu shows per phase (pure — tray.ts maps to MenuItems). */
export function shutdownMenuShape(phase: ShutdownPhase | null): Array<{ key: 'toggle' | 'now' | 'cancel'; checked?: boolean }> {
  if (phase === null) return [];
  if (phase === 'countdown') return [{ key: 'cancel' }];
  return [{ key: 'toggle', checked: phase === 'armed' }, { key: 'now' }];
}
