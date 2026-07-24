# Backlog

## Antigravity programmatic usage status

Status: waiting for an official interface

Check the official Antigravity CLI documentation and release notes whenever DevDeck changes Antigravity support or prepares a release that updates supported CLI behavior. Look for a documented non-interactive usage interface such as `/usage --json`, a local API, or a public usage endpoint.

When an official interface exists:

- implement `AntigravityUsageProvider` against that interface;
- replace the `/usage` and `/credits` guidance card with real normalized meters;
- preserve the same all-provider usage overlay contract and error states;
- add parser, authentication-boundary, timeout, and UI tests;
- update README privacy and outbound-connection documentation.

Do not reverse-engineer Antigravity credentials, protobuf quota storage, or private endpoints.

Official references:

- [Model quotas (`/usage`)](https://antigravity.google/docs/cli/commands/usage)
- [AI credits](https://antigravity.google/docs/cli/credits)
