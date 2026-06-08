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
