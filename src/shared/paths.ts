/**
 * Encode an absolute path the way Claude names its ~/.claude/projects dir:
 * every non-alphanumeric character (drive colon, path separators, spaces, dots,
 * …) becomes '-'. Replacing only ':' and '\' missed folders whose names contain
 * spaces or dots, so their usage/sessions silently went unmatched.
 */
export function encodeProjectPath(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}
