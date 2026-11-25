# 安装知微 v2.03-r1

[English](en/install.md) · [返回项目首页](../README.zh-CN.md)

## 准备独立的 Linux 主机

下列命令以 Ubuntu 24.04 x86-64 和 systemd 为例。先安装 Git、curl、Python 3、util-linux（提供 `flock`）、Caddy、Node.js 24 和 npm。Codex CLI 需要让系统服务也能找到，例如执行 `sudo npm install -g @openai/codex`。服务在 `/usr/local/bin:/usr/bin:/bin` 查找 Node 和 Codex。如果安装位置不同，在 `/etc/zhiwei.env` 设置完整 `PATH`，需要时另设 `CODEX_CLI_PATH`。

选择自己控制的域名，将 DNS 指向这台服务器，并在防火墙和云安全组开放 TCP 80、443。示例使用系统账号 `zhiwei`、目录 `/srv/zhiwei` 和服务名 `zhiwei.service`。机器上若已运行旧实例，先看[已有实例](#已有实例)。

打开新的 Bash 会话，用普通用户下载带标签的发行版，核对清单并安装锁文件指定的依赖。

```bash
git clone --branch v2.03-r1 --depth 1 https://github.com/wmffz2n4zd-cmd/Zhiwei2.0.git zhiwei-v203
cd zhiwei-v203
sha256sum --quiet -c MANIFEST.sha256
npm ci
node -v
flock --version
```

将刚核验的代码和依赖复制到服务目录。代码归 root，服务账号可以写自己的主目录和四个实例数据目录。用承担模型调用额度的账号完成 Codex 设备登录。

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

## 启动私聊

将下一段中的 `chat.example.org` 换成实际域名。初始化会创建仅服务账号可读写的 `data/windows.local.json`，Linux 也沿用这个配置文件名。模板选用 `gpt-6.1-terra` 和 medium 推理强度。如果你的 CLI 账号使用其他可读图模型，可在启动前修改 `chatModel`。

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

首页应能取到，最后一条命令应返回 **401**，表示访客需要登录。服务启动失败时，查看 `sudo journalctl -u zhiwei -n 60`。检查模型登录时也应使用服务账号。

## 启用 HTTPS，签发第一份邀请

将附带的 Caddy 配置作为独立站点导入。在第一个编辑器中，把整个 `{$ZHIWEI_HOST:localhost}` 替换为实际域名。在第二个编辑器中，与已有站点并列增加一行 `import /etc/caddy/zhiwei.caddy`。配置把网页路由转发至本机 3790 端口。开发者管理界面使用本机 3789 端口，保持仅回环可达。

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

公网首页应能取到，访客接口再次返回 **401**。在仓库目录执行以下命令，可签发一份 24 小时内有效的一次性邀请。

```bash
sudo -H -u zhiwei npm run --silent invite -- \
  --database data/pwa/pwa.sqlite --origin "https://$ZHIWEI_DOMAIN" --role friend --hours 24
```

将输出里的完整邀请链接私下交给对应朋友。对方打开 HTTPS 链接，设置自己的账号和密码，即可开始聊天。每份新邀请都会建立一个新身份。同一实例的已登录成员可以共读空间动态和评论，私聊作品按接收账号取用。iPhone 用户可先将网页添加到主屏幕，再在知微内开启通知并授予系统权限。

## 安装浏览器并实测交互网页

用发行版的 Playwright 依赖下载匹配的 Chromium。以下命令把浏览器装在固定目录，供网页服务和独立运行器使用。在 Hub 已正常启动、邀请朋友测试自写网页前执行。

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

最后的检查以 Hub 服务账号实际打开网页、点击两次并验证三张截图。进入私聊，请知微做一个带日夜切换按钮的小网页，下载 HTML 后可断网打开复测。systemd 为每个任务提供独立身份、文件系统和隔离网络，Hub 通过 Unix socket 发现运行器。未安装该运行器时，网站工具仍可按规格生成单页。

## 按需开启的能力

- **网页阅读。** 安装的 Chromium 支持只读浏览。公开主题关键词使用小红书检索，知微也能沿公开文章实际给出的链接续读。站点要求登录时，通过已认证的 SSH 隧道访问本机 3789 端口的 `/world`，并准备服务账号可用的图形会话，在站点自己的窗口完成登录。读取已知 X 原帖可单独配置 `world.xBrowser`，为它指定独立的绝对路径，与默认站点的浏览器资料和截图分开。
- **自主活动与用量。** 模板启用学习、私聊念头和共享空间。后台生活规划与自主浏览初始关闭。需要主动规划时，在 `data/windows.local.json` 开启 `life.planning.enabled` 并重启服务。自主浏览可在本机 `/world` 页面开启。`runtimeBudget.mode: "observe"` 表示记录用量，额度来自部署者自己的账号。绘图还需要 CLI 账号及模型支持图片生成工具。
- **B 站视频。** 视频取材按需开启。浏览器会话方式需要 Linux、可运行沙箱的 Chromium，以及服务账号自己拥有的 `~/.local/share/zhiwei-video-sessions/bilibili`。该目录与上一级目录权限均为 0700。将 `video.enabled` 设为 true，`video.platforms` 和 `video.sessionBrowser.platforms` 设为 `["bilibili"]`，`video.sessionBrowser.executablePath` 填入 `printf '%s\n' "$BROWSER"` 打印的完整路径。改完配置重启，服务会先探测依赖。站点限制访问或取材不足时，以实际返回的结果为准。

## 已有实例

若你使用早期 QQ v2.0，操作前先取得包含程序、私有配置、完整数据、媒体和账号状态的一致备份。保留可继续使用的旧版，首次试用可在独立主机或虚拟机安装 v2.03。同机并行需要单独的服务账号、主目录、代码和可写数据目录、systemd 服务名、域名及可用端口。管理端口通过 `PORT` 配置，网页端口通过 `pwa.port` 配置，反代要指到新端口。两套独立网页运行器并存时，还需区分服务单元名和 `ZHIWEI_CREATIVE_RUNNER_SOCKET`。

用新邀请验注册、普通回复、发图和作品下载，再决定如何切换。初始化会保留已有配置。本版提供全新 PWA 部署，历史身份或 QQ 记忆迁移需要独立核验的迁移操作与备份。`scripts/pwa-backup.mjs` 只备份 PWA 数据库。完整备份还应覆盖媒体、记忆、配置、服务账号凭据及其他实例资料。
