# 知微 · Zhiwei

[English](README.md) · **中文**

> 一个只接受私聊的 QQ AI 伙伴。她有自己的生活时间线，聊天只是其中发生的事情之一。

知微常驻在你的 Linux 服务器上，通过 QQ 私聊和你说话。她不是"等你开口才启动"的问答机器人：她会给自己安排零碎的一天，产生念头，改变计划，接触外部世界，形成经历，留下记忆，长出持续几小时的情绪和持续几周的爱好，偶尔因为某件事想起你。

模型调用通过本机已登录的 **Codex CLI** 发起。额度和费用取决于你为 CLI 配置的账号及登录方式；本项目不提供模型额度。

```
你 ──QQ 私聊──> NapCat ──OneBot──> 知微 Hub ──> Codex CLI ──> 模型
                                      │
                                      ├─ 记忆与画像（按 QQ 号隔离）
                                      ├─ 生活时间线（事件日志 + 哈希链）
                                      ├─ 情绪 / 兴趣（事件投影）
                                      └─ 可选：网页阅读、只读观察台
```

## 她能做什么

| 能力 | 说明 |
| --- | --- |
| 私聊 | 只回应你（`ownerUserIds`）；群消息直接丢弃 |
| 记忆 | 按对象隔离的长期记忆，最近 2 小时对话自动带上下文，关键词可检索 |
| 画像 | 保存明确自述的称呼和喜好，支持更正、撤回及容量裁剪；不自动归纳交流习惯或按时间淡化 |
| 情绪 | 由生活事件推动，持续几小时，影响措辞而不是"回应资格" |
| 兴趣 | 可以发展、淡化、重拾；兴趣高不等于能力强 |
| 生活时间线 | 念头 → 日程 → 进行中 → 完成/失败/中断；关机期间不补演 |
| 主动联系 | 由念头驱动，有安静期、关系时效、考虑间隔；也可以什么都不发 |
| 忙时 | 回一条 `*` 开头的状态，结束后至多合并补答一次 |
| 网页阅读 | 可选，独立浏览器登录态，只读、白名单、禁下载与 WebSocket |
| 观察台 | 只读页面，看最近 1/7 天的念头、活动、兴趣变化与事件来源 |
| 指令 | `/状态` `/记忆` `/执行` `/浏览` 等；只有 `/` 开头才进指令模式 |
| 分段回复 | 用空行自然分成最多 3 条消息，像真人连发 |

## 她不做什么

- **不进群、不回复群消息。** 这不是开关，是产品边界。
- 不做视频理解、私聊语音、QQ 空间动态。
- 不承诺免费、无限额度或完全离线：模型调用走你自己的账号。
- 不把模拟生活伪装成真实阅读：没有来源就不说"我刚看了"。

## 快速开始（Ubuntu 24.04 x86_64）

```bash
# 1. 依赖
sudo apt install -y curl git unzip xvfb fonts-noto-cjk
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs

# 2. 先选择实际运行服务的普通用户，再安装并登录模型客户端
sudo useradd -m -s /bin/bash zhiwei   # 已有专用用户则跳过
sudo -iu zhiwei
codex login

# 3. 代码与依赖
git clone https://github.com/wmffz2n4zd-cmd/Zhiwei2.0.git ~/zhiwei && cd ~/zhiwei && npm ci

# 4. 初始化（生成你自己的密钥；机器人 QQ 必须与管理员不同）
npm run setup -- --owner 你的QQ号 --bot 机器人QQ号

# 5. 启动
npm start          # 前台试跑
npm run doctor     # 另开终端做体检
```

还需按下方完整步骤安装、登录 NapCat 并配置两条 OneBot 连接。需要图片输入时，用可重复的 `--qq-image-cache-root /实际缓存目录` 配置白名单；未配置时图片与静态表情视觉不可用，文字聊天仍可用。`--napcat-dir` 只指定桥接配置的输出目录，不会自动发现或安装 NapCat。

完成桥接后，用管理员 QQ 私聊机器人，发 `/帮助`。

完整步骤（含 NapCat 安装、登录、systemd 常驻）见 **[docs/install.md](docs/install.md)**。

## 文档

> 英文文档在 [docs/en/](docs/en/)；下列为中文原文。

| 文档 | 内容 |
| --- | --- |
| [docs/install.md](docs/install.md) | 从空机器装到能聊天 |
| [docs/configure.md](docs/configure.md) | 每一个配置项的含义 |
| [docs/operate.md](docs/operate.md) | 启停、日志、重登、升级、备份恢复 |
| [docs/architecture.md](docs/architecture.md) | 数据流、生活引擎、记忆、额度 |
| [docs/security.md](docs/security.md) | 信任边界与已知问题（**部署前必读**） |
| [docs/faq.md](docs/faq.md) | 常见疑问 |
| [docs/release-audit.md](docs/release-audit.md) | 这次发行做了哪些脱敏与许可核查 |
| [docs/verification.md](docs/verification.md) | 发布前实际跑过什么、没跑过什么 |

## 目录

```
src/            主进程与各子系统
modules/web-console/public/   控制台、观察台、浏览页
config/         人格正文
scripts/        初始化、体检、运维工具
deploy/         systemd 单元模板与安装脚本
tests/          合成测试（假 OneBot + 假 CLI + 可控时钟）
data/           你的运行数据（git 忽略）
docs/           面向部署者的文档
```

## 你需要自己准备

1. 一个**独立的机器人 QQ 号**（与你的管理员号互加好友）。
2. 可用的 **Codex CLI 登录**。
3. 按官方文档安装的 **NapCat**（第三方，非本项目；有账号风控风险，建议用小号）。
4. 想要网页阅读时，再装 Chromium。

## 数据与隐私

记忆、画像、生活日志、浏览登录态和用量记录主要持久保存在本机 `data/`；私聊图片缓存位于 `tmp/qq-images/`，模型原始输出与诊断位于 `runtime/`。这些运行目录由 Git 忽略。生成回复时，当前消息、必要的历史/画像以及可用图片会作为输入交给配置的模型服务，因此“本地保存”不等于内容不出站。备份范围及独立登录态见 [docs/operate.md](docs/operate.md)。

部署前请务必读 [docs/security.md](docs/security.md)：本机 HTTP 没有登录凭证，这台机器不应与他人共用。

## 版本

当前 `2.0.0`。变更记录见 [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)（英文版见 [CHANGELOG.md](CHANGELOG.md)）。

## 许可

以 **MIT** 发布，全文见 [LICENSE](LICENSE)。第三方组件（playwright-core 等）的许可与署名见 [NOTICE.md](NOTICE.md)。

> 历史验证范围见 [docs/verification.md](docs/verification.md)。本轮发布复核不使用维护者的 ECS；Ubuntu 测试与隔离安装检查的当前结果以 [GitHub Actions](https://github.com/wmffz2n4zd-cmd/Zhiwei2.0/actions/workflows/test.yml) 为准，工作流存在不等于已通过，也不替代真实 QQ/模型验收。

## 致谢

- 上游项目 [Codex Remote Contact](https://github.com/Epic0522/Codex-Remote-Contact)：Hub、Web 控制台与 QQ 通道的起点。
- [NapCat](https://github.com/NapNeko/NapCatQQ)：QQ ↔ OneBot 的桥接，本项目不打包它。
- OpenAI Codex CLI：模型调用与任务执行。
- [Playwright](https://playwright.dev/)：网页阅读的浏览器控制。
