/**
 * Sessions this deck has closed, remembered until the machine that ran them stops listing them.
 *
 * Closing a tile and hearing what a machine runs are two independent streams, and the second one
 * lags: a machine announces its sessions after EVERY change, so closing three tiles in a row produces
 * three announcements of which the first still lists the two not yet closed. Adoption reads "listed
 * but not shown here" as "started somewhere else" and built tiles for them again — dead ones, which
 * then sat in the sidebar as "exited" and were saved and restored with everything else. A remote close
 * that could not be delivered (machine offline) came back the same way on reconnect, still running.
 *
 * A tombstone is released when an announcement from that machine no longer lists the id, which is
 * the machine's own word that the terminal is gone. A close still OWED (the machine was unreachable)
 * keeps its tombstone through announcements until it has been delivered.
 */
export class CloseTombstones {
  private readonly byMachine = new Map<string, Map<string, { pending: boolean }>>();

  add(machineId: string, id: string, pending = false): void {
    let ids = this.byMachine.get(machineId);
    if (!ids) { ids = new Map(); this.byMachine.set(machineId, ids); }
    ids.set(id, { pending });
  }

  has(machineId: string, id: string): boolean {
    return this.byMachine.get(machineId)?.has(id) === true;
  }

  /** The close could not be delivered yet; keep the session suppressed until it is. */
  markPending(machineId: string, id: string): void {
    const entry = this.byMachine.get(machineId)?.get(id);
    if (entry) entry.pending = true;
  }

  /** The close reached the machine; the next announcement without the id releases it. */
  settle(machineId: string, id: string): void {
    const entry = this.byMachine.get(machineId)?.get(id);
    if (entry) entry.pending = false;
  }

  /** Closes owed to a machine, for sending again once it is reachable. */
  pending(machineId: string): string[] {
    return [...(this.byMachine.get(machineId) ?? new Map<string, { pending: boolean }>())]
      .filter(([, entry]) => entry.pending).map(([id]) => id);
  }

  /** Every close still owed, on any machine — what has to survive a restart of this app. */
  allPending(): { machineId: string; id: string }[] {
    return [...this.byMachine].flatMap(([machineId, ids]) => [...ids].filter(([, e]) => e.pending).map(([id]) => ({ machineId, id })));
  }

  /** Forget a close entirely — it was refused, so the session is legitimately still there. */
  remove(machineId: string, id: string): void {
    const ids = this.byMachine.get(machineId);
    if (!ids) return;
    ids.delete(id);
    if (!ids.size) this.byMachine.delete(machineId);
  }

  /** An announcement of everything `machineId` runs: release what it no longer runs and owes nothing. */
  observe(machineId: string, aliveIds: readonly string[]): void {
    const ids = this.byMachine.get(machineId);
    if (!ids) return;
    const alive = new Set(aliveIds);
    for (const [id, entry] of [...ids]) if (!entry.pending && !alive.has(id)) ids.delete(id);
    if (!ids.size) this.byMachine.delete(machineId);
  }
}
