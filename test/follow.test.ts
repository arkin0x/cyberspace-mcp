// follow.test.ts: the follow watch and nobody's gibson (arkinox,
// 2026-10-11), end to end over the fake relays; no real relay is touched.
//
// The operator follows the agent and has a DM inbox, as in operator.test.ts.
// Their chain is signed here with the server's own builder (proofs are not
// re-verified by any chain read, so a placeholder proof hash stands in). The
// watch reports the operator's verified moves through orders_waiting, from
// memory; ignores a stranger's move, a forged event and a fork; survives a
// restart and reads what happened while it was down; and never makes a tool
// wait while it reads. The agent is refused the operator's exact gibson and
// told the free one beside it, which it may take; a bot's gibson is not
// protected, a human stranger's is; and a ride's arrival at a stop reports
// the exception.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Agent, Refusal } from '../src/agent.js'
import { hopTemplate, spawnTemplate } from '../src/chain/builder.js'
import { bytesToHex, nowSeconds, signEvent, type NostrEvent } from '../src/nostr/event.js'
import type { Calibration } from '../src/space/calibration.js'
import { placeFromHex, placeOf, type Place } from '../src/space/coords.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork, type FakeRelay } from './fakeRelay.js'

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'
const GENERAL = 'wss://general.example'
const INBOX = 'wss://inbox.example/'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }
const PROOF = 'ab'.repeat(32)

function dirWithKey(sk: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-follow-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
  return dir
}

interface World {
  network: FakeNetwork
  canonical: FakeRelay
  mine: FakeRelay
  general: FakeRelay
}

function world(): World {
  const network = new FakeNetwork()
  const canonical = network.add(CANONICAL, { refuse: (ev) => (ev.kind === 1059 ? 'blocked: kind 1059 is not accepted here' : null) })
  const mine = network.add(MINE)
  const general = network.add(GENERAL, { requireAuth: false })
  network.add(INBOX, { challengeOnReq: true, protectWraps: true, requireAuthToPublish: true })
  return { network, canonical, mine, general }
}

const running: Agent[] = []
afterAll(async () => { for (const a of running) await a.stop() })

async function start(w: World, dir: string, operator: string): Promise<Agent> {
  const a = await Agent.start({
    stateDir: dir, relays: [CANONICAL, MINE], operator, capCallSeconds: 30, capSessionSeconds: 300, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: w.network.WebSocket, calibration: cal, relayMaxWaitMs: 1500, lookupRelays: [GENERAL],
  })
  running.push(a)
  return a
}

async function stop(a: Agent): Promise<void> {
  await a.stop()
  running.splice(running.indexOf(a), 1)
}

async function until(what: string, ok: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try { await p } catch (err) { if (err instanceof Refusal) return err.message; throw err }
  throw new Error('expected a refusal')
}

/** A chain signed by a test key, one event at a time, as any client would publish it. */
class Walker {
  readonly pubkey: string
  readonly spawn: NostrEvent
  head: NostrEvent
  private at: number
  constructor(private readonly sk: Uint8Array, at = nowSeconds() - 600) {
    this.pubkey = getPublicKey(sk)
    this.at = at
    this.spawn = signEvent(spawnTemplate(this.pubkey, this.at), sk)
    this.head = this.spawn
  }

  /** The next hop, to `to`, without making it the head (a fork signs two from one head). */
  hopFrom(prev: NostrEvent, to: Place): NostrEvent {
    // Signed now, as a live client signs; a subscription asks only for the last minute.
    this.at = Math.max(this.at + 1, nowSeconds())
    const prevC = prev.tags.find((t) => t[0] === 'C')![1]
    return signEvent(hopTemplate({ createdAt: this.at, genesisId: this.spawn.id, previousId: prev.id, prevCoordHex: prevC, to: to.position, plane: to.plane, proofHash: PROOF }), this.sk)
  }

  hop(to: Place): NostrEvent {
    this.head = this.hopFrom(this.head, to)
    return this.head
  }
}

/** A place `dx` gibsons east of `p`, same plane. */
const east = (p: Place, dx: bigint, dy = 0n): Place => placeOf({ x: p.position.x + dx, y: p.position.y + dy, z: p.position.z }, p.plane)

describe('the follow watch', () => {
  const w = world()
  const opSk = generateSecretKey()
  const op = getPublicKey(opSk)
  const agentSk = generateSecretKey()
  const me = getPublicKey(agentSk)
  const home = placeFromHex(me)
  const dir = dirWithKey(agentSk)
  const operator = new Walker(opSk)
  let a: Agent

  it('reports the operator\'s verified position and the free gibson beside them, and marks it seen', async () => {
    w.general.seed(finalizeEvent({ kind: 10050, created_at: nowSeconds(), tags: [['relay', INBOX]], content: '' }, opSk) as NostrEvent, finalizeEvent({ kind: 3, created_at: nowSeconds(), tags: [['p', me]], content: '' }, opSk) as NostrEvent)
    a = await start(w, dir, op)
    await a.identity({ name: 'xor' })
    await a.hop({ target: { dx: 5, dy: 0, dz: 0 } })
    w.canonical.seed(operator.spawn, operator.hop(east(home, 30n)))

    const r = await a.followOperator({ on: true })
    expect(r.data.on).toBe(true)
    const pos = r.data.position as { to: string; eventId: string; action: string }
    expect(pos.to).toBe(east(home, 30n).hex)
    expect(pos.eventId).toBe(operator.head.id)
    expect(pos.action).toBe('hop')
    // The aim is beside the operator, never their own gibson, and the way there is priced.
    const beside = r.data.beside as { hex: string }
    expect(beside.hex).toBe(east(home, 29n).hex)
    expect((r.data.plan as { refused: string | null }).refused).toBeNull()
    expect(r.data.needsRide).toBe(false)
    expect(r.text).toContain('never land on your operator\'s own gibson')
    // Reported, so seen: orders_waiting has no move to wake on.
    const ow = await a.ordersWaiting()
    expect(ow.data.operatorMoved).toBeNull()
    expect(ow.data.orders).toBe(0)
  }, 30_000)

  it('a move of the operator is verified and reported by orders_waiting until follow_operator reports it', async () => {
    const h2 = operator.hop(east(home, 40n))
    w.canonical.inject(h2)
    await until('the move', () => a.follow.unseen()?.eventId === h2.id)
    const ow = await a.ordersWaiting()
    const moved = ow.data.operatorMoved as { to: string; plane: number; at: number; eventId: string; action: string; distance: string }
    expect(moved.eventId).toBe(h2.id)
    expect(moved.to).toBe(east(home, 40n).hex)
    expect(moved.plane).toBe(home.plane)
    expect(moved.at).toBe(h2.created_at)
    expect(moved.distance).toContain('35 east')
    expect(ow.text).toContain('Your operator moved')
    // Still unseen on the next poll: only follow_operator marks it.
    expect(((await a.ordersWaiting()).data.operatorMoved as { eventId: string }).eventId).toBe(h2.id)
  }, 30_000)

  it('ignores a stranger\'s move and a forged event; neither is a move', async () => {
    const stranger = new Walker(generateSecretKey())
    const theirs = stranger.hop(east(home, 50n))
    w.canonical.inject(stranger.spawn)
    w.canonical.inject(theirs)
    // A relay that hands over the stranger's event anyway is ignored too.
    a.follow.ingest(theirs)
    // The operator's pubkey on an event they never signed: the C tag changed after signing.
    const real = operator.hopFrom(operator.head, east(home, 90n))
    const forged = { ...real, tags: real.tags.map((t) => (t[0] === 'C' ? ['C', east(home, 91n).hex] : t)) }
    w.canonical.inject(forged)
    // nostr-tools drops it at the socket already; the watch checks it again for any path that does not.
    a.follow.ingest(forged)
    await until('the forged note', () => a.follow.notes().some((n) => n.text.includes('signature does not verify')))
    await new Promise((r) => setTimeout(r, 300))
    expect(a.follow.unseen()?.eventId).toBe(operator.head.id)
    expect(a.follow.latest()?.coordHex).toBe(east(home, 40n).hex)
  }, 30_000)

  it('nothing waits while the watch reads: orders_waiting and budget answer at once with a read in flight', async () => {
    // The canonical relay turns slow, so the read of the operator's chain takes its whole wait.
    w.canonical.policy.latencyMs = 1200
    const h3 = operator.hop(east(home, 45n))
    w.mine.inject(h3)
    await until('a read in flight', () => a.follow.reading)
    const t0 = performance.now()
    const ow = await a.ordersWaiting()
    const owMs = performance.now() - t0
    const t1 = performance.now()
    a.budgetState()
    const budgetMs = performance.now() - t1
    expect(a.follow.reading).toBe(true)
    expect(owMs).toBeLessThan(500)
    expect(budgetMs).toBeLessThan(50)
    expect(ow.data.orders).toBe(0)
    w.canonical.policy.latencyMs = 0
    await until('the move', () => a.follow.unseen()?.eventId === h3.id)
  }, 30_000)

  it('follow_operator marks the move seen', async () => {
    const r = await a.followOperator()
    expect((r.data.position as { eventId: string }).eventId).toBe(operator.head.id)
    expect((await a.ordersWaiting()).data.operatorMoved).toBeNull()
  }, 30_000)

  it('survives a restart: still on, reads the move made while it was down, and keeps watching', async () => {
    await stop(a)
    const whileDown = operator.hop(east(home, 60n))
    w.canonical.seed(whileDown)
    a = await start(w, dir, op)
    expect(a.follow.on).toBe(true)
    await until('the move made while down', () => a.follow.unseen()?.eventId === whileDown.id)
    const after = operator.hop(east(home, 70n))
    w.canonical.inject(after)
    await until('the move after the restart', () => a.follow.unseen()?.eventId === after.id)
    expect(((await a.ordersWaiting()).data.operatorMoved as { to: string }).to).toBe(east(home, 70n).hex)
  }, 30_000)

  it('a fork of the operator\'s chain is ignored with a note', async () => {
    const before = a.follow.latest()!.eventId
    const left = operator.hopFrom(operator.head, east(home, 80n))
    const right = operator.hopFrom(operator.head, east(home, 81n))
    w.canonical.inject(left)
    w.canonical.inject(right)
    await until('the fork note', () => a.follow.notes().some((n) => n.text.includes('chain is dead')))
    expect(a.follow.latest()!.eventId).toBe(before)
  }, 30_000)

  it('off stops the watch and orders_waiting stops reporting', async () => {
    const r = await a.followOperator({ on: false })
    expect(r.data.on).toBe(false)
    expect(a.follow.on).toBe(false)
    expect((await a.ordersWaiting()).data.operatorMoved).toBeNull()
  }, 30_000)
})

describe('nobody\'s gibson', () => {
  const w = world()
  const opSk = generateSecretKey()
  const op = getPublicKey(opSk)
  const agentSk = generateSecretKey()
  const me = getPublicKey(agentSk)
  const home = placeFromHex(me)
  const operator = new Walker(opSk)
  let a: Agent

  it('refuses a hop onto the operator\'s gibson, names the neighbor, and the neighbor is taken', async () => {
    w.general.seed(finalizeEvent({ kind: 10050, created_at: nowSeconds(), tags: [['relay', INBOX]], content: '' }, opSk) as NostrEvent, finalizeEvent({ kind: 3, created_at: nowSeconds(), tags: [['p', me]], content: '' }, opSk) as NostrEvent)
    a = await start(w, dirWithKey(agentSk), op)
    await a.identity({ name: 'xor' })
    await a.hop({ target: { dx: 5, dy: 0, dz: 0 } })
    const there = east(home, 20n)
    w.canonical.seed(operator.spawn, operator.hop(there))
    await a.followOperator({ on: true })

    const plan = await a.planHop({ target: there.hex })
    const said = plan.data.refused as string
    expect(said).toContain('Your operator stands on')
    expect(said).toContain(east(home, 19n).hex)
    expect(plan.text).toContain('REFUSED')
    const refused = await refusal(a.hop({ target: there.hex }))
    expect(refused).toContain(`Land beside them instead, at ${east(home, 19n).hex}`)
    expect(a.here().hex).toBe(east(home, 5n).hex)

    const r = await a.hop({ target: east(home, 19n).hex })
    expect(r.data.onTarget).toBe(true)
    expect(a.here().hex).toBe(east(home, 19n).hex)
    // Standing beside them already: the follow tool says no move is needed.
    const f = await a.followOperator()
    expect(f.data.besideAlready).toBe(true)
  }, 60_000)

  it('a bot\'s gibson is not protected; a human stranger\'s is', async () => {
    const botSk = generateSecretKey()
    const bot = new Walker(botSk)
    const humanSk = generateSecretKey()
    const human = new Walker(humanSk)
    w.mine.seed(
      finalizeEvent({ kind: 0, created_at: nowSeconds(), tags: [], content: JSON.stringify({ name: 'other-agent', bot: true }) }, botSk) as NostrEvent,
      finalizeEvent({ kind: 0, created_at: nowSeconds(), tags: [], content: JSON.stringify({ name: 'visitor' }) }, humanSk) as NostrEvent,
    )
    const botAt = east(home, 25n)
    const humanAt = east(home, 15n)
    w.canonical.inject(bot.spawn)
    w.canonical.inject(bot.hop(botAt))
    w.canonical.inject(human.spawn)
    w.canonical.inject(human.hop(humanAt))
    await until('presence', () => a.presence.people.has(bot.pubkey) && a.presence.people.has(human.pubkey))

    const toBot = await a.planHop({ target: botAt.hex })
    expect(toBot.data.refused).toBeNull()
    const toHuman = await a.planHop({ target: humanAt.hex })
    expect(toHuman.data.refused).toContain('The human visitor')
    expect(toHuman.data.refused).toContain('one gibson off')
  }, 30_000)

  it('a ride\'s exit at a stop is the reported exception, with the step off named', async () => {
    const stop = a.follow.latest()!.coordHex
    const spy = vi.spyOn(a.transit, 'ride').mockResolvedValue({ text: 'Ride signed.', data: { action: 'hyperjump', where: { hex: stop } } })
    try {
      const r = await a.ride({ to: 900000 })
      expect(r.text).toContain('A ride exits exactly at its stop')
      expect(r.text).toContain('the rule against landing on a person\'s gibson yields here')
      expect(r.text).toContain('Your operator stands on this exact gibson: step one gibson off now')
      const fixed = r.data.fixedPoint as { sharedWith: string[]; stepOff: string }
      expect(fixed.sharedWith).toEqual([op])
      expect(fixed.stepOff).not.toBe(stop)
      expect(placeFromHex(fixed.stepOff).plane).toBe(placeFromHex(stop).plane)
    } finally {
      spy.mockRestore()
    }
  }, 30_000)
})
