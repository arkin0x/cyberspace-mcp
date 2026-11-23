# Releasing cyberspace-mcp

A release is three files on a GitHub Release, built from a version tag:

| File | What it is |
|---|---|
| `cyberspace-mcp-<version>.tar.gz` | The self-contained bundle: one folder, `cyberspace-mcp-<version>/`, with the committed `dist/` (checked against `src/`), the production `node_modules` installed from the lockfile, `package.json`, the lockfile, README, QUICKSTART, LICENSE and `docs/agents.md`. |
| `cyberspace-mcp-<version>.tar.gz.sha256` | Its SHA-256, in `sha256sum` format. |
| `cyberspace-mcp-<version>.tar.gz.sig.json` | The release key's BIP-340 signature over a manifest holding that hash (added by the key's holder after a local rebuild; see step 4). |

The bundle needs only Node 22 or newer. No git, no npm, no network, no build: every production dependency is plain JavaScript (the native modules in the lockfile belong to devDependencies), so one bundle serves Linux, macOS and Windows. It is about 7 MB packed and 43 MB unpacked. Nothing is published to npm (decision D1, 2026-11-09: npm needs the owner's account; deferred).

## Using a release

```sh
curl -LO https://github.com/arkin0x/cyberspace-mcp/releases/download/v<version>/cyberspace-mcp-<version>.tar.gz
curl -LO https://github.com/arkin0x/cyberspace-mcp/releases/download/v<version>/cyberspace-mcp-<version>.tar.gz.sha256
sha256sum -c cyberspace-mcp-<version>.tar.gz.sha256        # macOS: shasum -a 256 -c
tar -xzf cyberspace-mcp-<version>.tar.gz
node cyberspace-mcp-<version>/dist/bin.js --help
```

On Windows 10 and later, in PowerShell (`tar` is built in):

```powershell
curl.exe -LO https://github.com/arkin0x/cyberspace-mcp/releases/download/v<version>/cyberspace-mcp-<version>.tar.gz
curl.exe -LO https://github.com/arkin0x/cyberspace-mcp/releases/download/v<version>/cyberspace-mcp-<version>.tar.gz.sha256
(Get-FileHash cyberspace-mcp-<version>.tar.gz -Algorithm SHA256).Hash.ToLower()   # must equal the first word of the .sha256
tar -xzf cyberspace-mcp-<version>.tar.gz
node cyberspace-mcp-<version>\dist\bin.js --help
```

Then check the signature with `scripts/verify-manifest.mjs` (README, "Release key"; [signing.md](signing.md)).

Point an MCP client at `node /absolute/path/to/cyberspace-mcp-<version>/dist/bin.js --state /absolute/path/to/state`. Keep the state directory outside the bundle's folder, so a newer bundle can replace the folder.

## Cutting a release

1. **Bump the version** in a normal PR: `npm version <x.y.z> --no-git-tag-version` changes `package.json` and the lockfile. Merge it.
2. **Tag the merged commit** on master and push the tag (the owner's call; agents never tag):
   ```sh
   git tag -a v<x.y.z> -m "cyberspace-mcp <x.y.z>" <merged commit>
   git push origin v<x.y.z>
   ```
3. **The `release` workflow** (`.github/workflows/release.yml`) runs on the tag, in two jobs. **build** (a read-only token, not kept in `.git`) runs `npm ci`, typecheck, the tests and `check:dist`; then `scripts/release-bundle.mjs` builds the bundle, refusing a tag that is not `v` plus `package.json`'s version; then `scripts/smoke-bundle.mjs` checks it with no network (its sha256, no `typescript`, no symlinks, `--help`, an MCP initialize and tool list over stdio, and two worker entries loading). It uploads the tarball and the `.sha256` as a workflow artifact. **attach** (the only job that can write, and it runs no repository code) downloads the artifact and attaches both files to a **draft** release for the tag. A draft is visible only to the repository's writers, so nobody downloads a release before it is signed. If a release for the tag exists already, the files are added only if it is still a draft, and an existing file is never replaced (a replaced file would no longer match its signature).
4. **Rebuild locally and sign**, on the machine that holds the release key (never in CI). The signer does not trust CI's build: in a clean checkout of the tag, after `npm ci --ignore-scripts`, it rebuilds the bundle with `scripts/release-bundle.mjs` and refuses to sign unless the local sha256 equals the draft's. The bundle is reproducible (the same commit gives the same bytes), so a mismatch means CI built something else. Then attach the `.sig.json` to the draft. The commands, the file format and how anyone verifies it are in [signing.md](signing.md). The rebuild needs GNU tar (Linux) and Node 22 with its bundled npm, as the workflow uses.
5. **Check the draft**: download it as a stranger would and run `verify-manifest.mjs release` on it.
6. **Publish the draft** on GitHub (Releases, Edit, Publish release), or `gh release edit v<x.y.z> --draft=false`.
7. **Re-pin the OpenClaw skill** (`skills/cyberspace/SKILL.md`): set the version and the bundle's sha256 in its install spec and its `openclaw mcp add` line, re-sign the skill's manifest, and open a PR.
8. **Publish the update notice**, on the machine that holds the release key, after the release is published (so the URL in the asset works): a dry run first, then the same line with `--publish`. Agents never run it with `--publish`; the key's holder does.
   ```sh
   node scripts/publish-update-notice.mjs --key <keyfile> --version <x.y.z> \
     --sha256-file release/cyberspace-mcp-<x.y.z>.tar.gz.sha256 \
     --note "<one plain line: what this release fixes>" \
     [--security] [--min-safe <x.y.z>]          # dry run: prints all three events, sends nothing
   node scripts/publish-update-notice.mjs ... --publish
   ```
   `--security` marks a release that fixes a security hole. `--min-safe` names the oldest version still safe to run: every older copy switches off strangers' words and wallet payments until it is updated ("Update notices" below). It can only be raised: a copy keeps the highest minimum it ever saw, so a minimum set by mistake stays set on every copy that heard it until those copies update past it. Give it only for a hole a stranger or a payment can reach. The note must be one plain line of at most 280 characters with no link (copies show nothing else of the notes). The commit is read from the tag `v<x.y.z>` in the clone, or given with `--commit`. The script reads the release back with the server's own parser before anything is sent, refuses to publish with any key but the release key, and after publishing reads it back from each relay.

## How the bundle is built

`scripts/release-bundle.mjs [--tag vX.Y.Z] [--out release]` (run `npm ci` first, for `tsc`):

- ships the committed `dist/` after checking it: it compiles `src/` into a scratch folder and refuses unless that gives the same files and every `.js` byte for byte. The committed `dist/` is shipped rather than the scratch build because its source maps name their sources relative to the repository (`../src/bin.ts`), while a compile into another folder writes that folder's path into every map, which would make CI's bundle and the key holder's rebuild differ. Then it marks `dist/bin.js` executable;
- copies `package.json`, the lockfile and what `package.json`'s `files` lists;
- runs `npm ci --omit=dev --omit=optional --ignore-scripts --no-bin-links` there (no `node_modules/.bin` symlinks, which Windows tar cannot unpack; the script refuses to pack any symlink). `--omit=optional` keeps out `typescript`, which the lockfile marks `devOptional` (a devDependency here and an optional peer of nostr-tools); the script refuses to run if the lockfile ever gains a genuine optional production dependency, which that flag would drop;
- packs with GNU tar, entries sorted, mtimes set to the commit's time (`SOURCE_DATE_EPOCH`, else HEAD's commit time), owner 0:0, normalized modes, and `gzip -n`;
- never overwrites: it stops if either output file exists.

It needs GNU tar, so it runs on Linux (the workflow uses `ubuntu-latest`). On macOS, install `gnu-tar` and put it first on PATH as `tar`.

## Update notices

Every running copy learns of a release from the release key's nostr events, never from GitHub, and tells its operator; it never installs anything. The code is `src/updates.ts`, the publisher `scripts/publish-update-notice.mjs` (step 8), and what the operator sees is in the README ("Update notices").

**The events are NIP-82's** ("Software Applications", [nostr-protocol/nips#2526](https://github.com/nostr-protocol/nips/pull/2526), a draft in use by Zapstore, ngit and Amethyst; chosen over a kind of our own on 2026-11-23, so other clients read our releases too). The script publishes three, signed by the release key, to `wss://relay.onosendai.tech` (and any `--relay`):

| Kind | What | Tags |
|---|---|---|
| 32267 | The app listing, republished each time (addressable, `d` `cyberspace-mcp`) | `name`, `f` for every platform Node 22 runs on (NIP-82: software that runs everywhere lists every platform), `summary`, `url`, `repository`, `license` |
| 3063 | The bundle | `i`, `x` (the bundle's sha256), `version`, `m` `application/gzip`, `f`, `url` (the GitHub release download), `size`, `filename`, `commit`, `min_allowed_version` |
| 30063 | The release (addressable, `d` `cyberspace-mcp@<version>`) | `i`, `version`, `d`, `c` `main`, `f`, `e` (the 3063), `a` (the 32267's address), `commit`, and ours: `security` (`true` or `false`) and `min_allowed_version` (a copy of the 3063's standard tag, so one event says it). The content is the note. |

Two deviations from the draft, both deliberate: NIP-82's Appendix C lists no generic archive, and our bundle is a `.tar.gz` (it needs Node, which NIP-82 calls a standard runtime, but not dependency resolution: every dependency is inside); and `security` and `min_allowed_version` on the 30063 are our additions, which readers that do not know them skip.

**How a copy reads them.** It asks for `{"kinds": [30063], "authors": [<release key>], "#i": ["cyberspace-mcp"], "limit": 100}` and keeps the subscription open. An event counts only when all of this holds; otherwise it is ignored whole:

- the signature verifies over the event as received, and the author is the release key compiled into `src/updates.ts`;
- kind 30063, `i` is `cyberspace-mcp`, `version` is strict `X.Y.Z` (each part at most six digits; no `v`, no pre-release), `d` is `cyberspace-mcp@<version>`, `c` is `main`, exactly one `a` naming `32267:<release key>:cyberspace-mcp`, at least one `f` and at least one `e` with a 64-hex id;
- `min_allowed_version`, when present, is strict `X.Y.Z` and not above `version`; `security`, when present, is `true` or `false`; `commit`, when present, is 40 hex;
- no single-valued tag appears twice or carries extra values, the notes are at most 64 KB, and it is not dated more than ten minutes ahead of the copy's clock.

Then: the latest release is the highest version (for the same version, the newer event, as NIP-82 lets a bad release be overwritten), so a backport published after a newer release does not win. The minimum safe version is the highest `min_allowed_version` any counted release carried, kept in `update.json` and never lowered, so a relay that hides events or replays old ones cannot roll it back. The operator sees only the first line of the notes, at most 280 characters, and nothing when it holds a link or a character that can disguise text; the update commands always come from the code.

**Why notify only.** A server that installed what a signed event told it to would hand the release key code execution on every machine that runs it. A stolen key can do much less here: announce a version that does not exist (the commands still fetch from GitHub, which the key does not control), or raise the minimum safe version so every copy switches off strangers' words and wallet payments until a release with a new key. If the key is ever lost or stolen: cut a release that compiles in a new key, and say so through every other channel; the old key's events stop counting the moment a copy runs that release.

**Watching the draft.** NIP-82 is not merged. Every rule above lives in one section of `src/updates.ts` (`parseNotice` and what it names) and in `templates()` in the script, so a change to the draft before it merges lands there.
