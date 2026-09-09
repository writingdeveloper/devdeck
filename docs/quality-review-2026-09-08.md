# Maintenance review — 2026-09-08

Status: **1.37.8 candidate, not released**. Baseline: `83b27b3` / 1.37.7. Branch: `fix/reliability-docs-20260908`.

## Fixed and checked

The baseline review reproduced failed setting writes that appeared applied, invalid threshold values silently ignored, and stale task arrays overwriting earlier changes. The candidate waits for settings persistence before applying runtime effects, restores failed selections, shows pending/saved/error feedback, validates ordered positive whole-day values on both sides of IPC, and publishes only the latest completed settings read.

Tasks are saved with a persistent expected revision. The host compares and writes synchronously in one Store instance. A stale writer receives the current committed snapshot without writing. The UI shows the latest list and retains the attempted change for review; new-task text remains available for a deliberate retry. Two separately paired clients through real loopback TLS exercise the same Store behavior. This is not evidence of two-physical-PC field validation.

The protocol method changed to `project:saveTodos`, rather than appending an ignored argument to the old method. New viewers recognize hosts without revision metadata; new hosts refuse old `project:setTodos` calls with an update message. Both host and viewer need 1.37.8 or a later compatible version for task editing. Notes remain last-write-wins and are tracked separately.

`js-yaml` was updated from 4.3.1 to 4.3.2 and Vitest from 3.2.7 to 4.1.11. Full and production advisory checks must be rerun when preparing publication. Node24 is selected by `.nvmrc` for CI. No global Node/npm installation was changed.

Performance QA refuses absent/invisible terminals, missing CPU measurements, incomplete stream/repaint workload, and abnormal Electron exit. Its live-agent nature is explicit and requires an opt-in flag. This review does not claim to have measured a performance improvement or converted it to a deterministic benchmark.

## Evidence recorded so far

| Check | Result |
| --- | --- |
| Windows source build | Pass |
| Unit suite including validation, CAS and real TLS conflict | 108 files; 1,289 passed, 1 pre-existing skip |
| New maintenance Electron journeys | 5 passed, no unexpected renderer errors |
| Existing resilience Electron journeys | 9 passed, normal shutdown |
| Dependency audit after upgrades | 0 known vulnerabilities at time of check |
| Node.js 24.20.0 unit suite (Windows, temporary npx toolchain) | 1,289 passed, 1 pre-existing skip |
| Actual Windows 1.37.8 unpacked executable | Maintenance 5/5 and resilience 9/9 passed, normal exit |
| Current documentation checks | 8 documents, 21 local links and script/CI assertions passed |
| All-OS CI | Consult candidate PR/checks; local Windows results do not establish macOS/Linux results |
| Human visual acceptance, installer wizard, extended real network testing | Not performed by this review |

Evidence locations: `qa/shots/maintenance/`, `qa/shots/resilience/`, and CI artifacts. Full logs stay local/attached, not committed. Tests use disposable profiles and synthetic tasks. Autostart and paid-summary settings are tested only on the failing-save path, before any operating-system/provider side effect; QA does not enable them.

## Documentation and GitHub maintenance

Current documentation index, quality guide, privacy boundaries, contribution/security guidance and prioritized backlog were added. The static test-count badge was removed. Historical 1.37.6/1.37.7 review results are preserved and labeled as snapshots. README now documents optional provider-bound AI summaries rather than promising no outbound transcript data in every mode.

GitHub private vulnerability reporting was enabled and the API confirmed `enabled: true`. Bug-report and PR templates request redacted evidence and explicit regression/compatibility results.

Weekly advisory checks and Dependabot configuration only become active once present on the default branch. A version bump, branch push or PR does not publish a release; no release tag was created by this maintenance work.

## Next priorities

Finish publication gates and review; migrate manual performance/Link harnesses to deterministic fixtures; expand Link settings failure handling; validate real network sleep/resume; then address signing/updater journeys and persistent terminal archives. See [backlog](backlog.md).

## Official advisory/toolchain references

- [js-yaml advisory](https://github.com/advisories/GHSA-2883-xcg3-v3hh)
- [Vitest advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9)
- [Node release support](https://nodejs.org/en/about/previous-releases)
