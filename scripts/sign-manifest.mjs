#!/usr/bin/env node
// sign-manifest.mjs: signs a release bundle or a skill directory with the
// release key (D6). Run it on the machine that holds the key, never in CI, in
// a clone after `npm ci --ignore-scripts`: that machine never runs dependency
// install scripts.
//
//   node scripts/sign-manifest.mjs release <cyberspace-mcp-X.Y.Z.tar.gz.sha256> --key <keyfile> [--repo <clone>]
//   node scripts/sign-manifest.mjs skill <skill directory> --key <keyfile>
//   node scripts/sign-manifest.mjs keygen <keyfile>
//
// release: reads the .sha256 the release workflow wrote and does not trust it:
//   it rebuilds the bundle locally with scripts/release-bundle.mjs, in a clean
//   checkout of the tag v<version> (this clone, or --repo), and refuses to sign
//   unless the local sha256 equals CI's (the bundle is reproducible, so a
//   mismatch means CI built something else). It also checks the tarball beside
//   the .sha256 when it is there, and writes <tarball>.sig.json beside it.
//   Never overwrites a release signature.
// skill:   writes <dir>/SIGNATURE.json over every other file in the directory
//   (replacing the previous one: re-signing a changed skill is routine, and git
//   keeps the old one).
// keygen:  makes a new key file (mode 600; refuses to overwrite) and prints
//   its npub. The secret is never printed.
//
// The key file holds the 32-byte secret as 64 hex characters. It must be
// readable by its owner only. The format and the verification are in
// scripts/verify-manifest.mjs and docs/signing.md; this script verifies what it
// wrote with that file's own verifier before it reports success.

import { schnorr } from '@noble/curves/secp256k1.js'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SIGNATURE_FORMAT,
  SKILL_SIGNATURE_FILE,
  buildManifest,
  checkSignature,
  sha256FileHex,
  sha256Hex,
  skillManifest,
} from './verify-manifest.mjs'

function fail(msg) {
  console.error(`sign-manifest: ${msg}`)
  process.exit(1)
}

function readKey(path) {
  if (!path) fail('--key <keyfile> is required')
  const st = statSync(path)
  if ((st.mode & 0o077) !== 0) fail(`${path} is readable by others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`)
  const hex = readFileSync(path, 'utf8').trim()
  if (!/^[0-9a-f]{64}$/.test(hex)) fail(`${path} does not hold a 64-hex-character secret key`)
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

function sign(manifest, sk) {
  const pubkey = getPublicKey(sk)
  const digest = createHash('sha256').update(manifest, 'utf8').digest()
  const sig = Buffer.from(schnorr.sign(Uint8Array.from(digest), sk)).toString('hex')
  const obj = {
    format: SIGNATURE_FORMAT,
    pubkey,
    npub: nip19.npubEncode(pubkey),
    signed_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    manifest_sha256: sha256Hex(Buffer.from(manifest, 'utf8')),
    manifest,
    sig,
  }
  const problems = checkSignature(obj, manifest, pubkey)
  if (problems.length) fail(`the signature just made does not verify: ${problems.join('; ')}`)
  return obj
}

const [cmd, target, ...rest] = process.argv.slice(2)
const opt = (name) => {
  const i = rest.indexOf(name)
  return i === -1 ? undefined : rest[i + 1]
}

if (cmd === 'keygen') {
  if (!target) fail('usage: sign-manifest.mjs keygen <keyfile>')
  if (existsSync(target)) fail(`${target} exists; a key file is never overwritten`)
  const sk = generateSecretKey()
  writeFileSync(target, `${Buffer.from(sk).toString('hex')}\n`, { flag: 'wx', mode: 0o600 })
  console.log(`wrote ${target} (mode 600). npub: ${nip19.npubEncode(getPublicKey(sk))}`)
} else if (cmd === 'release') {
  if (!target || !target.endsWith('.sha256')) fail('usage: sign-manifest.mjs release <tarball>.sha256 --key <keyfile> [--repo <clone>]')
  const shaPath = resolve(target)
  const m = /^([0-9a-f]{64}) [ *]?(\S+)\n?$/.exec(readFileSync(shaPath, 'utf8'))
  if (!m) fail(`${target} is not a one-line sha256sum file`)
  const [, hash, name] = m
  if (name !== basename(shaPath).slice(0, -'.sha256'.length)) fail(`${target} names ${name}, not the file it is named after`)
  const version = /^cyberspace-mcp-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tar\.gz$/.exec(name)?.[1]
  if (!version) fail(`${name} is not a cyberspace-mcp-<version>.tar.gz`)
  const tarball = join(dirname(shaPath), name)
  if (existsSync(tarball) && sha256FileHex(tarball) !== hash) fail(`${tarball} does not hash to ${hash}`)
  const out = `${tarball}.sig.json`
  if (existsSync(out)) fail(`${out} exists; a release signature is never overwritten`)
  if (!opt('--key')) fail('--key <keyfile> is required')

  // The local rebuild: a clean checkout of exactly the tag, then the same script CI ran.
  const repo = resolve(opt('--repo') ?? fileURLToPath(new URL('..', import.meta.url)))
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  const tag = `v${version}`
  let tagCommit
  try {
    tagCommit = git('rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`)
  } catch {
    fail(`${repo} has no tag ${tag}; fetch the tags (git fetch --tags) and check it out`)
  }
  if (git('rev-parse', 'HEAD') !== tagCommit) fail(`${repo} is not at ${tag}; run git checkout ${tag} there first`)
  const dirty = git('status', '--porcelain', '--untracked-files=all')
  if (dirty) fail(`${repo} has changes or untracked files, which the rebuild would pick up:\n${dirty}`)
  const pkgVersion = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version
  if (pkgVersion !== version) fail(`${repo}'s package.json says ${pkgVersion}, not ${version}`)
  const builder = join(repo, 'scripts', 'release-bundle.mjs')
  if (!existsSync(builder)) fail(`${builder} is missing; a release cannot be signed without rebuilding it`)
  const rebuilt = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-rebuild-'))
  console.error(`sign-manifest: rebuilding ${name} from ${tag} in ${rebuilt}`)
  try {
    execFileSync(process.execPath, [builder, '--tag', tag, '--out', rebuilt], { cwd: repo, stdio: ['ignore', 'inherit', 'inherit'] })
  } catch {
    fail('the local rebuild failed (run npm ci --ignore-scripts in the clone first); not signing')
  }
  const localPath = join(rebuilt, name)
  if (!existsSync(localPath)) fail(`the local rebuild wrote no ${name}; not signing`)
  const local = sha256FileHex(localPath)
  if (local !== hash) fail(`the local rebuild hashes to ${local}, CI's .sha256 says ${hash}; not signing. Find out why before anything is published.`)

  // The key is read only now, after the rebuild matched: no build step runs while it is in memory.
  const obj = sign(buildManifest('release', [{ path: name, sha256: hash }]), readKey(opt('--key')))
  writeFileSync(out, `${JSON.stringify(obj, null, 2)}\n`, { flag: 'wx' })
  console.log(`wrote ${out}: ${name} ${hash} signed by ${obj.npub}; the local rebuild from ${tag} matched${existsSync(tarball) ? ', and so did the tarball beside it' : ''}`)
} else if (cmd === 'skill') {
  if (!target) fail('usage: sign-manifest.mjs skill <dir> --key <keyfile>')
  const dir = resolve(target)
  const manifest = skillManifest(dir)
  const obj = sign(manifest, readKey(opt('--key')))
  writeFileSync(join(dir, SKILL_SIGNATURE_FILE), `${JSON.stringify(obj, null, 2)}\n`)
  const files = manifest.trimEnd().split('\n').length - 2
  console.log(`wrote ${join(target, SKILL_SIGNATURE_FILE)}: ${files} file${files === 1 ? '' : 's'} signed by ${obj.npub}`)
} else {
  fail('usage: sign-manifest.mjs release <tarball>.sha256 --key <keyfile> | skill <dir> --key <keyfile> | keygen <keyfile>')
}
