// roam.test.ts: the companion behaviors roam and visit (agents plan A4;
// arkinox, 2026-10-11), over the fake relays; no real relay is touched.
//
// Roam: the candidates and the search, alone; then roamDue in
// orders_waiting appearing after the interval (on a test clock) and clearing
// after a step, suggestions within the caps and off a person's gibson, and
// no roam while a ride or a move holds the head. Visit: a note hidden at the
// h12 cube of a person's live head, and at the spawn cube of a pubkey with
// no chain, opened again with the cube's key; and every refusal in plain
// words.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findLcaHeight } from 'cyberspace-core'
import { nip19 } from 'nostr-tools'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Agent, Refusal } from '../src/agent.js'
import { hopTemplate, spawnTemplate } from '../src/chain/builder.js'
import { HIDDEN_KIND, MAX_MESSAGE_LENGTH, unbag } from '../src/hidden/bags.js'
import { bytesToHex, hexToBytes, nowSeconds, signEvent, tagValue, type NostrEvent } from '../src/nostr/event.js'
import { cubeOf, roamCandidates, searchRoam } from '../src/roam.js'
import type { Calibration } from '../src/space/calibration.js'
import { placeFromHex, placeOf, spawnPlace, type Place } from '../src/space/coords.js'
import type { PricedStep } from '../src/space/plan.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork, type FakeRelay } from './fakeRelay.js'
import { fakeHopProof } from './fakeHop.js'

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'
const GENERAL = 'wss://general.example'
const INBOX = 'wss://inbox.example/'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }

function dirWithKey(sk: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-roam-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
  return dir
}

interface World { network: FakeNetwork; canonical: FakeRelay; mine: FakeRelay; general: FakeRelay }

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

interface Extra { capCallSeconds?: number; roamClock?: () => number; roamCandidates?: (from: Place, hop: number) => Iterable<Place> }

async function start(w: World, dir: string, operator: string | undefined, extra: Extra = {}): Promise<Agent> {
  const a = await Agent.start({
    stateDir: dir, relays: [CANONICAL, MINE], operator, capCallSeconds: extra.capCallSeconds ?? 30, capSessionSeconds: 300, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: w.network.WebSocket, calibration: cal, relayMaxWaitMs: 1500, lookupRelays: [GENERAL],
    roamClock: extra.roamClock, roamCandidates: extra.roamCandidates,
  })
  running.push(a)
  return a
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try { await p } catch (err) { if (err instanceof Refusal) return err.message; throw err }
  throw new Error('expected a refusal')
}

/** The operator's DM inbox and their follow of the agent, as the operator channel needs them. */
function operatorFacts(w: World, opSk: Uint8Array, agent: string): void {
  w.general.seed(
    finalizeEvent({ kind: 10050, created_at: nowSeconds(), tags: [['relay', INBOX]], content: '' }, opSk) as NostrEvent,
    finalizeEvent({ kind: 3, created_at: nowSeconds(), tags: [['p', agent]], content: '' }, opSk) as NostrEvent,
  )
}

/** A chain signed by a test key: a spawn and hops, as any client would publish them. */
function chainTo(sk: Uint8Array, to: Place): { spawn: NostrEvent; head: NostrEvent } {
  const pubkey = getPublicKey(sk)
  const at = nowSeconds() - 600
  const spawn = signEvent(spawnTemplate(pubkey, at), sk)
  const head = signEvent(hopTemplate({ createdAt: at + 1, genesisId: spawn.id, previousId: spawn.id, prevCoordHex: spawn.tags.find((t) => t[0] === 'C')![1], to: to.position, plane: to.plane, ...fakeHopProof() }), sk)
  return { spawn, head }
}

const east = (p: Place, dx: bigint): Place => placeOf({ x: p.position.x + dx, y: p.position.y, z: p.position.z }, p.plane)

/** The message in the agent's newest bag at the h12 cube around `at`, opened with that cube's key. */
async function noteAt(a: Agent, relay: FakeRelay, at: Place): Promise<string[]> {
  const key = a.keys.keyAt(at.position, 12, 'scan')
  const bags = relay.all().filter((e) => e.kind === HIDDEN_KIND && e.pubkey === a.pubkey && tagValue(e, 'd') === key.lookupId)
  expect(bags.length).toBeGreaterThan(0)
  const items = await unbag(bags[0], hexToBytes(key.keyHex), undefined, { at: { x: BigInt(key.base.x), y: BigInt(key.base.y), z: BigInt(key.base.z) }, plane: at.plane }, 12)
  return items.map((h) => h.text ?? '')
}

describe('roam candidates and the search', () => {
  const from = placeFromHex(getPublicKey(generateSecretKey()))

  it('offers places one walk away in the same plane, leaving the h12 cube first', () => {
    const got = [...roamCandidates(from, 18)]
    expect(got.length).toBeGreaterThan(20)
    for (const p of got) {
      expect(p.plane).toBe(from.plane)
      expect(p.hex).not.toBe(from.hex)
    }
    // The first heights tried are h13 to the ceiling, so the first candidates leave the h12 cube.
    for (const p of got.slice(0, 6)) {
      const lca = Math.max(findLcaHeight(from.position.x, p.position.x), findLcaHeight(from.position.y, p.position.y), findLcaHeight(from.position.z, p.position.z))
      expect(lca).toBeGreaterThanOrEqual(13)
    }
  })

  it('passes over a person\'s gibson, a step over the caps and a visited cube, and takes the first fresh one', () => {
    const person = east(from, 1n << 14n)
    const tooFar = east(from, 1n << 18n)
    const visited = east(from, (1n << 13n) + 5n)
    const fresh = east(from, (1n << 15n) + 9n)
    const price = (target: Place): PricedStep => ({ kind: 'hop', from, to: target, heights: { x: 0, y: 0, z: 0 }, maxHeight: 0, terrainK: 0, seconds: target.hex === tooFar.hex ? 99 : 1, work: 0, feasible: true, aboveSidestepCap: false })
    const found = searchRoam({
      candidates: [person, tooFar, visited, fresh],
      price,
      refusal: (step) => (step && step.seconds > 10 ? 'This would take about 99.0 s on this machine, above the 10 s cap for one call.' : null),
      blocked: (p) => p.hex === person.hex,
      visited: new Set([cubeOf(visited)]),
    })
    expect(found.pick?.target.hex).toBe(fresh.hex)
    expect(found.pick?.fresh).toBe(true)
    expect(found.skipped).toEqual({ people: 1, notOneHop: 0, refused: 1, visited: 1 })
    // With nothing fresh, a visited cube is the fallback.
    const fallback = searchRoam({ candidates: [person, visited], price, refusal: () => null, blocked: (p) => p.hex === person.hex, visited: new Set([cubeOf(visited)]) })
    expect(fallback.pick?.target.hex).toBe(visited.hex)
    expect(fallback.pick?.fresh).toBe(false)
  })
})

describe('roam', () => {
  const w = world()
  const opSk = generateSecretKey()
  const op = getPublicKey(opSk)
  const agentSk = generateSecretKey()
  const me = getPublicKey(agentSk)
  const home = placeFromHex(me)
  const dir = dirWithKey(agentSk)
  let clock = nowSeconds()
  let a: Agent

  it('roamDue appears once the interval has passed and clears after a step', async () => {
    operatorFacts(w, opSk, me)
    a = await start(w, dir, op, { roamClock: () => clock })
    await a.identity({ name: 'xor' })
    await a.hop({ target: { dx: 5, dy: 0, dz: 0 } })
    expect((await a.ordersWaiting()).data.roamDue).toBe(false)

    const on = await a.roam({ on: true })
    expect(on.data.on).toBe(true)
    expect(on.data.everyMinutes).toBe(30)
    expect((await a.ordersWaiting()).data.roamDue).toBe(false)
    clock += 29 * 60
    expect((await a.ordersWaiting()).data.roamDue).toBe(false)
    clock += 61
    const due = await a.ordersWaiting()
    expect(due.data.roamDue).toBe(true)
    expect(due.text).toContain('A roam step is due')

    const step = await a.roam()
    const s = step.data.suggestion as { hex: string; plane: number }
    expect(s.plane).toBe(home.plane)
    expect(step.text).toContain('hop with target')
    // The suggestion is one hop that lands on it, within the per-call cap.
    const plan = step.data.plan as { kind: string; landsOnTarget: boolean; expectedSeconds: number }
    expect(plan.kind).toBe('hop')
    expect(plan.landsOnTarget).toBe(true)
    expect(plan.expectedSeconds).toBeLessThanOrEqual(30)
    expect(a.here().hex).toBe(east(home, 5n).hex)
    expect((await a.ordersWaiting()).data.roamDue).toBe(false)
    // The interval runs from the step.
    clock += 30 * 60
    expect((await a.ordersWaiting()).data.roamDue).toBe(true)
  }, 30_000)

  it('the interval is the operator\'s to set within bounds, and is kept across a restart', async () => {
    expect(await refusal(a.roam({ every_minutes: 2 }))).toContain('every_minutes must be from 5 to 1440')
    await a.roam({ every_minutes: 10 })
    await a.stop()
    running.splice(running.indexOf(a), 1)
    a = await start(w, dir, op, { roamClock: () => clock })
    expect(a.roaming.on).toBe(true)
    expect(a.roaming.everyMinutes).toBe(10)
  }, 30_000)

  it('no roam while a ride holds the head, nor while a move is in flight; roamDue stays quiet meanwhile', async () => {
    clock += 60 * 60
    expect((await a.ordersWaiting()).data.roamDue).toBe(true)
    const spy = vi.spyOn(a.transit, 'rideState').mockReturnValue({ state: 'computing', to: 900000, done: 3, total: 10, attempts: 0, attemptsExpected: 0, etaSeconds: 50, reason: null })
    try {
      expect(await refusal(a.roam())).toContain('Your ride to block 900000 is computing')
      expect((await a.ordersWaiting()).data.roamDue).toBe(false)
    } finally {
      spy.mockRestore()
    }
    const release = a.keeper.reserve()
    try {
      expect(await refusal(a.roam())).toContain('Your head is reserved by a move in flight')
      expect((await a.ordersWaiting()).data.roamDue).toBe(false)
    } finally {
      release()
    }
    // Neither refusal counted as a step.
    expect((await a.ordersWaiting()).data.roamDue).toBe(true)
  }, 30_000)

  it('never suggests a person\'s gibson: the operator\'s is passed over', async () => {
    // Both inside the agent's own aligned 256-gibson cube, so the hop to
    // either crosses a wall of h8 at most. They used to sit 2^14 east of a
    // random home, where the carry could reach a wall above the hop ceiling
    // and roam (rightly) skipped the candidate as not one hop away
    // (flaky under load, 2026-10-14).
    const here = a.here()
    const cube = here.position.x - (here.position.x % 256n)
    const offset = here.position.x % 256n
    const at = (dx: bigint): Place => placeOf({ ...here.position, x: cube + ((offset + dx) % 256n) }, here.plane)
    const there = at(64n)
    const { spawn, head } = chainTo(opSk, there)
    w.canonical.seed(spawn, head)
    await a.followOperator({ on: true })
    expect(a.follow.latest()?.coordHex).toBe(there.hex)
    const beside = at(71n)
    await a.stop()
    running.splice(running.indexOf(a), 1)
    a = await start(w, dir, op, { roamClock: () => clock, roamCandidates: () => [there, beside] })
    await a.follow.resolveNow()
    const step = await a.roam()
    expect((step.data.suggestion as { hex: string }).hex).toBe(beside.hex)
    expect((step.data.skipped as { people: number }).people).toBe(1)
  }, 30_000)
})

describe('roam within the caps', () => {
  it('every suggestion fits a small per-call cap, and when nothing fits it says so and rests', async () => {
    const w = world()
    const sk = generateSecretKey()
    let clock = nowSeconds()
    const a = await start(w, dirWithKey(sk), undefined, { capCallSeconds: 2, roamClock: () => clock })
    await a.identity({ name: 'xor' })
    await a.hop({ target: { dx: 3, dy: 0, dz: 0 } })
    await a.roam({ on: true, every_minutes: 5 })
    const seen = new Set<string>()
    for (let i = 0; i < 6; i++) {
      const step = await a.roam()
      const plan = step.data.plan as { kind: string; expectedSeconds: number; landsOnTarget: boolean }
      expect(plan.kind).toBe('hop')
      expect(plan.landsOnTarget).toBe(true)
      expect(plan.expectedSeconds).toBeLessThanOrEqual(2)
      seen.add(cubeOf(placeFromHex((step.data.suggestion as { hex: string }).hex)))
    }
    // Fresh cubes are preferred: six steps, six different cubes.
    expect(seen.size).toBe(6)

    // Nothing fits a cap this small: refused in plain words, and the clock restarts so the waker rests.
    await a.stop()
    running.splice(running.indexOf(a), 1)
    const tight = await start(w, dirWithKey(sk), undefined, { capCallSeconds: 0.000001, roamClock: () => clock })
    // The same key in a fresh state directory: the chain is read from the relays.
    await tight.roam({ on: true, every_minutes: 5 })
    clock += 6 * 60
    expect(tight.roaming.due()).toBe(true)
    const said = await refusal(tight.roam())
    expect(said).toContain('No roam step fits right now')
    expect(said).toContain('above the 0.000001 s cap')
    expect(tight.roaming.due()).toBe(false)
  }, 60_000)
})

describe('visit', () => {
  const w = world()
  const opSk = generateSecretKey()
  const op = getPublicKey(opSk)
  const agentSk = generateSecretKey()
  const me = getPublicKey(agentSk)
  let a: Agent

  it('refuses a stranger before the agent\'s profile is published, in plain words', async () => {
    operatorFacts(w, opSk, me)
    a = await start(w, dirWithKey(agentSk), op)
    const stranger = getPublicKey(generateSecretKey())
    const said = await refusal(a.visit({ pubkey: stranger, note: 'hello' }))
    expect(said).toContain('no relay has accepted your profile yet')
    expect(said).toContain('Call identity first')
  }, 30_000)

  it('hides the note at the h12 cube of a person\'s live head, without moving', async () => {
    await a.identity({ name: 'xor' })
    await a.hop({ target: { dx: 2, dy: 0, dz: 0 } })
    const here = a.here().hex
    const sk = generateSecretKey()
    const pk = getPublicKey(sk)
    const there = east(placeFromHex(pk), 1n << 20n)
    const { spawn, head } = chainTo(sk, there)
    w.canonical.seed(spawn, head)
    const r = await a.visit({ pubkey: nip19.npubEncode(pk), note: 'I passed by. XOR' })
    expect(r.data.atSpawn).toBe(false)
    expect((r.data.at as { hex: string }).hex).toBe(there.hex)
    expect((r.data.head as { eventId: string }).eventId).toBe(head.id)
    const base = (r.data.cube as { height: number; base: { x: string } })
    expect(base.height).toBe(12)
    expect(base.base.x).toBe(((there.position.x >> 12n) << 12n).toString())
    expect(r.text).toContain('How they find it')
    expect(await noteAt(a, w.canonical, there)).toContain('I passed by. XOR')
    expect(a.here().hex).toBe(here)
  }, 30_000)

  it('hides the note at the spawn cube of a pubkey with no chain', async () => {
    const pk = getPublicKey(generateSecretKey())
    const r = await a.visit({ pubkey: pk, note: 'Welcome, whenever you arrive.' })
    expect(r.data.atSpawn).toBe(true)
    expect(r.data.chainStatus).toBe('none')
    expect((r.data.at as { hex: string }).hex).toBe(spawnPlace(pk).hex)
    expect(r.text).toContain('no chain yet')
    expect(await noteAt(a, w.canonical, spawnPlace(pk))).toContain('Welcome, whenever you arrive.')
  }, 30_000)

  it('leaves a note for the operator, and says how to tell them', async () => {
    const r = await a.visit({ pubkey: op, note: 'Something for you here.' })
    expect((r.data.for as { operator: boolean }).operator).toBe(true)
    expect(r.text).toContain('message_operator')
    expect(await noteAt(a, w.canonical, spawnPlace(op))).toContain('Something for you here.')
  }, 30_000)

  it('refuses an empty note, a note over the limit, a bad pubkey and its own, in plain words', async () => {
    const pk = getPublicKey(generateSecretKey())
    expect(await refusal(a.visit({ pubkey: pk, note: '   ' }))).toBe('The note is empty: write what you want them to find.')
    expect(await refusal(a.visit({ pubkey: pk, note: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }))).toContain(`at most ${MAX_MESSAGE_LENGTH}`)
    expect(await refusal(a.visit({ pubkey: 'arkinox', note: 'hi' }))).toContain('pubkey must be an npub')
    expect(await refusal(a.visit({ pubkey: me, note: 'hi' }))).toContain('That is your own pubkey')
  }, 30_000)
})
