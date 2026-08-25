/**
 * xterm's compatibility switch for a pty hosted by Windows.
 *
 * xterm and ConPTY disagree about what happens when a terminal gets TALLER. xterm's default is the
 * Unix one: the rows that appear at the top are filled from scrollback, so the viewport slides up
 * over content the user has already seen. ConPTY does the opposite — it adds BLANK rows at the
 * bottom and then repaints the screen as if that is what happened. Left at the default, one pane
 * growing by a few rows therefore leaves the buffer holding scrollback that ConPTY's repaint was
 * never aligned to, and the two land on the same rows: half-erased status lines, a sentence struck
 * through by a separator, the same block printed twice. Telling xterm the pty is a Windows one
 * switches it to ConPTY's rule.
 *
 * The build number matters as much as the backend: xterm turns its own reflow OFF unless it is told
 * ConPTY is new enough to reflow by itself (build 21376+), so passing a backend without a build
 * would trade one artifact for another — resizing would stop rewrapping altogether.
 *
 * Mirrors node-pty's own choice of backend (`windowsPtyAgent`: ConPTY from build 18309, winpty
 * below it), because it has to describe the pty that is actually there — including a REMOTE one:
 * a DevDeck Link tile draws a terminal whose pty lives on the other machine, so this is answered
 * for the machine that owns the session, never for the one doing the looking.
 */
export interface WindowsPtyCompat {
  backend: 'conpty' | 'winpty';
  buildNumber: number;
}

/** ConPTY exists from this Windows build; node-pty falls back to winpty below it. */
const CONPTY_MIN_BUILD = 18309;

/**
 * The `windowsPty` option for a terminal whose pty runs on `platform`, or undefined when it doesn't
 * run on Windows (and so needs no compatibility at all).
 *
 * `osRelease` is `os.release()` — "10.0.26200" on Windows. An unparseable one yields undefined
 * rather than a guess: a backend without a build number is exactly the case that silently disables
 * reflow, so being wrong here is worse than staying at the default.
 */
export function windowsPtyCompat(platform: string | undefined, osRelease: string | undefined): WindowsPtyCompat | undefined {
  if (platform !== 'win32') return undefined;
  const build = Number(/^\d+\.\d+\.(\d+)/.exec(String(osRelease ?? ''))?.[1]);
  if (!Number.isInteger(build) || build <= 0) return undefined;
  return { backend: build >= CONPTY_MIN_BUILD ? 'conpty' : 'winpty', buildNumber: build };
}
