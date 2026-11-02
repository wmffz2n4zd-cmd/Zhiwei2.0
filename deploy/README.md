# deploy/

Installation and long-running service files.

## Files

| File | Purpose |
| --- | --- |
| `install.sh` | Check Node → `npm ci` → `npm run setup` → render the systemd unit → run checks. **Never writes `/etc`, never starts a service.** |
| `zhiwei.service.in` | systemd unit template; `scripts/render-unit.mjs` substitutes the real paths. |
| `zhiwei.env.example` | Optional service-environment example for `CODEX_CLI_PATH`, `CODEX_HOME` and `PATH`; contains no credentials. |

## Usage

First choose a regular service user and log in to Codex CLI as that same user. Run initialization and rendering in that user's shell. If you use a custom `CODEX_HOME`, login and the service must use the same absolute directory. See [the installation sequence](../docs/en/install.md).

```bash
bash deploy/install.sh                                  # interactive initialisation
bash deploy/install.sh --owner 123456 --bot 654321      # non-interactive, args passed to setup
```

If `data/local.json` already exists the script skips initialisation, re-renders the unit and runs the checks again — it is safe to repeat.

## Install as a service

Stop any foreground Hub first. In the service user's shell:

```bash
node scripts/render-unit.mjs --dir "$PWD" --user "$USER" --home "$HOME"
```

The unit optionally reads `<installation>/deploy/zhiwei.env`; missing files do not block startup. If required, copy `zhiwei.env.example` to that path, fill in absolute `CODEX_CLI_PATH`, `CODEX_HOME` and a complete `PATH`, then set mode600. Use plain `KEY=value`, without `export`, `~`, `$HOME`, `$PATH` or command expansion. systemd does not load interactive shell startup files. `--env-file /absolute/path` selects a different file; rendering does not create or overwrite it and never copies authentication.

In a separate administrator terminal, install the rendered unit (example user/path: `zhiwei`):

```bash
sudo cp /home/zhiwei/zhiwei/deploy/zhiwei.service /etc/systemd/system/zhiwei.service
sudo systemctl daemon-reload
sudo systemctl enable --now zhiwei
sudo systemctl status zhiwei
```

The unit deliberately:

- runs as a normal user, not root;
- uses `Restart=on-failure`, so a normal `/关机` is not immediately resurrected;
- sets `TimeoutStopSec=600` and `KillMode=mixed` so accepted messages, memory writes and life state can finish;
- sets `UMask=0077` so new runtime data is owner-only.

## Upgrade

```bash
sudo systemctl stop zhiwei
# swap the code (git checkout or unpack a new tarball), then
npm ci
node scripts/doctor.mjs
sudo systemctl start zhiwei
```

Back up before upgrading. Git-ignored runtime directories can live inside the checkout: preserve `data/`, `runtime/`, `tmp/`, remote-task workspaces and `deploy/zhiwei.env`, plus actual NapCat and external authentication directories. Replace tracked code only; do not delete the whole installation or clean untracked files. See [backup scope](../docs/en/operate.md).

---

## 中文摘要

- `install.sh` 只做四件事：检查 Node、装依赖、初始化配置、生成 systemd 单元；不写 `/etc`、不启服务。
- 参数会透传给 `setup`，例如 `bash deploy/install.sh --owner 123 --bot 456`。
- 已有 `data/local.json` 时安装包装脚本跳过初始化；直接调用setup则默认拒绝覆盖现存目标。
- 单元以普通用户运行，`Restart=on-failure`，停机最多等 600 秒让写入完成。
- 先确定服务用户，再以该用户登录Codex、初始化和渲染；管理员终端负责安装systemd单元，不复制其他用户的凭据。
- 单元可选读取 `deploy/zhiwei.env`；可设置CLI绝对路径、CODEX_HOME和完整PATH，权限600，不能依赖shell变量展开。渲染参数 `--env-file` 可改路径，不会自动创建/覆盖该文件。
- 升级前备份，保留 `data/`、`runtime/`、`tmp/`、远程工作区和环境文件；实际NapCat/CLI认证目录另行保全，见[运维](../docs/operate.md)。
