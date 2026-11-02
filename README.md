# Zhiwei

**English** · [中文](README.zh-CN.md)

> A private-chat-only QQ companion with a life of her own. Chatting is just one of the things that happens on her timeline.

Zhiwei (知微) runs on your own Linux server and talks to you over QQ direct messages. She is not a question-answering bot that boots up when you speak: she plans a loose day for herself, forms thoughts, changes plans, reaches out to the outside world, accumulates experiences, keeps memories, grows moods that last hours and interests that last weeks — and occasionally thinks of you because of something she did.

Model requests run through the **Codex CLI** logged in on your machine. Allowances and charges depend on the account and authentication configured for that CLI; this project does not provide model credits.

```
you ──QQ DM──> NapCat ──OneBot──> Zhiwei Hub ──> Codex CLI ──> model
                                     │
                                     ├─ memory & profile (isolated per QQ account)
                                     ├─ life timeline (append-only, hash-chained)
                                     ├─ mood / interests (projected from events)
                                     └─ optional: web reading, read-only observer
```

## What she does

| Capability | Notes |
| --- | --- |
| Private chat | Answers only the accounts in `ownerUserIds`; group messages are dropped |
| Memory | Per-contact long-term memory, recent context carried automatically, keyword recall |
| Profile | Stores explicitly stated names and preferences; supports corrections, withdrawal and capacity limits, without automatic habit learning or time-based fading |
| Mood | Pushed by life events, lasts hours, colours wording — it never decides whether you get a reply |
| Interests | Can grow, fade and return; high interest does not imply competence |
| Life timeline | thought → plan → in progress → done/failed/interrupted; downtime is never replayed |
| Proactive contact | Driven by a thought, bounded by quiet hours, relationship age and a reconsideration interval; saying nothing is a valid outcome |
| Busy mode | One short status line starting with `*`; afterwards at most one merged catch-up reply |
| Web reading | Optional, isolated browser profile, read-only, allow-listed; no downloads or WebSockets |
| Observer | Read-only page: 1/7-day thoughts, activities, interest changes and their sources |
| Commands | `/状态`, `/记忆`, `/执行`, `/浏览` … only messages starting with `/` enter command mode |
| Split replies | Natural blank lines become up to three sequential messages, like a person typing |

## What she does not do

- **No groups.** She never joins one and never answers group messages. This is a product boundary, not a switch.
- No video understanding, no voice messages, no QQ Zone activity.
- No promise of free, unlimited or fully offline operation: model calls spend your own account quota.
- No faking: without a source she will not claim she just read something.

## Quick start (Ubuntu 24.04 x86_64)

```bash
# 1. dependencies
sudo apt install -y curl git unzip xvfb fonts-noto-cjk
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs

# 2. choose the regular service user before installing and logging in to the CLI
sudo useradd -m -s /bin/bash zhiwei   # skip if the dedicated user already exists
sudo -iu zhiwei
codex login

# 3. code and dependencies
git clone https://github.com/wmffz2n4zd-cmd/Zhiwei2.0.git ~/zhiwei && cd ~/zhiwei && npm ci

# 4. initialise (generates your own secrets; the bot QQ must differ from yours)
npm run setup -- --owner YOUR_QQ --bot BOT_QQ

# 5. start
npm start          # foreground trial run
npm run check      # validate the configuration
npm run doctor     # check CLI, bridge, timeline, browsing
```

The full instructions below also install and log in to NapCat and configure both OneBot connections. For image input, repeat `--qq-image-cache-root /actual/cache/directory` for each allowed cache root. Without a configured root, image and static-sticker vision are unavailable; text chat still works. `--napcat-dir` only selects where to write the bridge configuration; it does not discover or install NapCat.

Once the bridge is configured, send `/帮助` to the bot from your own QQ account.

Full instructions, including NapCat installation, login and systemd: **[docs/en/install.md](docs/en/install.md)**.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/en/install.md](docs/en/install.md) | From a bare machine to a working chat |
| [docs/en/configure.md](docs/en/configure.md) | Every configuration key |
| [docs/en/operate.md](docs/en/operate.md) | Start/stop, logs, re-login, upgrade, backup and restore |
| [docs/en/architecture.md](docs/en/architecture.md) | Data flow, life engine, memory, usage allowance |
| [docs/en/security.md](docs/en/security.md) | Trust boundaries and known issues (**read before deploying**) |
| [docs/en/faq.md](docs/en/faq.md) | Common questions |
| [docs/en/verification.md](docs/en/verification.md) | What was and was not tested before release |
| [docs/en/release-audit.md](docs/en/release-audit.md) | Redaction and licence checks performed for this release |

Chinese originals live in [docs/](docs/) (install.md, configure.md, operate.md, architecture.md, security.md, faq.md, verification.md, release-audit.md).

## Layout

```
src/                          main process and subsystems
modules/web-console/public/   console, observer, browsing pages
config/                       persona text
scripts/                      setup, checks, operations
deploy/                       systemd unit template and install script
tests/                        synthetic tests (fake OneBot + fake CLI + controllable clock)
data/                         your runtime data (git-ignored)
docs/                         deployment documentation
```

## What you need to bring

1. A **separate bot QQ account**, friends with your admin account.
2. A working **Codex CLI login**.
3. **NapCat** installed from its official docs (third party, not bundled; account risk is real — use a spare account).
4. **Chromium**, only if you want web reading.

## A note on language

The documentation is bilingual, but **the product itself is Chinese**: the persona, the prompts and the web console are written in Chinese. English documentation helps you deploy and operate her; it does not make her speak English.

## Data and privacy

Memory, profiles, the life journal, browser sessions and usage records are stored primarily in local `data/`. Private image caches live in `tmp/qq-images/`; raw model output and diagnostics live in `runtime/`. Git ignores these runtime directories. To generate replies, the current message, relevant history/profile and available images are passed to the configured model service: local storage does not mean the content never leaves the machine. See [backup scope and separate login state](docs/en/operate.md).

Read [docs/en/security.md](docs/en/security.md) before deploying: the local HTTP API has no authentication and this machine should not be shared.

## Version

`2.0.0`. See [CHANGELOG.md](CHANGELOG.md).

## Licence

Released under the **MIT** licence — see [LICENSE](LICENSE). Third-party components and attribution: [NOTICE.md](NOTICE.md).

> Historical validation is recorded in [docs/en/verification.md](docs/en/verification.md). This release review does not use the maintainer's ECS. Current Ubuntu test and isolated installation-check results are published in [GitHub Actions](https://github.com/wmffz2n4zd-cmd/Zhiwei2.0/actions/workflows/test.yml). A workflow file is not evidence of a passing run, and CI does not replace real QQ/model acceptance testing.

## Acknowledgements

- Upstream project [Codex Remote Contact](https://github.com/Epic0522/Codex-Remote-Contact): the starting point for the Hub, web console and QQ channel.
- [NapCat](https://github.com/NapNeko/NapCatQQ): the QQ ↔ OneBot bridge; not bundled here.
- OpenAI Codex CLI: model calls and task execution.
- [Playwright](https://playwright.dev/): browser control for web reading.
