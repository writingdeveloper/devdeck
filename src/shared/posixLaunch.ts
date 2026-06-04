import type { WtTab } from './wtArgs';

/** A spawnable command: an executable plus its argv. */
export interface LaunchCmd {
  file: string;
  args: string[];
}

// macOS: open one Terminal window per project. The directory and command are passed
// as `argv` to osascript (NOT interpolated into the AppleScript source), so a crafted
// path/command can never inject AppleScript. The directory is shell-quoted by
// AppleScript's `quoted form of` before the `cd`; the command is our own trusted
// string (`claude`, `claude -c`, or `claude -r <validated-id>`).
const MAC_SCRIPT = [
  '-e', 'on run argv',
  '-e', 'tell application "Terminal" to do script ("cd " & quoted form of (item 1 of argv) & " && " & (item 2 of argv))',
  '-e', 'tell application "Terminal" to activate',
  '-e', 'end run',
];

export function buildMacLaunch(tabs: WtTab[]): LaunchCmd[] {
  return tabs.map((t) => ({ file: 'osascript', args: [...MAC_SCRIPT, t.dir, t.command] }));
}

/** POSIX single-quote a string for safe inclusion in a `bash -lc` command. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Linux: one terminal window per project, keeping the shell open after the command
 * (`exec bash`). Terminals differ in how they set the working directory and run a
 * command, so we special-case the common ones and fall back to the `-e` convention
 * (xterm / x-terminal-emulator / unknowns) with an explicit `cd`.
 */
export function buildLinuxLaunch(tabs: WtTab[], term: string): LaunchCmd[] {
  return tabs.map((t) => {
    const keepOpen = `${t.command}; exec bash`;
    switch (term) {
      case 'gnome-terminal':
        return { file: term, args: [`--working-directory=${t.dir}`, '--', 'bash', '-lc', keepOpen] };
      case 'konsole':
        return { file: term, args: ['--workdir', t.dir, '-e', 'bash', '-lc', keepOpen] };
      case 'alacritty':
        return { file: term, args: ['--working-directory', t.dir, '-e', 'bash', '-lc', keepOpen] };
      case 'kitty':
        return { file: term, args: ['--directory', t.dir, 'bash', '-lc', keepOpen] };
      default:
        return { file: term, args: ['-e', 'bash', '-lc', `cd ${shSingleQuote(t.dir)} && ${keepOpen}`] };
    }
  });
}
