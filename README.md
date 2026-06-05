<div align="center">

<img src="build/icon.png" width="120" alt="DevDeck logo" />

# DevDeck

**A command deck for everyone juggling a pile of Claude Code projects.**

See every repo's state at a glance — git status, how long it's been neglected, your Claude session history — and jump back in with one click (`claude -c`).

![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D6)
![Built with Electron](https://img.shields.io/badge/Electron-31-47848F)
![Tests](https://img.shields.io/badge/tests-101%20passing-3fb950)
![CI](https://github.com/writingdeveloper/devdeck/actions/workflows/ci.yml/badge.svg)

<img src="docs/demo/demo.gif" width="820" alt="DevDeck demo" />

</div>

## Why

If you run Claude Code across a dozen side projects, you lose the thread: *Which repos have uncommitted work? Which have I not touched in weeks? What was I even doing in that one?* DevDeck is a always-on desktop deck that answers those at a glance and gets you back into a session in one click — without touching your code or files.

## Features

- **🗂 Project deck** — every git repo under your folder as a card: branch, uncommitted count, last commit, Claude session count.
- **🚦 Staleness traffic-light** — fresh / warning / neglected, so dirty or abandoned repos surface themselves.
- **▶ One-click resume** — opens a terminal in the repo and runs `claude -c` (continue your last session) — or pick a specific past session.
- **↩ Resume cue** — auto-reads the *last thing you asked* in each project's newest Claude session and shows it in the note slot, so "where was I?" needs no typing. Click to adopt it as your note.
- **📋 "Next" view** — every project's note (or resume cue) gathered into one cross-project "what's next" list.
- **↑ Unpushed signal** — commits ahead of your remote, flagged on the card so unprotected work stands out.
- **{ } Open in editor** (VS Code) and **📁 open folder** straight from a card; the deck **auto-refreshes** while it's open.
- **📝 Per-project notes** — jot your next todo; it sticks with the card.
- **📊 Usage analytics** — tokens, cache-hit rate, and an API-equivalent cost estimate, parsed locally from `~/.claude`.
- **📌 Pin / 🙈 hide / 🔎 search / sort** — keep the deck focused.
- **🌐 4 languages** — English, 한국어, 日本語, 中文.
- **🔒 Fully local & offline** — reads your `~/.claude` data and git, sends nothing anywhere (`connect-src 'none'`). No account, no telemetry.
- System tray + global shortcut (`Ctrl+Alt+D`), frameless Discord-style title bar.

<div align="center">
<img src="docs/screenshots/usage.png" width="600" alt="Usage analytics" />
</div>

## Install

Grab the latest from [**Releases**](https://github.com/writingdeveloper/devdeck/releases/latest):

| OS | Download | First run (unsigned build) |
|----|----------|----------------------------|
| **Windows** | `DevDeck-0.3.0-Setup.exe` | SmartScreen → **More info → Run anyway** |
| **macOS** — Apple Silicon | `DevDeck-0.3.0-arm64.dmg` | Right-click the app → **Open** (Gatekeeper) |
| **macOS** — Intel | `DevDeck-0.3.0-x64.dmg` | Right-click the app → **Open** |
| **Linux** | `DevDeck-0.3.0-x86_64.AppImage` (portable) or `…-amd64.deb` | `chmod +x` the AppImage, then run |

Builds are **unsigned** (no code-signing certificate yet), so the first launch needs the bypass above. Then open **Settings** and point DevDeck at the folder that holds your git repos (defaults to `~/Documents/GitHub`).

## Platform support

| OS | Status |
|----|--------|
| Windows | ✅ Supported — Windows Terminal / PowerShell. Installer provided. |
| macOS | ✅ Supported — opens Terminal.app via `osascript`. `.dmg` provided (arm64 + x64). Launcher logic + AppleScript are validated on real macOS CI runners; GUI hardware-testing & signing still pending — feedback welcome. |
| Linux | ✅ Supported — auto-detects `gnome-terminal` / `konsole` / `alacritty` / `kitty` / `xterm` (and `x-terminal-emulator`). AppImage + `.deb` provided. |

> Every release is built **and** unit-tested on real Windows, macOS, and Linux GitHub Actions runners; the macOS `.dmg` is produced on a genuine Mac runner.

## Build from source

```bash
git clone https://github.com/writingdeveloper/devdeck.git
cd devdeck
npm install
npm start          # build + launch
npm test           # run the test suite (Vitest)
npm run dist       # package to release/win-unpacked  (needs Windows Developer Mode for a clean run)
```

## How it works

DevDeck scans one level of git repos under a base folder, reads each repo's git state, and cross-references Claude Code's session history in `~/.claude/projects`. Everything runs in the Electron main process and stays on your machine — DevDeck only *reads* your data and *launches* a terminal; it never edits your project files.

**Tech:** Electron 31 · TypeScript · esbuild · Vitest. Hardened renderer (context isolation, sandbox, strict CSP).

## Contributing

Issues and PRs welcome — especially **macOS/Linux launcher support**, which is the top item on the roadmap. This is an early project; expect rough edges.

## License

[MIT](LICENSE) © Si Hyeong Lee
