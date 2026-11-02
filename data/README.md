# The data/ directory

Everything here is **specific to this machine**. Except for this file and `qq-stickers/README.md`, the whole directory is git-ignored.

| Path | Contents | First appears |
| --- | --- | --- |
| `local.json` | Deployment configuration (owner QQ, bridge secrets, model, switches). Should be mode 600. | `npm run setup` |
| `settings.json` | Settings editable from the console (model, channels, …) | first start |
| `unified-memory.json` | Private-chat memory and contact profiles, isolated by `qq:private:<QQ id>` | first successful reply |
| `life/` | Life timeline: `journal.jsonl` (append-only transactions), `snapshot.json` (cache), `archives/`, `.writer.lock` | once `life.enabled` is on |
| `runtime-budget/` | Usage ledger `budget.json` and its write lock | before the first model call |
| `runtime-usage/` | Observe-mode usage log, one file per Beijing day | first model call |
| `world/` | Browsing state, the message board, dedicated browser profile (contains sessions — sensitive) | once browsing is enabled |
| `qq-stickers/` | Sticker images; add your own | manual |

## Backup

`data/` contains core application state and credentials, but is not a complete backup of the installation. Private images also live in `tmp/qq-images/`; raw model output and diagnostics live in `runtime/`. NapCat, CLI authentication, environment files and custom workspaces may need separate preservation. See [the full backup scope](../docs/en/operate.md).

With the Hub stopped, a service-user backup of only this directory is:

```bash
umask 077
mkdir -p "$HOME/zhiwei-backups"
tar -czf "$HOME/zhiwei-backups/zhiwei-data-$(date +%F-%H%M%S).tar.gz" data/
```

Restore **only** while the service is stopped, otherwise two writers race on the same files. Upgrading code never requires touching `data/`.

## Privacy

`data/world/browser-profile/` holds website sessions and `local.json` holds QQ callback secrets. Neither belongs in Git, screenshots or public backups. Necessary chat history/profile is passed to the configured model service during generation; local persistence is not a promise that content never leaves the machine.

---

## 中文摘要

- 本目录是这台机器独有的运行数据，除两个说明文件外全部被 `.gitignore` 忽略。
- `local.json` 权限应为 600；`life/` 是生活时间线的追加日志与缓存；`world/` 含浏览器登录态。
- 本目录不是完整安装备份：`tmp/qq-images/`、`runtime/`、实际NapCat/CLI认证目录等另见[备份范围](../docs/operate.md)。备份放在仓库外受限目录，恢复须停机且先保全当前数据。
- 升级代码不需要动 `data/`；`local.json` 与浏览器 profile 都不能进 Git 或公开备份。
- 生成时必要的聊天历史和画像会传入所配置的模型服务，本地持久保存不等于内容不出站。
