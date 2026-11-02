# Architecture

> 中文: [docs/architecture.md](../architecture.md)

## 1. In one sentence

One Node process (the Hub) strings together QQ private chats, memory, the life timeline and model calls; the model is an external Codex CLI subprocess and QQ is external NapCat, and neither of the two belongs to this project.

```
QQ app ⇄ Tencent ⇄ NapCat (OneBot) ⇄ Hub (127.0.0.1:3789) ⇄ Codex CLI ⇄ model
                                    │
                                    ├─ data/unified-memory.json   memory and profile
                                    ├─ data/life/                 life timeline (event log)
                                    ├─ data/runtime-usage/        usage observation
                                    └─ data/world/                browsing and message board
```

## 2. Code map

| Path | Purpose |
| --- | --- |
| `src/server.js` | Main process: HTTP routing, inbound pipeline, prompt assembly, sending, startup wiring. About 5800 lines, of which about 2500 are the macOS-only iMessage channel, which never activates on Linux. |
| `src/portable.js` | Config loading, Codex path discovery, Skill, HMAC verification, the `/执行` task state machine |
| `src/life-timeline.js` | Life timeline: event log, state machine, persistence, single-writer lock |
| `src/life-state.js` | Projects events into mood and long-term interests (pure functions; no disk writes, no model calls) |
| `src/life-planner.js` | Lets the model produce thoughts and schedules (with count and interval limits) |
| `src/life-replies.js` | Busy notices, merged catch-up replies for backlogged messages, deduplication |
| `src/life-contacts.js` | Contact eligibility, pause/resume, proactive contact intent |
| `src/life-proactive.js` | Whether to proactively contact a given person |
| `src/life-conversation.js` | Trade-offs when a conversation conflicts with the next activity |
| `src/life-observer*.js` | The read-only observer page and its HTTP endpoints |
| `src/browser-*.js`, `src/world*.js` | Restricted browser reads, the message board, world state |
| `src/runtime-budget*.js`, `src/runtime-usage.js` | Usage allowance modes and usage recording |
| `src/private-profile.js`, `src/unified-memory/` | Per-person profile and the memory store |
| `modules/web-console/public/` | Static assets for the console, the read-only observer and the browsing page |

## 3. What a private message goes through

1. NapCat POSTs the message to `/api/onebot/event` with `X-Signature = sha1=HMAC(secret, body)`. If verification fails, the reply is an immediate 401.
2. Normalise the event; messages carrying a `group_id` are dropped here (private chat only).
3. Deduplicate (the same `message_id` is handled only once within 10 minutes), return 200 first, then write to storage.
4. 2.6-second batching (3.6 seconds at most): several consecutive plain-text/image messages are merged into one processing pass, which cuts model calls and message spam.
5. Admission: whether the sender is an admin, whether the channel is enabled, whether the sender is banned, whether a chat test is in progress.
6. The life layer steps in: it advances the timeline; if a `busy` activity is currently running, it sends back a status notice starting with `*` and the message goes into the queue.
7. Prompt assembly: the full persona text + life context + recent conversation + relevant memories + profile + quoted content + images.
8. `codex exec` subprocess generation (300-second default timeout, read-only sandbox), parsing the reply and the `[[qq_sticker:name]]` markers.
9. Sending: serialised per recipient; text goes first, and the sticker is sent separately once that succeeds; replies to `/` commands wait a random 2–6 seconds before being sent.
10. On success, the memory is written and the short-term mood committed; on failure, nothing is written. Timings go to `runtime/logs/qq-timings.jsonl`.

## 4. Life timeline

It is not a "list of scheduled tasks" but an **append-only event log**:

- Each line of `journal.jsonl` is a transaction carrying a `sequence` and the hash of the previous line, forming a hash chain; `snapshot.json` is only a replaceable cache; anything over 4 MiB is archived in segments. `.writer.lock` guarantees a single writer.
- State machine: plan `planned → active → completed / failed / cancelled / interrupted / missed`; thought `pending → planned / active / completed / failed / abandoned / expired / interrupted / missed`.
- Advancement relies on "injected clock + 15-second tick + lazy evaluation"; there is no "one timer per activity".
- **Downtime is not replayed**: at startup, leftover `active` entries are judged `interrupted`; an observation gap longer than 2 minutes is likewise judged an interruption; an expired window is recorded as `missed`. So the period while the machine is off does not exist in her life, and the model has no way to invent it.
- Busy activities have three limits: at most 45 minutes per occurrence, a 15-minute gap between two of them, and at most 120 minutes accumulated per day.

## 5. Mood and interest

Both are **deterministic projections** of events, not "values" that get stored:

- Mood has three axes `valence / energy / tension` and a half-life of 3 hours, and is driven only by events that actually happened (a completed reading, a failed activity, and so on).
- Interest has a half-life of 30 days; for a single topic the positive growth per day is capped at 0.3, and anything below 0.15 counts as dormant.
- There is also a separate 45-minute "short-lived micro-mood", isolated per recipient, committed only after the text has actually been sent successfully. The two are not the same thing.

## 6. Memory

- `data/unified-memory.json`; the scope is `qq:private:<QQ id>`, and different people cannot see each other's data.
- Retrieval sorts by "keyword + recency" and takes the top few entries; it is not vector retrieval. Long records are truncated by age (at most 2000 characters within 2 days, 280 characters from 2 to 7 days, 90 characters after 7 days).
- An ordinary private chat also carries the current person's conversation from the last 2 hours, up to 3 exchanges, as "recent context", so that "that thing from just now" can still be picked up.
- The profile extracts only explicitly stated names and preferences, preserves sources, and supports corrections and withdrawal. Capacity limits apply; it does not infer communication habits or fade facts with time. It uses the current person's persistent memory and is not shared between people.

## 7. Usage allowance

When `runtimeBudget.mode = observe` it only keeps records: each model call writes one `data/runtime-usage/<Beijing-day>.<instance>.jsonl` entry, recording the purpose, the result and the token count the model self-reports. Nothing is blocked.

`strict` mode is a conservative reservation: the weekly cap is counted as 75% of 80%, each call reserves allowance up front, a failure is not refunded, and the records need manual calibration. It is not used by default.

## 8. Web reading

- Playwright drives a separate browser profile, and requests are allowed according to a per-site allowlist; read mode forbids downloads, pop-ups, WebSocket and Service Worker, and for POST only precisely configured read-only endpoints are allowed.
- Page text and screenshots are fed to the model, but are **always marked as untrusted content**; on the CLI side tools and plugins are switched off, and any tool call terminates the run immediately.
- Login pages and CAPTCHA pages are not passed to the model, and their body text is cleared.
- These are **application-level policies**, not operating-system-level isolation: malicious pages, browser vulnerabilities and DNS rebinding all still carry residual risk.

## 9. Tests

`npm test` uses Node's built-in runner serially. Current counts and results come from [CI runs](https://github.com/wmffz2n4zd-cmd/Zhiwei2.0/actions/workflows/test.yml); historical counts are retained in the verification record. External dependencies are stand-ins: a fake OneBot service, a fake Codex CLI (which records prompts) and a controllable clock. Tests do not send real QQ messages or call a real model; real-model evaluation scripts are not part of this distribution.

**Why serial**: a dozen or so cases depend on real clock advancement (simulating a day's activities, busy windows, merged catch-up replies); run in parallel they contend with each other and time out intermittently. Serial execution is deterministic; for quick iteration you can use `npm run test:parallel` (concurrency 4), and re-check with `npm test` if something fails. A few cases need symlink permission; on Windows they are skipped or fail, and on Linux they work normally.
