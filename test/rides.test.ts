// rides.test.ts: the hyperspace tools end to end over the fake relay. An
// agent on a fresh key spawns and hops, is refused a boarding before the line
// is synced, syncs the line from the fixture blobs, boards, rides three
// blocks over two budgeted calls, rides again from the stop it reached,
// cancels a ride in flight, and is refused what would break its chain. The
// line is the real chain's first 6144 blocks (lineFixture.ts), served by a
// fetch that never leaves the process; the rides pass three blocks of low
// terrain K, so a leaf costs milliseconds and the suite stays fast.
//
// What would fail silently without these tests: a ride signed from a head
// other than the one its leaves were seeded by; a first ride without its
// as_of, or a later one whose from_height is not the previous B, both of
// which the reader (events.ts rideBreak) freezes the chain at; a cache
// dropped before the event was recorded, which a crash would turn into hours
// repaid; a head reservation that did not outlive the call, letting a hop
// sign from the head a ride was computing from.

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Agent, Refusal } from '../src/agent.js'
import { chainTemplateProblem, hopTemplate } from '../src/chain/builder.js'
import { buildChain, chainStatus, parseAction, type ActionEvent } from '../src/chain/events.js'
import { LineStore, type Line } from '../src/hyperspace/line.js'
import { lineTerrainK, verifyRideLevel1 } from '../src/hyperspace/ride.js'
import { bytesToHex, signEvent, tagValue, type NostrEvent } from '../src/nostr/event.js'
import type { Calibration } from '../src/space/calibration.js'
import { placeOf, spawnPlace, type Position } from '../src/space/coords.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { Transit } from '../src/transit.js'
import { FakeNetwork } from './fakeRelay.js'
import { MANIFEST_URL, fakeFetch, servedFor } from './hyperspace/lineFixture.js'

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }
/** The newest block of the fixture line. */
const TIP = 6143
/** A ride of this many blocks, each of terrain K at most CHEAP_K (a leaf of height 12, milliseconds). */
const RIDE_LENGTH = 3
const CHEAP_K = 6

const network = new FakeNetwork()
const canonical = network.add(CANONICAL, { refuse: (ev) => ([0, 33330].includes(ev.kind) ? 'blocked: not a member yet' : null) })
network.add(MINE)
const served = servedFor(3)

/** The ride runner's clock: every read moves it `stepPerRead` ms, so a call's budget runs out after a known amount of work. */
function fakeClock(): { now: () => number; stepPerRead: number } {
  let t = 1000
  const clock = {
    stepPerRead: 0,
    now: () => {
      const v = t
      t += clock.stepPerRead
      return v
    },
  }
  return clock
}
const clock = fakeClock()

/** A state directory whose key the test generated, written the way the server writes its own. */
function dirWithKey(sk: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-rides-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
  return dir
}

const agents: Agent[] = []
afterAll(async () => { for (const a of agents) await a.stop() })

async function startAgent(stateDir: string): Promise<Agent> {
  const agent = await Agent.start({
    stateDir, relays: [CANONICAL, MINE], capCallSeconds: 30, capSessionSeconds: 120, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1500,
    manifestUrl: MANIFEST_URL, lineFetch: fakeFetch(served), rideThreads: 0, rideClock: clock.now,
  })
  agents.push(agent)
  return agent
}

/** Whether the RIDE_LENGTH blocks above `s` are all cheap to ride. */
function cheapAbove(line: Line, s: number): boolean {
  if (s + RIDE_LENGTH > TIP) return false
  for (let h = s + 1; h <= s + RIDE_LENGTH; h++) if (lineTerrainK(line.blockHash(h)!) > CHEAP_K) return false
  return true
}

const published = (id: unknown): NostrEvent => {
  const ev = canonical.all().find((e) => e.id === id)
  if (!ev) throw new Error(`event ${String(id)} is not on the canonical relay`)
  return ev
}

const beside = (head: ActionEvent, dx: bigint): Position => ({ x: head.position.x + dx, y: head.position.y, z: head.position.z })

describe('the hyperspace tools, on a fresh key over the fixture line', () => {
  let sk: Uint8Array
  /** The station block of the key chosen: the ride leaves from here. */
  let S: number
  let a: Agent

  beforeAll(async () => {
    // The line, verified once here so the test can choose its key. A random
    // key's station is a random block, so keys are drawn until the three
    // blocks above the station are cheap; about one key in a hundred is.
    const probe = LineStore.open(join(mkdtempSync(join(tmpdir(), 'cyberspace-mcp-rides-probe-')), 'line'), { manifestUrl: MANIFEST_URL, fetch: fakeFetch(served) })
    const sync = await probe.sync({ budgetSeconds: 60 })
    if (sync.asOf !== TIP) throw new Error(`the fixture line did not verify: ${sync.failure}`)
    for (let tries = 0; ; tries++) {
      const candidate = generateSecretKey()
      const home = spawnPlace(getPublicKey(candidate))
      // Where the first hop (dx 5) lands, which is where the agent boards.
      const head = placeOf({ x: home.position.x + 5n, y: home.position.y, z: home.position.z }, home.plane)
      const station = probe.line.station(head.hex, TIP)
      if (station && cheapAbove(probe.line, station.stop.height)) {
        sk = candidate
        S = station.stop.height
        break
      }
      if (tries > 50_000) throw new Error('no key found whose station starts a cheap stretch of the line')
    }
  }, 60_000)

  it('spawns and hops; before the line is synced, board and ride are refused in words and station names no stop', async () => {
    a = await startAgent(dirWithKey(sk))
    const hop = await a.hop({ target: { dx: 5, dy: 0, dz: 0 } })
    expect(hop.data.action).toBe('hop')
    await expect(a.board()).rejects.toThrow(/station with sync: true/)
    await expect(a.ride({ to: S + RIDE_LENGTH })).rejects.toThrow(/not on the line/)
    const r = await a.station()
    expect((r.data.line as { asOf: number }).asOf).toBe(-1)
    expect(r.data.station).toBeNull()
    expect(r.data.onLine).toBeNull()
    expect(r.text).toContain('Nothing was signed')
    expect(a.transit.threads).toBe(0)
  }, 60_000)

  it('station with sync verifies the line (not charged to the session), names the station, and quotes a short ride', async () => {
    const spentBefore = a.budget.spentSeconds
    const r = await a.station({ sync: true, budget_seconds: 60, destination: S + RIDE_LENGTH })
    expect((r.data.sync as { done: boolean; failure: string | null }).done).toBe(true)
    expect((r.data.line as { asOf: number; tip: number; remainingBlobs: number }).asOf).toBe(TIP)
    expect((r.data.line as { remainingBlobs: number }).remainingBlobs).toBe(0)
    expect(a.budget.spentSeconds).toBe(spentBefore)
    const station = r.data.station as { height: number; distance: number; asOf: number; kind: string }
    expect(station.height).toBe(S)
    expect(station.asOf).toBe(TIP)
    expect(station.distance).toBeGreaterThan(0)
    expect((r.data.nearest as unknown[]).length).toBe(5)
    const quote = r.data.quote as { refused: string | null; fromHeight: number; asOf: number; chained: boolean; blocks: number; expectedSeconds: number; fitsSession: boolean; calls: number; exitDistance: number }
    expect(quote.refused).toBeNull()
    expect(quote).toMatchObject({ fromHeight: S, asOf: TIP, chained: false, blocks: RIDE_LENGTH, fitsSession: true })
    expect(quote.expectedSeconds).toBeGreaterThan(0)
    expect(quote.calls).toBeGreaterThanOrEqual(1)
    expect(quote.exitDistance).toBeGreaterThan(0)
    expect(r.text).toContain(`Quote to block ${S + RIDE_LENGTH}: from your station, block ${S}`)
    expect(r.text).toContain('Nothing was signed')
    // A quote beyond the line, and one to the station itself, are refused in words without a signature.
    expect(((await a.station({ destination: TIP + 1 })).data.quote as { refused: string }).refused).toMatch(/beyond the verified line, which reaches block 6143/)
    expect(((await a.station({ destination: S })).data.quote as { refused: string }).refused).toMatch(/your station/)
  }, 60_000)

  it('board signs a boarding whose c is its C and whose tags the builder accepts; a second boarding is refused', async () => {
    const head = a.keeper.head()!
    const r = await a.board()
    expect(r.data.action).toBe('enter-hyperspace')
    const ev = published(r.data.eventId)
    expect(tagValue(ev, 'c')).toBe(head.coordHex)
    expect(tagValue(ev, 'C')).toBe(head.coordHex)
    expect(ev.tags.find((t) => t[0] === 'e' && t[3] === 'previous')?.[1]).toBe(head.id)
    expect(chainTemplateProblem({ kind: ev.kind, created_at: ev.created_at, content: ev.content, tags: ev.tags }, a.pubkey)).toBeNull()
    expect(parseAction(ev)?.type).toBe('enter-hyperspace')
    expect((r.data.station as { height: number }).height).toBe(S)
    expect(r.text).toContain('You are on the line and have not moved')
    expect(a.keeper.status()).toBe('valid')
    expect(a.keeper.head()!.id).toBe(ev.id)
    expect(a.here().hex).toBe(head.coordHex)
    expect(a.budget.state().moves).toBe(2)
    expect((await a.station()).data.onLine).toMatchObject({ boarded: true, atStop: null, head: ev.id })
    await expect(a.board()).rejects.toThrow(/already on the line/)
  }, 60_000)

  it('ride refuses, in words and without reserving the head: a zero-length ride, a block beyond the line, an as_of below the destination, a ride the session cap does not allow', async () => {
    await expect(a.ride({ to: S })).rejects.toThrow(/your station, the block this ride would start from/)
    await expect(a.ride({ to: TIP + 1 })).rejects.toThrow(/beyond the verified line/)
    await expect(a.ride({ to: S + RIDE_LENGTH, as_of: S + 1 })).rejects.toThrow(/as_of \(\d+\) is below the block the ride goes to/)
    await expect(a.ride({})).rejects.toThrow(/Say which block to ride to/)
    const spent = a.budget.spentSeconds
    a.budget.spentSeconds = a.budget.capSessionSeconds
    await expect(a.ride({ to: S + RIDE_LENGTH })).rejects.toThrow(/the session has 0\.0 s of its 120 s left\. One call is capped at 30 s/)
    a.budget.spentSeconds = spent
    await expect(a.ride({ cancel: true })).rejects.toThrow(Refusal)
    expect(a.keeper.moving).toBe(false)
    expect(a.rideStatus().data.inFlight).toBe(false)
  })

  it('ride: progress over two budgeted calls with the head reserved between them, then a hyperjump the reader and Level 1 accept, its cache forgotten only once recorded', async () => {
    const to = S + RIDE_LENGTH
    const boarding = a.keeper.head()!
    const leavesFile = join(a.transit.runner.cache.path, 'leaves', `${boarding.id}.log`)
    // Every clock read is a second, so an eight-second budget cuts the ride after a leaf or two.
    clock.stepPerRead = 1000
    const first = await a.ride({ to, budget_seconds: 8 })
    clock.stepPerRead = 0
    expect(first.data.done).toBe(false)
    const flight = first.data.ride as { calls: number; progress: { leavesDone: number; leavesTotal: number; leavesResumed: number } }
    expect(flight.calls).toBe(1)
    expect(flight.progress.leavesTotal).toBe(RIDE_LENGTH)
    expect(flight.progress.leavesDone).toBeGreaterThan(0)
    expect(first.text).toContain(`Ride to block ${to} from block ${S}`)
    expect(first.text).toContain('The head is reserved for this ride')
    expect(existsSync(leavesFile)).toBe(true)
    // Reserved across calls: no hop and no other ride can sign from this head, and the status names the ride.
    expect(a.keeper.moving).toBe(true)
    await expect(a.hop({ target: { dx: 1 } })).rejects.toThrow(/already in flight/)
    await expect(a.ride({ to: to + 1 })).rejects.toThrow(new RegExp(`A ride to block ${to} is in flight`))
    const status = a.rideStatus()
    expect(status.data).toMatchObject({ inFlight: true, stale: false })
    expect(status.text).toContain(`Ride to block ${to}`)

    // forget runs only once the chain already holds the ride: what the head was, and whether the cache was still there, at the moment it was called.
    const forgotten: Array<{ prev: string; head: ActionEvent | null; cached: boolean }> = []
    const forget = vi.spyOn(a.transit.runner, 'forget').mockImplementation((prev: string) => {
      forgotten.push({ prev, head: a.keeper.head(), cached: existsSync(leavesFile) })
      return Object.getPrototypeOf(a.transit.runner).forget.call(a.transit.runner, prev)
    })
    let done
    try {
      done = await a.ride({ to })
    } finally {
      forget.mockRestore()
    }
    expect(done.data.action).toBe('hyperjump')
    expect(forgotten.length).toBe(1)
    expect(forgotten[0].prev).toBe(boarding.id)
    expect(forgotten[0].cached).toBe(true)
    expect(forgotten[0].head?.type).toBe('hyperjump')
    expect(forgotten[0].head?.id).toBe(done.data.eventId)
    expect(existsSync(leavesFile)).toBe(false)
    expect(done.data.calls).toBe(2)
    expect((done.data.verification as { ok: boolean; checked: number }).ok).toBe(true)
    expect(done.text).toContain('signed')
    expect(done.text).toContain('Accepted by')

    const ev = published(done.data.eventId)
    const parsed = parseAction(ev)!
    expect(parsed.type).toBe('hyperjump')
    expect(parsed).toMatchObject({ fromHeight: S, toHeight: to, asOf: TIP, previousId: boarding.id, prevCoordHex: boarding.coordHex })
    expect(parsed.coordHex).toBe(a.transit.store.line.stopCoordHex(to))
    expect(parsed.mn).toMatch(/^[0-9a-f]{16}$/)
    // The chain [spawn, hop, boarding, ride] resolves valid: rideBreak finds nothing to say.
    const chain = buildChain(a.keeper.events, a.pubkey)
    expect(chain.map((x) => x.type)).toEqual(['spawn', 'hop', 'enter-hyperspace', 'hyperjump'])
    expect(chainStatus(chain)).toBe('valid')
    expect(chain[3].breaks).toBeUndefined()
    // Level 1, as a verifier checks it, against the line's block hashes.
    const check = await verifyRideLevel1({ eventId: ev.id, previousEventIdHex: boarding.id, fromHeight: S, toHeight: to, rootHex: parsed.proofHash!, mp: parsed.mp!, mn: parsed.mn ?? null, blockHashFor: (h) => a.transit.store.line.blockHash(h)! })
    expect(check).toMatchObject({ ok: true, checked: 32, grandfathered: false })

    expect(a.here().hex).toBe(parsed.coordHex)
    expect(a.keeper.moving).toBe(false)
    expect(a.rideStatus().data.inFlight).toBe(false)
    expect(a.budget.state().moves).toBe(3)
    expect((await a.station()).data.onLine).toMatchObject({ boarded: true, atStop: to })
  }, 120_000)

  it('a second ride leaves from the first ride\'s B and declares no as_of; the block you stand at is refused', async () => {
    const at = S + RIDE_LENGTH
    const back = S + 1
    await expect(a.ride({ to: at })).rejects.toThrow(/already at block/)
    const prev = a.keeper.head()!
    const r = await a.ride({ to: back, as_of: TIP })
    expect(r.data.action).toBe('hyperjump')
    expect((r.data.notes as string[]).join(' ')).toMatch(/as_of \d+ was ignored/)
    const ev = published(r.data.eventId)
    const parsed = parseAction(ev)!
    expect(parsed).toMatchObject({ fromHeight: at, toHeight: back, previousId: prev.id, prevCoordHex: prev.coordHex })
    expect(parsed.asOf).toBeUndefined()
    expect(ev.tags.some((t) => t[0] === 'as_of')).toBe(false)
    const chain = buildChain(a.keeper.events, a.pubkey)
    expect(chainStatus(chain)).toBe('valid')
    expect(chain[chain.length - 1].coordHex).toBe(a.transit.store.line.stopCoordHex(back))
    expect((await a.station()).data.onLine).toMatchObject({ atStop: back })
  }, 120_000)

  it('cancel releases the head and keeps the cache; forget drops the cache too; nothing is signed', async () => {
    const to = S + RIDE_LENGTH
    const prev = a.keeper.head()!
    const leavesFile = join(a.transit.runner.cache.path, 'leaves', `${prev.id}.log`)
    clock.stepPerRead = 1000
    const first = await a.ride({ to, budget_seconds: 8 })
    clock.stepPerRead = 0
    expect(first.data.done).toBe(false)
    expect(a.keeper.moving).toBe(true)
    expect(existsSync(leavesFile)).toBe(true)
    const canceled = await a.ride({ cancel: true })
    expect(canceled.data.inFlight).toBe(false)
    expect(canceled.text).toContain('kept on disk')
    expect(a.keeper.moving).toBe(false)
    expect(existsSync(leavesFile)).toBe(true)
    expect(a.rideStatus().data.inFlight).toBe(false)
    const forgot = await a.ride({ forget: true })
    expect(forgot.data.forgot).toBe(prev.id)
    expect(existsSync(leavesFile)).toBe(false)
    expect(a.keeper.head()!.id).toBe(prev.id)
  }, 60_000)

  it('board refuses when the head moves while the entry proof is computed, discards the proof unsigned, and adopts the newer move', async () => {
    // Another device leaves the line with a hop from the stop; this server adopts it on its next look at the relays.
    const stop = a.keeper.head()!
    const spawn = a.keeper.chain()[0]
    const left = signEvent(hopTemplate({ createdAt: stop.createdAt + 1, genesisId: spawn.id, previousId: stop.id, prevCoordHex: stop.coordHex, to: beside(stop, 1n), plane: stop.plane, proofHash: 'cd'.repeat(32) }), sk)
    canonical.inject(left)
    await a.whereami()
    expect(a.keeper.head()!.id).toBe(left.id)
    expect((await a.station()).data.onLine).toBeNull()
    await expect(a.ride({ to: S })).rejects.toThrow(/not on the line: your head .* is a hop/)

    let other: NostrEvent | null = null
    const spy = vi.spyOn(a.transit, 'entryProof').mockImplementation((head: ActionEvent) => {
      // Another device signs in as this identity and hops from the confirmed head while the entry proof is being computed.
      other = signEvent(hopTemplate({ createdAt: head.createdAt + 1, genesisId: spawn.id, previousId: head.id, prevCoordHex: head.coordHex, to: beside(head, 7n), plane: head.plane, proofHash: 'ef'.repeat(32) }), sk)
      canonical.inject(other)
      return Transit.prototype.entryProof.call(a.transit, head)
    })
    try {
      const movesBefore = a.budget.state().moves
      await expect(a.board()).rejects.toThrow(/moved while the entry proof was computed/)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(a.keeper.head()!.id).toBe(other!.id)
      // The proof was work, so it counts; the boarding it was for was never signed.
      expect(a.budget.state().moves).toBe(movesBefore + 1)
      expect(canonical.all().some((e) => e.pubkey === a.pubkey && tagValue(e, 'A') === 'enter-hyperspace' && e.tags.some((t) => t[0] === 'e' && t[3] === 'previous' && t[1] === left.id))).toBe(false)
    } finally {
      spy.mockRestore()
    }
    // From the adopted head, boarding goes through, bound to that head.
    const r = await a.board()
    expect(parseAction(published(r.data.eventId))?.previousId).toBe(other!.id)
    expect(a.keeper.status()).toBe('valid')
  }, 60_000)
})
