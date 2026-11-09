# Releasing cyberspace-mcp

A release is three files on a GitHub Release, built from a version tag:

| File | What it is |
|---|---|
| `cyberspace-mcp-<version>.tar.gz` | The self-contained bundle: one folder, `cyberspace-mcp-<version>/`, with `dist/` built from `src/`, the production `node_modules` installed from the lockfile, `package.json`, the lockfile, README, QUICKSTART, LICENSE and `docs/agents.md`. |
| `cyberspace-mcp-<version>.tar.gz.sha256` | Its SHA-256, in `sha256sum` format. |
| `cyberspace-mcp-<version>.tar.gz.sig.json` | The release key's BIP-340 signature over a manifest holding that hash (added by hand after the build; see step 5). |

The bundle needs only Node 22 or newer. No git, no npm, no network, no build: every production dependency is plain JavaScript (the native modules in the lockfile belong to devDependencies), so one bundle serves Linux, macOS and Windows. It is about 7 MB packed and 43 MB unpacked. Nothing is published to npm (decision D1, 2026-11-09: npm needs the owner's account; deferred).

## Using a release

```sh
curl -LO https://github.com/arkin0x/cyberspace-mcp/releases/download/v<version>/cyberspace-mcp-<version>.tar.gz
curl -LO https://github.com/arkin0x/cyberspace-mcp/releases/download/v<version>/cyberspace-mcp-<version>.tar.gz.sha256
sha256sum -c cyberspace-mcp-<version>.tar.gz.sha256        # macOS: shasum -a 256 -c
tar -xzf cyberspace-mcp-<version>.tar.gz
node cyberspace-mcp-<version>/dist/bin.js --help
```

Point an MCP client at `node /absolute/path/to/cyberspace-mcp-<version>/dist/bin.js --state /absolute/path/to/state`. Keep the state directory outside the bundle's folder, so a newer bundle can replace the folder.

## Cutting a release

1. **Bump the version** in a normal PR: `npm version <x.y.z> --no-git-tag-version` changes `package.json` and the lockfile. Merge it.
2. **Tag the merged commit** on master and push the tag (the owner's call; agents never tag):
   ```sh
   git tag -a v<x.y.z> -m "cyberspace-mcp <x.y.z>" <merged commit>
   git push origin v<x.y.z>
   ```
3. **The `release` workflow** (`.github/workflows/release.yml`) runs on the tag. It refuses a tag that does not match `package.json`'s version, then runs `npm ci`, typecheck, the tests and `check:dist`, builds the bundle with `scripts/release-bundle.mjs`, checks it unpacks, carries no `typescript` and starts with no network, and attaches the tarball and the `.sha256` to a **draft** release for the tag. A draft is visible only to the repository's writers, so nobody downloads a release before it is signed. If a release for the tag exists already, the files are added to it; an existing file is never replaced (a replaced file would no longer match its signature).
4. **Check the build yourself** (optional, recommended). The bundle is reproducible: the same commit gives the same bytes. On Linux with GNU tar:
   ```sh
   git checkout v<x.y.z> && npm ci
   node scripts/release-bundle.mjs --tag v<x.y.z> --out /tmp/check-release
   cat /tmp/check-release/*.sha256       # must equal the draft's .sha256
   ```
   The same npm major version as CI matters for the lockfile install; Node 22's bundled npm is what the workflow uses.
5. **Sign the hash** with the release key, on the machine that holds it (never in CI), and attach the signature to the draft. The signing script, its file format and how anyone verifies it are in [signing.md](signing.md).
6. **Publish the draft** on GitHub (Releases, Edit, Publish release), or `gh release edit v<x.y.z> --draft=false`.
7. **Re-pin the OpenClaw skill** (`skills/cyberspace/SKILL.md`): set the version and the bundle's sha256 in its install spec and its `openclaw mcp add` line, re-sign the skill's manifest, and open a PR.

## How the bundle is built

`scripts/release-bundle.mjs [--tag vX.Y.Z] [--out release]` (run `npm ci` first, for `tsc`):

- compiles `src/` with `tsconfig.build.json` into a fresh temporary folder (never the working tree's `dist/`), and marks `dist/bin.js` executable;
- copies `package.json`, the lockfile and what `package.json`'s `files` lists;
- runs `npm ci --omit=dev --omit=optional --ignore-scripts` there. `--omit=optional` keeps out `typescript`, which the lockfile marks `devOptional` (a devDependency here and an optional peer of nostr-tools); the script refuses to run if the lockfile ever gains a genuine optional production dependency, which that flag would drop;
- packs with GNU tar, entries sorted, mtimes set to the commit's time (`SOURCE_DATE_EPOCH`, else HEAD's commit time), owner 0:0, normalized modes, and `gzip -n`;
- never overwrites: it stops if either output file exists.

It needs GNU tar, so it runs on Linux (the workflow uses `ubuntu-latest`). On macOS, install `gnu-tar` and put it first on PATH as `tar`.
