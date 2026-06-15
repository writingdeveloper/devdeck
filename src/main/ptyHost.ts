export interface PtyProcess {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type PtySpawn = (
  file: string, args: string[], opts: { cwd: string; cols: number; rows: number }
) => PtyProcess;

export class PtyHost {
  private procs = new Map<string, PtyProcess>();
  constructor(private readonly spawn: PtySpawn) {}

  create(
    id: string, file: string, args: string[], cwd: string, cols: number, rows: number,
    onData: (data: string) => void, onExit: (e: { exitCode: number }) => void,
  ): void {
    const proc = this.spawn(file, args, { cwd, cols, rows });
    this.procs.set(id, proc);
    proc.onData(onData);
    proc.onExit((e) => { this.procs.delete(id); onExit(e); });
  }

  write(id: string, data: string): void { this.procs.get(id)?.write(data); }
  resize(id: string, cols: number, rows: number): void { this.procs.get(id)?.resize(cols, rows); }
  kill(id: string): void { const p = this.procs.get(id); if (p) { p.kill(); this.procs.delete(id); } }
  killAll(): void { for (const p of this.procs.values()) p.kill(); this.procs.clear(); }
}
