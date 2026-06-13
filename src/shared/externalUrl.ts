/** Only DevDeck's own GitHub project URLs may be opened externally (renderer-supplied URLs are untrusted). */
export function isAllowedExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      u.host === 'github.com' &&
      (u.pathname === '/writingdeveloper/devdeck' || u.pathname.startsWith('/writingdeveloper/devdeck/'))
    );
  } catch {
    return false;
  }
}

/**
 * A project's repo URL is safe to open externally only if it is an https github.com
 * URL. Main derives these from `git remote` (so they're already trusted), but this is
 * defense-in-depth before `shell.openExternal`. `host` (not `hostname`) rejects any
 * `github.com:port`/userinfo variants outright.
 */
export function isSafeRepoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.host === 'github.com';
  } catch {
    return false;
  }
}
