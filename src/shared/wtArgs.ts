export interface WtTab {
  name: string;
  dir: string;
}

export function buildWtArgs(projects: WtTab[], shell: string, command: string): string[] {
  if (projects.length === 0) throw new Error('buildWtArgs: no projects');
  const args: string[] = [];
  projects.forEach((p, i) => {
    if (i > 0) args.push(';');
    args.push('new-tab', '--title', p.name, '-d', p.dir, shell, '-NoExit', '-Command', command);
  });
  return args;
}
