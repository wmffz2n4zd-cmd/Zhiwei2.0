# Frequently asked questions

> 中文: [docs/faq.md](../faq.md)

**Will she come to me first? How often?**
Yes, but not as a scheduled greeting. Proactive contact requires that the timeline happens to contain a "feel like talking to someone" thought that turns into an activity, and that all of the following hold: at least 10 minutes since the last message, the other person has shown up within the last 30 days, and the same person has not been considered in the last 6 hours. If any one of these is not met, nothing is sent. There is no quota, and no "must make contact once a day" logic; going several days without proactive contact is a normal outcome.

**Why is she quiet all the time after installation?**
Three possibilities, checked in order: ① the life timeline is not on (`life.enabled`); ② the most recent planning run scheduled only simulated activities, with no contact thought, and the next planning run is 4–24 hours away; ③ the only contact has been marked "contact paused" (after an explicit "stop contacting me"). The read-only observer shows the thought and activity records; if there is no record, there really was none.

**Why are replies sometimes slow?**
Generation is one Codex subprocess call, with a default timeout of 300 seconds; the slowness is on the model side, not in this project. Consecutive messages from the same person queue up; generation does not run in parallel.

**Why does she send several messages at once?**
An ordinary reply may use blank lines to split into up to 3 paragraphs, sent one after another in order, imitating a real person firing off several messages. Short answers, command replies and structured content are not split.

**Does she make up things like "I read a book today"?**
By design she is not allowed to. Planned, in progress, completed and failed are different states; only a reading that actually completed becomes an external experience, and web reads carry their source as well. With no record she can only say what she wants to do, not that she has already done it.

**Can I add her to a group?**
No. This version supports private chat only: group messages are dropped before they reach the model, and the sending side blocks the group API too. `qqPrivateOnly` cannot be turned off by configuration.

**Can I swap in my own character?**
Yes. Edit `config/zhiwei-profile.md`, or point `assistantProfile` at your own file, or set the environment variable `CODEX_REMOTE_CONTACT_ASSISTANT_PROFILE_PATH`. The persona file is re-read every time, so no restart is needed after editing.

**Can I change the model?**
Yes. In `data/local.json`, set `chatModel` / `chatReasoningEffort`; or send `/私聊模型 名称` or `/私聊智能等级 low|medium|high|xhigh` in a private chat. The model must be a name the account logged in with `codex login` can use.

**Does she remember what I said?**
Yes. Memory is stored in `data/unified-memory.json`, isolated by QQ number. Profiles store only explicitly stated names and preferences, with corrections, withdrawal and capacity limits; they do not infer communication habits or fade facts with time. Bounded context from the last 2 hours can accompany a reply; older material is retrieved using keywords and other conditions. Necessary context is passed with the current message to the model service.

**What does "usage allowance limited" mean?**
It means `runtimeBudget.mode` is `strict` and there is no calibration record. The default is `observe`: only records, no blocking. But observe does not mean free — the allowance still comes out of your own account.

**Are Windows / macOS / ARM supported?**
This distribution targets Ubuntu 24.04 x86_64 only. The upstream macOS-native channels (iMessage, Shadowrocket, backlight control) are still in the code, but they do not activate on Linux and are outside the supported scope. ARM is unverified.

**Can I use it without QQ?**
No. The only channel in this distribution is QQ private chat (via NapCat to OneBot).

**How do I move the data away / delete it for good?**
Primary persistent state is under `data/`, private images under `tmp/qq-images/`, and output/diagnostics under `runtime/`. NapCat, Codex authentication and custom workspaces may be outside the repository. Preserve those locations according to the [backup scope](operate.md). Removing only `data/` is neither a complete migration nor removal of all sensitive content, and also removes application configuration: private chat will need initialization again. Stop the service and decide what must be preserved before cleanup or recovery.

**The read-only observer won't open?**
It allows local loopback access only, and it rejects requests carrying `X-Forwarded-*`. On a server, use SSH port forwarding: `ssh -L 13789:127.0.0.1:3789 user@server`, then visit `http://127.0.0.1:13789/life-observer.html`.

**Can several QQ numbers all chat with her?**
By default, only the numbers in `ownerUserIds`. Turning on `allowOtherPrivateChats` lets any stranger chat as well, each leaving behind their own memory and profile — not recommended.

**Will a restart lose anything?**
A normal stop does not: the service waits for received messages and writes to complete (600 seconds at most). A forced `kill -9` or a power cut may lose the last few messages that were ACKed but not yet stored. The life timeline has a hash chain and half-line repair, so old activities are not executed again after a restart.

**After copying back a backup or an older version of `data/`, the service fails to start and the log says the life journal is invalid?**
The life timeline is an append-only log with a hash chain and sequence numbers (`data/life/journal.jsonl`). Manual edits, overwriting only some of the files, or mixing `data/` directories from different versions will all make verification fail. The program's handling is to **refuse to start and keep the original files**, rather than quietly discarding or rewriting your history. The right way: stop the service, replace the whole `data/` directory (do not pick out just a few files), then start again; if recovery is truly impossible, move `data/life/` away and let it rebuild (the life history is lost; chat memory is unaffected).

**Does she keep sending "I'm here"?**
An early version really did have this problem on pure-image messages; it has been fixed so that "body text / images / quotes / @ mentions" are described separately. If you still run into it, please report back along with what the message looked like at the time.
