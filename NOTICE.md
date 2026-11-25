# Attribution and dependencies

Zhiwei grew from [Codex Remote Contact](https://github.com/Epic0522/Codex-Remote-Contact). The upstream author and the Zhiwei maintainer are different people. The maintainer confirms explicit permission from the upstream author for this distribution. This repository distributes Zhiwei under the [MIT license](LICENSE). The original upstream snapshot carried no license file at handover.

The release includes the Zhiwei character profile and web artwork. Third-party runtimes, model credentials and browser profiles are installed or supplied by the person deploying the service.

| Dependency | Use |
| --- | --- |
| better-sqlite3 | PWA accounts, sessions, chat and space records |
| sharp | Reading, resizing and exporting images |
| playwright-core | Browser control for reading, tests and the offline webpage worker |
| web-push | Web Push encryption and delivery |

The exact npm package versions and package metadata are recorded in [package-lock.json](package-lock.json). Node.js, Codex CLI, Chromium or Chrome, Caddy and optional video tools are distributed separately by their respective projects.
