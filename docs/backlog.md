# Prioritized backlog

Updated 2026-09-08. The 1.37.9 maintenance work was released on 2026-10-15. Implementation and evidence: [review](quality-review-2026-09-08.md).

| Priority | Work | Acceptance criteria |
| --- | --- | --- |
| P1 | Release validation | Same-commit all-OS CI and package gates; mixed-version task/title review; explicit publication decision |
| P1 | Deterministic performance and Link fixtures | No real providers by default; isolated homes/projects; verified workload and CPU samples; reproducible JSON; live-provider mode stays opt-in |
| P1 | Link settings failure handling | Cover host mode, machine name/port, permission and pairing edits under disk/network failures, duplicate clicks and repeated views |
| P1 | Network field validation | Sleep/resume, VPN address changes, disconnect/reconnect, host restart and extended two-PC use; do not substitute loopback assertions for field acceptance |
| P2 | Installer/updater journeys and signing | NSIS first install and upgrades preserve state; unsigned macOS manual-download guidance; evaluate signing/notarization |
| P2 | Persistent terminal history | Separate screen reconstruction from archive; bounded retention, deletion/export, redaction and visible gaps |
| P2 | Task operation API | Task-ID mutations after revision-checked baseline; explicit same-task conflicts and concurrent create/edit/delete/clear-completed checks |
| P1 | Remaining shared-metadata migrations | Apply the [ownership contract](state-consistency.md) to notes, project flags and Link settings; explicit failure/conflict UI and multi-observer QA |
| P2 | Focused module extraction | Terminal lifecycle/rendering boundaries protected by regression tests; no rewrite solely for file length |

## Implemented in 1.38.0

Reliable session close across paired PCs (answered remote close, offline closes delivered on reconnect, tombstones against re-adoption, `closed` exits), DOM terminal rendering, Apply update for Claude Code, versioned notes, Windows process-tree kill, Link pre-auth/notify/event hardening, scan performance and spinner CPU reduction, and the supervised `qa:close` harness. See the [release notes](releases/1.38.0.md).

## Implemented in 1.37.9

Revision-checked task writes, legacy refusal, conflict review with retained attempted change, settings save rollback and inline validation, js-yaml/Vitest advisory fixes, Node24 CI, maintenance regression gates, fail-closed performance preconditions, and current documentation/maintenance configuration. See the candidate review for evidence and limits.

## Antigravity programmatic usage status

Status: waiting for an official interface; this maintenance pass did not re-evaluate provider interfaces.

Check official CLI documentation and release notes before changing Antigravity support. When a documented non-interactive usage interface exists, implement the usage provider, replace guidance with normalized meters, preserve independent provider errors/last-good data, and add parser, authentication-boundary, timeout and UI tests. Update network/privacy documentation at the same time.

Do not reverse-engineer Antigravity credentials, protobuf quota storage or private endpoints.

References: [Model quotas](https://antigravity.google/docs/cli/commands/usage), [AI credits](https://antigravity.google/docs/cli/credits).

Session-title follow-up: confirmed host-owned renames, disk-before-ack, stale response guards, scoped session identity, explicit draft commit/cancel, cached-title read-only adoption and a three-app Windows CI/package harness are implemented. Full provider workload/physical-network soak tests and all-domain operation-ID retry deduplication remain unfinished. See [review](session-sync-review-2026-09-08.md).
