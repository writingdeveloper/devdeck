# Quality and release checks

## Repeatable checks

Use the Node.js version in `.nvmrc` and run from the repository root:

```sh
npm ci
npm run build
npm test
npm run check:docs
npm audit --audit-level=moderate
npm audit --omit=dev --audit-level=moderate
npm run qa:maintenance
npm run qa:resilience
npm run qa:audit
npm run qa
```

Run Electron harnesses sequentially. On headless Linux use `xvfb-run`; the multilingual window journeys also need a window manager (CI uses Openbox). Windows-only controls and native PTY checks are explicitly scoped to Windows.

`qa:maintenance` checks ordered threshold validation, settings rollback/retry, task revision conflicts and restart persistence, conflict draft review, and refusal of legacy unversioned task writes. `qa:resilience` covers the existing disk failure, machine switch, out-of-order responses and native-terminal cases. Unit integration tests also exercise two independently paired clients through real TLS on loopback.

Results and screenshots are written to `qa/shots/maintenance/` and `qa/shots/resilience/`. An abnormal Electron exit fails the harness even if the visible assertions passed. Automated accessibility, boundary checks and screenshots are not human visual approval.

## Manual harnesses

`qa:link` is a supervised two-app harness that may start installed provider CLIs. `npm run qa:perf -- 4 --allow-live-agents` is a manual Windows benchmark and explicitly opts into real-agent startup. Performance QA refuses missing terminals, invisible workload, incomplete streaming/repaint activity and missing CPU samples instead of treating low CPU as success. It has not become a deterministic CI performance gate; that conversion remains a separate task.

Do not run these against a live development conversation. Do not equate a short loopback test with sleep/resume, VPN changes or multi-day field validation.

## Release gates

CI builds/tests on Windows, macOS and Linux using Node.js 24. Linux runs accessibility and multilingual journeys. Windows/Linux run resilience and maintenance regressions. Pull requests additionally exercise packaging through the Release workflow without publishing.

Tagged publication waits for the reusable quality workflow and all OS packages. The actual unpacked Windows executable must pass both regression harnesses before assets are published. This verifies the packaged layout, not the NSIS installer wizard, OS trust dialogs, macOS signing/notarization or every in-place upgrade scenario.

A version bump or passing local checks does not publish a release. Record the exact commit, OS/toolchain, commands, counts, failures and skipped/manual scope in a dated review. Dependency audit results can change without a code change; the scheduled audit checks that case. See the [documentation index](README.md) for the current candidate review and historical evidence.
