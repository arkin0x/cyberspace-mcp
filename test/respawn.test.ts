// respawn.test.ts: a spawn is never signed without the human. On a dead
// chain (a fork on the relays) hop refuses and names --allow-respawn; with
// the flag it respawns and the new chain is valid. When the relays cannot
// say whether the identity has a chain at all, hop refuses to spawn.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Agent, Refusal } from '../src/agent.js'
import { hopTemplate, spawnTemplate } from '../src/chain/builder.js'
import { bytesToHex, signEvent } from '../src/nostr/event.js'
import type { Calibration } from '../src/space/calibration.js'
import { placeFromHex } from '../src/space/coords.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork } from './fakeRelay.js'

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

async function start(network: FakeNetwork, dir: string, allowRespawn: boolean): Promise<Agent> {
  const a = await Agent.start({ stateDir: dir, relays: [CANONICAL], capCallSeconds: 30, capSessionSeconds: 120, maxSidestepHeight: 24, allowRespawn, websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1000 })
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
    const branch = (dx: bigint, createdAt: number) => signEvent(hopTemplate({ createdAt, genesisId: spawn.id, previousId: spawn.id, prevCoordHex: pubkey, to: { x: home.position.x + dx, y: home.position.y, z: home.position.z }, plane: home.plane, proofHash: 'ab'.repeat(32) }), sk)
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
})
