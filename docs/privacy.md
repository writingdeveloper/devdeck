# Privacy and network boundaries

## What stays local by default

Authorized repository scanning, Git inspection, task/note storage, transcript indexing, local cost estimates and the Project Memory snapshot run on the machine that owns that data. DevDeck has no telemetry or project-operated relay service. A local cost estimate is not an invoice or a provider's finalized billing record.

## Explicit network-enabled behavior

| Feature | Data boundary |
| --- | --- |
| Update checks/downloads | Release metadata and binaries from the configured GitHub update provider |
| Supported provider usage checks | Provider-specific usage/authentication interfaces; computed usage is normalized for display |
| Starting/resuming a coding agent | The installed provider CLI has its own network and data policies; DevDeck cannot promise the agent stays offline |
| Optional AI session summaries | Off by default. Recent session activity is sent through that session's Claude or Codex CLI to generate a short label; this can use quota. The prompt caps the activity excerpt at 1,200 characters. Antigravity has no AI summary runner |
| DevDeck Link | Authorized project/session data and terminal input/output move directly between paired machines over pinned TLS. No project-operated relay |
| Link reachability setup | Host-mode networking can discover/configure the local gateway using NAT-PMP/UPnP; this is not a relay and can affect network reachability |

The optional AI summary is distinct from the heuristic summary and the on-demand Project Memory snapshot. Those local features do not require an AI call. Turning AI summaries off prevents queued new requests; an already running provider process is not represented as retroactively unsent.

## Storage and diagnostic sharing

State is stored under Electron's user-data directory. Saving uses a temporary file and replacement, with a best-effort `.bak` copy. Corrupt files may be preserved as `.corrupt`. These are recovery aids, not versioned encrypted backups. Operating-system account and disk protections still matter.

Diagnostics are local until a person copies or shares them. Logs can contain error details and paths; inspect and redact before attaching them to an issue. The task-conflict panel keeps the attempted change in renderer memory for review and copying; it is not a durable draft archive and is cleared on machine changes or app restart. Draft contents are not deliberately added to diagnostic messages.

## Terminal history is not a transcript archive

The visible terminal keeps up to 10,000 lines. Remote reconstruction uses a bounded 256 KiB replay buffer; resizing may invalidate output captured at another size. A reconnect is not a guarantee that all previous output survives. Persistent searchable history with retention and deletion controls is a separate backlog item.
