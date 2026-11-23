// chestCap.test.ts: how much a chest holds (DECK-0004 3.2 step 2 and Size,
// cyberspace #117). The cap is 131,072 bytes of contents. Past 65,535 bytes
// nostr-tools seals with NIP-44's extended length prefix (two zero bytes,
// then the length in four bytes) and opens it again; at or under 65,535 the
// two-byte prefix is used, exactly as before. A chest at the cap, hidden
// alone in a bag, stays under the 240,000 bytes ONOSENDAI holds a bag to, and
// hide refuses a write that would bring a bag past that, before anything is
// kept or sent. Fake relays only.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Agent, Refusal } from '../src/agent.js'
import { regionKeyAt } from '../src/hidden/crypto.js'
import type { Calibration } from '../src/space/calibration.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork } from './fakeRelay.js'
import { v2 as nip44 } from 'nostr-tools/nip44'
import { BAG_SAFE_BYTES, HIDDEN_KIND, bagTemplate, chestInnerTemplate, chestItemOf, unbag } from '../src/hidden/bags.js'
import { CHEST_MAX_PLAINTEXT, openWithSecret, readContents, sealEntries } from '../src/hidden/chests.js'
import { bytesToHex, signEvent, type NostrEvent } from '../src/nostr/event.js'

const hider = generateSecretKey()
const at = { x: 1n << 40n, y: 5n, z: 9n }
const regionKey = new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff)
const lookup = 'bb'.repeat(32)
const utf8 = (s: string): number => new TextEncoder().encode(s).length

/** A list of one signed message whose JSON is exactly `n` UTF-8 bytes. */
function listOf(n: number): NostrEvent[] {
  const base = utf8(JSON.stringify([signEvent({ kind: 1, created_at: 1, content: '', tags: [] }, hider)]))
  const list = [signEvent({ kind: 1, created_at: 1, content: 'x'.repeat(n - base), tags: [] }, hider)]
  expect(utf8(JSON.stringify(list))).toBe(n)
  return list
}

/** The bytes NIP-44 put in front of the padded plaintext: 2, or 6 with the extended length prefix. */
const prefixBytes = (payload: string, n: number): number => Buffer.from(payload, 'base64').length - 1 - 32 - 32 - nip44.utils.calcPaddedLen(n)

/** A lock's keypair: its public key to seal to, its secret to open with. */
function lock(): { pub: string; secretHex: string } {
  const sk = generateSecretKey()
  return { pub: getPublicKey(sk), secretHex: bytesToHex(sk) }
}

describe('the chest cap (DECK-0004 3.2)', () => {
  it('is 131,072 bytes, and a list one byte larger is refused in words', () => {
    expect(CHEST_MAX_PLAINTEXT).toBe(131_072)
    expect(() => sealEntries(listOf(CHEST_MAX_PLAINTEXT + 1), lock().pub)).toThrow('Too large to seal: 131073 of 131072 bytes. Take something out.')
  })

  it('a chest past 65,535 bytes seals with the extended length prefix and opens with its lock, round trip', () => {
    const l = lock()
    const list = listOf(80_000)
    const sealed = sealEntries(list, l.pub)
    expect(prefixBytes(sealed.payload, 80_000)).toBe(6)
    const back = openWithSecret(sealed, l.secretHex)
    expect(back).toEqual(list)
    expect(readContents(back)[0].verified).toBe(true)
    expect(() => openWithSecret(sealed, lock().secretHex)).toThrow()
  })

  it('a chest of 65,535 bytes or less seals with the two-byte prefix, as before', () => {
    const l = lock()
    const sealed = sealEntries(listOf(65_535), l.pub)
    expect(prefixBytes(sealed.payload, 65_535)).toBe(2)
    expect(openWithSecret(sealed, l.secretHex)).toHaveLength(1)
  })

  it('a chest at the cap, hidden alone in a bag, fits under 240,000 bytes and opens out of the bag, round trip', async () => {
    const l = lock()
    const list = listOf(CHEST_MAX_PLAINTEXT)
    const sealed = sealEntries(list, l.pub)
    expect(prefixBytes(sealed.payload, CHEST_MAX_PLAINTEXT)).toBe(6)
    expect(sealed.payload).toHaveLength(174_860)
    const chest = signEvent(chestInnerTemplate({ name: 'n'.repeat(64), lockPubkey: l.pub, senderPubkey: sealed.senderPubkey, requires: 'r'.repeat(64), payload: sealed.payload }, at, 0, 1), hider)
    const bag = signEvent(await bagTemplate([chest], regionKey, lookup, 12, 2, HIDDEN_KIND), hider)
    expect(utf8(JSON.stringify(bag))).toBeLessThan(240_000)
    const found = await unbag(bag, regionKey)
    expect(found).toHaveLength(1)
    const item = chestItemOf(found[0].inner)!
    expect(item.payload).toBe(sealed.payload)
    expect(openWithSecret(item, l.secretHex)).toEqual(list)
  })
})

describe('hiding a large chest through the agent', () => {
  const CANONICAL = 'wss://canonical.example'
  const network = new FakeNetwork()
  const relay = network.add(CANONICAL)
  const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }
  const sk = generateSecretKey()
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-chestcap-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
  const agents: Agent[] = []
  afterAll(async () => { for (const a of agents) await a.stop() })
  /** Twelve messages of 10,000 letters, about 124 KB of contents: past 65,535, under the cap. */
  const twelve = Array.from({ length: 12 }, (_, i) => ({ message: 'abcdefghijkl'[i].repeat(10_000) }))

  it('a chest past 65,535 bytes is hidden and opens out of the published bag; a second that would overfill the bag is refused, nothing sent or held', async () => {
    const a = await Agent.start({ stateDir: dir, relays: [CANONICAL], capCallSeconds: 30, capSessionSeconds: 120, maxSidestepHeight: 24, allowRespawn: false, websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1500, ordersPollMs: 0 } as Parameters<typeof Agent.start>[0])
    agents.push(a)
    const here = { dx: 0, dy: 0, dz: 0 }
    const r = await a.hide({ contents: { chest: { name: 'Hoard', lock: a.npub, entries: [...twelve, { key: { name: 'Inside Key' } }] } }, coordinate: here, height: 5 })
    expect(r.text).toContain('a chest "Hoard"')
    const pos = (a as unknown as { keeper: { place(): { position: { x: bigint; y: bigint; z: bigint } } } }).keeper.place().position
    const h5 = regionKeyAt(pos, 5, 16)
    const bagsHere = (): NostrEvent[] => relay.all().filter((e) => e.kind === HIDDEN_KIND && e.pubkey === a.pubkey && e.tags.some((t) => t[0] === 'd' && t[1] === h5.lookupId))
    expect(bagsHere()).toHaveLength(1)
    const bag = bagsHere()[0]
    expect(utf8(JSON.stringify(bag))).toBeLessThanOrEqual(BAG_SAFE_BYTES)
    const found = (await unbag(bag, h5.key)).find((h) => h.type === 'chest')!
    const opened = openWithSecret(chestItemOf(found.inner)!, bytesToHex(sk))
    expect(utf8(JSON.stringify(opened))).toBeGreaterThan(65_535)
    expect(readContents(opened, a.pubkey).filter((c) => c.body.type === 'message').map((c) => c.body.text)).toEqual(twelve.map((m) => m.message))
    expect([...a.keys.items.values()].some((i) => i.name === 'Inside Key')).toBe(true)

    // The same again beside it would bring the bag past 240,000 bytes: refused in words, before it is kept, sent or any item forged in it is held.
    const again = a.hide({ contents: { chest: { name: 'Second hoard', lock: a.npub, entries: [...twelve, { key: { name: 'Spare Key' } }] } }, coordinate: here, height: 5 })
    await expect(again).rejects.toThrow(Refusal)
    await expect(again).rejects.toThrow(/Too large for one bag: \d+ of 240000 bytes\. Nothing was sent\./)
    expect(bagsHere().map((e) => e.id)).toEqual([bag.id])
    expect([...a.keys.items.values()].some((i) => i.name === 'Spare Key')).toBe(false)
  }, 60_000)
})
