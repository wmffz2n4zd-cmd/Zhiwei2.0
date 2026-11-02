#!/usr/bin/env bash
# 知微安装脚本（Ubuntu 24.04 x86_64）
# 只做四件事：检查 Node、安装依赖、生成配置、渲染 systemd 单元。
# 不写入 /etc，不启动服务，不修改系统设置。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

fail() { printf '\n✗ %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "未找到 node。请先安装 Node.js 20 或更新版本（见 docs/install.md）。"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 版本过低（当前 $(node -v)），需要 20 或更新版本。"

printf '==> 安装依赖（playwright-core）\n'
command -v npm >/dev/null 2>&1 || fail "未找到 npm，Node.js 安装不完整（见 docs/install.md）。"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

printf '==> 初始化配置\n'
if [ -f data/local.json ]; then
  printf '    已存在 data/local.json，跳过（如需重新生成：npm run setup -- --force）\n'
else
  # 参数透传：bash deploy/install.sh --owner 123 --bot 456 --napcat-dir ~/napcat-data
  node scripts/setup.mjs "$@"
fi

printf '==> 生成 systemd 单元\n'
# sudo 下取真实调用者；直接用 root 登录时退回当前用户；两者都缺失则用 id。
RUN_USER="${SUDO_USER:-${USER:-$(id -un)}}"
node scripts/render-unit.mjs --dir "$DIR" --user "$RUN_USER"

printf '==> 体检\n'
node scripts/check-config.mjs || true
node scripts/doctor.mjs || true

cat <<'EOF'

下一步：
  1. 启动 NapCat 并登录机器人 QQ（见 docs/install.md）
  2. 用管理员 QQ 私聊机器人，发送 /帮助
  3. 安装为系统服务：
       sudo cp deploy/zhiwei.service /etc/systemd/system/zhiwei.service
       sudo systemctl daemon-reload
       sudo systemctl enable --now zhiwei
       journalctl -u zhiwei -f
EOF
