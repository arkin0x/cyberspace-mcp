// backgroundRide.test.ts: a ride computing in the background on real
// threads (arkinox, 2026-10-11: "agents being responsive is top priority or
// else the feature feels broken"), over the fake relay and the fixture line.
//
// The agent rides a stretch of real blocks whose leaves cost a few seconds
// in all, on the server's ride thread (rideHost.ts) and its leaf threads.
// Responsiveness is measured, not assumed: while the ride computes, a timer
// on the main thread records how late it fires (the event loop's lag), and
// the test calls ride_status, budget, whereami (a relay round trip),
// orders_waiting and ride itself, timing each. The ride's slow main-thread
// steps of old (reading the cache, building the tree, the Level 1
// self-verification of 32 sampled leaves) now run on the ride thread, so
// neither the lag nor any call may reach a second.
//
// Then the interruptions: a pause stops the threads promptly and loses no
// leaf (the cache never holds a height twice, so nothing was computed
// again); a pause that arrives while another call waits on the ride is
// answered and the waiting call returns the paused state; a resume picks the
// cached leaves up; a restart mid-ride leaves flight.json behind, the new
// server reports the ride as interrupted, and the next ride call resumes it
// and signs it; a cancel while computing releases the head.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Agent } from '../src/agent.js'
import { parseAction } from '../src/chain/events.js'
import { LineStore, type Line } from '../src/hyperspace/line.js'
import { K_LINE, lineTerrainK, verifyRideLevel1 } from '../src/hyperspace/ride.js'
import { bytesToHex } from '../src/nostr/event.js'
import type { Calibration } from '../src/space/calibration.js'
import { placeOf, spawnPlace } from '../src/space/coords.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork } from './fakeRelay.js'
import { MANIFEST_URL, fakeFetch, servedFor } from './hyperspace/lineFixture.js'

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }
const TIP = 6143
/** The ride: this many blocks above the station, none above terrain K MAX_K, costing about MIN_PAIRS to MAX_PAIRS pairings in all. */
const LENGTH = 16
const MAX_K = 10
const MIN_PAIRS = 2 ** 18
const MAX_PAIRS = 2 ** 20
/** The most a tool call or the event loop may lag while the ride computes. */
const RESPONSIVE_MS = 1000

const network = new FakeNetwork()
const canonical = network.add(CANONICAL)
network.add(MINE)
const served = servedFor(3)

function dirWithKey(sk: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-bgride-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
  return dir
}

const agents: Agent[] = []
afterAll(async () => { for (const a of agents) await a.stop() })

async function startAgent(stateDir: string): Promise<Agent> {
  const agent = await Agent.start({
    stateDir, relays: [CANONICAL, MINE], capCallSeconds: 30, capSessionSeconds: 600, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1500,
    manifestUrl: MANIFEST_URL, lineFetch: fakeFetch(served), rideThreads: 2,
  })
  agents.push(agent)
  return agent
}

function pairsAbove(line: Line, s: number): number | null {
  if (s + LENGTH > TIP) return null
  let pairs = 0
  for (let h = s + 1; h <= s + LENGTH; h++) {
    const k = lineTerrainK(line.blockHash(h)!)
    if (k > MAX_K) return null
    pairs += 2 ** (k + K_LINE)
  }
  return pairs
}

async function until(cond: () => boolean, ms = 120_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** The heights in a ride's leaf file, each as often as a line holds it. */
function leafHeights(file: string): number[] {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => Number(l.split(' ')[0]))
}

/**
 * While `busy` holds, sample the event loop's lag and time a round of tool
 * calls every 200 ms; returns the worst of each, in milliseconds.
 */
async function measure(a: Agent, busy: () => boolean): Promise<{ lag: number; call: number; rounds: number; phases: Set<string> }> {
  let lag = 0
  let last = performance.now()
  const sampler = setInterval(() => {
    const now = performance.now()
    lag = Math.max(lag, now - last - 20)
    last = now
  }, 20)
  let call = 0
  let rounds = 0
  const phases = new Set<string>()
  const timed = async (fn: () => unknown): Promise<void> => {
    const t = performance.now()
    await fn()
    call = Math.max(call, performance.now() - t)
  }
  try {
    while (busy()) {
      await timed(() => a.rideStatus())
      await timed(() => a.budgetState())
      await timed(() => a.whereami())
      await timed(() => a.ordersWaiting())
      const to = a.transit.rideState().to
      if (to !== null && a.transit.rideState().state === 'computing') await timed(() => a.ride({ to }))
      const p = (a.rideStatus().data.ride as { progress: { phase: string } | null } | undefined)?.progress
      if (p) phases.add(p.phase)
      rounds++
      await new Promise((r) => setTimeout(r, 200))
    }
  } finally {
    clearInterval(sampler)
  }
  // BGRIDE_REPORT=1 prints what was measured.
  if (process.env.BGRIDE_REPORT) console.log(`measured over ${rounds} round(s): worst event-loop lag ${lag.toFixed(0)} ms, worst tool call ${call.toFixed(0)} ms, phases seen ${[...phases].join(', ')}`)
  return { lag, call, rounds, phases }
}

describe('a ride in the background, on real threads (arkinox, 2026-10-11)', () => {
  let sk: Uint8Array
  let dir: string
  let S: number
  let a: Agent

  beforeAll(async () => {
    const probe = LineStore.open(join(mkdtempSync(join(tmpdir(), 'cyberspace-mcp-bgride-probe-')), 'line'), { manifestUrl: MANIFEST_URL, fetch: fakeFetch(served) })
    const sync = await probe.sync({ budgetSeconds: 60 })
    if (sync.asOf !== TIP) throw new Error(`the fixture line did not verify: ${sync.failure}`)
    for (let tries = 0; ; tries++) {
      const candidate = generateSecretKey()
      const home = spawnPlace(getPublicKey(candidate))
      const head = placeOf({ x: home.position.x + 5n, y: home.position.y, z: home.position.z }, home.plane)
      const station = probe.line.station(head.hex, TIP)
      const pairs = station ? pairsAbove(probe.line, station.stop.height) : null
      if (station && pairs !== null && pairs >= MIN_PAIRS && pairs <= MAX_PAIRS) {
        sk = candidate
        S = station.stop.height
        break
      }
      if (tries > 50_000) throw new Error('no key found whose station starts a suitable stretch of the line')
    }
    dir = dirWithKey(sk)
    a = await startAgent(dir)
    await a.hop({ target: { dx: 5, dy: 0, dz: 0 } })
    await a.station({ sync: true, budget_seconds: 60 })
    await a.board()
    // The waker's question, answered by a stand-in operator channel: the ride's state is what is under test.
    vi.spyOn(a.operatorChannel, 'ordersWaiting').mockResolvedValue({ text: 'No new orders.', data: { orders: 0, strategy: false, continue: false, waitingForFollow: 0 } })
  }, 120_000)

  it('starts at once, answers every tool within a second while computing, pauses promptly without losing a leaf, and a pause racing a waiting call is safe', async () => {
    const to = S + LENGTH
    const boarding = a.keeper.head()!
    const leavesFile = join(a.transit.runner.cache.path, 'leaves', `${boarding.id}.log`)

    const t0 = performance.now()
    const started = await a.ride({ to })
    expect(performance.now() - t0).toBeLessThan(RESPONSIVE_MS * 2)
    expect(started.data.state).toBe('computing')
    expect(started.text).toContain('2 thread(s)')
    // One background ride at a time: a second ride, to anywhere else, is refused at once.
    await expect(a.ride({ to: to - 1 })).rejects.toThrow(new RegExp(`A ride to block ${to} is in flight`))
    const waiting = await a.ordersWaiting()
    expect(waiting.data.ride).toMatchObject({ state: 'computing', to, total: LENGTH })

    // Responsive while the leaves compute.
    const leaves = await measure(a, () => a.transit.rideState().done < 4)
    expect(leaves.rounds).toBeGreaterThan(0)
    expect(leaves.lag).toBeLessThan(RESPONSIVE_MS)
    expect(leaves.call).toBeLessThan(RESPONSIVE_MS)

    // A call that waits on the ride, and a pause arriving while it waits.
    const waiter = a.ride({ to, wait_seconds: 25 })
    const p0 = performance.now()
    const paused = await a.ride({ pause: true })
    expect(performance.now() - p0).toBeLessThan(5000)
    expect(paused.data.state).toBe('paused')
    const waited = await waiter
    expect(waited.data.state).toBe('paused')
    expect(a.keeper.moving).toBe(true)
    // The threads stopped: nothing more lands in the cache while paused.
    const heldAtPause = leafHeights(leavesFile)
    expect(heldAtPause.length).toBe(a.transit.rideState().done)
    await new Promise((r) => setTimeout(r, 1500))
    expect(leafHeights(leavesFile)).toEqual(heldAtPause)
    expect(new Set(heldAtPause).size).toBe(heldAtPause.length)
    expect((await a.ordersWaiting()).data.ride).toMatchObject({ state: 'paused', done: heldAtPause.length })

    // Resume: the cached leaves are picked up, and the work goes on.
    const resumed = await a.ride({ to })
    expect(resumed.text).toContain('Resumed from the pause')
    await until(() => a.transit.rideState().done >= heldAtPause.length + 2 && a.transit.rideState().state === 'computing')
    expect((a.rideStatus().data.ride as { progress: { leavesResumed: number } }).progress.leavesResumed).toBe(heldAtPause.length)
  }, 180_000)

  it('a restart mid-ride leaves the ride interrupted; the next ride call resumes it from the cache, recomputing nothing, stays responsive through the tree and the self-verification, and signs it', async () => {
    const to = S + LENGTH
    const boarding = a.keeper.head()!
    const leavesFile = join(a.transit.runner.cache.path, 'leaves', `${boarding.id}.log`)
    await a.stop()
    const held = leafHeights(leavesFile)
    expect(new Set(held).size).toBe(held.length)
    const record = JSON.parse(readFileSync(join(a.transit.runner.cache.path, 'flight.json'), 'utf8'))
    expect(record).toMatchObject({ status: 'live', previousId: boarding.id, toHeight: to })

    const b = await startAgent(dir)
    vi.spyOn(b.operatorChannel, 'ordersWaiting').mockResolvedValue({ text: 'No new orders.', data: { orders: 0, strategy: false, continue: false, waitingForFollow: 0 } })
    expect(b.keeper.moving).toBe(false)
    expect(b.transit.rideState()).toMatchObject({ state: 'interrupted', to })
    expect(b.rideStatus().text).toContain(`Call ride with to: ${to} to resume it`)
    expect((await b.ordersWaiting()).data.ride).toMatchObject({ state: 'interrupted', to })
    // The line is verified again by each process before a ride can use it.
    await b.station({ sync: true, budget_seconds: 60 })
    const resumed = await b.ride({ to })
    expect(resumed.data.state).toBe('computing')
    expect((resumed.data.ride as { notes: string[] }).notes.join(' ')).toContain('cached leaf(s) are picked up')
    expect(b.keeper.moving).toBe(true)

    const rest = await measure(b, () => b.transit.rideState().state === 'computing')
    expect(b.transit.rideState().state).toBe('ready')
    expect(rest.phases.has('verify')).toBe(true)
    expect(rest.lag).toBeLessThan(RESPONSIVE_MS)
    expect(rest.call).toBeLessThan(RESPONSIVE_MS)
    const progress = (b.rideStatus().data.ride as { progress: { leavesResumed: number; leavesDone: number } }).progress
    expect(progress.leavesResumed).toBe(held.length)
    const all = leafHeights(leavesFile)
    expect(all.length).toBe(LENGTH)
    expect(new Set(all).size).toBe(LENGTH)
    expect((await b.ordersWaiting()).data.ride).toMatchObject({ state: 'ready', to, done: LENGTH, total: LENGTH })

    const done = await b.ride({ to })
    expect(done.data.action).toBe('hyperjump')
    const ev = canonical.all().find((e) => e.id === done.data.eventId)!
    const parsed = parseAction(ev)!
    expect(parsed).toMatchObject({ previousId: boarding.id, fromHeight: S, toHeight: to })
    const check = await verifyRideLevel1({ eventId: ev.id, previousEventIdHex: boarding.id, fromHeight: S, toHeight: to, rootHex: parsed.proofHash!, mp: parsed.mp!, mn: parsed.mn ?? null, blockHashFor: (h) => b.transit.store.line.blockHash(h)! })
    expect(check.ok).toBe(true)
    expect(b.keeper.moving).toBe(false)
    a = b
  }, 240_000)

  it('cancel while computing stops the threads and releases the head at once', async () => {
    const to = S + 1
    const r = await a.ride({ to })
    expect(r.data.state).toBe('computing')
    const t0 = performance.now()
    const canceled = await a.ride({ cancel: true })
    expect(performance.now() - t0).toBeLessThan(5000)
    expect(canceled.data.inFlight).toBe(false)
    expect(a.keeper.moving).toBe(false)
    expect(a.transit.rideState().state).toBeNull()
  }, 60_000)
})
