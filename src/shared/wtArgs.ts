export interface WtTab {
  name: string;
  dir: string;
  command: string;
}

/** Build `wt` args opening each tab in the CURRENT window (-w 0), each running its own command. */
export function buildWtArgs(tabs: WtTab[], shell: string): string[] {
  if (tabs.length === 0) throw new Error('buildWtArgs: no tabs');
  const args: string[] = ['-w', '0'];
  tabs.forEach((t, i) => {
    if (i > 0) args.push(';');
    args.push('new-tab', '--title', t.name, '-d', t.dir, shell, '-NoExit', '-Command', t.command);
  });
  return args;
}
