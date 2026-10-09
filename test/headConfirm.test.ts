// headConfirm.test.ts: the rule of spec 8.7.3 as ONOSENDAI implements it,
// row by row, over the fake relay: the canonical relay's answer counts; a
// non-canonical holder counts only when it holds the anchor; silence
// refuses; a newer move from another device is adopted and the head moves.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { hopTemplate, spawnTemplate } from '../src/chain/builder.js'
import { Holders } from '../src/chain/holders.js'
import { ChainKeeper, HEAD_UNCONFIRMED_MESSAGE } from '../src/chain/keeper.js'
import { confirmChainEvents } from '../src/chain/resolve.js'
import { signEvent, type NostrEvent } from '../src/nostr/event.js'
import { Relays } from '../src/nostr/relays.js'
import { placeFromHex } from '../src/space/coords.js'
import { StateDir } from '../src/state/dir.js'
import { FakeNetwork } from './fakeRelay.js'

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'

function identity() {
  const sk = generateSecretKey()
  const pubkey = getPublicKey(sk)
  const home = placeFromHex(pubkey)
  const spawn = signEvent(spawnTemplate(pubkey, 1_700_000_000), sk)
  const hop = (previous: NostrEvent, dx: bigint, createdAt: number): NostrEvent => {
    const prevCoord = previous.tags.find((t) => t[0] === 'C')![1]
    const to = { x: home.position.x + dx, y: home.position.y, z: home.position.z }
    return signEvent(hopTemplate({ createdAt, genesisId: spawn.id, previousId: previous.id, prevCoordHex: prevCoord, to, plane: home.plane, proofHash: 'ab'.repeat(32) }), sk)
  }
  return { sk, pubkey, spawn, hop }
}

function setup(network: FakeNetwork, sk: Uint8Array, urls: string[]) {
  const dir = StateDir.open(mkdtempSync(join(tmpdir(), 'cyberspace-mcp-confirm-')))
  const relays = new Relays({ urls, signAuth: async (t) => finalizeEvent(t, sk), websocketImplementation: network.WebSocket, maxWaitMs: 1500 })
  const holders = new Holders(dir, relays.canonical)
  return { dir, relays, holders }
}

describe('confirming the live head', () => {
  it('passes when the canonical relay answers with nothing newer', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL)
    const me = identity()
    const a = me.hop(me.spawn, 1n, 1_700_000_001)
    canonical.seed(me.spawn, a)
    const { relays, holders } = setup(network, me.sk, [CANONICAL])
    const got = await confirmChainEvents(relays, holders, me.pubkey, me.spawn.id, [me.spawn, a], { since: a.created_at, anchorId: a.id, maxWait: 500 })
    expect(got?.map((e) => e.id).sort()).toEqual([me.spawn.id, a.id].sort())
    relays.close()
  })

  it('refuses when nobody answers, and passes on a degraded answer only from a relay that holds the anchor', async () => {
    const network = new FakeNetwork()
    network.add(CANONICAL, { silent: true })
    const mine = network.add(MINE)
    const me = identity()
    const a = me.hop(me.spawn, 1n, 1_700_000_001)
    const { relays, holders } = setup(network, me.sk, [CANONICAL, MINE])
    // My relay answers, but holds nothing of the chain: that is not an answer about this chain.
    const empty = await confirmChainEvents(relays, holders, me.pubkey, me.spawn.id, [me.spawn, a], { since: a.created_at, anchorId: a.id, maxWait: 400 })
    expect(empty).toBeNull()
    // Now it holds the anchor: a degraded pass.
    mine.seed(me.spawn, a)
    const degraded = await confirmChainEvents(relays, holders, me.pubkey, me.spawn.id, [me.spawn, a], { since: a.created_at, anchorId: a.id, maxWait: 400 })
    expect(degraded?.some((e) => e.id === a.id)).toBe(true)
    relays.close()
  })

  it('a newer move from another device is returned even when no answer counted, and the keeper adopts it', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL)
    const me = identity()
    const a = me.hop(me.spawn, 1n, 1_700_000_001)
    const b = me.hop(a, 2n, 1_700_000_005) // signed elsewhere, after a
    canonical.seed(me.spawn, a, b)
    const { dir, relays, holders } = setup(network, me.sk, [CANONICAL])
    const keeper = new ChainKeeper(dir, relays, holders, me.pubkey)
    keeper.record(me.spawn, 'ok')
    keeper.record(a, 'ok')
    expect(keeper.head()?.id).toBe(a.id)
    expect(await keeper.confirmHead()).toBeNull()
    expect(keeper.head()?.id).toBe(b.id)
    expect(keeper.published[b.id]).toBe('ok')
    // The chain survives a restart, authentic events only.
    const again = new ChainKeeper(dir, relays, holders, me.pubkey)
    expect(again.head()?.id).toBe(b.id)
    relays.close()
  })

  it('the keeper refuses with a plain message when the relays are down', async () => {
    const network = new FakeNetwork()
    network.add(CANONICAL, { reachable: false })
    const me = identity()
    const { dir, relays, holders } = setup(network, me.sk, [CANONICAL])
    const keeper = new ChainKeeper(dir, relays, holders, me.pubkey)
    keeper.record(me.spawn, 'ok')
    expect(await keeper.confirmHead()).toBe(HEAD_UNCONFIRMED_MESSAGE)
    relays.close()
  }, 60_000)

  it('the head is reserved while a move is in flight', () => {
    const network = new FakeNetwork()
    const me = identity()
    const { dir, relays, holders } = setup(network, me.sk, [CANONICAL])
    const keeper = new ChainKeeper(dir, relays, holders, me.pubkey)
    const release = keeper.reserve()
    expect(() => keeper.reserve()).toThrow(/already in flight/)
    release()
    keeper.reserve()()
    relays.close()
  })

  it('the self-check says none only when the canonical relay answered, found when a chain is there, unknown when it is silent', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL)
    const me = identity()
    const { dir, relays, holders } = setup(network, me.sk, [CANONICAL])
    const keeper = new ChainKeeper(dir, relays, holders, me.pubkey)
    expect((await keeper.selfCheck()).status).toBe('none')
    canonical.seed(me.spawn)
    const found = await keeper.selfCheck()
    expect(found.status).toBe('found')
    expect(keeper.head()?.id).toBe(me.spawn.id)
    canonical.policy.silent = true
    relays.dropRelays([CANONICAL])
    const unknown = await keeper.selfCheck()
    expect(unknown.status).toBe('unknown')
    relays.close()
  }, 30_000)
})
