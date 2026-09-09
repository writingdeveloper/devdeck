# Documentation map

The README describes the product. This directory separates current operating guidance from dated evidence and design history.

| Document | Purpose |
| --- | --- |
| [Quality and release checks](quality.md) | Required commands, isolated QA, release gates, evidence rules |
| [Privacy and network boundaries](privacy.md) | Local processing, optional AI calls, Link transport, diagnostics |
| [Maintenance review: 2026-09-08](quality-review-2026-09-08.md) | Changes in the 1.37.8 candidate and verification status |
| [Backlog](backlog.md) | Unfinished work, priority and acceptance criteria |
| [Contributing](../CONTRIBUTING.md) | Development setup and review requirements |
| [Security](../SECURITY.md) | Private vulnerability reporting and supported fixes |

## Historical evidence

[1.37.6 review](quality-review-1.37.6.md) and [1.37.7 review](quality-review-1.37.7.md) describe what was tested for those versions. Their test counts and audit results are dated observations, not claims about the present dependency database.

`releases/` contains version-specific release notes. `superpowers/plans/` and `superpowers/specs/` are historical design records; they are not the current backlog. Existing screenshots and demo media illustrate particular captured builds, not every current dialog.

Keep this index updated when adding a new current guide. Do not delete historical evidence or generated local release directories as part of routine documentation cleanup.
