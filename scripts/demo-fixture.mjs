// Builds a CURATED, isolated demo dataset for marketing screenshots — no real
// data leaks. Creates a throwaway HOME under the temp dir with handsome fake git
// repos (varied staleness / dirty counts / branches) and matching Claude
// sessions (resume cues + usage data). Prints the HOME path on the last line.
//
// Dev-only. Pair with scripts/demo-capture.mjs (which launches DevDeck against it).
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const HOME = join(tmpdir(), 'devdeck-demo-home');
const REPOS = join(HOME, 'Documents', 'GitHub');
const CLAUDE = join(HOME, '.claude', 'projects');
rmSync(HOME, { recursive: true, force: true });
mkdirSync(REPOS, { recursive: true });
mkdirSync(CLAUDE, { recursive: true });

const NOW = Date.now();
const DAY = 86_400_000;
const encode = (p) => p.replace(/[:\\]/g, '-');
const iso = (daysAgo, h = 14, m = 30) => new Date(NOW - daysAgo * DAY + (h * 60 + m) * 60_000 - 12 * 3600_000).toISOString();
const uuid = (n) => `a0b1c2d3-e4f5-6789-abcd-ef01234567${String(n).padStart(2, '0')}`;

function git(repo, args, dateIso) {
  const env = { ...process.env, GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso,
    GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
  execFileSync('git', args, { cwd: repo, env, stdio: 'ignore' });
}

// model + token helpers for usage data
const asst = (model, tsIso, input, output, cacheR = 0) => JSON.stringify({
  type: 'assistant', timestamp: tsIso,
  message: { model, usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: Math.round(input * 0.3), cache_read_input_tokens: cacheR } },
});
const user = (text) => JSON.stringify({ type: 'user', message: { content: text } });

// stale days chosen for a balanced traffic-light spread (fresh<1, neutral<3, warn<7, else neglected).
// usageDaysAgo clustered in the last week for a clean Usage chart (decoupled from deck staleness).
const PROJECTS = [
  { name: 'acme-dashboard', branch: 'main', stale: 0, dirty: 3,
    commit: 'feat(ui): dark mode toggle + theme persistence',
    sessions: [{ first: 'scaffold the settings page', cue: 'add a dark mode toggle to the settings page', model: 'claude-opus-4-8', usageDaysAgo: [0, 1] }] },
  { name: 'payments-api', branch: 'feat/refunds', stale: 0, dirty: 1,
    commit: 'feat(refunds): partial refund endpoint',
    sessions: [
      { first: 'design the refund data model', cue: 'write integration tests for the refund flow', model: 'claude-opus-4-8', usageDaysAgo: [1, 2] },
      { first: 'add idempotency keys', cue: 'handle the double-charge edge case', model: 'claude-sonnet-4-6', usageDaysAgo: [3] },
    ] },
  { name: 'portfolio-site', branch: 'main', stale: 2, dirty: 0,
    commit: 'content: add case studies section',
    sessions: [{ first: 'set up the project', cue: 'make the hero section responsive on mobile', model: 'claude-sonnet-4-6', usageDaysAgo: [2, 4] }] },
  { name: 'ml-pipeline', branch: 'develop', stale: 5, dirty: 7,
    commit: 'perf: batch the feature extraction',
    sessions: [
      { first: 'load the training data', cue: 'debug the data loader OOM on large batches', model: 'claude-opus-4-8', usageDaysAgo: [3, 5] },
      { first: 'add a metrics dashboard', cue: 'why is validation loss diverging?', model: 'claude-sonnet-4-6', usageDaysAgo: [5] },
    ] },
  { name: 'design-system', branch: 'main', stale: 12, dirty: 0,
    commit: 'feat: Button + Input primitives',
    sessions: [{ first: 'init storybook', cue: 'document the Button variants in Storybook', model: 'claude-sonnet-4-6', usageDaysAgo: [4] }] },
  { name: 'mobile-app', branch: 'main', stale: 45, dirty: 2,
    commit: 'fix: token refresh on cold start',
    sessions: [{ first: 'set up navigation', cue: 'fix the login crash on Android 14', model: 'claude-haiku-4-5', usageDaysAgo: [6] }] },
];

let sid = 0;
for (const p of PROJECTS) {
  const repo = join(REPOS, p.name);
  mkdirSync(repo, { recursive: true });
  const d = iso(p.stale);
  git(repo, ['-c', 'init.defaultBranch=main', 'init'], d);
  writeFileSync(join(repo, 'README.md'), `# ${p.name}\n`);
  writeFileSync(join(repo, 'index.js'), `// ${p.name}\nconsole.log('${p.name}');\n`);
  git(repo, ['add', '-A'], d);
  git(repo, ['commit', '-m', p.commit], d);
  if (p.branch !== 'main') git(repo, ['checkout', '-b', p.branch], d);
  // leave N uncommitted changes
  for (let i = 0; i < p.dirty; i++) writeFileSync(join(repo, `wip_${i}.txt`), `work in progress ${i}\n`);

  // Claude sessions for this repo
  const sessDir = join(CLAUDE, encode(repo));
  mkdirSync(sessDir, { recursive: true });
  p.sessions.forEach((s, idx) => {
    const lines = [user(s.first)];
    s.usageDaysAgo.forEach((da, j) => lines.push(asst(s.model, iso(da, 10 + j), 38000 + j * 9000, 6000 + j * 1500, 120000)));
    lines.push(user(s.cue));
    lines.push(asst(s.model, iso(s.usageDaysAgo[s.usageDaysAgo.length - 1], 16), 22000, 4200, 90000));
    const file = join(sessDir, uuid(sid++) + '.jsonl');
    writeFileSync(file, lines.join('\n'));
    const ms = NOW - (p.stale + idx * 0.1) * DAY; // newest session = the project's staleness
    utimesSync(file, new Date(ms), new Date(ms));
  });
}

console.log('projects:', PROJECTS.length, '| sessions:', sid);
console.log(HOME);
