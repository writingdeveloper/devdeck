# State ownership and consistency

This is the implementation/review contract for the 1.37.8 candidate. It is not a claim that every mutable field has already migrated to one state framework.

## Why locally correct code still failed in use

The viewer could update the host's PTY label while the host renderer explicitly ignored local-machine label announcements. Existing QA inspected host runtime metadata, not the host's visible title and disk record. A successful transport call was mistaken for a successful user journey.

Related paths treated cached session labels as authority when attaching, used bare conversation IDs across machines/providers/projects, and mixed live metadata into viewer-owned layout snapshots. Re-rendering an edit field could also trigger a blur-save. These are ownership, identity and lifecycle problems; changing a UI framework or adding more happy-path tests alone does not resolve them.

## Invariants

| Domain | Authority | Write rule | Read rule |
| --- | --- | --- | --- |
| Session title | Main process of the machine running the terminal | Permission + terminal incarnation + expected label revision; persist before publishing/acknowledging | All renderers, including the host, consume the owner snapshot. Drafts are separate. |
| Saved session membership and pins | Each viewer | Local persistence; overlay host-owned titles when reconciling local live sessions | Never send cached titles back merely because a viewer attached or restarted. |
| Project task list | Main process owning the project | Expected task revision; reject conflicts; no silent retry | Display returned snapshot; preserve unsaved attempted change. |
| Project notes/flags | Project-owning machine | Existing last-write-wins behavior | Not yet covered by title/task CAS guarantees. |
| Settings | Current PC | Await write; rollback or retain invalid draft with explicit feedback | No success state before persistence. Link settings still need broader failure coverage. |
| Terminal input/output | Host terminal | Ordered byte stream; do not turn every keystroke into a storage transaction | Screen replay is bounded and is not an archival transcript. |

A conversation is identified by **machine + normalized project path + provider + conversation ID**. A live terminal additionally has an opaque **incarnation ID**, regenerated when the terminal is recreated. A reused runtime path/counter is not the same terminal after restart. Windows drive/UNC paths compare case-insensitively; POSIX paths do not.

## Title write sequence

`explicit user commit → permission/identity/version check → disk save → runtime metadata update → session announcement → request response`

The implementation is in `src/main/sessionLabels.ts`; IPC/Link adapters call that one operation. The check/save portion has no asynchronous gap. A failed disk save does not update runtime metadata or send a successful announcement. A conflicting revision returns the committed snapshot. An old terminal incarnation cannot rename a new terminal with a reused runtime ID.

The renderer keeps an independent draft and base version. Save/Enter commits; Cancel/Escape discards the draft. Blur, focus changes and renderer reconciliation are never write consent. A peer's rename can update committed state while the user is still editing; it does not rewrite the draft. A deliberate retry after reviewing a conflict uses the latest known version.

`cockpit:renameSession` and `cockpit:persistSessions` are reply-bearing calls. Legacy unversioned title notifications are blocked. Stream commands such as input/resize retain their streaming behavior. Operation failures are distinct from unsupported methods so a storage failure is not mislabeled a version mismatch.

A timeout is an **unknown outcome**: the host might have committed before the reply was lost. Reconcile from the host; do not blindly repeat the command. A complete operation-ID/retry journal across all metadata is still future work.

## Snapshot order and recovery

Per-machine request epochs invalidate a pull when a newer pull, push or disconnect is observed. A queued obsolete result is not allowed to remove newly announced sessions. Label revisions reject a delayed reply that predates a newer committed title; incarnation IDs separate terminal lifetimes. These are local ordering guards, not a distributed event log.

On attachment/reconnection, the host's current label wins, including an explicit `null` clear. Saved membership may donate a local pin/tile identity, not an old title. Cached state does not grant remote permissions. Pairing display names and IDs come from bounded hello metadata, but authentication remains the pinned certificate plus the authorized pairing flow, never a self-reported machine name.

## Regression strategy

A bug fix needs a test that fails on the broken behavior and observes the final user result. For title synchronization the baseline fails with a host UI timeout in the three-app harness; the prior host-runtime-only assertion was insufficient.

- Unit/contract tests check ownership, scoped identities, CAS, stale replies, disk failure, permissions and legacy refusal. A seeded interleaving exercises three stale writers against a reference model.
- `qa:session-sync` launches an actual Windows host and two viewers, separate profiles/homes, a fixture Git repository and harmless fixture CLIs. It uses actual title controls and actual TLS, checks header/sidebar titles, on-disk records, no terminal remount, conflicts, storage failure, permissions, reconnect/restart and explicit clears. Router mapping is stubbed only in these isolated test processes.
- Existing maintenance/resilience tests remain required. The new multi-app harness also runs against the Windows package in the release workflow.

A green check is not physical two-PC field acceptance. Sleep/resume, VPN changes, unattended multi-day use, host restart under live provider workloads, installation/upgrades and human visual assessment still need separate evidence. See [the quality guide](quality.md) and [backlog](backlog.md).

## Review checklist for the next mutable feature

Identify its owner, identity dimensions and persistence boundary before adding UI. Decide whether failures/conflicts/unknown outcomes preserve a draft, revert a control, or need a read-back. Test two writers, a third observer, delayed replies, a screen switch, reconnect and restart. State explicitly which other machines should see the change and which local preferences must remain untouched. Add the invariant to the appropriate contract test and CI journey; do not treat a larger test count as a substitute.

References: [Electron request-response IPC](https://www.electronjs.org/docs/latest/tutorial/ipc), [Playwright user-visible testing](https://playwright.dev/docs/best-practices).
