/**
 * "What is this session actually working on right now?" — the one line the cockpit sidebar shows
 * under each session, so a long-running session doesn't have to be renamed by hand every time the
 * work moves on.
 *
 * Every function here is pure text work (no fs, no IPC) so the whole priority ladder is unit-testable.
 * The callers supply the raw candidates; this module decides which one is worth showing.
 */

/** Hard cap for a summary. The row clips to one line anyway — this bounds what crosses IPC/signatures. */
export const SUMMARY_MAX = 60;

export type SummarySource = 'ai' | 'task' | 'assistant' | 'files' | 'user';

export interface SummaryInput {
  /** Optional LLM one-liner (opt-in setting). Wins outright when present. */
  ai?: string | null;
  /** activeForm of an in-progress entry in ~/.claude/tasks (freshness is the caller's job). */
  activeForm?: string | null;
  /** Last main-chain assistant text of the session log. */
  assistantText?: string | null;
  /** Recently edited file basenames, newest first. */
  editedFiles?: string[];
  /** Last genuine user message — the weakest signal ("계속 진행"), so it sits last. */
  userText?: string | null;
}

export interface SessionSummary { text: string; source: SummarySource }

/** Strip markdown/markup down to plain prose on a single line. */
export function cleanSummaryText(raw: string | null | undefined): string {
  if (!raw) return '';
  return String(raw)
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks carry no summary value
    .replace(/```[\s\S]*$/g, ' ') // an unterminated fence (the turn was cut off mid-block)
    .replace(/<\/?[a-zA-Z][^>\n]{0,60}>/g, ' ') // stray tags (<system-reminder>, html)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links/images → their text
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, '') // heading markers
    .replace(/^[ \t]*[>\-*+|][ \t]+/gm, '') // list / quote / table-row markers
    .replace(/[`*~]/g, '') // emphasis + code spans (NOT _, which is common inside identifiers)
    .replace(/\b[0-9a-f]{40}\b/g, '') // full commit SHAs: 40 characters of the row spent on nothing
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cut to `max`, preferring a word boundary, with an ellipsis. Never returns more than `max` chars. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const hard = s.slice(0, max - 1);
  const sp = hard.lastIndexOf(' ');
  const body = sp >= Math.floor(max * 0.6) ? hard.slice(0, sp) : hard;
  return body.replace(/\s+$/, '') + '…';
}

// A sentence ends at .!? — but NOT at the dot inside a version/decimal (v1.24.0). An em/en dash is a
// lead-in separator in practice ("v1.24.0 출시 완료 — GitHub latest 확인"), so it ends the headline too.
const SENTENCE_END = /(?<!\d)[.!?。！？](?=\s|$)|\s*[—–]\s*/;

function cutAtBoundary(t: string): string {
  const m = t.match(SENTENCE_END);
  return (m && m.index != null && m.index > 0 ? t.slice(0, m.index) : t).trim();
}

/**
 * The headline sentence of a block of text, cleaned and capped.
 *
 * When the headline alone says nothing, the next clause is pulled in — the information the user needs
 * is always in what comes after it. A bare acknowledgement ("네, 전혀 문제없습니다.") is DROPPED rather
 * than kept, since the row has ~18 CJK characters to work with and an ack would eat most of them; a
 * short-but-real fragment ("# v3 — 음악까지…") is kept and extended instead.
 */
export function firstSentence(raw: string | null | undefined, max = SUMMARY_MAX): string {
  const t = cleanSummaryText(raw);
  if (!t) return '';
  const head = cutAtBoundary(t);
  if (head && head.length < t.length && isLowSignal(head)) {
    const rest = cutAtBoundary(t.slice(head.length).replace(/^[\s—–.!?。！？]+/, ''));
    if (rest) return truncate(isAcknowledgement(head) ? rest : `${head} ${rest}`, max);
  }
  return truncate(head || t, max);
}

// Openers that carry no information on their own — stripped before the acknowledgement test, so
// "모두 처리했습니다" and "네, 전혀 문제없습니다" are recognized as the bare acks they are.
const LEAD_FILLER = /^(네|넵|예|응|음|자|그럼|이제|일단|우선|먼저|모두|전부|다|전혀|ok|okay|yes|well|now|alright)[,.!]?\s+/i;
const ACK = /^(네|넵|예|응|알겠습니다|알겠어요|확인했습니다|확인|완료|완료했습니다|끝냈습니다|끝났습니다|됐습니다|처리했습니다|수정했습니다|반영했습니다|정리했습니다|맞습니다|좋습니다|문제없습니다|문제 없습니다|감사합니다|ok|okay|done|all done|finished|complete|completed|sure|got it|thanks|yes|no)[.!]?$/i;

/** True for a bare acknowledgement ("모두 처리했습니다", "네, 전혀 문제없습니다") — zero information. */
export function isAcknowledgement(text: string | null | undefined): boolean {
  let t = (text ?? '').trim();
  if (!t) return false;
  for (let i = 0; i < 4 && LEAD_FILLER.test(t); i++) t = t.replace(LEAD_FILLER, '');
  return ACK.test(t.trim());
}

/** True when the text is an acknowledgement ("모두 처리했습니다") or too short to mean anything. */
export function isLowSignal(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  if (t.length < 5) return true;
  return isAcknowledgement(t);
}

/** "cockpitView.ts +2" — the newest edited file, plus how many others rode along. */
function filesLabel(files: string[]): string {
  const names = files.map((f) => String(f ?? '').trim()).filter(Boolean);
  if (!names.length) return '';
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
}

/**
 * The activity blob handed to the AI layer: the ask, what it touched, what it said back. Empty when
 * the session has nothing to summarize yet (the caller then skips the call entirely).
 */
export function buildAiSourceText(meta: { userText?: string | null; editedFiles?: string[]; assistantText?: string | null }): string {
  const parts: string[] = [];
  const user = cleanSummaryText(meta.userText);
  const files = (meta.editedFiles ?? []).filter(Boolean);
  const assistant = cleanSummaryText(meta.assistantText);
  if (user) parts.push(`The user asked: ${user}`);
  if (files.length) parts.push(`Files edited this turn: ${files.join(', ')}`);
  if (assistant) parts.push(`The agent replied: ${assistant}`);
  return parts.join('\n');
}

/**
 * Pick the best available "what's happening" line, best source first:
 *   AI one-liner → in-progress task → a meaty assistant sentence → recently edited files →
 *   a bare assistant ack → the last user message.
 * Returns null when every candidate is empty.
 */
export function pickSessionSummary(input: SummaryInput): SessionSummary | null {
  const ai = truncate(cleanSummaryText(input.ai), SUMMARY_MAX);
  if (ai) return { text: ai, source: 'ai' };

  const task = truncate(cleanSummaryText(input.activeForm), SUMMARY_MAX);
  if (task) return { text: task, source: 'task' };

  const assistant = firstSentence(input.assistantText);
  if (assistant && !isLowSignal(assistant)) return { text: assistant, source: 'assistant' };

  const files = truncate(filesLabel(input.editedFiles ?? []), SUMMARY_MAX);
  if (files) return { text: files, source: 'files' };

  if (assistant) return { text: assistant, source: 'assistant' };

  const user = firstSentence(input.userText);
  if (user) return { text: user, source: 'user' };

  return null;
}
