# Session title synchronization: 2026-09-08

Status: implemented in the unreleased 1.37.8 candidate on PR #33. This review extends the [earlier maintenance pass](quality-review-2026-09-08.md); it is not evidence that the installed/public 1.37.7 application has been replaced.

## Reproduced defect

Against baseline `b781754`, the new isolated three-app test could rename on a viewer and observe a change in host runtime metadata, but the host header/sidebar did not update. The first UI convergence assertion timed out. Baseline artifacts were retained locally at `qa/shots/session-sync-before/`.

The host renderer's `syncAdoptedLabel` explicitly excluded `LOCAL_MACHINE_ID`. The previous Link QA only checked `host.cockpit.liveSessions()` for the viewer-to-host direction, not the host's rendered title or on-disk state. The old rename API was fire-and-forget, so originating UI state also could not depend on an acknowledged commit.

## Changes

| Root cause | Candidate change |
| --- | --- |
| Host window treated itself as separate authority | Host and viewer windows consume the same host-owned title snapshots. |
| Successful send confused with successful save | Reply-bearing rename operation validates permission, terminal incarnation and label revision; writes disk before runtime/event/ACK. |
| Concurrent edits overwrite one another | Version conflict returns current owner state; separate edit draft is retained for explicit review/retry. |
| Re-render blur could implicitly submit a draft | Only Enter/Save title commits. Escape/Cancel discards; blur is not consent. |
| Old cached title overwrites current host on attach | Adoption is read-only; current host title wins, including explicit null clear. |
| Similar IDs mixed across machines/providers/projects | Shared scoped-identity helpers; saved-list, sidebar and restore matching use the proper scope. Id-less live terminals use their incarnation to adopt the exact saved tile. |
| Old pull/reply arrives after new information | Per-machine read epochs and monotonic title revisions reject obsolete results. Incarnations separate reused runtime IDs. |
| Old unversioned route bypasses the new transaction | Legacy title notifications are blocked; matching updated builds are required. |
| Failed handler mislabeled an unsupported method | Link operation failures have their own error code. |
| Paired display identity was lost | Pairing retains sanitized hello name/ID while keeping certificate/token authentication unchanged. |

The architecture and next-feature checklist are documented in [state consistency](state-consistency.md). This is a focused extraction of the shared metadata boundary, not a promise that replacing every renderer module would eliminate all future bugs.

## Evidence and release gate

`qa/session-sync.mjs` uses a real Electron host and two viewers, separate temporary homes/profiles, a fixture repository, harmless fixture CLIs and real TLS. Its assertions inspect actual title controls, header/sidebar text, saved lists and disk, not just transport responses. Router mapping is disabled in the test processes; user installations and live provider conversations are not used.

The new scenarios cover both rename directions and all observers, terminal identity preservation, simultaneous edit drafts and conflicts, actual host disk-save failure/retry, permission removal, offline/reconnect, explicit clear plus viewer restart, and repeated rename cycles. Existing maintenance and resilience suites remain required. Unit tests cover host transaction ordering, revisions, incarnation mismatches, id-less records, scoped collisions, stale reads and a seeded multi-writer model.

Windows CI runs the new multi-app harness. The release workflow must run it again using the packaged Windows executable before publication. `check:docs` additionally checks current-document links, local screenshot references and heading anchors, and verifies that the regression gates exist.

Exact final counts, source/package results and same-commit GitHub check URLs are recorded in the PR verification comment. Never reuse an older passing run as evidence for a newer commit.

## README and remaining work

The README now starts with installation/first-session instructions and a platform matrix. It distinguishes host-owned titles/tasks from local session pins/layout, explains matching-build compatibility and retained drafts, and provides a symptom/action troubleshooting table. It removes absolute zero-GPU wording and separates automated QA from human/field acceptance. Candidate status is explicit; screenshots are labeled as prior captured builds.

Not completed by this change: physical two-PC multi-day use, sleep/VPN variations, live-provider host-restart stress, installer/upgrader and signing journeys, persistent terminal archival history, note CAS, complete Link-settings rollback, and operation-ID retry journals for every metadata domain. These remain visible in the [backlog](backlog.md). New session-sync screenshots are automated evidence, not human visual approval.
