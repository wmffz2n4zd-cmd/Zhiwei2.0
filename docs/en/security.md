# Security and privacy boundaries

> 中文: [docs/security.md](../security.md)

This system is positioned as a **single-user, single-machine, private** deployment. Below is what is a design guarantee, what is only best-effort, and the pitfalls you may run into.

## 1. Trust boundary

- The Hub listens only on `127.0.0.1` and exposes no ports to the outside.
- It responds only to the private QQ accounts in `ownerUserIds`; group messages are discarded before they reach the model, and the send side separately blocks all group APIs.
- Outbound traffic includes message requests to NapCat, model requests made by Codex CLI, and web reads triggered manually or by life activities. Model inputs can include the current message, recalled private history, profile and images. Local persistence does not mean content never leaves the machine. This project has no additional telemetry channel.

**So: do not share this machine with people you do not trust, and do not expose 3789 to the public internet through a reverse proxy.**

## 2. Local HTTP has no authentication

This is the point you most need to know. Endpoints such as `/api/state`, `/api/maintenance`, and `/api/memory` **have no login credentials**; they rely on only two checks:

1. `Host` must be `localhost` / `127.0.0.1` (blocks DNS rebinding);
2. Write operations require a same-origin `Origin`.

Consequence: **any process on this machine that can make HTTP requests can read memory summaries and change channel switches**. Acceptable on a single-user server; not on a shared machine.

In addition, `/api/qq/event` is nominally "preview the reply, do not send", but it executes command side effects (for example, `/ban` writes to disk). Do not treat it as a purely read-only endpoint.

## 3. Secrets

| Location | Contents | Handling |
| --- | --- | --- |
| `data/local.json` | QQ number, two OneBot secrets | Permissions 600, ignored by `.gitignore` |
| `data/world/browser-profile/` | Website login cookies | Sensitive; equivalent to a password |
| Actual `CODEX_HOME` (default `~/.codex/`) | Model login and CLI session data | Authentication is managed by the CLI; keep it out of the repository and public backups |
| `napcat-data/` | QQ login state | Sensitive |

`napcat-data/` is only an example location; your NapCat installation determines the actual configuration, cache and login-state directories. Private images in `tmp/qq-images/` and output/diagnostics in `runtime/` are sensitive too, and should be excluded from Git alongside `data/`.

`npm run setup` generates independent secrets for each instance; there is no "default secret". If `data/local.json` leaks, change the two tokens and update the NapCat configuration to match; no reinstall is needed.

## 4. `/执行` and full access

- Ordinary `/执行`: Codex runs inside the `workspace` directory with `workspace-write`; each task requires `/确认` and is valid for 3 minutes.
- `/执行完全访问`: `danger-full-access`, able to read and write files outside the workspace and access the network. **Off by default** (`allowFullAccessTasks: false`). When enabled, the model can execute commands with the actual service user's system permissions; enable it only if you accept those consequences.

Input for both kinds of tasks comes from your own QQ private chat. **If you leak the admin QQ login elsewhere, an attacker can use it to execute commands on your machine.** This is the highest-privilege link in the entire chain.

## 5. Web reading is not a sandbox

The allowlist, download blocking, WebSocket blocking, and read-only POST described in `docs/architecture.md` are all **application-layer policies**, not operating-system isolation. The following still exist:

- Prompt injection through the text content of a malicious page (the model can see the page text, although tool calls are disabled on that path);
- Vulnerabilities in the browser itself;
- DNS rebinding (the code rejects private/reserved addresses, but that cannot replace network-layer isolation);
- Site redesigns that leave you "thinking you read it when you actually read a navigation page" (the code detects login pages and clears the body, but cannot cover every layout).

To make browsing safer, run it in a container or a separate network namespace rather than relying on the application-layer allowlist.

## 6. NapCat and QQ accounts

NapCat is a third-party, unofficial QQ protocol implementation that works by injecting into the QQ NT client. It is not in this repository and is not controlled by this project. Using it carries a real risk of **the account being risk-flagged or banned**; this project does not attempt any evasion and does not guarantee stability. Use a secondary account as the bot, not your main account.

## 7. Logs contain content

- `runtime/replies/*.txt`: raw model output (contains conversation content).
- `runtime/logs/cli-error-*.json`: CLI failure snapshots (may contain prompt fragments).
- `data/unified-memory.json`, `data/life/journal.jsonl`: the complete personal history.
- `tmp/qq-images/`: local copies of received images, not anonymous assets.

This is private data; treat it like a password. Do not paste raw content when filing an issue.

## 8. Supply chain

The only runtime dependency is `playwright-core` (Apache-2.0), version-locked by `package-lock.json` and installed with `npm ci`. Codex CLI, Node.js, NapCat, and Chromium are all installed by you; this repository does not bundle them.

## 9. Known issues that are not fixed

Listed plainly, so you do not have wrong expectations:

1. Local HTTP has no authentication (see section 2).
2. `/api/qq/event` nominally previews but actually executes command side effects.
3. `GET /api/platform` returns the admin QQ number.
4. `settings.json` is not written atomically; a parse failure silently falls back to defaults, and the next save may overwrite your custom entries.
5. When the process crashes, messages already ACKed but not yet persisted are lost (there is no inbound replay queue).
6. There is no single-instance lock: starting a second process on a different port writes the same `data/` concurrently, so be sure to run only one.
