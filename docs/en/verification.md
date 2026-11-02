# Release acceptance record

> 中文: [docs/verification.md](../verification.md)

This file preserves **the historical validation record supplied by DSH with the initial 153-file release tree**. Counts, platforms and results below apply to that snapshot, not automatically to later revisions, and are not new runs from this review. Current Ubuntu tests and isolated installation checks are recorded in [GitHub Actions](https://github.com/wmffz2n4zd-cmd/Zhiwei2.0/actions/workflows/test.yml). Without a successful run for the relevant commit, treat those checks as unverified.

## 1. Environment

| Item | Value |
| --- | --- |
| Packaging and verification machine | Windows 11 (the packaging machine) |
| Node | v24.22.0 |
| npm | 11.19.1 |
| bash | GNU bash 5.3.15 (bundled with Git for Windows; used only for syntax checks and install-script trial runs) |
| Codex CLI | 0.166.0-alpha.5.1 (logged in; the health check really invoked `--version` and `login status`) |
| **Real Ubuntu host** | **None**: no WSL, no Docker, no usable Linux machine |

The historical checks ran in Unix-like tools or at the Node level on the packaging machine; they did not provide a real Ubuntu 24.04 installation record. Git for Windows bash results are not Linux host acceptance evidence.

> This release review does not connect to or use the maintainer's ECS for deployment or testing. An `ubuntu-24.04` CI workflow is included; check its actual run results before claiming success. CI uses synthetic data and does not replace real QQ, model or website acceptance.

## 2. Historical validation supplied by DSH

| # | Item | Command | Result |
| --- | --- | --- | --- |
| 1 | Syntax check | `node --check` over every `.js` / `.mjs` | 0 failures |
| 2 | Shell syntax | `bash -n deploy/install.sh bin/zhiwei` | 0 failures |
| 3 | Full test suite | `npm test` (serial, about 4.7 minutes) | 691 cases: **687 passed / 1 failed / 3 skipped** |
| 3b | Parallel rerun | `npm run test:parallel` (concurrency 4) | timing-sensitive cases occasionally time out; serial is therefore the default |
| 4 | Install script execution | ran `bash deploy/install.sh --owner … --bot …` on a copy (`npm` replaced by a stub) | **completed end to end, exit code 0**: generate config → render systemd unit → health check |
| 5 | Repeat install | ran the same command again (with the `USER` environment variable cleared) | correctly skipped the existing configuration, did not overwrite it, exit code 0 |
| 5b | Status entry point | `bash bin/zhiwei status` / `version` (with the service running) | printed channel, model, life and usage-allowance status; version `2.0.0` |
| 6 | Cold start | extract from the archive → initialise → `node src/server.js` | started cleanly with empty memory, empty profile and empty life |
| 7 | Endpoints | `GET /api/state`, `/api/platform`, `/life-observer.html`, `/world` | all 200 |
| 8 | End to end | the bundled `integration` + `private-only` + `assistant-profile` | 7/7 passed: signed callback → fake CLI → send path |
| 9 | Package integrity | verified against `MANIFEST.sha256` after extraction | 153 files (MANIFEST included), 0 mismatches |
| 10 | Redaction scan | keywords, private keys, 64-character key patterns | no hits; no runtime data, no `node_modules` |
| 11 | Linux readiness scan | relative imports across 105 scripts must match case exactly (Linux is case-sensitive) | 0 mismatches |
| 12 | Platform-assumption scan | searched for PowerShell / osascript / drive-letter paths / `/opt` | only branches explicitly gated by `isMac` and `win32` remain |
| 13 | Archive permission bits | checked the mode recorded inside the archive | `bin/zhiwei` and `deploy/install.sh` are 0755, all others 0644; executable straight after extraction |
| 14 | Reproducible build | packed twice in a row and compared SHA-256 | identical |
| 15 | Backup / restore drill | packed, moved away and extracted using the commands in `docs/en/operate.md` | `data/` fingerprint identical before and after the restore |
| 16 | Upgrade drill | ran once to generate real state → stopped → replaced the whole code block → started again | 18 protected files: **0 user data modified, 0 lost**; only 3 volatile files (two locks + the `snapshot.json` cache) were rewritten by the new process |
| 17 | Config validator | `npm run check`: a valid config / a deliberately corrupted config | valid config exited 0; the corrupted config (empty administrator + missing planning dependency) exited 1 and named both errors |

The end-to-end tests used stand-ins throughout: a fake OneBot service, a fake Codex CLI and a controllable clock. **No** message was sent to real QQ, **no** real model was called, and **no** real website was logged into.

## 3. Historical failures and explanations

| Failure | Cause | Impact |
| --- | --- | --- |
| The symlink case in `browser-router.test.mjs` | creating symlinks on Windows requires a privilege; `EPERM` | environment limitation; it should pass on Linux |
| `mood-integration` / some life timing cases time out when run in parallel | these cases depend on the real clock advancing, and parallel contention distorts the windows; they pass when run alone or serially | default switched to serial (4.7 minutes); `test:parallel` remains for fast iteration |
| The second run of the install script reported `USER: unbound variable` | `USER` was not set during the test, and the script uses `set -u` | **Fixed**: changed to a three-step fallback `SUDO_USER → USER → id -un`; re-tested and passed after the fix |
| Rendered unit-file paths containing spaces were left unquoted | —— | **Fixed**: paths containing spaces are double-quoted (observed in practice: `ExecStart="C:\Program Files\…"`) |
| The archive recorded every file as 0666 | Windows bsdtar does not carry Unix permission bits | **Fixed**: switched to a script that writes the tar explicitly; 0755/0644 are correct, and reproducible builds came out of the same change |
| On Linux the prompt for `/执行` tasks still said "use PowerShell on Windows" | the prompt had no platform branch | **Fixed**: non-Windows now says "use bash and POSIX paths" |

The failures are all kept in the maintenance record; nothing was deleted or rewritten to make the result look all green.

## 4. What the original release record did not verify

1. The full installation on a real Ubuntu 24.04 (`apt`, NodeSource, `npm ci`, permissions).
2. Installing and starting/stopping the systemd unit.
3. Real QQ send and receive (a real account was never connected).
4. Latency and usage-allowance behaviour of the real model call path.
5. Real website login and web page reading.
6. Compatibility with Node 20.10 / 22 (verified only on 24).
7. ARM, Windows, macOS.
8. The original record contained no GitHub Actions run. Check the CI link above for later results and the exact commit each run tested; a pass does not automatically apply to another revision.

## 5. How to re-verify it yourself

```bash
sha256sum -c MANIFEST.sha256     # package integrity
npm ci && npm test               # bundled tests
npm run setup -- --owner … --bot … --print-only   # show what would be written, without writing
npm run doctor                   # health check
```

If `npm test` shows timing-related timeouts on your machine, first make sure no other heavy task is running, or re-run serially with
`node --test --test-concurrency=1 tests/*.test.mjs`.
