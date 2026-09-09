# Prioritized backlog

Updated 2026-09-08. The 1.37.8 maintenance candidate is not a published release. Implementation and evidence: [review](quality-review-2026-09-08.md).

| Priority | Work | Acceptance criteria |
| --- | --- | --- |
| P1 | Release validation | Same-commit all-OS CI and package gates; mixed-version task review; explicit publication decision |
| P1 | Deterministic performance and Link fixtures | No real providers by default; isolated homes/projects; verified workload and CPU samples; reproducible JSON; live-provider mode stays opt-in |
| P1 | Link settings failure handling | Cover host mode, machine name/port, permission and pairing edits under disk/network failures, duplicate clicks and repeated views |
| P1 | Network field validation | Sleep/resume, VPN address changes, disconnect/reconnect, host restart and extended two-PC use; do not substitute loopback assertions for field acceptance |
| P2 | Installer/updater journeys and signing | NSIS first install and upgrades preserve state; unsigned macOS manual-download guidance; evaluate signing/notarization |
| P2 | Persistent terminal history | Separate screen reconstruction from archive; bounded retention, deletion/export, redaction and visible gaps |
| P2 | Task operation API | Task-ID mutations after revision-checked baseline; explicit same-task conflicts and concurrent create/edit/delete/clear-completed checks |
| P2 | Note concurrency | Notes remain last-write-wins across devices; add revision checks while preserving drafts |
| P2 | Focused module extraction | Terminal lifecycle/rendering boundaries protected by regression tests; no rewrite solely for file length |

## Implemented in the candidate

Revision-checked task writes, legacy refusal, conflict review with retained attempted change, settings save rollback and inline validation, js-yaml/Vitest advisory fixes, Node24 CI, maintenance regression gates, fail-closed performance preconditions, and current documentation/maintenance configuration. See the candidate review for evidence and limits.

## Antigravity programmatic usage status

Status: waiting for an official interface; this maintenance pass did not re-evaluate provider interfaces.

Check official CLI documentation and release notes before changing Antigravity support. When a documented non-interactive usage interface exists, implement the usage provider, replace guidance with normalized meters, preserve independent provider errors/last-good data, and add parser, authentication-boundary, timeout and UI tests. Update network/privacy documentation at the same time.

Do not reverse-engineer Antigravity credentials, protobuf quota storage or private endpoints.

References: [Model quotas](https://antigravity.google/docs/cli/commands/usage), [AI credits](https://antigravity.google/docs/cli/credits).
