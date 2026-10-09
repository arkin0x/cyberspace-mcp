// guard.test.ts: the outbox guard with real chain events (H1). An agent
// signs a hop and dies before sending it. On the next start: relays that
// cannot be read leave the hop pending and unsent; a relay that shows another
// signer's branch from the same point drops it and the relays' version is
// adopted; a canonical relay that answers with the chain clear sends it; a
// newer spawn on the relays drops an event of the ended chain.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { Agent } from '../src/agent.js'
import { hopTemplate, spawnTemplate } from '../src/chain/builder.js'
import { bytesToHex, signEvent, type NostrEvent } from '../src/nostr/event.js'
import type { Calibration } from '../src/space/calibration.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork } from './fakeRelay.js'

const CANONICAL = 'wss://canonical.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }
const fresh = (): string => mkdtempSync(join(tmpdir(), 'cyberspace-mcp-guard-'))

/** A state directory whose key is one the test generated, written the way the server writes its own. */
function dirWithKey(sk: Uint8Array): string {
  const dir = fresh()
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
  return dir
}

const running: Agent[] = []
afterAll(async () => { for (const a of running) await a.stop() })

async function start(network: FakeNetwork, dir: string): Promise<Agent> {
  const a = await Agent.start({ stateDir: dir, relays: [CANONICAL], capCallSeconds: 30, capSessionSeconds: 120, maxSidestepHeight: 24, allowRespawn: false, websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1000 })
  running.push(a)
  return a
}

async function stop(a: Agent): Promise<void> {
  await a.stop()
  running.splice(running.indexOf(a), 1)
}

/** A hop signed by `sk` from the agent's head, as the agent would sign it a moment before dying (or as another device would). */
function hopFrom(a: Agent, sk: Uint8Array, dx: bigint, createdAt: number, proof: string): NostrEvent {
  const head = a.keeper.head()!
  const spawn = a.keeper.chain()[0]
  return signEvent(hopTemplate({ createdAt, genesisId: spawn.id, previousId: head.id, prevCoordHex: head.coordHex, to: { x: head.position.x + dx, y: head.position.y, z: head.position.z }, plane: head.plane, proofHash: proof }), sk)
}

describe('the outbox guard', () => {
  it('leaves an unsent hop pending when the relays cannot be read, drops it when another signer forked, and adopts the relays', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL)
    const sk = generateSecretKey()
    const dir = dirWithKey(sk)
    let a = await start(network, dir)
    await a.hop({ target: { dx: 3 } })
    const head = a.keeper.head()!
    // Signed, recorded, written to the outbox, and then the process died.
    const unsent = hopFrom(a, sk, 1n, head.createdAt + 1, 'ab'.repeat(32))
    a.keeper.record(unsent, 'queued')
    a.outbox.add(unsent)
    await stop(a)

    // The relays are down: nothing is sent, nothing is dropped.
    canonical.policy.reachable = false
    a = await start(network, dir)
    expect(a.outbox.pending().map((e) => e.event.id)).toEqual([unsent.id])
    expect(a.outbox.pending()[0].lastError).toMatch(/cannot tell whether another device moved/)
    expect(a.outbox.state().dropped).toHaveLength(0)
    expect(canonical.published.some((e) => e.id === unsent.id)).toBe(false)
    expect(a.keeper.head()?.id).toBe(unsent.id)
    await stop(a)

    // Another device signed in as this identity moved from the same head meanwhile.
    canonical.policy.reachable = true
    const other = signEvent(hopTemplate({ createdAt: head.createdAt + 2, genesisId: a.keeper.chain()[0].id, previousId: head.id, prevCoordHex: head.coordHex, to: { x: head.position.x + 2n, y: head.position.y, z: head.position.z }, plane: head.plane, proofHash: 'cd'.repeat(32) }), sk)
    canonical.seed(other)
    a = await start(network, dir)
    expect(a.outbox.pending()).toHaveLength(0)
    expect(a.outbox.state().dropped).toHaveLength(1)
    expect(a.outbox.state().dropped[0].dropped).toMatch(/fork the chain/)
    expect(canonical.published.some((e) => e.id === unsent.id)).toBe(false)
    expect(a.keeper.head()?.id).toBe(other.id)
    expect(a.keeper.status()).toBe('valid')
    await stop(a)
  }, 60_000)

  it('sends an unsent hop when the canonical relay answers with the chain clear, and drops an event of a chain a newer spawn ended', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL)
    const sk = generateSecretKey()
    const dir = dirWithKey(sk)
    let a = await start(network, dir)
    await a.hop({ target: { dx: 3 } })
    const head = a.keeper.head()!
    const unsent = hopFrom(a, sk, 1n, head.createdAt + 1, 'ab'.repeat(32))
    a.keeper.record(unsent, 'queued')
    a.outbox.add(unsent)
    await stop(a)

    a = await start(network, dir)
    expect(canonical.published.some((e) => e.id === unsent.id)).toBe(true)
    expect(a.outbox.pending()).toHaveLength(0)
    expect(a.keeper.head()?.id).toBe(unsent.id)
    expect(a.keeper.published[unsent.id]).toBe('ok')

    // Another unsent hop, and meanwhile a newer spawn for this identity on the relays: the old chain has ended.
    const head2 = a.keeper.head()!
    const stale = hopFrom(a, sk, 1n, head2.createdAt + 1, 'ef'.repeat(32))
    a.keeper.record(stale, 'queued')
    a.outbox.add(stale)
    await stop(a)
    const respawn = signEvent(spawnTemplate(a.pubkey, head2.createdAt + 10), sk)
    canonical.seed(respawn)
    a = await start(network, dir)
    expect(a.outbox.state().dropped[0].dropped).toMatch(/newer spawn/)
    expect(canonical.published.some((e) => e.id === stale.id)).toBe(false)
    expect(a.keeper.chain()[0].id).toBe(respawn.id)
    await stop(a)
  }, 60_000)
})
