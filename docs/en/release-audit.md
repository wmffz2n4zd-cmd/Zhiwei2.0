# Release audit record

> 中文: [docs/release-audit.md](../release-audit.md)

This file is a **redacted** release audit summary: it describes only categories, scope and results, and contains no mapping to any real account, address or path. The per-file sensitive mapping is kept in the maintainer's private working record and is not distributed with the release.

Sections1–2 preserve DSH's historical audit of the initial release tree and archive; those counts do not automatically cover later edits. `MANIFEST.sha256` lists the current release tree. See the [verification record](verification.md) and the relevant CI commit for validation status.

## 1. Historical provenance and extraction

- The source is a source snapshot of a private deployment instance that is already live, extracted by an **explicit allowlist**, not by copying the whole repository.
- During extraction, every file's SHA-256 and byte count was compared against the source manifest; after extraction, the written result was compared once more.
- Extraction result: 108 files byte-identical to the source, 7 files adapted for release, the rest newly added for the release (English documentation included).
- Adaptation covered only: configuration file path compatibility, startup self-check, package name and script entry points, console page links and copy, and the health-check script.
- Engineering records, the deployment toolchain, real-model evaluation scripts, runtime data, backups and logs were **all excluded**.

## 2. Historical redaction check

| Category | What was checked | Result |
| --- | --- | --- |
| Credentials | callback secret, access token, password, private key, Cookie, Codex login cache | Not found. The release contains no keys at all; they are generated locally by the deployer during initialisation |
| Private chat content | memory entries, conversation summaries, profile, notes, pending messages | Not found. `data/` holds only the explanatory file |
| Personal identifiers | real QQ numbers, nicknames, group numbers, avatars | Not found. Every example uses placeholder numbers |
| Infrastructure | server addresses, hostnames, tunnels, port-forwarding configuration | Not found |
| Local machine paths | drive-letter absolute paths, user directories, paths of neighbouring private projects | Not found. Only illustrative paths in regexes and test fixtures remain (e.g. `C:/secret`) |
| Internal engineering material | requirement IDs, acceptance evidence, task records, handover documents, screenshots | Not found |
| Binaries and media | sticker packs, screenshots, archives, third-party runtimes, browsers | Not found. The sticker directory is empty; third-party runtimes are installed by the deployer |
| Logs | runtime logs, timing logs, error snapshots | Not found |

Supplementary notes:

- Persona files are kept because they are fictional character settings and contain no real-person information; the crossover experiences drawn from other works are marked as creative setting.
- The accounts (e.g. `123456`) and URLs (e.g. `example.com`, `127.0.0.1`) in the test cases are all synthetic.
- Scanning tools can only cover known patterns; the conclusions above were also reviewed manually, file by file, focusing on comments, examples, file names and documentation wording.

## 3. Licence review

| Component | Distributed with the release | Licence |
| --- | --- | --- |
| playwright-core 1.64.1 | No; declared dependency, fetched by the deployer through `npm ci` | Apache-2.0 |
| Codex CLI | No | Set by upstream |
| NapCat | No | Set by upstream |
| Node.js / Chromium | No | Their own licences |
| Character text | Yes | Original work of the project owner |

This repository and upstream have different authors. The maintainer confirms explicit upstream-author permission for this distribution, which retains **MIT** (see `LICENSE`). This records that confirmation without reproducing or expanding the separate permission terms. The upstream snapshot had no LICENSE; no licence is inferred for other upstream copies. Third-party runtimes are not bundled, and deployers must follow their respective licences.

## 4. Not covered and known limitations

- The historical record did not include real Ubuntu24.04 installation or systemd startup/shutdown acceptance. This review does not use the maintainer's ECS. Check [actual CI runs](https://github.com/wmffz2n4zd-cmd/Zhiwei2.0/actions/workflows/test.yml) for Ubuntu synthetic tests and installation checks; these are not real QQ/model acceptance.
- No acceptance used a real QQ account, real model calls or real website logins; everything used synthetic events, a simulated bridge and a simulated CLI.
- The full security properties of the upstream code were not audited; only this release's admission, signing, isolation and redaction paths were checked.
- ARM, Windows and macOS were not verified.

## 5. How to re-verify

Anyone can verify this independently:

```bash
sha256sum -c MANIFEST.sha256          # file integrity
grep -rn "TODO\|FIXME" src/ | head    # check the leftover markers yourself
node --test tests/*.test.mjs          # run the bundled tests
```
