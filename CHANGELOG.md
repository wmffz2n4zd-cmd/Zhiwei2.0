# Changelog

Release-level changes only. The upstream project's per-session engineering log is not distributed with this release.

## 2.0.0

First release packaged for public deployment. Target platform Ubuntu 24.04 x86_64. Licensed under **MIT** (see `LICENSE`).

Capabilities (relative to upstream Codex Remote Contact):

- **Private chat only**: group messages are dropped before they reach the model, and the sender blocks group APIs as well; `qqPrivateOnly` cannot be turned off.
- **Life timeline**: thought / plan / activity state machine, append-only hash-chained event log, single-writer lock, no replaying downtime and no re-running finished activities after a restart.
- **Personal state**: three-axis mood (3-hour half-life) and long-term interests (30-day half-life), both projected deterministically from committed events.
- **Life planning**: low-frequency model planning per Beijing day; empty days, abandoned and failed plans are valid outcomes. Reconsideration intervals remain; observe mode disables cumulative daily call caps.
- **Proactive contact**: driven by a contact-type activity, bounded by quiet hours, relationship age, a reconsideration interval and do-not-disturb.
- **Reply coordination**: one `*` status line while busy, at most one merged catch-up reply afterwards, duplicate-message suppression.
- **Memory and profile**: per-contact unified memory, recent context (up to 3 turns within 2 hours), keyword recall.
- **Split replies**: one generation becomes up to three sequential messages on blank lines; each segment is re-checked, and a partial failure never resends the delivered prefix.
- **Web reading**: dedicated browser profile, site allow-list, read-only mode, login-page detection.
- **Read-only observer**: 1/7-day statistics, source expansion, daily JSON export.
- **Usage observe mode**: `observe` by default — recorded, never blocked.

Distribution changes relative to upstream:

- `data/local.json` is the standard configuration file (the legacy `data/windows.local.json` is still read), plus `ZHIWEI_CONFIG`.
- New startup self-check printing readiness for account, bridge, channel, timeline, planning, reading and usage mode.
- New `npm run setup` initialiser and `scripts/render-unit.mjs` service-unit renderer.
- Setup accepts repeatable image-cache roots and protects existing main/NapCat configurations with explicit overwrite and backup handling.
- systemd can load an optional environment file for the CLI path, authentication directory and PATH; login remains under the actual service user.
- Runtime images, credentials, temporary memory writes and service environment files are excluded from Git; privacy and backup documentation distinguishes local storage from model inputs.
- New `scripts/status.mjs` and `bin/zhiwei` read-only status entry point.
- Removed the macOS-only page assumptions; the console now links to a Linux QQ setup page.
- Removed upstream Windows launchers, the private ECS deployment toolchain, the real-model evaluation scripts and their private data.
- `allowFullAccessTasks`, `allowOtherPrivateChats` and the autonomous browsing timer are off by default.

## Not included

- Video understanding, voice messages, QQ Zone activity.
- Anything group-chat related.
- Claims of Windows / macOS / ARM support.
