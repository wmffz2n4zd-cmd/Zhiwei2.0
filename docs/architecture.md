# 架构

> English: [docs/en/architecture.md](en/architecture.md)

## 1. 一句话

一个 Node 进程（Hub）把 QQ 私聊、记忆、生活时间线和模型调用串起来；模型是外部的 Codex CLI 子进程，QQ 是外部的 NapCat，两者都不属于本项目。

```
手机QQ ⇄ 腾讯 ⇄ NapCat(OneBot) ⇄ Hub(127.0.0.1:3789) ⇄ Codex CLI ⇄ 模型服务
                                    │
                                    ├─ data/unified-memory.json   记忆与画像
                                    ├─ data/life/                 生活时间线（事件日志）
                                    ├─ data/runtime-usage/        用量观察
                                    └─ data/world/                浏览与留言板
```

## 2. 代码地图

| 路径 | 作用 |
| --- | --- |
| `src/server.js` | 主进程：HTTP 路由、入站流水线、提示词装配、发送、启动装配。约 5800 行，其中约 2500 行是仅 macOS 可用的 iMessage 通道，在 Linux 上永不激活。 |
| `src/portable.js` | 配置加载、Codex 路径发现、Skill、HMAC 校验、`/执行` 任务状态机 |
| `src/life-timeline.js` | 生活时间线：事件日志、状态机、持久化、单写者锁 |
| `src/life-state.js` | 把事件投影成情绪与长期兴趣（纯函数，不写盘、不调模型） |
| `src/life-planner.js` | 让模型产生念头与日程（有次数和间隔约束） |
| `src/life-replies.js` | 忙时提示、积压消息合并补答、去重 |
| `src/life-contacts.js` | 联系人资格、暂停/恢复、主动联系意图 |
| `src/life-proactive.js` | 是否主动联系某人 |
| `src/life-conversation.js` | 对话与下一活动冲突时的取舍 |
| `src/life-observer*.js` | 只读观察页与它的 HTTP 端点 |
| `src/browser-*.js`, `src/world*.js` | 受限浏览器读取、留言板、世界状态 |
| `src/runtime-budget*.js`, `src/runtime-usage.js` | 额度模式与用量记录 |
| `src/private-profile.js`, `src/unified-memory/` | 对象画像与记忆库 |
| `modules/web-console/public/` | 控制台、观察台、浏览页的静态资源 |

## 3. 一条私聊消息经历了什么

1. NapCat 把消息 POST 到 `/api/onebot/event`，带 `X-Signature = sha1=HMAC(secret, body)`。校验失败直接 401。
2. 归一化事件；带 `group_id` 的消息在此丢弃（仅私聊）。
3. 去重（同 `message_id` 10 分钟内只处理一次），先回 200 再入库。
4. 2.6 秒合批（最长 3.6 秒）：连续几条纯文本/图片合成一次处理，减少模型调用与刷屏。
5. 准入：是否管理员、通道是否开启、是否被 ban、是否在聊天测试中。
6. 生活层介入：推进时间线；如果当前有 `busy` 活动，回一条 `*` 开头的状态提示，消息进队列。
7. 装配提示词：人格全文 + 生活上下文 + 近期对话 + 相关记忆 + 画像 + 引用内容 + 图片。
8. `codex exec` 子进程生成（默认 300 秒超时，read-only 沙箱），解析回复与 `[[qq_sticker:名]]` 标记。
9. 发送：按对象串行；先发文字，成功后单独发表情；`/` 指令的回复在发送前随机等 2–6 秒。
10. 成功后写记忆、提交短期情绪；失败不写。耗时写进 `runtime/logs/qq-timings.jsonl`。

## 4. 生活时间线

它不是“定时任务列表”，而是一份**只追加的事件日志**：

- `journal.jsonl` 每行是一个事务，带 `sequence` 与前一行 hash，形成哈希链；`snapshot.json` 只是可替换的缓存；超过 4 MiB 分段归档。`.writer.lock` 保证单写者。
- 状态机：计划 `planned → active → completed / failed / cancelled / interrupted / missed`；念头 `pending → planned / active / completed / failed / abandoned / expired / interrupted / missed`。
- 推进靠“注入时钟 + 15 秒 tick + 懒判定”，没有“每个活动一个定时器”。
- **不补演停机期**：启动时把残留的 `active` 判为 `interrupted`；观测空档超过 2 分钟同样判中断；窗口过期记 `missed`。所以关机那段时间在她的人生里不存在，模型也无从编造。
- 忙碌活动有三重限制：单次 ≤45 分钟、两次之间留 15 分钟、每天累计 ≤120 分钟。

## 5. 情绪与兴趣

都是事件的**确定性投影**，不是存下来的“数值”：

- 情绪三轴 `valence / energy / tension`，半衰期 3 小时，只由真实发生的事件（完成的阅读、失败的活动等）推动。
- 兴趣半衰期 30 天，同一话题每天正增长上限 0.3，低于 0.15 视为沉寂。
- 另外有一套 45 分钟的“短期小情绪”，按对象隔离，只在文字真正发送成功后提交。两者不是一回事。

## 6. 记忆

- `data/unified-memory.json`，scope 是 `qq:private:<QQ号>`，不同人互不可见。
- 检索是“关键词 + 新近程度”排序取前若干条，不是向量检索；长记录会按年龄截断（2 天内最多 2000 字，2–7 天 280 字，7 天后 90 字）。
- 普通私聊会把当前对象最近 2 小时内最多 3 轮对话作为“近期上下文”一并带上，避免“刚才那个”捡不回来。
- 画像只提取明确自述的称呼与喜好，保留来源，支持更正和撤回；有容量裁剪，不自动归纳交流习惯或按时间淡化。画像来自当前对象的持久记忆，不跨对象共享。

## 7. 额度

`runtimeBudget.mode = observe` 时只记账：每次模型调用写一条 `data/runtime-usage/<北京日>.<实例>.jsonl`，记录用途、结果、模型自报的 token。不拦截。

`strict` 模式是保守预扣：周上限按 80% 的 75% 计，每次调用先占额度，失败不退，需要人工校准记录。默认不用它。

## 8. 网页阅读

- Playwright 驱动独立浏览器 profile，按站点白名单放行请求；读模式禁下载、弹窗、WebSocket、Service Worker，POST 只放行精确配置的只读端点。
- 页面文字与截图会喂给模型，但**一律标记为不可信内容**；CLI 侧关闭工具与插件，出现工具调用立即终止。
- 登录页/验证码页不会送进模型，正文会被清空。
- 这些是**应用层策略**，不是操作系统级隔离：恶意页面、浏览器漏洞、DNS 重绑定都仍有残余风险。

## 9. 测试

`npm test` 用 Node 自带的测试运行器串行执行。用例数和结果以当前 [CI运行](https://github.com/wmffz2n4zd-cmd/Zhiwei2.0/actions/workflows/test.yml) 为准；历史计数见发行验收记录。外部依赖使用替身：假 OneBot 服务、假 Codex CLI（会记录收到的提示词）、可控时钟。测试不会向真实 QQ 发消息，也不会调用真实模型（`scripts/evaluate-*.mjs` 那类真实模型评估不进本发行版）。

**为什么串行**：有十几个用例依赖真实时钟推进（模拟一天里的活动、忙碌窗口、合并补答），并行跑时相互争用会让它们偶发超时。串行是确定性的；想快速迭代可以用 `npm run test:parallel`（并发 4），失败时再用 `npm test` 复核。个别用例需要符号链接权限；Windows 上会跳过或失败，Linux 上正常。
