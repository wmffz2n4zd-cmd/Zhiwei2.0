# Install Zhiwei v2.03

[中文](../install.md) · [Back to Zhiwei](../../README.md)

## Prepare a fresh Linux host

These commands target Ubuntu 24.04 on x86-64 with systemd. Install Git, curl, Python 3, util-linux (`flock`), Caddy, Node.js 24 and npm. Install Codex CLI system-wide, for example with `sudo npm install -g @openai/codex`. The service searches `/usr/local/bin:/usr/bin:/bin` for Node and Codex. If your installation uses a different prefix, set the full `PATH` and, if needed, `CODEX_CLI_PATH` in `/etc/zhiwei.env`.

Choose a public hostname you control, point its DNS at this server, and allow inbound TCP 80 and 443. The examples assume the account `zhiwei`, the directory `/srv/zhiwei` and the service name `zhiwei.service` are available. For a host with an existing installation, read [Existing installations](#existing-installations) first.

In a fresh Bash session, download the tagged release and its locked Node dependencies as your normal user.

```bash
git clone --branch v2.03 --depth 1 https://github.com/wmffz2n4zd-cmd/Zhiwei2.0.git zhiwei-v203
cd zhiwei-v203
sha256sum --quiet -c MANIFEST.sha256
npm ci
node -v
flock --version
```

Copy the verified checkout and dependencies into the service directory. The code belongs to root. Only the four private state directories and the service account's home need to be writable by the service. Complete the CLI device sign-in using the account that should pay for model calls.

```bash
set -e
sudo useradd --system --user-group --create-home --home-dir /home/zhiwei --shell /usr/sbin/nologin zhiwei
sudo mkdir /srv/zhiwei
sudo cp -a . /srv/zhiwei/
cd /srv/zhiwei
sudo chown -R root:root /srv/zhiwei
sudo install -d -m 700 -o zhiwei -g zhiwei data runtime tmp workspaces
sudo -H -u zhiwei codex login --device-auth
sudo -H -u zhiwei codex login status
```

## Start private chat

Replace `chat.example.org` in the next command with your actual hostname. Setup writes `data/windows.local.json` with private permissions. The historical filename is also used on Linux. If your CLI account uses a different vision-capable model, edit `chatModel` in this file. The template selects `gpt-6.1-terra` with medium reasoning effort.

```bash
ZHIWEI_DOMAIN=chat.example.org
sudo -H -u zhiwei npm run setup -- "https://$ZHIWEI_DOMAIN"
sudo install -m 0644 scripts/ecs/zhiwei.service /etc/systemd/system/zhiwei.service
sudo systemctl daemon-reload
sudo systemctl enable --now zhiwei.service
sudo systemctl is-active zhiwei.service
curl -fsS -H "Host: $ZHIWEI_DOMAIN" http://127.0.0.1:3790/ > /dev/null
curl -sS -o /dev/null -w '%{http_code}\n' -H "Host: $ZHIWEI_DOMAIN" http://127.0.0.1:3790/api/pwa/me
```

A healthy Hub serves the home page, and the last command prints **401** for a visitor. For a startup failure, inspect `sudo journalctl -u zhiwei -n 60`. Model sign-in belongs to the service user, including when troubleshooting.

## Enable HTTPS and invite a friend

Install the supplied Caddy site fragment. In the first editor, replace the entire site address `{$ZHIWEI_HOST:localhost}` with your hostname. In the second, add one top-level line, `import /etc/caddy/zhiwei.caddy`, alongside any existing sites. The fragment proxies the PWA to loopback port 3790. Keep the developer interface on loopback port 3789.

```bash
sudo install -m 0644 deploy/Caddyfile /etc/caddy/zhiwei.caddy
sudoedit /etc/caddy/zhiwei.caddy
sudoedit /etc/caddy/Caddyfile
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
curl -fsS "https://$ZHIWEI_DOMAIN/" > /dev/null
curl -sS -o /dev/null -w '%{http_code}\n' "https://$ZHIWEI_DOMAIN/api/pwa/me"
```

The public check should again return **401** for the signed-out visitor. Issue an invitation from the checkout. The command prints a secret link with a single-use token, valid here for 24 hours.

```bash
sudo -H -u zhiwei npm run --silent invite -- \
  --database data/pwa/pwa.sqlite --origin "https://$ZHIWEI_DOMAIN" --role friend --hours 24
```

Send the link privately to its intended recipient. They open it over HTTPS, choose their account and password, and can then start chatting. A new invitation creates a new identity. Shared space posts and comments are visible to signed-in members of the instance. Works delivered in chat belong to their recipient. On iPhone, add the PWA to the Home Screen before enabling notifications, and grant permission when prompted.

## Install the browser and check interactive works

Install the Chromium build matched to the locked Playwright dependency. Use the cache path below so systemd and the offline worker use an accessible, stable location. Run this section after the Hub starts and before inviting people to test self-written pages.

```bash
cd /srv/zhiwei
BROWSER_CACHE=/var/cache/zhiwei-browsers
sudo env PLAYWRIGHT_BROWSERS_PATH="$BROWSER_CACHE" node node_modules/playwright-core/cli.js install --with-deps chromium
BROWSER=$(PLAYWRIGHT_BROWSERS_PATH="$BROWSER_CACHE" node -p "require('playwright-core').chromium.executablePath()")
test -x "$BROWSER"
sudo install -d -m 0755 /etc/systemd/system/zhiwei.service.d
printf '[Service]\nEnvironment=PLAYWRIGHT_BROWSERS_PATH=%s\n' "$BROWSER_CACHE" | sudo tee /etc/systemd/system/zhiwei.service.d/browser.conf > /dev/null
sudo python3 scripts/ecs/creative-program-service.py start --persistent \
  --source "$PWD" --node "$(command -v node)" --dependencies "$PWD/node_modules" \
  --browser "$BROWSER" --client-group zhiwei
sudo systemctl daemon-reload
sudo systemctl restart zhiwei.service
sudo -H -u zhiwei npm run check:runner
```

The check actually opens a page, clicks twice and verifies three screenshots as the Hub user. In a private chat, ask for a page with a day/night button, download the HTML and try it offline. The systemd worker runs each job under a separate identity and filesystem with private networking. The Hub detects its Unix socket. With the socket absent, the website tool can still render a layout from a specification.

## Optional capabilities

- **Reading.** The installed Chromium supports the read-only browser. Public-topic keywords go to Xiaohongshu. The Hub can follow a link offered by a public article. If a site requires sign-in, use the local `/world` interface on port 3789 via an authenticated SSH tunnel and a GUI session accessible to the service account. The website opens its own login window. X can read known posts with a separately configured `world.xBrowser` profile. Give that profile its own absolute directory, separate from the default site's profile and snapshots.
- **Activity and allowances.** The installation enables learning, private thoughts and shared space. Background planning (`life.planning.enabled`) and autonomous reading start off. Enable planning in `data/windows.local.json` and restart to use proactive planning. The local `/world` page toggles autonomous reading. `runtimeBudget.mode: "observe"` records usage. The deployment account supplies the allowance. Drawing also requires an account and model with the CLI image-generation tool.
- **Bilibili video.** Video capture is opt-in. The session-backed route requires Linux, a working Chromium sandbox and a dedicated private directory under the service user's `~/.local/share/zhiwei-video-sessions/bilibili`. The parent and site directory must both be owned by that user, mode 0700. Set `video.enabled` to true, `video.platforms` and `video.sessionBrowser.platforms` to `["bilibili"]`, and `video.sessionBrowser.executablePath` to the full path printed by `printf '%s\n' "$BROWSER"`. Restart after changing configuration. The worker probes dependencies at startup, and reports site restrictions or missing evidence when it cannot read the video.

## Existing installations

For an earlier QQ v2.0 deployment, take a consistent backup of its application, private configuration, full data/media and account state before any changes. Keep the working installation available and install v2.03 on a separate host or VM for the first trial. A same-host trial needs its own service account/home, checkout, writable directories, systemd unit, hostname, free Hub/PWA ports (`PORT` and `pwa.port`) and matching proxy target. If using both runners, also assign separate unit names and `ZHIWEI_CREATIVE_RUNNER_SOCKET`.

Use a new invitation to test registration, a normal reply, media and a downloaded work. Setup refuses to overwrite old settings. This release supplies a fresh PWA setup. Transferring historical identities or QQ memories requires a separately verified migration and backup. The SQLite utility in `scripts/pwa-backup.mjs` covers the PWA database only. Keep media, memory, configuration, service-owned credentials and the rest of the instance data in your protected backup.
