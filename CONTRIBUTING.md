# Contributing to DevDeck

## Development

Use Node.js 24 LTS (`.nvmrc`) and Git. CI reads the same version file. In a clean checkout:

```sh
npm ci
npm run build
npm test
npm run check:docs
```

Use `npm ci` rather than updating the lockfile implicitly. Dependency upgrades should be reviewed separately from behavior changes, particularly test-runner major versions. If an older npm crashes internally during lockfile resolution, use the npm bundled with the supported Node toolchain; do not delete the lockfile or apply `audit fix --force` blindly.

## Changes and regression evidence

For a bug fix, describe the observed user-visible failure and add a regression that would fail on the previous version. Check both the screen and committed disk state. A passing unit test count alone is not release acceptance.

| Area | Required checks |
| --- | --- |
| Tasks or persistence | stale-client conflict, disk failure, retry, restart, allowlist/permission checks |
| Settings | pending state, failed save rollback, invalid input, retry, repeated navigation |
| Async views | response order inversion and A → B → A machine changes |
| Link protocol | permissions, old/new client compatibility, real loopback TLS tests |
| UI | four locales, keyboard, narrow width, accessibility and actual Electron journeys |
| Packaging | packaged Windows regression scripts and all-OS CI builds |

Run GUI harnesses sequentially. `qa:maintenance` and `qa:resilience` use isolated profiles and fixture projects. Do not run QA against a user's current conversation. The older `qa:link` can launch installed real provider CLIs; it remains a supervised manual harness. `qa:perf` also requires the explicit `--allow-live-agents` flag and must not be run unattended. A future deterministic performance fixture is tracked in the backlog.

Task saves use `project:saveTodos` with an expected revision. Do not fall back to the unversioned method for compatibility: that would recreate silent data loss. Host and viewer must both support this protocol (1.37.8+). Conflicts require review; no automatic replay of a stale array.

## Pull requests

Include the changed behavior, regression command/results, compatibility impact and outstanding validation. Keep generated QA logs/screenshots in `qa/shots/` or CI artifacts, not in source control. Never commit credentials, pairing codes, private keys, personal transcripts or full diagnostic bundles.

Update [current documentation](docs/README.md) when behavior changes. Preserve dated reviews as historical evidence and add a new review instead of rewriting old test results. Publishing a tag is a separate release action, not an automatic consequence of a merged fix.
