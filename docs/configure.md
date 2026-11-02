# 配置说明

> English: [docs/en/configure.md](en/configure.md)

主配置是 `data/local.json`（权限应为 600），由 `npm run setup` 生成。改完需要重启服务：

```bash
sudo systemctl restart zhiwei
```

`data/settings.json` 是控制台可写的另一层状态，通常不用手改。

> 历史兼容：如果只有 `data/windows.local.json` 而没有 `data/local.json`，程序仍会读它。此时setup默认拒绝创建会遮蔽旧配置的新文件；显式 `--force` 才允许新 `local.json` 优先，旧文件原样保留，但其自定义项不会自动迁移，需先自行核对。新部署一律用 `data/local.json`。也可用 `ZHIWEI_CONFIG=/绝对路径/xxx.json` 完全指定配置文件。

---

## 1. 账号与桥接

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `ownerUserIds` | string[] | 管理员 QQ 号。**只有这些号**的私聊会得到回应（除非另开 `allowOtherPrivateChats`）。 |
| `botUserId` | string | 机器人 QQ 号，仅作记录与自检提示。 |
| `allowOtherPrivateChats` | boolean | 默认 `false`。设为 `true` 后，任意陌生人私聊都会得到回应，且会写入各自的记忆与画像。**不建议**打开。 |
| `qqPrivateOnly` | boolean | 程序内部恒为 `true`；群消息在进入模型前被丢弃，发送端也拦截群 API。此键不接受“关掉”。 |
| `qqEnabled` | boolean | 启动时 QQ 通道是否开启。关闭后仍可用 `/开启QQ` 打开。 |
| `oneBotApiBase` | string | NapCat 的 HTTP API 地址，默认 `http://127.0.0.1:3000`。 |
| `oneBotSecret` | string | 回调签名密钥（HMAC-SHA1）。与 NapCat「HTTP 客户端」的 Token 一致。 |
| `oneBotAccessToken` | string | 调用 NapCat 发送接口的 Bearer Token。与「HTTP 服务端」的 Token 一致。 |
| `qqImageCacheRoots` | string[] | 允许读取的实际 QQ/NapCat 图片缓存目录白名单。可用重复的 `setup --qq-image-cache-root /目录` 生成；留空时图片/静态表情视觉不可用，文字仍可用。目录必须可由服务用户读取，不要放行整个磁盘 |

两个密钥必须由 `npm run setup` 生成，**每个实例不同**，不要复制别人的配置。

## 2. 模型

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `chatModel` | 空 | 普通私聊模型名；留空用 Codex 默认模型。 |
| `chatReasoningEffort` | `low` | `low` / `medium` / `high` / `xhigh`。 |
| `privateChatModel` | 空 | 覆盖 `chatModel`（优先级更高，不需要就不用填）。 |
| `privateChatReasoningEffort` | 空 | 覆盖思考强度。 |
| `remoteModel` | 空 | `/执行` 任务用的模型。 |
| `codexProxy` | 空 | 给 Codex 子进程用的 HTTP 代理，例如 `http://127.0.0.1:7890`。留空则直连。 |
| `runtimeBudget.mode` | `observe` | 见第 6 节。 |

模型必须是你 `codex login` 后账号可用的名字。写错不会崩溃，但每次生成都会失败并回一句本地提示。

## 3. 生活时间线

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `life.enabled` | `true` | 总开关。关闭后没有念头、日程、情绪推进与主动联系。 |
| `life.planning.enabled` | `true` | 是否让模型规划一天。**它复用 `world` 的受限模型入口，所以要求 `world.enabled=true`**，否则启动时报错退出。 |
| `life.tickIntervalMs` | `15000` | 时间线推进间隔，会被限制在 250–15000 之间。 |

不要为了“看起来安静”把 `tickIntervalMs` 调大：观测空档超过 2 分钟的活动会被判为中断。

## 4. 网页阅读

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `world.enabled` | `true` | 生活规划依赖它，别关。 |
| `world.executablePath` | 空 | Chromium/Chrome 可执行文件。**为空时阅读会失败，但规划和聊天不受影响。** |
| `world.channel` | `chromium` | Playwright 通道名；用系统 Chrome 时可设 `chrome`。 |
| `world.headless` | `true` | 服务器上保持 `true`。 |
| `world.autoEnabled` | `false` | 旧的“每 4 小时自主浏览”定时器。**生活规划开启时它不会启动**，浏览改由时间线里的活动触发。 |
| `world.maxSteps` | `4` | 一次阅读最多打开几页。 |
| `world.proxy` | 空 | 浏览器专用代理；不填则沿用 `codexProxy`。 |
| `world.xBrowser` | 无 | 单独给 X 的浏览器配置（独立登录目录）。一般不用手写。 |

登录方式：浏览器第一次打开站点需要人工扫码/短信，`data/world/browser-profile/` 会保存会话（**这个目录是敏感数据**）。没有登录态时页面会被判为登录页并清空正文，不会把验证码页面喂给模型。

## 5. 人格

唯一真相是 `config/zhiwei-profile.md`，每次生成回复都会重新读取全文（不需要重启即可生效）。想换成你自己的角色：

```bash
cp config/zhiwei-profile.md config/my-persona.md
# 编辑 config/my-persona.md
```

然后在 `data/local.json` 里改：

```json
{ "assistantProfile": "config/my-persona.md" }
```

或用环境变量覆盖（优先级最高）：

```bash
export CODEX_REMOTE_CONTACT_ASSISTANT_PROFILE_PATH=/srv/my-persona.md
```

注意：**显式配置了却读不到文件会直接报错**，程序不会悄悄换回默认人格。设成空字符串才表示“不使用人格文件”。

## 6. 额度与预算

| 模式 | 行为 |
| --- | --- |
| `observe`（默认，推荐） | 只把每次模型调用的用途、结果和可得 token 写进 `data/runtime-usage/`，**不拦截**。生活规划的次数上限、浏览的日配额也一并停用。 |
| `strict` | 按周上限保守预扣（80% 的 75%），需要人工校准记录，否则每次调用都会被拒绝。 |

`observe` 不代表免费或无限：额度仍然消耗在你自己账号上，只是由服务端不设闸。用 `node scripts/runtime-usage.mjs inspect --from 2026-11-01 --to 2026-11-07` 看用量。

## 7. 任务与扩展

| 键 | 说明 |
| --- | --- |
| `workspace` | `/执行` 任务的默认工作目录。 |
| `remoteEnabled` | 是否允许 `/执行`。 |
| `allowFullAccessTasks` | 是否允许 `/执行完全访问`（`danger-full-access`）。默认 `false`，打开前请读 `docs/security.md`。 |
| `skills` | `{"名字": "/绝对路径/SKILL.md"}`，用于 `/技能`。 |
| `chatSkill` | 普通聊天默认使用哪个 Skill，`none` 表示不用。 |
| `automationScripts` | `/运行脚本 名称` 的白名单：`{"名称": {"command": "...", "args": [...], "timeoutMs": 30000}}`。只执行固定命令，不接受参数拼接。 |
| `desktopRecall` | 仅 macOS 有意义，Linux 保持 `enabled:false`。 |

## 8. 环境变量

| 变量 | 作用 |
| --- | --- |
| `PORT` | Hub 端口，默认 3789（只绑定 127.0.0.1）。 |
| `ZHIWEI_CONFIG` | 指定配置文件路径。 |
| `CODEX_CLI_PATH` | 指定 Codex 可执行文件。 |
| `CODEX_HOME` | Codex 配置目录，默认 `~/.codex`。 |
| `ONEBOT_API_BASE` / `ONEBOT_SECRET` / `ONEBOT_ACCESS_TOKEN` | 覆盖配置文件里的同名项。 |
| `CODEX_REMOTE_CONTACT_ASSISTANT_PROFILE_PATH` | 覆盖人格文件路径。 |
| `TZ` | 服务时区，建议 `Asia/Shanghai`；生活时间线按北京时间切日。 |

systemd 不继承交互 shell 的 PATH。需要自定义时，复制 `deploy/zhiwei.env.example` 为 `deploy/zhiwei.env` 并按实际环境填写 `CODEX_CLI_PATH`、`CODEX_HOME`、`PATH`（绝对路径，权限600）。默认单元可选加载此文件；`render-unit.mjs --service-env-file /绝对路径` 可改位置。CLI登录必须由实际服务用户完成，并使用相同的 HOME/CODEX_HOME；此文件不负责登录或复制凭据。

## 9. 配置改坏的常见后果

| 现象 | 原因 |
| --- | --- |
| 启动即退出并提示“生活规划需要启用world” | `life.planning.enabled=true` 但 `world.enabled!=true`。 |
| 所有回调 401 | `oneBotSecret` 与 NapCat 客户端 Token 不一致。 |
| 能收到消息但不回复 | 模型名不可用、Codex 未登录，或 `ownerUserIds` 里没有你。 |
| 回复一句“额度受限” | `runtimeBudget.mode` 是 `strict` 且没有校准记录。 |
| 生活页一直空白 | `life.enabled` 关闭，或还没有任何事件（允许空白是正常状态）。 |
