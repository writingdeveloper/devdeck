import { LOCAL_MACHINE_ID } from './link/machine';
export interface SessionScope { machineId?: string; projectPath: string; agentId?: string; }
/** Windows paths are case-insensitive; POSIX paths are not. */
function pathKey(path: string): string {
  return /^[a-z]:[\\/]|^\\\\/i.test(path) ? path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : path.replace(/\/+$/, '');
}
export function scopeKey(s: SessionScope): string {
  return JSON.stringify([s.machineId ?? LOCAL_MACHINE_ID, s.agentId ?? 'claude', pathKey(s.projectPath)]);
}
export function sameScope(a: SessionScope, b: SessionScope): boolean { return scopeKey(a) === scopeKey(b); }
export function conversationKey(s: SessionScope & {sessionId: string | null}): string | null {
  return s.sessionId ? JSON.stringify([scopeKey(s), s.sessionId]) : null;
}
