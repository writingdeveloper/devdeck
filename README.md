<div align="center">

<img src="build/icon.png" width="120" alt="DevDeck logo" />

# DevDeck

**A command deck for everyone juggling a pile of Claude Code & Codex projects.**

See every repo's state at a glance — git status, how long it's been neglected, your Claude Code and Codex session history — and jump back in with one click (`claude -c` / `codex resume`).

![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D6)
![Built with Electron](https://img.shields.io/badge/Electron-31-47848F)
![Tests](https://img.shields.io/badge/tests-358%20passing-3fb950)
![CI](https://github.com/writingdeveloper/devdeck/actions/workflows/ci.yml/badge.svg)

<img src="docs/demo/demo.gif" width="820" alt="DevDeck demo" />

</div>

## Why

If you run Claude Code across a dozen side projects, you lose the thread: *Which repos have uncommitted work? Which have I not touched in weeks? What was I even doing in that one?* DevDeck is a always-on desktop deck that answers those at a glance and gets you back into a session in one click — without touching your code or files.

## Features

- **🗂 Project deck** — every git repo under your scan locations as a card: branch, uncommitted count, last commit, AI session count.
- **➕ New project** — spin up a project without leaving the deck: pick a scan location, name it, and DevDeck creates the folder, runs `git init`, and opens it in a terminal with your active agent.
- **🤖 Multi-agent (Claude Code & Codex)** — choose your active agent; the deck shows that agent's sessions and **Open** launches it (`claude -c` / `codex resume`). A toolbar switcher appears when both CLIs are installed.
- **📂 Multiple scan locations** — point DevDeck at several folders to scan for repos, or add individual repos that live anywhere; each is auto-detected.
- **🚦 Staleness traffic-light** — fresh / warning / neglected, so dirty or abandoned repos surface themselves.
- **▶ One-click resume** — opens a terminal in the repo and continues your last session with the active agent (`claude -c` / `codex resume`) — or pick a specific past session.
- **🖥 Cockpit (embedded terminals · Windows)** — on Windows, **Open** drops you straight into an in-app terminal instead of a pile of external windows. A searchable session list shows each session's **live status** — working (spinner) / awaiting-you / idle — and floats the ones needing you to the top, with a count badge on the 🖥 icon (and an optional **tray icon alert**, off-by-default-able) so you can see "who's waiting on me" from any view. Each session shows its **model and active working time**, and you can **name** sessions and run **several per repo**. The live agent terminal + branch · agent status bar fill the right, with selection **copy (Ctrl+C) / paste (Ctrl+V)** that doesn't clash with the agent's own Ctrl+C interrupt. Running 10+ projects no longer means a wall of shrinking tabs you have to click through to see which finished. Your open sessions are **remembered across restarts** — after a quit or crash the cockpit lists them as one-click **restorable** entries (re-attaching via `claude -c` / `codex resume`). You can run **several sessions in the same repo at once** — a **+ New session** button forks another conversation; each is tracked separately and you can **name it** (double-click the name) so you remember what each one is doing. (macOS/Linux keep opening your external terminal.)
- **↩ Resume cue** — auto-reads the *last thing you asked* in each project's newest session (Claude or Codex) and shows it in the note slot, so "where was I?" needs no typing. Click to adopt it as your note.
- **📋 "Next" view** — every project's note (or resume cue) gathered into one cross-project "what's next" list.
- **↑ Unpushed signal** — commits ahead of your remote, flagged on the card so unprotected work stands out.
- **{ } Open in editor** (VS Code) and **📁 open folder** straight from a card; the deck **auto-refreshes in place** while it's open — only the cards that changed update, so there's no flicker as you work.
- **🐙 Jump to GitHub** — projects with a `github.com` remote show a GitHub icon; click it to open the repo page in your browser.
- **📝 Per-project notes** — jot your next todo; it sticks with the card.
- **📊 Usage analytics** — tokens, cache-hit rate, an API-equivalent cost estimate, and **active working-time** per project (real focused time, idle gaps excluded), parsed locally from `~/.claude`.
- **📌 Pin / 🙈 hide / 🔎 search / sort** — keep the deck focused.
- **☰ Card / list view** — toggle a dense one-line-per-project list to scan many repos at a glance; your choice is remembered.
- **🌐 4 languages** — English, 한국어, 日本語, 中文.
- **⬆ Auto-update** — checks GitHub Releases on launch and offers an in-app, user-confirmed download + restart (Windows/Linux; macOS pending code-signing).
- **🚀 Start on Windows login** — optionally launch DevDeck when you sign in (Windows only; opt-in in Settings).
- **🔒 Local-first** — reads your local agent data and git, and the renderer sends nothing anywhere (`connect-src 'none'`). The only outbound calls are to first-party endpoints: the GitHub update check, and — when you're signed into Claude Code — a usage check to `api.anthropic.com` (the same endpoint Claude Code itself uses) for the 5-hour / weekly bar. Your OAuth token stays in the main process and never reaches the renderer; if you're not signed in, no usage call is made. No account, no telemetry.
- System tray + global shortcut (`Ctrl+Alt+D`), frameless Discord-style title bar.

<div align="center">
<img src="docs/screenshots/usage.png" width="600" alt="Usage analytics" />
</div>

## Install

Grab the latest from [**Releases**](https://github.com/writingdeveloper/devdeck/releases/latest):

| OS | Download | First run (unsigned build) |
|----|----------|----------------------------|
| **Windows** | `DevDeck-…-Setup.exe` — or `DevDeck-…-win.zip` (portable, no installer) | SmartScreen → **More info → Run anyway** |
| **macOS** — Apple Silicon | `DevDeck-…-arm64.dmg` | Right-click the app → **Open** (Gatekeeper) |
| **macOS** — Intel | `DevDeck-…-x64.dmg` | Right-click the app → **Open** |
| **Linux** | `DevDeck-…-x86_64.AppImage` (portable) or `…-amd64.deb` | `chmod +x` the AppImage, then run |

Builds are **unsigned** (no code-signing certificate yet), so the first launch needs the bypass above. On Windows, if `Setup.exe` won't launch, use the **portable `…-win.zip`** instead — extract it anywhere and run `DevDeck.exe` (no installer involved). Then open **Settings** and add the folders that hold your git repos (defaults to `~/Documents/GitHub`); you can add several scan locations or pin individual repos.

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

DevDeck scans your configured **scan locations** for git repos (walking org/repo layouts, plus any individual repos you add), reads each repo's git state, and cross-references your AI coding sessions — Claude Code (`~/.claude/projects`) or Codex (`~/.codex/sessions`). Everything runs in the Electron main process and stays on your machine — DevDeck only *reads* your data and *launches* a terminal; it never edits your project files. New agents plug in behind one `AgentProvider` interface.

**Tech:** Electron 31 · TypeScript · esbuild · Vitest · electron-updater. Hardened renderer (context isolation, sandbox, strict CSP).

## Contributing

Issues and PRs welcome — especially **code-signing** (Windows/macOS), the top roadmap item: it removes the SmartScreen/Gatekeeper friction and unlocks macOS auto-update. This is an early project; expect rough edges.

## License

[MIT](LICENSE) © Si Hyeong Lee
