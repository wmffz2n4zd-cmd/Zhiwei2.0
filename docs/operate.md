# 日常运维

> English: [docs/en/operate.md](en/operate.md)

## 1. 启停与状态

```bash
sudo systemctl start zhiwei      # 启动
sudo systemctl stop zhiwei       # 停止（会等待已接收的消息写完，最长 600 秒）
sudo systemctl restart zhiwei    # 重启（升级或改配置后）
sudo systemctl status zhiwei     # 是否在跑、最近几次退出
journalctl -u zhiwei -f          # 跟踪日志
journalctl -u zhiwei --since "10 min ago"
```

前台调试（不装服务也能用）：

```bash
npm start
```

只读状态（不触发模型、不发消息）：

```bash
bin/zhiwei status     # 通道、模型、生活、额度模式
bin/zhiwei doctor     # 体检：账号、桥接、CLI、时间线、浏览器
npm run check         # 只校验配置；改完 data/local.json 后先跑这个
```

`/关机` 指令会让 Hub 正常停止（需要再发 `/确认关机`，60 秒内可 `/取消关机`）。它只停服务，不关机器。

## 2. 日志在哪

| 位置 | 内容 |
| --- | --- |
| `journalctl -u zhiwei` | 服务标准输出/错误：启动自检、致命错误、生活层警告 |
| `runtime/logs/qq-timings.jsonl` | 每条消息的准备/模型/发送耗时，超过 2 MiB 自动轮转为 `.previous`。**不含正文。** |
| `runtime/replies/*.txt` | Codex 每次生成的原始输出（本地文件，含对话内容） |
| `runtime/logs/cli-error-*.json` | CLI 失败时的诊断快照（可能含提示词片段，注意别外传） |
| `tmp/qq-images/` | 接收的私聊图片缓存，同样属于敏感内容 |
| NapCat 自己的日志 | 在 NapCat 安装目录或 journalctl 中看 |

## 3. 重新登录

**QQ**：NapCat 的 WebUI（默认 `127.0.0.1:6099`，服务器上需 SSH 转发）：

```bash
ssh -L 6099:127.0.0.1:6099 用户@服务器
# 浏览器打开 http://127.0.0.1:6099，扫码登录机器人账号
```

机器人掉线通常表现为私聊无响应，而 Hub 仍然 200。

**Codex**：

先切换到 systemd 单元的实际运行用户，并使用与 `deploy/zhiwei.env` 一致的 HOME/CODEX_HOME及CLI路径；不要用另一个管理员或root账号登录。以下认证命令在服务用户终端执行：

```bash
codex login          # 按 CLI 提示认证
codex login status   # 确认
```

认证完成后，在有权限的管理员终端执行 `sudo systemctl restart zhiwei`。systemd 不继承交互 shell 的环境；本地终端显示已登录时，仍需核对单元中的运行用户和环境文件。

**网站（X / 小红书）**：Hub 首页的「网页浏览」入口，或 `/world` 页面，点登录 → 人工扫码 → 完成后切回只读。登录态存在 `data/world/browser-profile/`，删掉它等于退出登录。

## 4. 升级

```bash
sudo systemctl stop zhiwei
cd ~/zhiwei
git fetch --tags && git checkout <新版本标签>     # 或解压新压缩包覆盖代码
npm ci
node scripts/doctor.mjs                          # 可选，先看配置是否需要补
sudo systemctl start zhiwei
```

升级前先按下节备份，并只替换受版本控制的代码。`data/`、`runtime/`、`tmp/` 和默认远程任务工作区属于被Git忽略的运行内容，不代表它们一定在仓库目录之外；不要使用删除整个目录或清理未跟踪文件的方式升级。保留实际NapCat目录、自定义工作区及 `deploy/zhiwei.env`。新增配置项需对照 `docs/configure.md` 补齐。

回退同理：`git checkout <旧版本>`，`npm ci`，重启。**不要**用旧备份覆盖 `data/` 来“回退代码”。

## 5. 备份与恢复

应用核心状态是 `data/`，包括配置、记忆、画像、生活记录、用量与默认网站登录态。`runtime/` 保存原始模型输出/诊断，`tmp/qq-images/` 保存私聊图片；若要保留这些历史材料，应一并备份。默认远程任务工作区 `workspaces/remote/`、自定义人格和 `deploy/zhiwei.env` 也应按使用情况保全。

NapCat配置/登录态/原始图片缓存、Codex的实际 HOME/CODEX_HOME 以及仓库外自定义工作区需另行备份；`--napcat-dir` 只指定配置输出目录，不代表它包含全部QQ登录态。下例是应用目录备份，**不是整机或全部认证的完整备份**。先在管理员终端停止Hub；若备份NapCat正在写入的目录，也需单独正常停止它。然后由服务用户在项目根目录执行：

```bash
umask 077
mkdir -p "$HOME/zhiwei-backups"
backup_paths=(data)
for path in runtime tmp workspaces/remote deploy/zhiwei.env; do
  [ ! -e "$path" ] || backup_paths+=("$path")
done
tar -czf "$HOME/zhiwei-backups/zhiwei-$(date +%F-%H%M%S).tar.gz" "${backup_paths[@]}"
```

核对归档清单、权限和可读取性后，由管理员启动服务。备份含凭据与私聊，保存在仓库外受限目录；公开issue、Git提交和CI工件均不应包含它。

恢复前正常停机，先另存当前数据和切版后的新增聊天，再把备份解到新的私有恢复目录检查清单、文件权限及代码/配置版本。核对后整体恢复对应状态，不把新旧 `data/life/` 文件混合，也不直接覆盖唯一现存副本。外部认证目录按其原位置和所属用户分别恢复；旧备份不能证明其中登录仍有效。

必须停机操作，否则会和运行中的进程双写同一份 JSON/JSONL。

## 6. 生活观察台

只读页面，用来查看最近 1/7 天的念头、活动、兴趣变化和事件来源，并支持导出当日 JSON。它不推进时间、不调用模型、不能编辑。

```bash
# 服务器上：本机访问
curl http://127.0.0.1:3789/life-observer.html

# 你自己的电脑：端口转发后打开
ssh -L 13789:127.0.0.1:3789 用户@服务器
# 浏览器打开 http://127.0.0.1:13789/life-observer.html
```

页面每次加载会向 `/api/life-observer/session` 取一次性令牌；直接拷贝 URL 给别人无效。它只允许回环地址访问，并拒绝带 `X-Forwarded-*` 的请求——所以不要放在反向代理后面。

## 7. 记忆与画像

| 指令 | 作用 |
| --- | --- |
| `/记忆 关键词` | 按关键词查当前对象的记忆 |
| `/记住 内容` | 显式写入一条长期记忆 |
| `/统一记忆状态` | 看条目数与类型分布 |
| `/清除统一记忆` → `/确认清除记忆` | 清空统一记忆（不可撤销） |

记忆按 `qq:private:<QQ号>` 隔离。画像仅保存明确自述的称呼和喜好；新的自述可更正，明确的“忘掉我的称呼/偏好”等表达可撤回，容量有限，不会自动归纳交流习惯或按时间淡化。撤回画像不等于删除普通聊天原文。

## 8. 出问题时的判断顺序

1. `sudo systemctl status zhiwei` —— 进程在不在。
2. `bin/zhiwei status` —— Hub 自己怎么看（通道、桥接、生活）。
3. `npm run doctor` —— 外部依赖（CLI 登录、NapCat、浏览器）。
4. `journalctl -u zhiwei -n 100` —— 有没有崩溃栈。
5. `runtime/logs/qq-timings.jsonl` 最后几行 —— 消息卡在准备、模型还是发送。

常见对照见 `docs/faq.md`。
