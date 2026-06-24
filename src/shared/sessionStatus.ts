export type ActivityState = 'working' | 'attention' | 'turn' | 'idle' | 'exited';

export const WORKING_MS = 1500;
// Once 'working', tolerate the agent's OWN output gaps (thinking, running a tool, API latency) this long
// before deciding it's your turn — prevents working↔turn flicker during a busy agent.
export const WORKING_STICKY_MS = 10_000;
export const IDLE_MS = 180_000; // 3 min of silence => idle (vs a fresh "your turn")
// The user typed this recently => "your turn", never "working" (the PTY just echoes keystrokes,
// which must not be mistaken for agent output). Kept > WORKING_MS so a typing pause can't flip to 'working'.
export const INPUT_ACTIVE_MS = 2000;

/**
 * Strip ANSI/VT escape sequences (CSI and OSC) so prompt patterns match on plain text.
 * Char-code based (ESC = 0x1b) — never touches ordinary printable text (incl. brackets/uppercase).
 */
export function stripAnsi(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x1b) { // ESC — consume the escape sequence
      const next = s[i + 1];
      if (next === '[') { // CSI: ESC [ params/intermediates final(0x40–0x7e)
        i += 2;
        while (i < s.length && (s.charCodeAt(i) < 0x40 || s.charCodeAt(i) > 0x7e)) i++;
      } else if (next === ']') { // OSC: ESC ] … terminated by BEL (0x07) or ST (ESC \)
        i += 2;
        while (i < s.length && s.charCodeAt(i) !== 0x07 && s.charCodeAt(i) !== 0x1b) i++;
        if (s.charCodeAt(i) === 0x1b) i++; // skip the ESC of an ST terminator
      } else {
        i++; // other two-char escape
      }
    } else {
      out += s[i];
    }
  }
  return out;
}

/**
 * Best-effort signatures of an agent waiting on a confirmation/question (Claude's UI mainly).
 * Best-effort: a prompt-like line in ordinary output can false-positively flag 'attention' until it
 * scrolls out of the recentOutput window — or until the user types (cockpitView clears the buffer on input).
 */
export const PROMPT_PATTERNS: RegExp[] = [
  /❯\s*\d+\.\s/,                 // ❯ 1. Yes
  /\bdo you want to\b/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /press enter to continue/i,
  /\bproceed\?/i,
];

export function hasPromptPattern(recentOutput: string): boolean {
  return PROMPT_PATTERNS.some((re) => re.test(recentOutput));
}

// Claude Code's "working" status line animates a star/asterisk dingbat spinner (✶ ✻ ✢ ✳ ✽ …)
// that is ABSENT at the idle ❯ prompt. (Captured from claude v2.1.179 — note that version shows NO
// "esc to interrupt" text, so the glyph is the reliable signal.) We only scan the TAIL of the recent
// output: the spinner frame is the LAST thing drawn while working — and it STAYS there during a long
// silent tool/think/API gap (a frozen spinner) — whereas the idle frame ends with the star-free status
// bar (~250 chars), so a short tail window cleanly separates "working" from "your turn".
// Excludes ASCII '*' (git "main*"), '·' (00B7) and '●' (25CF), which appear in the idle status bar.
export const SPINNER_TAIL = 200;
// U+2722–U+2727 and U+2731–U+273D: the asterisk/star dingbat block Claude cycles through.
export const WORKING_SPINNER_RE = /[✢-✧✱-✽]/;
export function hasWorkingSpinner(recentOutput: string): boolean {
  return WORKING_SPINNER_RE.test(recentOutput.slice(-SPINNER_TAIL));
}

export function computeActivity(i: { exited: boolean; lastDataAt: number; lastInputAt: number; now: number; recentOutput: string; prev?: ActivityState }): ActivityState {
  if (i.exited) return 'exited';
  // The user actively typing is engaged, not the agent working — keep it a stable "your turn"
  // so the indicator (and the needs-you badge) don't flicker as keystrokes echo back.
  if (i.now - i.lastInputAt <= INPUT_ACTIVE_MS) return 'turn';
  const sinceData = i.now - i.lastDataAt;
  if (sinceData <= WORKING_MS) return 'working';
  // A real confirmation prompt outranks the working signals below — never mask a question as 'working'.
  if (hasPromptPattern(i.recentOutput)) return 'attention';
  // Content signal: the agent's spinner frame is still the last thing on screen, so it's working even
  // through a long silent tool/think/API gap (survives a frozen spinner — which the timer alone can't).
  if (hasWorkingSpinner(i.recentOutput)) return 'working';
  // Timing hysteresis fallback: it WAS working and only briefly went quiet — covers agents/versions
  // whose spinner glyph we don't match (e.g. Antigravity / Codex-style TUIs).
  if (i.prev === 'working' && sinceData < WORKING_STICKY_MS) return 'working';
  if (sinceData < IDLE_MS) return 'turn';
  return 'idle';
}
