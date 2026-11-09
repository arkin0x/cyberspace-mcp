#!/usr/bin/env node
// sign-manifest.mjs: signs a release bundle or a skill directory with the
// release key (D6). Run it in a clone after `npm ci`, on the machine that
// holds the key. Never in CI.
//
//   node scripts/sign-manifest.mjs release <cyberspace-mcp-X.Y.Z.tar.gz.sha256> --key <keyfile>
//   node scripts/sign-manifest.mjs skill <skill directory> --key <keyfile>
//   node scripts/sign-manifest.mjs keygen <keyfile>
//
// release: reads the .sha256 the release workflow wrote, checks the tarball
//   beside it when it is there (it must hash the same), and writes
//   <tarball>.sig.json beside it. Never overwrites a release signature.
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
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
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
  if (!target || !target.endsWith('.sha256')) fail('usage: sign-manifest.mjs release <tarball>.sha256 --key <keyfile>')
  const shaPath = resolve(target)
  const m = /^([0-9a-f]{64}) [ *]?(\S+)\n?$/.exec(readFileSync(shaPath, 'utf8'))
  if (!m) fail(`${target} is not a one-line sha256sum file`)
  const [, hash, name] = m
  if (name !== basename(shaPath).slice(0, -'.sha256'.length)) fail(`${target} names ${name}, not the file it is named after`)
  const tarball = join(dirname(shaPath), name)
  if (existsSync(tarball) && sha256FileHex(tarball) !== hash) fail(`${tarball} does not hash to ${hash}`)
  const out = `${tarball}.sig.json`
  if (existsSync(out)) fail(`${out} exists; a release signature is never overwritten`)
  const obj = sign(buildManifest('release', [{ path: name, sha256: hash }]), readKey(opt('--key')))
  writeFileSync(out, `${JSON.stringify(obj, null, 2)}\n`, { flag: 'wx' })
  console.log(`wrote ${out}: ${name} ${hash} signed by ${obj.npub}${existsSync(tarball) ? '' : ' (tarball not present; hash taken from the .sha256)'}`)
} else if (cmd === 'skill') {
  if (!target) fail('usage: sign-manifest.mjs skill <dir> --key <keyfile>')
  const dir = resolve(target)
  const manifest = skillManifest(dir)
  const obj = sign(manifest, readKey(opt('--key')))
  writeFileSync(join(dir, SKILL_SIGNATURE_FILE), `${JSON.stringify(obj, null, 2)}\n`)
  const files = manifest.trimEnd().split('\n').length - 2
  console.log(`wrote ${join(target, SKILL_SIGNATURE_FILE)}: ${files} files signed by ${obj.npub}`)
} else {
  fail('usage: sign-manifest.mjs release <tarball>.sha256 --key <keyfile> | skill <dir> --key <keyfile> | keygen <keyfile>')
}
