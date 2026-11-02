# 安装（Ubuntu 24.04 x86_64）

> English: [docs/en/install.md](en/install.md)

这版只支持 Ubuntu 24.04 / x86_64。本地电脑、虚拟机、云服务器都可以，最低建议 2 vCPU / 4 GiB 内存 / 20 GiB 磁盘。

安装完成后，这台机器上会有三个进程：

| 进程 | 作用 | 端口 |
| --- | --- | --- |
| 知微 Hub（本项目） | 收消息、管记忆、调模型、排生活 | `127.0.0.1:3789` |
| NapCat | 登录机器人 QQ，转成 OneBot 协议 | `127.0.0.1:3000`（API）、`127.0.0.1:6099`（WebUI） |
| Codex CLI | 真正生成回复和执行任务的模型客户端 | 无（子进程） |

---

## 0. 你需要先准备

1. **一个独立的机器人 QQ 号**，与你的管理员 QQ 互加好友。机器人号不能和你自己的号相同，也不能同时在手机桌面版登录。
2. **Codex CLI 可用的账号**。模型调用由 CLI 发起，费用和额度遵循所配置的账号与登录方式。
3. 服务器能访问 QQ 与模型服务所需的网络。国内网络访问模型通常需要代理，见 `docs/configure.md` 的 `codexProxy`。

---

## 1. 系统依赖

```bash
sudo apt update
sudo apt install -y curl git unzip xvfb fonts-noto-cjk
```

`xvfb` 只在服务器没有图形界面、又需要跑 NapCat / Chromium 时才必需。`fonts-noto-cjk` 用于截图里的中文。

## 2. Node.js 20 以上

已验证版本：**Node v24.22.0**；最低 **20.10**（`npm test` 使用 `--test-concurrency`）。推荐用 NodeSource：

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # 应 >= 20
```

> 不要用 Ubuntu 自带的 Node 18：本项目要求 `>=20`，低于该版本启动会直接失败。

## 3. 先选定服务用户，再登录 Codex CLI

在管理员终端创建普通服务用户，然后切换过去。后续克隆、初始化、CLI 登录和前台检查都以这个用户执行；已有专用用户时跳过创建：

```bash
sudo useradd -m -s /bin/bash zhiwei
sudo -iu zhiwei
```

在该用户下安装官方 Codex CLI 并登录：

```bash
codex --version
codex login          # 按 CLI 提示完成认证
codex login status   # 显示已登录即可
```

如果 `codex` 不在 PATH 中，设置 `CODEX_CLI_PATH` 指向可执行文件（或 npm 包里的 `bin/codex.js`）。登录归属于当前用户的 Codex 配置目录；不要先用 root 登录再改用 `zhiwei` 运行。自定义 `CODEX_HOME` 时，登录与 systemd 必须使用同一个绝对路径。认证由 CLI 管理，不复制其他用户的登录文件。

## 4. 获取代码并安装依赖

```bash
git clone https://github.com/wmffz2n4zd-cmd/Zhiwei2.0.git ~/zhiwei
cd ~/zhiwei
npm ci
```

如果你拿到的是压缩包：

```bash
tar -xzf zhiwei-2.0.0.tar.gz
cd zhiwei-2.0.0
npm ci
```

依赖只有 `playwright-core` 一个，用于网页浏览；不装浏览器也能启动，只是阅读能力不可用。

## 5. 初始化配置

```bash
npm run setup -- --owner 你的QQ号 --bot 机器人QQ号
```

它会：

- 生成 `data/local.json`（权限 600），内含**本实例独有**的 OneBot 密钥对；
- 生成 NapCat 的 `onebot11_<机器人QQ>.json`（如果给了 `--napcat-dir`）；
- 创建 `runtime/`、`workspaces/remote/` 等目录。

`--napcat-dir /实际NapCat配置目录` 是可选的输出路径，必须由你按实际安装位置填写；脚本不会发现 NapCat，也不会自动加载任意目录里的配置。如果先输出到临时目录，需自行将生成的 `onebot11_<机器人QQ>.json` 放入该 NapCat 实例实际使用的配置目录，再按 NapCat 的方式重新加载；也可在 WebUI 手动配置下节的两条连接。保留现有连接配置，确认替换范围后再覆盖。

其它可用参数：

| 参数 | 说明 |
| --- | --- |
| `--chromium /usr/bin/chromium` | 指定浏览器；不填则网页阅读不可用（生活规划不受影响） |
| `--qq-image-cache-root /实际缓存目录` | QQ 图片目录白名单，可重复传入多个目录；不能使用文件系统根目录。未配置时图片/静态表情视觉不可用，文字仍可用 |
| `--napcat-dir /实际配置目录` | 在此目录生成 OneBot 配置；不安装或自动发现 NapCat |
| `--no-life` | 关闭生活时间线（不推荐，等于只有一个聊天机器人） |
| `--force` | 覆盖前分别备份已有主配置和所选 NapCat 配置；默认拒绝覆盖任一现存目标。备份与新文件权限为600 |

图片缓存目录应是当前 NapCat 实际落盘的目录，且服务用户有读取权限。例如需要两个目录时，追加 `--qq-image-cache-root /实际缓存A --qq-image-cache-root /实际缓存B`；不要为省事放行整个家目录或磁盘。

## 6. 安装并登录 NapCat

按 [NapCat 官方文档](https://napneko.github.io/guide/boot/Shell) 安装 Linux 版。历史上游部署记录使用过 NapCat `v4.18.41` + QQ NT `3.2.34`，不代表本发行包已完成真实 QQ 验收。无桌面环境时可用 `xvfb-run`，下面可执行路径必须替换为实际安装位置：

```bash
xvfb-run -a ~/Napcat/opt/QQ/qq --no-sandbox
```

首次启动打开 NapCat WebUI（默认 `http://127.0.0.1:6099`），扫码登录**机器人** QQ。

登录后确认「网络配置」里有两条连接。只有配置文件放在实际加载目录并被 NapCat 读取后，生成的配置才生效：

- HTTP 服务端 `127.0.0.1:3000`，Token = `data/local.json` 的 `oneBotAccessToken`；
- HTTP 客户端 `http://127.0.0.1:3789/api/onebot/event`，Token = `data/local.json` 的 `oneBotSecret`。

> 服务器没有浏览器可打开 WebUI 时，用 SSH 端口转发：`ssh -L 6099:127.0.0.1:6099 用户@服务器`。

## 7. 启动

前台试跑：

```bash
npm start
```

应看到启动自检，例如：

```
知微 chat hub: http://127.0.0.1:3789
知微配置：.../data/local.json（全部就绪）
  OK   管理员 QQ：...
  OK   OneBot 回调密钥：已配置
  ...
```

任何一项 `TODO` 都说明对应能力不可用，按提示补齐即可；服务本身仍会启动。

另开一个终端做体检：

```bash
npm run check    # 只看配置是否自洽，不启动服务
npm run doctor   # 连 QQ 桥接器、Codex CLI 一起看
```

## 8. 常驻运行（systemd）

先用 `Ctrl+C` 正常结束前台 Hub，避免两实例并发写数据。仍在服务用户终端渲染单元；确认 `$USER`、`$HOME` 就是前面完成 CLI 登录的用户：

```bash
node scripts/render-unit.mjs --dir "$PWD" --user "$USER" --home "$HOME"
```

systemd 不读取你的交互 shell 启动文件。需要自定义 CLI 路径、认证目录或 PATH 时，将 `deploy/zhiwei.env.example` 复制为 `deploy/zhiwei.env`，按真实环境填写绝对路径并设置 `chmod 600 deploy/zhiwei.env`。可用项为 `CODEX_CLI_PATH`、`CODEX_HOME`、`PATH`；不填的项目保持默认。环境文件使用 `KEY=value`，不写 `export`，不依赖 `$HOME` 或命令替换。默认单元会可选加载该文件；另选位置时渲染参数用 `--env-file /绝对路径/zhiwei.env`。该文件不会自动创建或覆盖，也不复制登录凭据。

回到有 sudo 权限的管理员终端安装服务（以下路径以专用用户 `zhiwei` 为例）：

```bash
sudo cp /home/zhiwei/zhiwei/deploy/zhiwei.service /etc/systemd/system/zhiwei.service
sudo systemctl daemon-reload
sudo systemctl enable --now zhiwei
sudo systemctl status zhiwei
journalctl -u zhiwei -f
```

服务以普通用户运行，只监听 `127.0.0.1`。**不要把 3789 端口直接暴露到公网。**

## 9. 第一次对话

用你的管理员 QQ 私聊机器人：

```text
/帮助
/状态
```

能收到回复就说明链路通了。之后可以正常聊天，`/` 开头的才是指令。

---

## 常见安装失败

| 现象 | 原因与处理 |
| --- | --- |
| 启动报 `生活规划需要启用world...` | `life.planning.enabled=true` 时 `world.enabled` 必须为 `true`。在现有配置中修正这两个开关的组合，再运行 `npm run check`；不要为修一个开关重建全部配置和密钥 |
| 回调 401 | 两个 Token 用反了。服务端 Token 给 NapCat 的 HTTP 服务端，回调 Token 给 HTTP 客户端。 |
| `npm run doctor` 显示 Codex CLI 待处理 | 核对实际服务用户、HOME/CODEX_HOME、CLI路径和登录状态；交互终端可用不等于systemd环境相同。需要时填写 `deploy/zhiwei.env` 后重启 |
| QQ 没有回复 | 先看 `npm run doctor` 的桥接器一项，再看日志里是否有模型超时。 |
| 端口被占用 `EADDRINUSE` | 已经有一个 Hub 在跑；先正常停止既有实例。不要仅换端口启动另一个共享同一数据目录的实例 |
| 服务器休眠/卡顿后生活记录出现“中断” | 观测空档超过 2 分钟会被判定为中断，这是设计行为，不是崩溃。 |

下一步：`docs/configure.md` 调配置，`docs/operate.md` 学日常运维。
