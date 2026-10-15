export interface SessionLabelSnapshot { label: string | null; labelRevision: number; instanceId: string; }
export interface SessionLabelVersion { labelRevision: number; instanceId: string; }
export type SessionLabelResult =
  | { ok: true; snapshot: SessionLabelSnapshot }
  | { ok: false; reason: 'conflict'; snapshot: SessionLabelSnapshot }
  | { ok: false; reason: 'missing' };
export function normalizeSessionLabel(value: unknown): string | null {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 60) || null : null;
}
export function hasLabelVersion(v: unknown): v is SessionLabelVersion {
  const o = v as Partial<SessionLabelVersion> | null;
  return !!o && typeof o.instanceId === 'string' && o.instanceId.length > 0 && o.instanceId.length <= 128
    && Number.isSafeInteger(o.labelRevision) && (o.labelRevision as number) >= 0;
}
/** Reject delayed replies for an older revision or another terminal incarnation. */
export function acceptsLabelVersion(current: SessionLabelVersion | null, incoming: SessionLabelVersion): boolean {
  return current === null || (current.instanceId === incoming.instanceId && incoming.labelRevision >= current.labelRevision);
}
