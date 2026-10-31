// hopResidue.test.ts: version 2 of the hop proof, end to end over the fake
// relays (spec 5.9 to 5.13, chain rules 2026-10-08-residue-openings). Every
// hop the agent publishes carries proof (the seal), mn and mp exactly once,
// in spec 8.4's order, and verifies with cyberspace-core at Level 1 from its
// own tags and id: one-axis, three-axis and plane-change hops. On a restart
// the agent checks its own chain's hops at Level 1 and reports them. A chain
// adopted from the relays with a version 1 hop on it (signed before the
// cutover; the exemption list is empty until the census) is reported and
// never a stop. A version 1 hop a stopped server left unsent in the outbox
// is dropped, never sent, with the chain events after it and never a note
// beside it; when a relay already holds it (the crash window), the next hop
// adopts and extends it, never a fork (review of #51). Nothing leaves the
// process (test/fakeRelay.ts).

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GRANDFATHERED_V1_HOPS, coordToXyz, hexToCoord, isGrandfatheredV1Hop, verifyHopLevel1, type HopCostEstimate } from 'cyberspace-core'
import { afterAll, describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Agent } from '../src/agent.js'
import { hopTemplate, spawnTemplate } from '../src/chain/builder.js'
import { HopProofCheck, hopReportWords, isVersion1Hop } from '../src/chain/hopProofs.js'
import { bytesToHex, signEvent, type NostrEvent } from '../src/nostr/event.js'
import { DEFAULT_RESIDUE_RATES, cacheValid, hopResidueSeconds, hopSeconds, measureResidueRates, projectCantorMs, type Calibration } from '../src/space/calibration.js'
import { positionHex } from '../src/space/coords.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork } from './fakeRelay.js'
import { fakeHopProof } from './fakeHop.js'

const CANONICAL = 'wss://canonical.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }

function dirWithKey(sk: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-residue-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
  return dir
}

const running: Agent[] = []
afterAll(async () => { for (const a of running) await a.stop() })

async function start(network: FakeNetwork, dir: string, log?: (line: string) => void): Promise<Agent> {
  const a = await Agent.start({
    stateDir: dir, relays: [CANONICAL], capCallSeconds: 30, capSessionSeconds: 600, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1000, log,
  })
  running.push(a)
  return a
}

async function stop(a: Agent): Promise<void> {
  await a.stop()
  running.splice(running.indexOf(a), 1)
}

const tag = (ev: NostrEvent, name: string): string | undefined => ev.tags.find((t) => t[0] === name)?.[1]
const hopsOn = (published: NostrEvent[]): NostrEvent[] => published.filter((e) => e.kind === 3333 && tag(e, 'A') === 'hop')

/** Level 1 of a published hop from nothing but its own tags and id, straight through cyberspace-core. */
function levelOne(ev: NostrEvent): string[] {
  const at = (hex: string) => coordToXyz(hexToCoord(hex))
  return verifyHopLevel1({
    from: at(tag(ev, 'c')!), to: at(tag(ev, 'C')!),
    previousEventIdHex: ev.tags.find((t) => t[0] === 'e' && t[3] === 'previous')![1],
    proof: tag(ev, 'proof'), nonce: tag(ev, 'mn'), openings: tag(ev, 'mp'), eventId: ev.id,
  })
}

/** Resolves once `cond` holds, polling; fails the test after `ms`. */
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('every hop the agent publishes is version 2', () => {
  it('one-axis, three-axis and plane-change hops each carry proof, mn and mp once, in order, and verify with core; a restart checks them all', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL)
    const dir = dirWithKey(generateSecretKey())
    let a = await start(network, dir)
    await a.hop({ target: { dx: 5 } })
    await a.hop({ target: { dx: 3, dy: -7, dz: 2 } })
    const here = a.keeper.place()
    await a.hop({ target: { x: here.position.x.toString(), y: here.position.y.toString(), z: here.position.z.toString(), plane: here.plane === 0 ? 1 : 0 } })
    await a.hop({ target: { dy: 1 } })

    const hops = hopsOn(canonical.published)
    expect(hops).toHaveLength(4)
    for (const hop of hops) {
      for (const name of ['proof', 'mn', 'mp']) expect(hop.tags.filter((t) => t[0] === name), name).toHaveLength(1)
      expect(hop.tags.map((t) => t[0]).slice(0, 8)).toEqual(['A', 'e', 'e', 'c', 'C', 'proof', 'mn', 'mp'])
      expect(tag(hop, 'mn')).toMatch(/^[0-9a-f]{16}$/)
      expect(tag(hop, 'mp')).toMatch(/^[0-9a-f]+$/)
      expect(isVersion1Hop(hop)).toBe(false)
      expect(levelOne(hop), hop.id).toEqual([])
    }
    // The plane change landed in the other plane, the C tag says so, and its proof still holds (the plane bit is in K).
    expect(coordToXyz(hexToCoord(tag(hops[2], 'C')!)).plane).not.toBe(coordToXyz(hexToCoord(tag(hops[2], 'c')!)).plane)
    expect(a.keeper.status()).toBe('valid')
    await stop(a)

    // On load, the kept chain's hops are checked at Level 1 and reported.
    const lines: string[] = []
    a = await start(network, dir, (l) => lines.push(l))
    await until(() => a.keeper.lastHopReport !== null)
    expect(a.keeper.lastHopReport).toMatchObject({ checked: 4, valid: 4, listed: 0, unlisted: [], failing: [], skipped: 0 })
    expect(lines.some((l) => /hop proofs \(Level 1, spec 5\.11\): 4 hop\(s\) checked, 4 version 2 valid/.test(l))).toBe(true)
    await stop(a)
  }, 120_000)
})

describe('version 1 hops around the cutover', () => {
  it('the embedded list is the census: a real old hop stands, and the two h24 hops that failed its audit do not', () => {
    expect(GRANDFATHERED_V1_HOPS.size).toBeGreaterThanOrEqual(2658)
    expect(isGrandfatheredV1Hop('a11938c376d8b53032d9a704a3db3fc1d82add779c164fe589f922889a88ab9f')).toBe(true)
    expect(isGrandfatheredV1Hop('8a24c20a74102aa82f73a9c75cb55609ab8c8ea9050555e80a9f35b530cd3973')).toBe(false)
    expect(isGrandfatheredV1Hop('97c4de2ffcda3e1ccfd433fc8862ba97c20572d9a8c40f34621c20aa9a5ed60a')).toBe(false)
  })

  it('a chain adopted from the relays with an unlisted version 1 hop is reported, not a stop: the agent hops on, version 2', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL)
    const sk = generateSecretKey()
    const pubkey = getPublicKey(sk)
    // What this identity signed before the cutover, from another state directory: a spawn and a version 1 hop.
    const spawn = signEvent(spawnTemplate(pubkey, Math.floor(Date.now() / 1000) - 60), sk)
    const home = coordToXyz(hexToCoord(pubkey))
    const t = hopTemplate({ createdAt: spawn.created_at + 1, genesisId: spawn.id, previousId: spawn.id, prevCoordHex: pubkey, to: { x: home.x + 2n, y: home.y, z: home.z }, plane: home.plane, ...fakeHopProof('cd') })
    const v1 = signEvent({ ...t, tags: t.tags.filter((x) => x[0] !== 'mn' && x[0] !== 'mp') }, sk)
    canonical.seed(spawn, v1)

    const lines: string[] = []
    const a = await start(network, dirWithKey(sk), (l) => lines.push(l))
    await a.hop({ target: { dx: 1 } })
    await until(() => a.keeper.lastHopReport !== null)
    expect(a.keeper.lastHopReport!.unlisted).toEqual([v1.id])
    expect(a.keeper.lastHopReport!.failing).toEqual([])
    expect(lines.some((l) => /1 version 1 not on the list \(signed before the cutover/.test(l))).toBe(true)
    // The new hop extends the adopted chain from the version 1 hop, and is version 2.
    const mine = hopsOn(canonical.published)
    expect(mine).toHaveLength(1)
    expect(mine[0].tags.find((x) => x[0] === 'e' && x[3] === 'previous')![1]).toBe(v1.id)
    expect(levelOne(mine[0])).toEqual([])
    await stop(a)
  }, 60_000)

  it('a version 1 hop a stopped server left unsent in the outbox is dropped, never sent; the next hop is version 2', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL)
    const sk = generateSecretKey()
    const dir = dirWithKey(sk)
    let a = await start(network, dir)
    await a.hop({ target: { dx: 3 } })
    const head = a.keeper.head()!
    const t = hopTemplate({ createdAt: head.createdAt + 1, genesisId: a.keeper.chain()[0].id, previousId: head.id, prevCoordHex: head.coordHex, to: { x: head.position.x + 1n, y: head.position.y, z: head.position.z }, plane: head.plane, ...fakeHopProof() })
    const v1 = signEvent({ ...t, tags: t.tags.filter((x) => x[0] !== 'mn' && x[0] !== 'mp') }, sk)
    a.keeper.record(v1, 'queued')
    a.outbox.add(v1)
    await stop(a)

    a = await start(network, dir)
    expect(a.outbox.state().dropped.map((e) => e.event.id)).toEqual([v1.id])
    expect(a.outbox.state().dropped[0].dropped).toMatch(/a version 1 hop \(no mn and no mp\)/)
    expect(canonical.published.some((e) => e.id === v1.id)).toBe(false)
    expect(a.keeper.head()?.id).toBe(head.id)
    await a.hop({ target: { dx: 1 } })
    const hops = hopsOn(canonical.published)
    expect(hops).toHaveLength(2)
    expect(hops[1].tags.find((x) => x[0] === 'e' && x[3] === 'previous')![1]).toBe(head.id)
    expect(levelOne(hops[1])).toEqual([])
    await stop(a)
  }, 60_000)
})

describe('version 1 hops left in the outbox (review of #51)', () => {
  const prevOf = (e: NostrEvent): string | undefined => e.tags.find((t) => t[0] === 'e' && t[3] === 'previous')?.[1]
  const v1Of = (t: ReturnType<typeof hopTemplate>, sk: Uint8Array): NostrEvent => signEvent({ ...t, tags: t.tags.filter((x) => x[0] !== 'mn' && x[0] !== 'mp') }, sk)

  it('a version 1 hop, a hop chained after it and a kind 1 note: both chain events dropped and logged with the reason, the note sent, the head back where the relays saw it', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL)
    const sk = generateSecretKey()
    const dir = dirWithKey(sk)
    let a = await start(network, dir)
    await a.hop({ target: { dx: 3 } })
    const head = a.keeper.head()!
    const genesis = a.keeper.chain()[0].id
    const to1 = { x: head.position.x + 1n, y: head.position.y, z: head.position.z }
    const v1 = v1Of(hopTemplate({ createdAt: head.createdAt + 1, genesisId: genesis, previousId: head.id, prevCoordHex: head.coordHex, to: to1, plane: head.plane, ...fakeHopProof() }), sk)
    const after = signEvent(hopTemplate({ createdAt: head.createdAt + 2, genesisId: genesis, previousId: v1.id, prevCoordHex: positionHex(to1, head.plane), to: { ...to1, x: to1.x + 1n }, plane: head.plane, ...fakeHopProof('cd') }), sk)
    const note = signEvent({ kind: 1, created_at: head.createdAt + 3, tags: [], content: 'a note beside the chain' }, sk)
    a.keeper.record(v1, 'queued')
    a.outbox.add(v1)
    a.keeper.record(after, 'queued')
    a.outbox.add(after)
    a.outbox.add(note)
    await stop(a)

    const lines: string[] = []
    a = await start(network, dir, (l) => lines.push(l))
    const dropped = a.outbox.state().dropped
    expect(dropped.map((e) => e.event.id).sort()).toEqual([v1.id, after.id].sort())
    const why = (id: string): string => dropped.find((d) => d.event.id === id)!.dropped!
    expect(why(v1.id)).toMatch(/a version 1 hop \(no mn and no mp\), with no relay's acceptance on record here/)
    expect(why(v1.id)).toMatch(/with the 1 unsent event after it on the chain/)
    expect(why(v1.id)).not.toMatch(/no relay has taken/)
    expect(why(after.id)).toMatch(new RegExp(`dropped because the version 1 hop ${v1.id.slice(0, 8)}\\.\\.\\. ahead of it on the chain was dropped`))
    expect(lines).toContain('outbox replay: 1 sent, 2 dropped, 0 waiting for the relays')
    expect(lines.some((l) => l.startsWith(`dropped ${after.id.slice(0, 8)}: dropped because the version 1 hop`))).toBe(true)
    expect(canonical.published.some((e) => e.id === v1.id || e.id === after.id)).toBe(false)
    expect(canonical.published.some((e) => e.id === note.id)).toBe(true)
    expect(a.keeper.head()?.id).toBe(head.id)
    await stop(a)
  }, 60_000)

  it('the crash window: a relay already holds the version 1 hop the outbox thinks is unsent; it is dropped locally, the next hop extends it from the relays, and nothing forks', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL)
    const sk = generateSecretKey()
    const dir = dirWithKey(sk)
    let a = await start(network, dir)
    await a.hop({ target: { dx: 3 } })
    const head = a.keeper.head()!
    const genesis = a.keeper.chain()[0].id
    const v1 = v1Of(hopTemplate({ createdAt: head.createdAt + 1, genesisId: genesis, previousId: head.id, prevCoordHex: head.coordHex, to: { x: head.position.x + 1n, y: head.position.y, z: head.position.z }, plane: head.plane, ...fakeHopProof() }), sk)
    a.keeper.record(v1, 'queued')
    a.outbox.add(v1)
    canonical.seed(v1)
    await stop(a)

    a = await start(network, dir)
    expect(a.outbox.state().dropped.map((d) => d.event.id)).toEqual([v1.id])
    await a.hop({ target: { dx: 1 } })
    await a.hop({ target: { dx: 1 } })
    const hops = hopsOn(canonical.published)
    expect(hops).toHaveLength(3)
    // The first hop after the restart extends the version 1 hop the relay holds, adopted from the relays.
    expect(prevOf(hops[1])).toBe(v1.id)
    for (const hop of hops) expect(levelOne(hop)).toEqual([])
    const moves = canonical.all().filter((e) => e.kind === 3333)
    const prevs = moves.map(prevOf).filter((p): p is string => !!p)
    expect(new Set(prevs).size).toBe(prevs.length)
    expect(a.keeper.status()).toBe('valid')
    await stop(a)
  }, 90_000)
})

describe('the Level 1 check of the agent\'s own chain', () => {
  it('names a failing hop by the step that failed, reports each hop once, and leaves hops past the time budget for the next pass', async () => {
    const sk = generateSecretKey()
    const pubkey = getPublicKey(sk)
    const home = coordToXyz(hexToCoord(pubkey))
    const spawn = signEvent(spawnTemplate(pubkey, 1_700_000_000), sk)
    const forged = signEvent(hopTemplate({ createdAt: 1_700_000_001, genesisId: spawn.id, previousId: spawn.id, prevCoordHex: pubkey, to: { x: home.x + 1n, y: home.y, z: home.z }, plane: home.plane, ...fakeHopProof() }), sk)
    const check = new HopProofCheck(pubkey)
    const skippedFirst = await check.check([spawn, forged], -1)
    expect(skippedFirst).toMatchObject({ checked: 0, skipped: 1 })
    expect(hopReportWords(skippedFirst)).toMatch(/1 left for the next pass/)
    const report = await check.check([spawn, forged])
    expect(report.checked).toBe(1)
    expect(report.failing).toHaveLength(1)
    expect(report.failing[0].id).toBe(forged.id)
    expect(report.failing[0].failed.length).toBeGreaterThan(0)
    expect(hopReportWords(report)).toMatch(/1 FAILING/)
    expect(hopReportWords(await check.check([spawn]))).toBeNull()
  })
})

describe('plan_hop prices the residue extension', () => {
  it('adds primes, trees and re-roll attempts to the trees a hop always cost, growing with h_max', () => {
    const at = (h: number): HopCostEstimate => ({ lcaX: h, lcaY: 0, lcaZ: 0, terrainK: 0, maxHeight: h, totalOps: 0, exceedsLimit: false })
    // At least the m primes and A attempts of the spec's own sizes: h16, m = 22,832; h20, m = 365,288 (spec 5.12).
    expect(hopResidueSeconds(cal, at(16))).toBeGreaterThan((22_832 * DEFAULT_RESIDUE_RATES.primeUs) / 1e6)
    expect(hopResidueSeconds(cal, at(20))).toBeGreaterThan((365_288 * DEFAULT_RESIDUE_RATES.primeUs) / 1e6)
    expect(hopResidueSeconds(cal, at(20))).toBeGreaterThan(hopResidueSeconds(cal, at(16)))
    // The extension is the product and remainder trees on top of the tallest tree, so a hop quote is at least about twice and a bit what the trees alone were.
    expect(hopSeconds(cal, at(16))).toBeGreaterThan(3 * (projectCantorMs(cal.cantorMsByHeight, 16) / 1000))
    // A machine's measured rates are what it is priced at.
    const slow: Calibration = { ...cal, residue: { primeUs: 50, attemptUs: 150 } }
    expect(hopResidueSeconds(slow, at(16))).toBeGreaterThan(hopResidueSeconds(cal, at(16)))
    // A trivial hop (a plane change on the spot at K 0) still pays its minimum: 8 primes and one attempt.
    expect(hopResidueSeconds(cal, at(0))).toBeGreaterThan(0)
  })
})

describe('the calibration measures the residue extension', () => {
  it('times primes and attempts with the prover\'s kernel, and a saved file without those rates is measured again', () => {
    const rates = measureResidueRates()
    expect(rates.primeUs).toBeGreaterThan(0)
    expect(rates.attemptUs).toBeGreaterThan(0)
    const now = Date.now()
    const saved = { ...cal, at: now - 1000, fingerprint: 'here' }
    expect(cacheValid(saved, now, 'here')).toBe(false)
    expect(cacheValid({ ...saved, residue: rates }, now, 'here')).toBe(true)
    expect(cacheValid({ ...saved, residue: { primeUs: 0, attemptUs: 1 } }, now, 'here')).toBe(false)
  })
})
