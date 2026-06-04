<div align="center">

<img src="build/icon.png" width="120" alt="DevDeck logo" />

# DevDeck

**A command deck for everyone juggling a pile of Claude Code projects.**

See every repo's state at a glance — git status, how long it's been neglected, your Claude session history — and jump back in with one click (`claude -c`).

![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Windows-0078D6)
![Built with Electron](https://img.shields.io/badge/Electron-31-47848F)
![Tests](https://img.shields.io/badge/tests-70%20passing-3fb950)

<img src="docs/demo/demo.gif" width="820" alt="DevDeck demo" />

</div>

## Why

If you run Claude Code across a dozen side projects, you lose the thread: *Which repos have uncommitted work? Which have I not touched in weeks? What was I even doing in that one?* DevDeck is a always-on desktop deck that answers those at a glance and gets you back into a session in one click — without touching your code or files.

## Features

- **🗂 Project deck** — every git repo under your folder as a card: branch, uncommitted count, last commit, Claude session count.
- **🚦 Staleness traffic-light** — fresh / warning / neglected, so dirty or abandoned repos surface themselves.
- **▶ One-click resume** — opens a terminal in the repo and runs `claude -c` (continue your last session) — or pick a specific past session.
- **↩ Resume cue** — auto-reads the *last thing you asked* in each project's newest Claude session and shows it in the note slot, so "where was I?" needs no typing. Click to adopt it as your note.
- **📝 Per-project notes** — jot your next todo; it sticks with the card.
- **📊 Usage analytics** — tokens, cache-hit rate, and an API-equivalent cost estimate, parsed locally from `~/.claude`.
- **📌 Pin / 🙈 hide / 🔎 search / sort** — keep the deck focused.
- **🌐 4 languages** — English, 한국어, 日本語, 中文.
- **🔒 Fully local & offline** — reads your `~/.claude` data and git, sends nothing anywhere (`connect-src 'none'`). No account, no telemetry.
- System tray + global shortcut (`Ctrl+Alt+D`), frameless Discord-style title bar.

<div align="center">
<img src="docs/screenshots/usage.png" width="600" alt="Usage analytics" />
</div>

## Install (Windows)

> ⚠️ **Early release (v0.1) — Windows only** for now. macOS/Linux are planned (see [Platform support](#platform-support)).

1. Download the latest **`DevDeck-win-x64.zip`** from [**Releases**](https://github.com/writingdeveloper/devdeck/releases/latest).
2. Extract it anywhere and run **`DevDeck.exe`**.
3. The build is **unsigned**, so Windows SmartScreen may warn: click **More info → Run anyway**.
4. Open **Settings** and point DevDeck at the folder that holds your git repos (defaults to `~/Documents/GitHub`).

## Platform support

| OS | Status |
|----|--------|
| Windows | ✅ Supported |
| macOS / Linux | ⏳ Planned — the terminal launcher is currently Windows-only (`wt.exe` / PowerShell). PRs welcome. |

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
