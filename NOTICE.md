# Third-party notices

*(中文说明见 [README.zh-CN.md](README.zh-CN.md)。)*

This distribution **does not bundle** any third-party runtime listed below under "Not distributed"; deployers install those themselves. This file records the relationship and the licence so the release can be reviewed.

## Runtime dependency (installed separately)

| Component | Version | Licence | Notes |
| --- | --- | --- | --- |
| [playwright-core](https://github.com/microsoft/playwright) | 1.64.1 (see `package-lock.json`) | Apache-2.0 | Declared dependency fetched by `npm ci`; neither its installed files nor browser binaries are bundled. |

## Not distributed

| Component | Licence | Notes |
| --- | --- | --- |
| [Codex CLI](https://github.com/openai/codex) | As set by upstream | Model calls and task execution; install and log in yourself. |
| [NapCat](https://github.com/NapNeko/NapCatQQ) | As set by upstream | QQ ↔ OneBot bridge; install it yourself. This project only talks to its HTTP API. |
| Node.js | MIT and third-party licences | Runtime. |
| Chromium / Chrome | Respective licences | Only used if you enable web reading. |

## Character and text

`config/zhiwei-profile.md` is an original character written by the project owner, including fictional cross-franchise experiences (Faerûn, Warhammer, and others). These are creative fiction, not canon for the referenced works, and contain no real person's private information.

## Upstream origin and licensing

This project started from [Codex Remote Contact](https://github.com/Epic0522/Codex-Remote-Contact), and adds private-chat-only operation, the life timeline, memory and profiles, the observer, and split replies.

This repository and upstream have different authors. The maintainer confirms having explicit permission from the upstream author for this distribution. The release uses **MIT**, see [`LICENSE`](LICENSE). This notice records the maintainer's confirmation; it does not reproduce or expand the separate permission terms.

The upstream snapshot carried no `LICENSE` file at hand-over time. The permission confirmed for this distribution is not a declaration that every other upstream copy has the same licence; consult its author for those copies.

## Assets

This distribution contains no sticker images, web screenshots, chat logs, logs or personal data of any kind.
