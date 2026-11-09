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

## How the bundle is built

`scripts/release-bundle.mjs [--tag vX.Y.Z] [--out release]` (run `npm ci` first, for `tsc`):

- ships the committed `dist/` after checking it: it compiles `src/` into a scratch folder and refuses unless that gives the same files and every `.js` byte for byte. The committed `dist/` is shipped rather than the scratch build because its source maps name their sources relative to the repository (`../src/bin.ts`), while a compile into another folder writes that folder's path into every map, which would make CI's bundle and the key holder's rebuild differ. Then it marks `dist/bin.js` executable;
- copies `package.json`, the lockfile and what `package.json`'s `files` lists;
- runs `npm ci --omit=dev --omit=optional --ignore-scripts --no-bin-links` there (no `node_modules/.bin` symlinks, which Windows tar cannot unpack; the script refuses to pack any symlink). `--omit=optional` keeps out `typescript`, which the lockfile marks `devOptional` (a devDependency here and an optional peer of nostr-tools); the script refuses to run if the lockfile ever gains a genuine optional production dependency, which that flag would drop;
- packs with GNU tar, entries sorted, mtimes set to the commit's time (`SOURCE_DATE_EPOCH`, else HEAD's commit time), owner 0:0, normalized modes, and `gzip -n`;
- never overwrites: it stops if either output file exists.

It needs GNU tar, so it runs on Linux (the workflow uses `ubuntu-latest`). On macOS, install `gnu-tar` and put it first on PATH as `tar`.
