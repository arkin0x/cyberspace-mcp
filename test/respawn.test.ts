// respawn.test.ts: a spawn is never signed without the human. On a dead
// chain (a fork on the relays) hop refuses and names --allow-respawn; with
// the flag it respawns and the new chain is valid. When the relays cannot
// say whether the identity has a chain at all, hop refuses to spawn. An
// agent on the default relay whose chain lives only on the former default
// (and whose chain.json is gone) adopts that chain instead of spawning over
// it, and never writes to the former default.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Agent, Refusal } from '../src/agent.js'
import { hopTemplate, spawnTemplate } from '../src/chain/builder.js'
import { bytesToHex, signEvent } from '../src/nostr/event.js'
import { DEFAULT_RELAY, FORMER_DEFAULT_RELAY } from '../src/nostr/relays.js'
import type { Calibration } from '../src/space/calibration.js'
import { placeFromHex } from '../src/space/coords.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork } from './fakeRelay.js'
import { fakeHopProof } from './fakeHop.js'

const CANONICAL = 'wss://canonical.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }

function dirWithKey(sk: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-respawn-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
  return dir
}

const running: Agent[] = []
afterAll(async () => { for (const a of running) await a.stop() })

async function start(network: FakeNetwork, dir: string, allowRespawn: boolean, relays: string[] = [CANONICAL]): Promise<Agent> {
  const a = await Agent.start({ stateDir: dir, relays, capCallSeconds: 30, capSessionSeconds: 120, maxSidestepHeight: 24, allowRespawn, websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1000 })
  running.push(a)
  return a
}

describe('spawning again', () => {
  it('refuses to move on a dead chain without --allow-respawn, and respawns with it', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL)
    const sk = generateSecretKey()
    const pubkey = getPublicKey(sk)
    const home = placeFromHex(pubkey)
    // A fork on the relays: two hops from the spawn, so the chain is dead and the identity stands at its spawn.
    const spawn = signEvent(spawnTemplate(pubkey, 1_700_000_000), sk)
    const branch = (dx: bigint, createdAt: number) => signEvent(hopTemplate({ createdAt, genesisId: spawn.id, previousId: spawn.id, prevCoordHex: pubkey, to: { x: home.position.x + dx, y: home.position.y, z: home.position.z }, plane: home.plane, ...fakeHopProof('ab') }), sk)
    canonical.seed(spawn, branch(1n, 1_700_000_001), branch(2n, 1_700_000_002))
    const dir = dirWithKey(sk)

    const a = await start(network, dir, false)
    const where = await a.whereami()
    expect((where.data.chain as { status: string }).status).toBe('dead')
    expect((where.data.where as { hex: string }).hex).toBe(pubkey)
    await expect(a.hop({ target: { dx: 1 } })).rejects.toThrow(Refusal)
    await expect(a.hop({ target: { dx: 1 } })).rejects.toThrow(/--allow-respawn/)
    expect(canonical.published).toHaveLength(0)
    await a.stop()
    running.splice(running.indexOf(a), 1)

    const b = await start(network, dir, true)
    const r = await b.hop({ target: { dx: 1 } })
    expect(r.text).toMatch(/Respawned/)
    const spawns = canonical.all().filter((e) => e.pubkey === pubkey && e.tags.some((t) => t[0] === 'A' && t[1] === 'spawn'))
    expect(spawns).toHaveLength(2)
    const after = await b.whereami()
    expect((after.data.chain as { status: string }).status).toBe('valid')
    expect((after.data.where as { x: string }).x).toBe((home.position.x + 1n).toString())
  }, 60_000)

  it('refuses to spawn when the relays cannot say whether a chain exists', async () => {
    const network = new FakeNetwork()
    network.add(CANONICAL, { silent: true })
    const sk = generateSecretKey()
    const a = await start(network, dirWithKey(sk), false)
    await expect(a.hop({ target: { dx: 1 } })).rejects.toThrow(/Cannot tell whether this identity already has a chain/)
    expect(a.keeper.events).toHaveLength(0)
  }, 90_000)

  it('on the default relay, adopts a chain found only on the former default instead of spawning over it', async () => {
    const network = new FakeNetwork()
    const nostr1 = network.add(DEFAULT_RELAY)
    const feeds = network.add(FORMER_DEFAULT_RELAY)
    const sk = generateSecretKey()
    const pubkey = getPublicKey(sk)
    const home = placeFromHex(pubkey)
    // A valid chain (a spawn and one hop) on the former default only; the state directory has no chain.json.
    const spawn = signEvent(spawnTemplate(pubkey, 1_700_000_000), sk)
    const hop = signEvent(hopTemplate({ createdAt: 1_700_000_001, genesisId: spawn.id, previousId: spawn.id, prevCoordHex: pubkey, to: { x: home.position.x + 1n, y: home.position.y, z: home.position.z }, plane: home.plane, ...fakeHopProof('ab') }), sk)
    feeds.seed(spawn, hop)
    const a = await start(network, dirWithKey(sk), false, [DEFAULT_RELAY])
    const r = await a.hop({ target: { dx: 1 } })
    // Adopted (at startup or on this hop, whichever reads the chain first), never spawned over.
    expect(r.text).not.toMatch(/signed your spawn/)
    expect(a.keeper.events.map((e) => e.id)).toEqual(expect.arrayContaining([spawn.id, hop.id]))
    // No new spawn anywhere; the move extends the adopted chain on the default relay; the former default is never written.
    const spawns = nostr1.published.filter((e) => e.tags.some((t) => t[0] === 'A' && t[1] === 'spawn'))
    expect(spawns).toHaveLength(0)
    expect(nostr1.published.some((e) => e.kind === 3333 && e.tags.some((t) => t[0] === 'e' && t[1] === hop.id))).toBe(true)
    expect(feeds.published).toHaveLength(0)
  }, 60_000)

  it('does not read the former default when the canonical relay is not the default', async () => {
    const network = new FakeNetwork()
    network.add(CANONICAL)
    const feeds = network.add(FORMER_DEFAULT_RELAY)
    const sk = generateSecretKey()
    const pubkey = getPublicKey(sk)
    feeds.seed(signEvent(spawnTemplate(pubkey, 1_700_000_000), sk))
    const a = await start(network, dirWithKey(sk), false)
    const r = await a.hop({ target: { dx: 1 } })
    expect(r.text).toMatch(/No chain on the relays: signed your spawn/)
    expect(feeds.received).toHaveLength(0)
  }, 60_000)
})
