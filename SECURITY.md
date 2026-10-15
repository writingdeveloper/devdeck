# Security policy

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/writingdeveloper/devdeck/security/advisories/new) for security issues. Do not post exploit details, credentials, pairing codes, private keys, private project paths or transcripts in a public issue. Provide the affected version, operating system, affected boundary and a minimal reproduction using synthetic data.

Private reporting is for vulnerabilities. Ordinary UI bugs belong in the issue tracker with redacted evidence. No fixed response-time or bounty commitment is implied.

## Fix scope

Security fixes target the current development line and the next validated release; older versions are not maintained as separate backport branches. Install the latest validated release and review its notes. A clean dependency audit is a dated advisory-database result, not a guarantee of vulnerability absence.

## Boundaries

DevDeck is a local developer tool capable of launching terminal processes. Granting another device terminal control or spawn permission is powerful access, not a read-only screen share. Pair only devices you trust and revoke access when no longer needed. Link host mode is opt-in; direct peer connections use pinned certificates and per-device permissions. Native folder authorization and provider login remain local-only.

The application uses Electron isolation and path checks, but does not claim protection against a compromised operating-system account, malicious installed provider CLI or a user intentionally granting broad folder/session access. See [privacy and network behavior](docs/privacy.md), including the optional AI-summary exception to local processing.

Dependency checks run on pull requests and through a weekly scheduled audit; Dependabot proposes upgrades. The release workflow gates publication on tests and packaging. Windows/macOS builds are currently unsigned, and full installation/upgrade and code-signing work remains tracked in the backlog.
