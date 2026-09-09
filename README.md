<div align="center">

<img src="build/icon.png" width="104" alt="DevDeck logo" />

# DevDeck

**One workspace for your repositories and coding-agent sessions.**

See what needs attention, resume the right conversation, and work on a paired PC without screen sharing.

![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D6)
![CI](https://github.com/writingdeveloper/devdeck/actions/workflows/ci.yml/badge.svg)

[Install](#install) · [First session](#first-session) · [Across machines](#working-across-machines) · [Troubleshooting](#troubleshooting) · [Documentation](docs/README.md)

</div>

> **Candidate documentation:** this branch contains the unreleased **1.37.8 reliability candidate**, including confirmed session renames and task conflict protection. The [published releases](https://github.com/writingdeveloper/devdeck/releases/latest), not this version number or a green build, determine what users can install. Use matching updated builds on both machines for the new write protocol. See [the candidate review](docs/quality-review-2026-09-08.md) and [session synchronization review](docs/session-sync-review-2026-09-08.md).

<div align="center">
<img src="docs/screenshots/projects.png" width="820" alt="DevDeck project overview with repository and session navigation" />
</div>

*Screenshots illustrate previously captured builds; they are not acceptance evidence for every current dialog.*

## What it does

DevDeck is a local-first desktop command center for **Claude Code, Codex, and Antigravity**. It does not replace those tools or include their subscriptions.

| Need | DevDeck provides |
| --- | --- |
| Find work that needs attention | Shared sidebar for working/waiting sessions; Quick Open with `Ctrl+Shift+P`; recent projects |
| Resume without losing context | Provider-aware Open, existing terminal focus, previous-session restore, local Project Memory |
| Track a repository | Branch, dirty files, unpushed commits, activity, notes, project pin/hide and external actions |
| Plan and inspect usage | Cross-project tasks and calendar; local token/API-equivalent cost estimates; supported live provider limits |
| Use another PC | Opt-in DevDeck Link: the agent runs on the host; the viewer sends input and receives terminal output |
| Work in your language | English, 한국어, 日本語, 中文; responsive layout and keyboard-accessible controls |

Ordinary project analysis and Project Memory do not require an AI call. **Optional AI summaries and coding agents can contact their provider and consume usage.** DevDeck has no account service or telemetry. See [privacy and network boundaries](docs/privacy.md).

## Install

Download a build from [GitHub Releases](https://github.com/writingdeveloper/devdeck/releases/latest).

| Platform | Package | Local embedded terminal | Link host | Link viewer |
| --- | --- | --- | --- | --- |
| Windows x64 | `DevDeck-…-Setup.exe` | Yes | Yes | Yes |
| macOS Apple Silicon / Intel | `DevDeck-…-arm64.dmg` / `…-x64.dmg` | No; external Terminal.app | No | Yes |
| Linux | AppImage or `.deb` | No; supported external terminal | No | Yes |

Builds are currently unsigned. Verify that the file came from this repository before approving an OS trust prompt. Unsigned macOS builds do not have a supported automatic update-apply path; download a newer build manually. macOS may ask for Terminal automation permission. AppImage users may need to mark the downloaded file executable.

## First session

1. Install and sign in to a supported coding-agent CLI **on the machine that will run it**. DevDeck does not install or sign in to providers for you.
2. Open **Settings** and choose **Add scan root** to discover repositories underneath a folder, or **Add project folder** for one project. Project scanning starts only after you choose locations.
3. Open **Projects**, choose the intended provider in the Open control, and start or resume a session. On Windows the terminal appears in DevDeck; macOS/Linux use an external terminal for local work.
4. Use the sidebar to return to an existing session. Open **Project Memory** for its local resume snapshot, or **Tasks** to plan the next action.

A restored session whose provider conversation no longer exists may start fresh; DevDeck marks that condition instead of promising to reconstruct deleted provider history.

## Working across machines

The **host** owns the repository and runs the agent. The **viewer** displays it. Link transmits terminal output over **mutually authenticated TLS 1.3 over TCP**, not desktop video. This avoids video-encoding load; it does not promise zero CPU or GPU usage.

### Pairing

On the host, open **Settings → Machines → Create a connection code**. Paste that code into **Settings → Machines** on the viewer. Choose the host in the machine selector, then open one of its projects or focus a running session.

Use a trusted channel to transfer the code. It carries addresses and the certificate fingerprint, expires, and is single-use. Provider login and adding scan locations remain local-only. Each paired device has revocable permissions; host shutdown permission is separate and off by default.

Both machines must be reachable, for example on the same LAN, through an existing VPN/overlay network, or through an SSH tunnel. Link has no project-operated relay. Host mode is opt-in; it can attempt local-router port mapping and may require firewall approval. Check **Settings → Machines → Connection history** for the actual failure rather than assuming every connection problem is a firewall issue.

### What is shared, and what stays local?

| State | Owner and behavior |
| --- | --- |
| **Running session title** | Host-owned. Save title or Enter requests a confirmed write. Accepted changes appear on the host and other connected viewers. Concurrent edits show a conflict and keep your draft. Escape/Cancel uses the latest committed title. |
| Session pin, sidebar layout, selected view | Local to each viewer; another person's navigation should not rearrange yours. |
| Project tasks | Stored on the project-owning machine. Revision checks reject stale full-list writes and retain the attempted change for review. |
| Project notes and project pin/hide | Stored on the project-owning machine. Notes still use last-write-wins; they do not yet have task-style conflict protection. |
| Application settings | Belong to the PC whose Settings screen you are using. |
| Terminal screen | The host provides bounded recent output for reconstruction, not an unlimited durable archive. |

**Compatibility:** confirmed titles and task editing need compatible 1.37.8-or-newer builds on both ends. During candidate testing, use the same build, not an earlier candidate with the same version number. The app checks title-version support and refuses unversioned writes rather than silently treating a viewer-only rename as shared success. Titles of disconnected or ended sessions cannot be remotely committed.

Reconnecting reads the host's current title; it must not send an old cached title back. Clearing a custom title is an explicit change to the default project name, not an invitation to restore the old name. See [state ownership and consistency](docs/state-consistency.md) for the implementation contract and remaining gaps.

## Troubleshooting

| Symptom | Check or next action |
| --- | --- |
| No projects | Add a scan root or project folder **on the machine whose projects you want**. |
| Provider missing or login required | Confirm the CLI is installed and signed in on the host; viewer login is not host login. |
| Rename is rejected or stays in the editor | Check matching builds, connection and **control** permission. Review a conflict before saving again. A retained draft is not a committed title. |
| Two PCs show different notes/tasks | Confirm the selected machine. Tasks have conflict protection; notes do not yet. Refresh the relevant view; do not overwrite blindly. |
| Connection fails after sleep/network change | Check that the host is awake and host mode is enabled; inspect connection history and reconnect. Do not bypass a certificate mismatch. |
| Earlier terminal output is missing | Live scrollback is bounded; reconnect/resize can reconstruct only retained output. Consult the provider's own conversation history where available. |
| Settings will not save | Follow the inline error and retry after fixing the storage problem. Do not delete `state.json` as a first troubleshooting step. |

For a reproducible bug report, include **both app versions/builds**, host/viewer OS, the exact action sequence, expected vs actual results, and whether restarting or reconnecting changes it. Remove secrets from logs and screenshots. [Report a bug](https://github.com/writingdeveloper/devdeck/issues/new/choose); use [private reporting](SECURITY.md) for vulnerabilities.

## Build and verify

Use **Git and Node.js 24 LTS** (`.nvmrc`).

```sh
git clone https://github.com/writingdeveloper/devdeck.git
cd devdeck
npm ci
npm start
```

```sh
npm test
npm run build
npm run check:docs
npm run qa:maintenance
npm run qa:resilience
npm run qa:session-sync  # Windows: isolated host + two viewers, no paid provider
```

Run Electron harnesses sequentially. CI tests/builds all three operating systems, exercises multilingual UI and accessibility on Linux, and runs Windows metadata synchronization with isolated fixture CLIs. Release gates also run the actual packaged Windows executable. **Passing automated checks is not human visual acceptance, installer/upgrade acceptance, or multi-day real-network validation.**

Detailed commands, artifacts, remaining coverage and manual performance testing: [Quality guide](docs/quality.md). Architecture and future work: [State consistency](docs/state-consistency.md) · [Backlog](docs/backlog.md). Contribution rules: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Si Hyeong Lee
