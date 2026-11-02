# 发行验收记录

> English: [docs/en/verification.md](en/verification.md)

本文件保留 **DSH随初始153文件发行树提供的历史验收记录**。下表数量、平台和结果针对当时快照，不自动覆盖后续修订，也不是本轮重新运行所得。当前源码的Ubuntu测试及隔离安装检查以 [GitHub Actions运行](https://github.com/wmffz2n4zd-cmd/Zhiwei2.0/actions/workflows/test.yml) 为准；没有成功运行记录时，应视为尚未验证。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 整理与验证机器 | Windows 11（打包机） |
| Node | v24.22.0 |
| npm | 11.19.1 |
| bash | GNU bash 5.3.15（Git for Windows 自带，仅用于语法检查与安装脚本试跑） |
| Codex CLI | 0.166.0-alpha.5.1（已登录，体检时真实调用 `--version` 与 `login status`） |
| **真实 Ubuntu 主机** | **没有**：无 WSL、无 Docker、无可用 Linux 机器 |

历史记录中的验证在打包机的类 Unix 环境或 Node 层完成，未提供真实 Ubuntu 24.04 安装记录；不应把 Git for Windows 的 bash 结果等同于 Linux 实机验收。

> 本轮发布复核不连接或使用维护者的ECS，不在其上部署或跑测试。仓库包含 `ubuntu-24.04` CI工作流；其运行结果需单独查看，不能因文件存在就写为通过。CI使用合成数据，不代替真实QQ、模型和网站验收。

## 2. DSH提供的历史验证

| # | 项目 | 命令 | 结果 |
| --- | --- | --- | --- |
| 1 | 语法检查 | `node --check` 覆盖全部 `.js` / `.mjs` | 0 失败 |
| 2 | Shell 语法 | `bash -n deploy/install.sh bin/zhiwei` | 0 失败 |
| 3 | 全量测试 | `npm test`（串行，约 4.7 分钟） | 691 用例：**687 通过 / 1 失败 / 3 跳过** |
| 3b | 并行复跑 | `npm run test:parallel`（并发 4） | 时序类用例偶发超时；因此默认串行 |
| 4 | 安装脚本执行 | 在副本里执行 `bash deploy/install.sh --owner … --bot …`（`npm` 用桩替代） | **完整走通，退出码 0**：生成配置 → 渲染 systemd 单元 → 体检 |
| 5 | 重复安装 | 再执行一次同一命令（且清空 `USER` 环境变量） | 正确跳过已有配置，未覆盖，退出码 0 |
| 5b | 状态入口 | `bash bin/zhiwei status` / `version`（服务运行中） | 输出通道、模型、生活、额度状态；版本 `2.0.0` |
| 6 | 冷启动 | 从压缩包解压 → 初始化 → `node src/server.js` | 空记忆/空画像/空生活下正常启动 |
| 7 | 端点 | `GET /api/state`、`/api/platform`、`/life-observer.html`、`/world` | 全部 200 |
| 8 | 端到端 | 包内 `integration` + `private-only` + `assistant-profile` | 7/7 通过：签名回调 → 假 CLI → 发送链路 |
| 9 | 包完整性 | 解压后按 `MANIFEST.sha256` 校验 | 153 文件（含 MANIFEST），0 不一致 |
| 10 | 脱敏扫描 | 关键字、私钥、64 位密钥模式 | 无命中；无运行数据、无 `node_modules` |
| 11 | Linux 就绪扫描 | 105 个脚本的相对 import 必须大小写完全匹配（Linux 区分大小写） | 0 处不匹配 |
| 12 | 平台假设扫描 | 查找 PowerShell / osascript / 盘符路径 / `/opt` | 仅剩被 `isMac`、`win32` 显式门控的分支 |
| 13 | 压缩包权限位 | 检查归档内记录的 mode | `bin/zhiwei`、`deploy/install.sh` 为 0755，其余 0644；解压即可执行 |
| 14 | 可复现构建 | 连续打包两次比较 SHA-256 | 完全一致 |
| 15 | 备份/恢复演练 | 按 `docs/operate.md` 的命令打包、移走、解压 | 恢复前后 `data/` 指纹一致 |
| 16 | 升级演练 | 跑一次生成真实状态 → 停机 → 整块替换代码 → 再启动 | 18 个受保护文件：**用户数据 0 改动、0 丢失**；仅 3 个易变文件（两个锁 + `snapshot.json` 缓存）被新进程重写 |
| 17 | 配置校验器 | `npm run check`：正常配置 / 故意损坏的配置 | 正常配置退出 0；损坏配置（管理员为空 + 规划依赖缺失）退出 1 并指出两项错误 |

端到端测试使用的都是替身：假 OneBot 服务、假 Codex CLI、可控时钟。**没有**向真实 QQ 发消息，**没有**调用真实模型，**没有**登录真实网站。

## 3. 历史失败与解释

| 失败 | 原因 | 影响 |
| --- | --- | --- |
| `browser-router.test.mjs` 符号链接用例 | Windows 上创建符号链接需要特权，`EPERM` | 环境限制，Linux 上应通过 |
| `mood-integration` / 部分 life 时序用例并行时超时 | 这些用例依赖真实时钟推进，并行争用会打乱窗口；单独运行或串行运行均通过 | 默认改为串行（4.7 分钟），另提供 `test:parallel` 供快速迭代 |
| 安装脚本第二次执行报 `USER: unbound variable` | 测试时未设置 `USER`，而脚本用了 `set -u` | **已修复**：改为 `SUDO_USER → USER → id -un` 三级回退，修复后复测通过 |
| 渲染出的单元文件路径带空格时未加引号 | —— | **已修复**：含空格的路径会加双引号（实测 `ExecStart="C:\Program Files\…"`） |
| 压缩包把每个文件都记成 0666 | Windows 的 bsdtar 不带 Unix 权限位 | **已修复**：改用显式写 tar 的脚本，0755/0644 正确，并顺带做到可复现 |
| Linux 上 `/执行` 任务的提示词仍写着“Windows 上使用 PowerShell” | 提示词没有按平台分支 | **已修复**：非 Windows 改为“使用 bash 和 POSIX 路径” |

失败都保留在维护记录里，没有为了“看起来全绿”而删改。

## 4. 原始发行记录未验证的部分

1. 真实 Ubuntu 24.04 上的完整安装（`apt`、NodeSource、`npm ci`、权限）。
2. systemd 单元的安装与启停。
3. 真实 QQ 收发（从未连接真实账号）。
4. 真实模型调用链路的时延与额度表现。
5. 真实网站登录与网页阅读。
6. Node 20.10 / 22 的兼容性（只在 24 上验证）。
7. ARM、Windows、macOS。
8. 原始记录没有GitHub Actions运行结果；后续结果请查上方CI链接，并核对所对应的提交，不沿用为其他提交的通过证明。

## 5. 如何自行复核

```bash
sha256sum -c MANIFEST.sha256     # 包完整性
npm ci && npm test               # 自带测试
npm run setup -- --owner … --bot … --print-only   # 只看将写入什么
npm run doctor                   # 体检
```

如果 `npm test` 在你的机器上出现时序类超时，先确认没有其他重负载任务，或改用
`node --test --test-concurrency=1 tests/*.test.mjs` 串行复跑。
