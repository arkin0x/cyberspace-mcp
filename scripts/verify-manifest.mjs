#!/usr/bin/env node
// verify-manifest.mjs: checks a cyberspace-mcp release bundle or skill
// directory against the release key's signature (D6). One file, Node 22 or
// newer, no dependencies, no network: download it on its own and run it.
//
//   node verify-manifest.mjs release <cyberspace-mcp-X.Y.Z.tar.gz> [--sig <file>] [--npub <npub>]
//   node verify-manifest.mjs skill <skill directory> [--npub <npub>]
//
// Exit 0 when the files on disk are exactly the files the key signed; 1
// otherwise, saying what differs. --npub checks against another key instead
// of the release key below (for testing; a stranger never needs it).
//
// The format (docs/signing.md): a canonical manifest, UTF-8 text with LF line
// endings,
//
//   cyberspace-mcp signed manifest v1
//   scope: release            (or: scope: skill)
//   <sha256 hex>  <path>      (one line per file, sorted by path, bytewise)
//
// signed with BIP-340 Schnorr over secp256k1 (the signature nostr uses) on the
// 32-byte SHA-256 of the manifest. The signature file is JSON holding the
// manifest, its sha256, the signer's pubkey and the 64-byte signature. For a
// release it sits beside the tarball (<tarball>.sig.json) and the manifest
// lists the tarball by its file name; for a skill it is SIGNATURE.json inside
// the directory, and the manifest lists every other file in the directory.
//
// The BIP-340 verification below is written out with BigInt so this file
// needs nothing installed; test/releaseSigning.test.ts checks it against the
// BIP's own test vectors and against @noble/curves.

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The cyberspace-mcp release key (README, "Release key"). */
export const RELEASE_NPUB = 'npub1ttlpyy4r6lrsvgtxmny8wny2pakp8xwpurvuc3a6pae2jnv8wpestxy4ks'

export const MANIFEST_HEADER = 'cyberspace-mcp signed manifest v1'
export const SIGNATURE_FORMAT = 'cyberspace-mcp-signature-v1'
export const SKILL_SIGNATURE_FILE = 'SIGNATURE.json'

// ---------------------------------------------------------------- hashing

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function sha256FileHex(path) {
  return sha256Hex(readFileSync(path))
}

// --------------------------------------------------------------- manifest

// A path in a manifest: relative, forward slashes, printable ASCII with no
// spaces, no `.` or `..` segment. Anything else is refused, never escaped, so
// the text form has exactly one reading.
const SAFE_PATH = /^[!-~]+$/

function checkPath(p) {
  if (!SAFE_PATH.test(p) || p.includes('\\') || p.startsWith('/') || p.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`refusing an unusual file name in a manifest: ${JSON.stringify(p)}`)
  }
}

function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** The canonical manifest text for a scope and a list of { path, sha256 }. */
export function buildManifest(scope, entries) {
  if (scope !== 'release' && scope !== 'skill') throw new Error(`unknown scope ${JSON.stringify(scope)}`)
  const seen = new Set()
  for (const e of entries) {
    checkPath(e.path)
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) throw new Error(`not a sha256: ${JSON.stringify(e.sha256)}`)
    if (seen.has(e.path)) throw new Error(`duplicate path ${e.path}`)
    seen.add(e.path)
  }
  const sorted = [...entries].sort((a, b) => byteCompare(a.path, b.path))
  return [MANIFEST_HEADER, `scope: ${scope}`, ...sorted.map((e) => `${e.sha256}  ${e.path}`)].join('\n') + '\n'
}

/** Every regular file under dir, except the skill signature at its top. Refuses symlinks and other special files. */
export function manifestEntriesForDir(dir) {
  const out = []
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name
      if (r === SKILL_SIGNATURE_FILE) continue
      const st = lstatSync(join(dir, r))
      if (st.isSymbolicLink()) throw new Error(`refusing a symlink in a signed directory: ${r}`)
      if (st.isDirectory()) walk(r)
      else if (st.isFile()) out.push({ path: r, sha256: sha256FileHex(join(dir, r)) })
      else throw new Error(`refusing a special file in a signed directory: ${r}`)
    }
  }
  walk('')
  return out
}

export function skillManifest(dir) {
  return buildManifest('skill', manifestEntriesForDir(dir))
}

export function releaseManifest(tarballPath) {
  return buildManifest('release', [{ path: basename(tarballPath), sha256: sha256FileHex(tarballPath) }])
}

// ----------------------------------------------------------------- bech32

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const b = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i]
  }
  return chk
}

/** The 32-byte hex pubkey inside an npub (NIP-19), or an error. */
export function npubToHex(npub) {
  const s = npub.toLowerCase()
  if (s !== npub && npub.toUpperCase() !== npub) throw new Error('mixed-case npub')
  const pos = s.lastIndexOf('1')
  if (s.slice(0, pos) !== 'npub' || s.length - pos - 1 < 6) throw new Error('not an npub')
  const data = [...s.slice(pos + 1)].map((c) => {
    const v = BECH32.indexOf(c)
    if (v === -1) throw new Error('bad character in npub')
    return v
  })
  const hrp = [...'npub'].map((c) => c.charCodeAt(0))
  const expanded = [...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31), ...data]
  if (bech32Polymod(expanded) !== 1) throw new Error('npub checksum does not match')
  let acc = 0
  let bits = 0
  const bytes = []
  for (const v of data.slice(0, -6)) {
    acc = ((acc << 5) | v) & 0xfff
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((acc >> bits) & 0xff)
    }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0 || bytes.length !== 32) throw new Error('npub does not hold 32 bytes')
  return Buffer.from(bytes).toString('hex')
}

// ---------------------------------------------------------------- BIP-340

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const G = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
]

const mod = (a, m = P) => ((a % m) + m) % m

function modPow(b, e, m) {
  let r = 1n
  b = mod(b, m)
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m
    b = (b * b) % m
    e >>= 1n
  }
  return r
}

const inv = (a) => modPow(a, P - 2n, P)

// Affine points; null is the point at infinity.
function add(p1, p2) {
  if (p1 === null) return p2
  if (p2 === null) return p1
  const [x1, y1] = p1
  const [x2, y2] = p2
  if (x1 === x2 && mod(y1 + y2) === 0n) return null
  const lam = x1 === x2 && y1 === y2 ? mod(3n * x1 * x1 * inv(2n * y1)) : mod((y2 - y1) * inv(mod(x2 - x1)))
  const x3 = mod(lam * lam - x1 - x2)
  return [x3, mod(lam * (x1 - x3) - y1)]
}

function mul(pt, k) {
  let r = null
  let q = pt
  while (k > 0n) {
    if (k & 1n) r = add(r, q)
    q = add(q, q)
    k >>= 1n
  }
  return r
}

function liftX(x) {
  if (x >= P) return null
  const c = mod(x * x * x + 7n)
  const y = modPow(c, (P + 1n) / 4n, P)
  if ((y * y) % P !== c) return null
  return [x, y % 2n === 0n ? y : P - y]
}

const toInt = (bytes) => BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`)

function taggedHash(tag, ...parts) {
  const t = createHash('sha256').update(tag, 'utf8').digest()
  const h = createHash('sha256').update(t).update(t)
  for (const p of parts) h.update(p)
  return h.digest()
}

/** BIP-340 verification: pubkey 32 bytes, message any length, signature 64 bytes. */
export function schnorrVerify(pubkey, message, signature) {
  const pk = Buffer.from(pubkey)
  const sig = Buffer.from(signature)
  if (pk.length !== 32 || sig.length !== 64) return false
  const Pt = liftX(toInt(pk))
  if (Pt === null) return false
  const r = toInt(sig.subarray(0, 32))
  const s = toInt(sig.subarray(32))
  if (r >= P || s >= N) return false
  const e = toInt(taggedHash('BIP0340/challenge', sig.subarray(0, 32), pk, Buffer.from(message))) % N
  const R = add(mul(G, s), mul(Pt, (N - e) % N))
  if (R === null || R[1] % 2n !== 0n || R[0] !== r) return false
  return true
}

// -------------------------------------------------------------- signature

/**
 * Checks a signature object against a manifest computed from the files on
 * disk and an expected pubkey (hex). Returns a list of problems; empty means
 * valid.
 */
export function checkSignature(sigObj, computedManifest, expectedPubkeyHex) {
  const problems = []
  if (!sigObj || sigObj.format !== SIGNATURE_FORMAT) problems.push(`not a ${SIGNATURE_FORMAT} file`)
  if (problems.length) return problems
  if (sigObj.pubkey !== expectedPubkeyHex) problems.push(`signed by ${sigObj.npub ?? sigObj.pubkey}, not by the expected key`)
  if (typeof sigObj.manifest !== 'string' || typeof sigObj.sig !== 'string' || !/^[0-9a-f]{128}$/.test(sigObj.sig)) {
    problems.push('malformed signature file')
    return problems
  }
  if (sigObj.manifest_sha256 !== sha256Hex(Buffer.from(sigObj.manifest, 'utf8'))) problems.push('manifest_sha256 does not match the manifest')
  if (sigObj.manifest !== computedManifest) {
    const signed = new Set(sigObj.manifest.split('\n'))
    const here = new Set(computedManifest.split('\n'))
    for (const l of here) if (l && !signed.has(l)) problems.push(`on disk, not signed: ${l}`)
    for (const l of signed) if (l && !here.has(l)) problems.push(`signed, not on disk: ${l}`)
    if (problems.length === 0) problems.push('the manifest differs from the files on disk')
  }
  const digest = createHash('sha256').update(sigObj.manifest, 'utf8').digest()
  if (!schnorrVerify(Buffer.from(sigObj.pubkey, 'hex'), digest, Buffer.from(sigObj.sig, 'hex'))) problems.push('the signature does not verify')
  return problems
}

// -------------------------------------------------------------------- CLI

function main(argv) {
  const [scope, target, ...rest] = argv
  const opt = (name) => {
    const i = rest.indexOf(name)
    return i === -1 ? undefined : rest[i + 1]
  }
  if ((scope !== 'release' && scope !== 'skill') || !target) {
    console.error('usage: verify-manifest.mjs release <tarball> [--sig <file>] [--npub <npub>]\n       verify-manifest.mjs skill <dir> [--npub <npub>]')
    return 2
  }
  const npub = opt('--npub') ?? RELEASE_NPUB
  const expected = npubToHex(npub)
  const path = resolve(target)
  let manifest
  let sigPath
  try {
    if (scope === 'release') {
      manifest = releaseManifest(path)
      sigPath = resolve(opt('--sig') ?? `${path}.sig.json`)
    } else {
      manifest = skillManifest(path)
      sigPath = join(path, SKILL_SIGNATURE_FILE)
    }
  } catch (e) {
    console.error(`FAIL ${e.message}`)
    return 1
  }
  let sigObj
  try {
    sigObj = JSON.parse(readFileSync(sigPath, 'utf8'))
  } catch (e) {
    console.error(`FAIL cannot read ${sigPath}: ${e.message}`)
    return 1
  }
  const problems = checkSignature(sigObj, manifest, expected)
  if (problems.length) {
    for (const p of problems) console.error(`FAIL ${p}`)
    return 1
  }
  const files = manifest.trimEnd().split('\n').length - 2
  console.log(`OK ${scope} ${target}: ${files} file${files === 1 ? '' : 's'} signed by ${npub}`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}

