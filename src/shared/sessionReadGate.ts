/** Request epochs are local to one machine: a newer push, pull, or disconnect invalidates older reads. */
export class SessionReadGate {
  private versions = new Map<string, number>();
  begin(machine: string): number {
    const next = (this.versions.get(machine) ?? 0) + 1;
    this.versions.set(machine, next);
    return next;
  }
  current(machine: string, token: number): boolean { return this.versions.get(machine) === token; }
}
