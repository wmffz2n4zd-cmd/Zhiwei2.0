# Daily operations

> 中文: [docs/operate.md](../operate.md)

## 1. Start, stop, and status

```bash
sudo systemctl start zhiwei      # start
sudo systemctl stop zhiwei       # stop (waits for already-received messages to finish writing, up to 600 seconds)
sudo systemctl restart zhiwei    # restart (after an upgrade or configuration change)
sudo systemctl status zhiwei     # whether it is running, and the last few exits
journalctl -u zhiwei -f          # follow the logs
journalctl -u zhiwei --since "10 min ago"
```

Foreground debugging (works without installing the service):

```bash
npm start
```

Read-only status (does not invoke the model or send messages):

```bash
bin/zhiwei status     # channels, model, life, usage-allowance mode
bin/zhiwei doctor     # health check: account, bridge, CLI, timeline, browser
npm run check         # validate configuration only; run this first after editing data/local.json
```

The `/关机` command makes the Hub shut down cleanly (it requires sending `/确认关机` afterwards; `/取消关机` is possible within 60 seconds). It stops only the service, not the machine.

## 2. Where the logs are

| Location | Contents |
| --- | --- |
| `journalctl -u zhiwei` | Service stdout/stderr: startup self-checks, fatal errors, life-layer warnings |
| `runtime/logs/qq-timings.jsonl` | Per-message timings for preparation / model / sending; automatically rotated to `.previous` when it exceeds 2 MiB. **Contains no message bodies.** |
| `runtime/replies/*.txt` | Raw output from each Codex generation (local file, contains conversation content) |
| `runtime/logs/cli-error-*.json` | Diagnostic snapshot when the CLI fails (may contain prompt fragments; do not share it externally) |
| `tmp/qq-images/` | Received private image caches; sensitive content too |
| NapCat's own logs | Check the NapCat installation directory or journalctl |

## 3. Logging in again

**QQ**: NapCat's WebUI (default `127.0.0.1:6099`; on a server you need SSH forwarding):

```bash
ssh -L 6099:127.0.0.1:6099 user@server
# open http://127.0.0.1:6099 in a browser and scan the QR code to log in the bot account
```

Typically, the bot being offline shows up as no reply in private chat while the Hub still returns 200.

**Codex**:

Switch to the actual systemd service user and use the same HOME/CODEX_HOME and CLI path as `deploy/zhiwei.env`. Do not authenticate under another administrator or root account. Run these commands in the service user's terminal:

```bash
codex login          # follow the CLI authentication instructions
codex login status   # confirm
```

After login, run `sudo systemctl restart zhiwei` from an authorized administrator terminal. systemd does not inherit the interactive shell environment; a successful shell login still needs the unit's user and environment to match.

**Websites (X / Xiaohongshu)**: the Web browsing entry (`网页浏览`) on the Hub home page, or the `/world` page: click log in → scan the QR code manually → switch back to read-only when done. The login state is stored in `data/world/browser-profile/`; deleting it is equivalent to logging out.

## 4. Upgrading

```bash
sudo systemctl stop zhiwei
cd ~/zhiwei
git fetch --tags && git checkout <new tag>     # or unpack a new archive over the code
npm ci
node scripts/doctor.mjs                          # optional; check first whether the configuration needs additions
sudo systemctl start zhiwei
```

Back up first, then replace only version-controlled code. `data/`, `runtime/`, `tmp/` and the default remote-task workspace are Git-ignored runtime content, but can still live inside the repository directory. Do not upgrade by deleting the whole directory or cleaning untracked files. Preserve actual NapCat directories, custom workspaces and `deploy/zhiwei.env`; consult `configure.md` for new configuration items.

Rolling back works the same way: `git checkout <old version>`, `npm ci`, restart. **Do not** overwrite `data/` with an old backup to "roll back the code".

## 5. Backup and restore

Core application state is in `data/`: configuration, memories, profiles, life records, usage and default website sessions. `runtime/` contains raw model output/diagnostics, and `tmp/qq-images/` contains private images; include these if you need to preserve that history. Preserve `workspaces/remote/`, custom personas and `deploy/zhiwei.env` when used.

NapCat configuration/login state/original image caches, the actual Codex HOME/CODEX_HOME, and custom workspaces outside the repository need separate backups. `--napcat-dir` selects only configuration output and does not imply it contains all QQ login state. The example below is an application-directory backup, **not a full-machine or complete authentication backup**. Stop the Hub in an administrator terminal first; separately stop NapCat cleanly if backing up its writable directories. Then run this at the project root as the service user:

```bash
umask 077
mkdir -p "$HOME/zhiwei-backups"
backup_paths=(data)
for path in runtime tmp workspaces/remote deploy/zhiwei.env; do
  [ ! -e "$path" ] || backup_paths+=("$path")
done
tar -czf "$HOME/zhiwei-backups/zhiwei-$(date +%F-%H%M%S).tar.gz" "${backup_paths[@]}"
```

After checking archive contents, permissions and readability, have the administrator start the service. Backups contain credentials and private chats; keep them in a restricted directory outside the repository, never in public issues, Git commits or CI artifacts.

Before restoring, stop cleanly and preserve the current state, including chats added since the backup. Extract into a new private recovery directory and inspect contents, permissions and matching code/configuration versions. Restore the corresponding state as a whole: do not mix old/new `data/life/` files or overwrite the sole current copy. Restore external authentication directories separately to their original locations and owners; old backups do not prove those sessions are still valid.

The service must be stopped; otherwise you will double-write the same JSON/JSONL files as the running process.

## 6. Life read-only observer

A read-only page for viewing thoughts, activities, interest changes, and event sources for the last 1/7 days, with export of the current day's JSON. It does not advance time, does not call the model, and cannot be edited.

```bash
# on the server: access locally
curl http://127.0.0.1:3789/life-observer.html

# on your own computer: forward the port, then open
ssh -L 13789:127.0.0.1:3789 user@server
# open http://127.0.0.1:13789/life-observer.html in a browser
```

Each time the page loads, it fetches a one-time token from `/api/life-observer/session`; copying the URL to someone else does not work. It allows access only from loopback addresses and rejects requests carrying `X-Forwarded-*` — so do not put it behind a reverse proxy.

## 7. Memory and profile

| Command | Effect |
| --- | --- |
| `/记忆 <keyword>` | Look up the current subject's memories by keyword |
| `/记住 <content>` | Explicitly write one long-term memory |
| `/统一记忆状态` | View entry count and type distribution |
| `/清除统一记忆` → `/确认清除记忆` | Clear unified memory (irreversible) |

Memory is isolated by `qq:private:<QQ id>`. Profiles store explicitly stated names and preferences only. New self-reports can correct them, and explicit requests such as “忘掉我的称呼/偏好” withdraw them. Capacity is limited; there is no automatic habit learning or time-based fading. Withdrawing a profile fact does not delete ordinary chat history.

## 8. Troubleshooting order

1. `sudo systemctl status zhiwei` — whether the process exists.
2. `bin/zhiwei status` — what the Hub itself reports (channels, bridge, life).
3. `npm run doctor` — external dependencies (CLI login, NapCat, browser).
4. `journalctl -u zhiwei -n 100` — whether there is a crash stack.
5. The last few lines of `runtime/logs/qq-timings.jsonl` — whether a message is stuck in preparation, model, or sending.

For common cases, see `docs/faq.md`.
