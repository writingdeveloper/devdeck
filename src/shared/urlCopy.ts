/**
 * Rejoin a URL that a terminal (or a CLI's own renderer) broke across multiple rows.
 *
 * Long URLs have no spaces to wrap at, so they get hard-wrapped — and each continuation row may
 * even carry the message's left indentation. Selecting + copying then yields the URL with embedded
 * newlines/spaces, which silently corrupts it (e.g. an OAuth `state` mismatch when pasted elsewhere).
 *
 * URLs never contain literal whitespace, so when a selection is unambiguously a single http/https
 * URL split across lines, we can safely strip the wrap artifacts and return the original. Anything
 * else — code, prose, multiple URLs, bare tokens — is returned untouched, since collapsing
 * whitespace there would be wrong.
 */
export function unwrapCopiedUrl(raw: string): string {
  if (!raw.includes('\n')) return raw; // single line: xterm already joins genuine soft-wraps cleanly
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length < 2) return raw;
  if (lines.some((l) => /\s/.test(l))) return raw; // a row with inner whitespace isn't a pure URL fragment
  const joined = lines.join('');
  // Require a single http(s) URL: exactly one literal "://" guards against merging two stacked URLs.
  const isSingleUrl = /^https?:\/\/\S+$/i.test(joined) && (joined.match(/:\/\//g) ?? []).length === 1;
  return isSingleUrl ? joined : raw;
}
