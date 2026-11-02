# Install (Ubuntu 24.04 x86_64)

> 中文: [docs/install.md](../install.md)

This release supports Ubuntu 24.04 / x86_64 only. A local machine, a virtual machine, or a cloud server all work; the recommended minimum is 2 vCPU / 4 GiB RAM / 20 GiB disk.

After installation, the machine runs three processes:

| Process | Role | Port |
| --- | --- | --- |
| Zhiwei Hub (this project) | Receives messages, manages memory, calls the model, schedules daily life | `127.0.0.1:3789` |
| NapCat | Logs in the bot QQ account and converts it to the OneBot protocol | `127.0.0.1:3000` (API), `127.0.0.1:6099` (WebUI) |
| Codex CLI | The model client that actually generates replies and executes tasks | None (subprocess) |

---

## 0. Prerequisites

1. **A dedicated QQ account for the bot**, added as a friend in both directions with your admin QQ. The bot account cannot be the same as your own account, and cannot be logged in on the mobile or desktop build at the same time.
2. **An account that can use Codex CLI**. The CLI makes model requests; charges and allowances follow the configured account and authentication method.
3. The server must be able to reach the network that QQ and the model service need. On networks in mainland China, reaching the model usually needs a proxy; see `codexProxy` in `../en/configure.md`.

---

## 1. System dependencies

```bash
sudo apt update
sudo apt install -y curl git unzip xvfb fonts-noto-cjk
```

`xvfb` is required only when the server has no graphical interface but NapCat / Chromium still have to run. `fonts-noto-cjk` is used for the Chinese text in screenshots.

## 2. Node.js 20 or later

Verified version: **Node v24.22.0**; minimum **20.10** (`npm test` uses `--test-concurrency`). NodeSource is recommended:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # must be >= 20
```

> Do not use the Node 18 that ships with Ubuntu: this project requires `>=20`, and startup fails outright below that version.

## 3. Choose the service user before logging in to Codex CLI

In an administrator terminal, create a regular service user and switch to it. Clone, initialize, log in to the CLI and run foreground checks as this same user. Skip creation if you already have a dedicated account:

```bash
sudo useradd -m -s /bin/bash zhiwei
sudo -iu zhiwei
```

Install the official Codex CLI and log in as this user:

```bash
codex --version
codex login          # follow the CLI authentication instructions
codex login status   # should show you are logged in
```

If `codex` is not on PATH, set `CODEX_CLI_PATH` to the executable (or to `bin/codex.js` inside the npm package). Login belongs to the current user's Codex configuration directory: do not log in as root and then switch the service to `zhiwei`. If you customize `CODEX_HOME`, use the same absolute path during login and in systemd. The CLI manages authentication; do not copy another user's login files.

## 4. Get the code and install dependencies

```bash
git clone https://github.com/wmffz2n4zd-cmd/Zhiwei2.0.git ~/zhiwei
cd ~/zhiwei
npm ci
```

If what you received is an archive:

```bash
tar -xzf zhiwei-2.0.0.tar.gz
cd zhiwei-2.0.0
npm ci
```

The only dependency is `playwright-core`, used for web browsing; it also starts without a browser installed, and only reading is unavailable.

## 5. Initialize the configuration

```bash
npm run setup -- --owner YOUR_QQ --bot BOT_QQ
```

It will:

- generate `data/local.json` (mode 600), containing an OneBot key pair **unique to this instance**;
- generate NapCat's `onebot11_<bot QQ>.json` (if `--napcat-dir` was given);
- create directories such as `runtime/` and `workspaces/remote/`.

`--napcat-dir /actual/NapCat/config/directory` is an optional output location that you must choose from your actual installation. The script does not discover NapCat or load configurations from arbitrary folders. If you first write into a staging directory, copy the generated `onebot11_<bot QQ>.json` into the directory that this NapCat instance actually loads, then reload it using NapCat's procedure. Alternatively, configure the two connections below manually in its WebUI. Preserve existing connections and check the replacement scope before overwriting them.

Other available options:

| Option | Description |
| --- | --- |
| `--chromium /usr/bin/chromium` | Specifies the browser; if not filled in, web reading is unavailable (life planning is unaffected) |
| `--qq-image-cache-root /actual/cache/directory` | Allowed QQ image-cache root; repeat for multiple directories. Filesystem roots are rejected. Without a root, image/static-sticker vision is unavailable while text chat still works |
| `--napcat-dir /actual/config/directory` | Writes OneBot configuration here; does not install or discover NapCat |
| `--no-life` | Turns off the life timeline (not recommended; it amounts to having only a chat bot) |
| `--force` | Backs up each existing main/NapCat configuration before replacing it; without this option, either existing target is refused. Backups and new files use mode600 |

Image-cache roots must match where your NapCat actually stores images and must be readable by the service user. For two roots, append `--qq-image-cache-root /actual/cacheA --qq-image-cache-root /actual/cacheB`. Do not allow an entire home directory or disk merely for convenience.

## 6. Install and log in to NapCat

Install the Linux build following the [official NapCat documentation](https://napneko.github.io/guide/boot/Shell). Historical upstream deployment records used NapCat `v4.18.41` + QQ NT `3.2.34`; this is not real-QQ acceptance evidence for this distribution. Without a desktop environment, you can use `xvfb-run`; replace the executable below with your actual installation path:

```bash
xvfb-run -a ~/Napcat/opt/QQ/qq --no-sandbox
```

On the first start, open the NapCat WebUI (default `http://127.0.0.1:6099`) and scan the QR code to log in the **bot** QQ account.

After logging in, confirm that "Network Config" has two connections. Generated configuration takes effect only after it is placed in the actual loaded directory and read by NapCat:

- HTTP Server `127.0.0.1:3000`, Token = `oneBotAccessToken` of `data/local.json`;
- HTTP Client `http://127.0.0.1:3789/api/onebot/event`, Token = `oneBotSecret` of `data/local.json`.

> When the server has no browser for opening the WebUI, use SSH port forwarding: `ssh -L 6099:127.0.0.1:6099 user@server`.

## 7. Start

Trial run in the foreground:

```bash
npm start
```

You should see the startup self-check. The program prints it in Chinese; this is the real output:

```
知微 chat hub: http://127.0.0.1:3789
知微配置：.../data/local.json（全部就绪）
  OK   管理员 QQ：...
  OK   OneBot 回调密钥：已配置
  ...
```

Any `TODO` item means the corresponding capability is unavailable; fill in what the hint says. The service itself still starts.

Open another terminal and run the health checks:

```bash
npm run check    # config only, does not start the service
npm run doctor   # also checks the QQ bridge and Codex CLI
```

## 8. Run persistently (systemd)

First stop the foreground Hub cleanly with `Ctrl+C` so two instances cannot write the same data. Render the unit in the service user's terminal; `$USER` and `$HOME` must identify the account used for CLI login:

```bash
node scripts/render-unit.mjs --dir "$PWD" --user "$USER" --home "$HOME"
```

systemd does not read interactive shell startup files. For a custom CLI path, authentication directory or PATH, copy `deploy/zhiwei.env.example` to `deploy/zhiwei.env`, fill in the actual absolute paths and run `chmod 600 deploy/zhiwei.env`. Available entries are `CODEX_CLI_PATH`, `CODEX_HOME` and `PATH`; omitted entries keep their defaults. Use `KEY=value`, without `export`, `$HOME` expansion or command substitution. The default unit optionally loads this file; select another location with `--env-file /absolute/path/zhiwei.env`. Rendering never creates or overwrites the environment file and does not copy credentials.

Back in an administrator terminal with sudo access, install the service (paths below assume the dedicated user is `zhiwei`):

```bash
sudo cp /home/zhiwei/zhiwei/deploy/zhiwei.service /etc/systemd/system/zhiwei.service
sudo systemctl daemon-reload
sudo systemctl enable --now zhiwei
sudo systemctl status zhiwei
journalctl -u zhiwei -f
```

The service runs as a regular user and listens only on `127.0.0.1`. **Do not expose port 3789 directly to the public internet.**

## 9. First conversation

Send a private message from your admin QQ to the bot:

```text
/帮助
/状态
```

Getting a reply means the chain is up. You can then chat normally; only what starts with `/` is a command.

---

## Common installation failures

| Symptom | Cause and fix |
| --- | --- |
| Startup reports `生活规划需要启用world...` | When `life.planning.enabled=true`, `world.enabled` must be `true`. Correct these switches in the existing configuration, then run `npm run check`; do not regenerate all settings and secrets to repair one switch |
| Callback returns 401 | The two Tokens are swapped. The server Token goes to NapCat's HTTP Server, the callback Token to the HTTP Client. |
| `npm run doctor` shows Codex CLI as pending | Check the actual service user, HOME/CODEX_HOME, CLI path and login status. An interactive shell can have a different environment from systemd; configure `deploy/zhiwei.env` if needed, then restart |
| QQ gets no reply | Check the bridge item of `npm run doctor` first, then check whether the log has a model timeout. |
| Port already in use, `EADDRINUSE` | A Hub is already running; stop the existing instance cleanly. Do not merely change the port and start a second instance sharing the same data |
| Life records show "中断" after the server sleeps or stalls | An observation gap longer than 2 minutes is judged an interruption. This is by design, not a crash. |

Next step: `../en/configure.md` to tune the configuration, `../operate.md` to learn day-to-day operations.
