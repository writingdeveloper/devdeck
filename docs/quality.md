# Quality and release checks

## Repeatable checks

Use the Node.js version in `.nvmrc` and run from the repository root:

```sh
npm ci
npm run build
npm test
npm run check:docs
npm audit --audit-level=high
npm audit --omit=dev --audit-level=moderate
npm run qa:maintenance
npm run qa:resilience
npm run qa:session-sync
npm run qa:audit
npm run qa
```

Shipped dependencies are held to moderate. The full tree, including build and test tools, is held to high: electron-builder (through `roarr`) and Vitest (through `sprintf-js`) carry moderate advisories that have no fixed release yet.

Run Electron harnesses sequentially. On headless Linux use `xvfb-run`; the multilingual window journeys also need a window manager (CI uses Openbox). Windows-only controls and native PTY checks are explicitly scoped to Windows.

`qa:maintenance` checks ordered threshold validation, settings rollback/retry, task revision conflicts and restart persistence, conflict draft review, and refusal of legacy unversioned task writes. `qa:resilience` covers the existing disk failure, machine switch, out-of-order responses and native-terminal cases. Unit integration tests also exercise two independently paired clients through real TLS on loopback.

Results and screenshots are written to `qa/shots/maintenance/` and `qa/shots/resilience/`. An abnormal Electron exit fails the harness even if the visible assertions passed. Automated accessibility, boundary checks and screenshots are not human visual approval.

## Manual harnesses

`qa:link` is a supervised two-app harness that may start installed provider CLIs. `qa:close` is a supervised two-app harness for the session close lifecycle (remote, offline, refused and bulk close, adoption focus, restart, Apply update); it starts the installed `claude` CLI in a throwaway repository and sends no prompts. `npm run qa:perf -- 4 --allow-live-agents` is a manual Windows benchmark and explicitly opts into real-agent startup. Performance QA refuses missing terminals, invisible workload, incomplete streaming/repaint activity and missing CPU samples instead of treating low CPU as success. Its CPU percentages are for a person to read, not for CI.

The CI performance gate is `qa:perf-gate` (Windows, every push): a fixture agent instead of a real one, and units that do not depend on the runner's speed — running CSS animations and DOM mutation records on an idle deck (both must be ~0), DOM mutations outside the terminals while two tiles repaint at 10fps (a per-chunk sidebar rebuild is ~8,000 against a limit of 400), and the main process's longest event-loop stall while working and while 20,000 lines stream. Each limit was checked by injecting the regression it guards against: an infinite CSS animation, a sidebar render per PTY chunk, and a 700ms synchronous block in the main process all fail it. Results go to `qa/shots/perf-gate/results.json`.

`qa:images` (Windows) drives the cockpit image strip, full-size viewer and 📎 attach against an isolated home holding a transcript with a tool screenshot, a pasted image and a written image file; its fixture `claude` echoes what it is sent, so an attached path is read back off the terminal. `qa:update` (Windows) checks "Update all": a fixture `claude` prints Claude Code's failed-update footer, and the harness asserts that `claude update` ran with no session process alive and that every conversation was resumed by id. `qa:images-remote` (Windows) pairs a host and a viewer over real TLS and checks the same from the viewer: thumbnails and the full view cross the link, an attached JPEG lands on the host as PNG with the host path typed, and a non-image named `.png` or an unindexed id is refused over the link. None of these starts a real agent.

Do not run these against a live development conversation. Do not equate a short loopback test with sleep/resume, VPN changes or multi-day field validation.

## Release gates

CI builds/tests on Windows, macOS and Linux using Node.js 24. Linux runs accessibility and multilingual journeys. Windows/Linux run resilience and maintenance regressions. Pull requests additionally exercise packaging through the Release workflow without publishing.

Tagged publication waits for the reusable quality workflow and all OS packages. The actual unpacked Windows executable must pass maintenance, resilience and three-app session synchronization harnesses before assets are published. This verifies the packaged layout, not the NSIS installer wizard, OS trust dialogs, macOS signing/notarization or every in-place upgrade scenario.

A version bump or passing local checks does not publish a release. Record the exact commit, OS/toolchain, commands, counts, failures and skipped/manual scope in a dated review. Dependency audit results can change without a code change; the scheduled audit checks that case. See the [documentation index](README.md) for the current candidate review and historical evidence.

Official checkout/setup-node/artifact actions use verified Node24-native releases pinned to full commit SHAs. Dependabot can propose reviewed updates; build-tool Node selection and the action runtime are separate concerns.

## Shared state regression contract

`qa:session-sync` is the deterministic Windows host/two-viewer test. It uses temporary profiles, homes and repositories, real TLS, fixture CLIs instead of paid agents, actual title controls, on-disk checks, conflict/failure recovery and restart. Source and packaged Windows CI both run it; evidence is saved under `qa/shots/session-sync/`. Run it sequentially with other Electron tests.

Read [state consistency](state-consistency.md) before adding or changing shared metadata. The source of truth is the owner commit, not one renderer's optimistic value or a successful send. Tests must inspect the owner, writer, another observer and persisted result, including failure and restart. See [the synchronization review](session-sync-review-2026-09-08.md) for the red-to-green case.
