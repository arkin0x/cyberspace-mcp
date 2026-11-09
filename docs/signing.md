# Signing releases and the skill

Decision D6 (2026-11-09): a dedicated cyberspace-mcp release key signs release bundles and the OpenClaw skill directory. Its secret lives only on the signing machine, never in git and never in CI. Its public key is in the README ("Release key") and in `scripts/verify-manifest.mjs`:

```
npub1ttlpyy4r6lrsvgtxmny8wny2pakp8xwpurvuc3a6pae2jnv8wpestxy4ks
```

## What is signed

A **canonical manifest**: UTF-8 text, LF line endings, ending in a newline.

```
cyberspace-mcp signed manifest v1
scope: release
3f0c...e1a9  cyberspace-mcp-0.1.0.tar.gz
```

- Line 1 is the header; line 2 says what kind of thing was signed (`release` or `skill`), so a signature for one can never pass as the other.
- Then one line per file: its SHA-256 in lowercase hex, two spaces, its path. Paths are relative, use `/`, and are sorted bytewise. A path must be printable ASCII with no spaces and no `.` or `..` segment; anything else is refused rather than escaped, so the text has exactly one reading.
- For a **release**, the one file is the tarball, by its file name. For a **skill**, the files are every regular file in the skill directory, recursively, except `SIGNATURE.json` itself. A symlink or any other special file is refused. Adding, changing or removing any file breaks the signature, so a skill whose SKILL.md is untouched but whose scripts were swapped does not verify.

The signature is **BIP-340 Schnorr over secp256k1**, the scheme nostr signs events with, on the 32-byte SHA-256 of the manifest's bytes. It is not a nostr event and is never published to a relay: it is a file next to what it signs.

## The signature file

JSON, `<tarball>.sig.json` beside a release tarball, `SIGNATURE.json` inside a skill directory:

```json
{
  "format": "cyberspace-mcp-signature-v1",
  "pubkey": "<32-byte hex>",
  "npub": "npub1...",
  "signed_at": "2026-11-09T00:00:00Z",
  "manifest_sha256": "<hex>",
  "manifest": "cyberspace-mcp signed manifest v1\nscope: skill\n...",
  "sig": "<64-byte hex>"
}
```

`signed_at` and `npub` are informational and not signed. The verifier trusts nothing in the file: it recomputes the manifest from the files on disk, requires it to equal `manifest` byte for byte, requires `pubkey` to be the release key, and checks `sig` over the SHA-256 of the manifest.

## Verifying

`scripts/verify-manifest.mjs` is one file with no dependencies (Node 22 or newer; its BIP-340 code is checked in `test/releaseSigning.test.ts` against the BIP's test vectors and against @noble/curves). Fetch it from a commit you trust, not from the download you are checking:

```sh
node verify-manifest.mjs release cyberspace-mcp-0.1.0.tar.gz      # reads cyberspace-mcp-0.1.0.tar.gz.sig.json beside it
node verify-manifest.mjs skill skills/cyberspace                 # reads skills/cyberspace/SIGNATURE.json
```

It prints `OK ... signed by npub1...` and exits 0, or prints one `FAIL` line per problem (`on disk, not signed: <hash>  <path>`, `signed, not on disk: ...`, `signed by ..., not by the expected key`, `the signature does not verify`) and exits 1.

## Signing (the release key's holder only)

In a clone, after `npm ci --ignore-scripts` (the signer uses @noble/curves; the machine that holds the key never runs dependency install scripts, and the rebuild needs none), on the machine that holds the key.

**A release is never signed on CI's word.** The signer rebuilds the bundle itself and signs only when its own build hashes the same as CI's. The bundle is reproducible (docs/releasing.md), so a mismatch means CI built something other than the tag, and nothing is signed. For the rebuild the clone must be exactly at the tag, with no changes and no untracked files (an untracked file under a shipped folder would end up in the bundle), and it needs Linux with GNU tar and Node 22 with its bundled npm, as the workflow uses.

```sh
# A release: the workflow put the tarball and its .sha256 on a draft release (docs/releasing.md).
git fetch --tags && git checkout v0.1.0 && npm ci --ignore-scripts
mkdir -p ~/release-v0.1.0 && cd ~/release-v0.1.0          # outside the clone, which must stay clean
gh release download v0.1.0 -R arkin0x/cyberspace-mcp --pattern 'cyberspace-mcp-*'
node <clone>/scripts/sign-manifest.mjs release cyberspace-mcp-0.1.0.tar.gz.sha256 --key <keyfile>
node <clone>/scripts/verify-manifest.mjs release cyberspace-mcp-0.1.0.tar.gz
gh release upload v0.1.0 -R arkin0x/cyberspace-mcp cyberspace-mcp-0.1.0.tar.gz.sig.json

# The skill, after any change to any file in it:
cd <clone>
node scripts/sign-manifest.mjs skill skills/cyberspace --key <keyfile>
node scripts/verify-manifest.mjs skill skills/cyberspace
git add skills/cyberspace/SIGNATURE.json
```

- The key file holds the secret as 64 hex characters and must be mode 600 (the signer refuses otherwise). The signer never prints it.
- A release signature is never overwritten. A skill's `SIGNATURE.json` is replaced on each signing; git keeps the history.
- For a release, the signer refuses unless: the clone (the one the script is in, or `--repo <clone>`) has the tag `v<version>` and stands exactly at it; `git status --untracked-files=all` shows nothing; `package.json` says that version; and its own run of `scripts/release-bundle.mjs --tag v<version>` hashes to the `.sha256`. It reads the key file only after that rebuild matched. It also checks the tarball against the `.sha256` when the tarball is beside it, and verifies its own output before it reports success.
- `node scripts/sign-manifest.mjs keygen <keyfile>` makes a new key (mode 600, never overwriting a file) and prints its npub. Rotating the key means a new npub in the README and in `RELEASE_NPUB`, announced from the old key's holder.

## What a signature proves, and what it does not

- It proves the files are the ones the release key's holder signed. It does not prove the code is safe: it is a statement of origin, not a review.
- It is only as good as how you got the npub. Take it from the README at a commit you trust, or from the owner, never from the download itself.
- **No rollback protection.** A signature says nothing about being the newest: an older signed release or an older signed skill still verifies. Pin the version you mean (the skill pins one version and its sha256), and do not take "it verifies" as "it is current".
- **No revocation.** There is no way to withdraw a signature, or to announce that the key was lost or stolen, that a verifier would notice; `verify-manifest.mjs` checks one fixed key. If the key is ever compromised, the owner says so through the README and his own nostr identity, a new key replaces it there and in `RELEASE_NPUB`, and every signature by the old key is to be distrusted.
- A git checkout with `core.autocrlf=true` (common on Windows) would rewrite line endings and break a skill's signature. The repository marks `skills/**` as `-text` in `.gitattributes`, so git stores and checks out those files byte for byte; verify a skill from a checkout that honors that, or from a release.
- Nothing is signed in CI, and nothing is published to relays or to ClawHub.
