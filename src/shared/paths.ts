/** Replace every ':' and '\' with '-' to match Claude's ~/.claude/projects dir name. */
export function encodeProjectPath(absPath: string): string {
  return absPath.replace(/[:\\]/g, '-');
}
