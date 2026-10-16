export interface WtTab {
  name: string;
  dir: string;
  command: string;
}

/**
 * wt splits its whole command line on `;` into separate subcommands — a folder or title containing
 * one opened a broken tab plus a stray command. `\;` is wt's escape for a literal semicolon.
 */
function wtLiteral(value: string): string { return value.replace(/;/g, '\\;'); }

/** Build `wt` args opening each tab in the CURRENT window (-w 0), each running its own command. */
export function buildWtArgs(tabs: WtTab[], shell: string): string[] {
  if (tabs.length === 0) throw new Error('buildWtArgs: no tabs');
  const args: string[] = ['-w', '0'];
  tabs.forEach((t, i) => {
    if (i > 0) args.push(';');
    args.push('new-tab', '--title', wtLiteral(t.name), '-d', wtLiteral(t.dir), shell, '-NoExit', '-Command', wtLiteral(t.command));
  });
  return args;
}
