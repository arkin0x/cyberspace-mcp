// hosaka.test.ts: a ride bought from HOSAKA with no wallet connected, end to
// end over the fake relays and a fake HOSAKA (test/fakeHosaka.ts), never the
// real one. The operator reads the invoice from a strict DM inbox relay and
// pays it from elsewhere; the server follows the job in the background with
// no ride call, checks the proof at Level 1 there, and reports through
// ride_status and orders_waiting as it does for a local background ride
// (arkinox, 2026-10-11). Ported from PR #11, where the agent polled.
//
// What would fail silently without these tests: an invoice bought for an
// operator who cannot be told about it; a submit asked again after a lost
// answer making a second job and a second invoice; a restart that forgets
// the job, or forgets to reserve the head it is bound to, letting a hop
// waste a paid proof; an expired invoice left as the one the operator is
// told to pay; a proof from HOSAKA signed without being checked; HOSAKA's
// compute charged to the agent's own caps; a waker never told the proof is
// ready.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Agent, Refusal } from '../src/agent.js'
import { buildChain, chainStatus, parseAction } from '../src/chain/events.js'
import { parseArgs, settingsFrom } from '../src/config.js'
import { HOSAKA_DEFAULT_URL, rideIdempotencyKey } from '../src/hosaka.js'
import type { Line } from '../src/hyperspace/line.js'
import { nowSeconds, tagValue, type NostrEvent } from '../src/nostr/event.js'
import { FakeHosaka, RIDE_MSATS } from './fakeHosaka.js'
import { FakeNetwork } from './fakeRelay.js'
import { MANIFEST_URL, RIDE_LENGTH, cal, cheapKey, dirWithKey, dmsTo, fakeFetch, probeLine, served, settle, until } from './hosakaWorld.js'

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'
const GENERAL = 'wss://general.example'
const INBOX = 'wss://inbox.example/'
const HOSAKA = 'https://hosaka.test'

const network = new FakeNetwork()
const canonical = network.add(CANONICAL, { refuse: (ev) => (ev.kind === 1059 ? 'blocked: kind 1059 is not accepted here' : null) })
network.add(MINE)
const general = network.add(GENERAL, { requireAuth: false })
const inbox = network.add(INBOX, { challengeOnReq: true, protectWraps: true, requireAuthToPublish: true })
let line: Line
const hosaka = new FakeHosaka(() => line)

const running: Agent[] = []
afterAll(async () => { for (const a of running) await a.stop() })

/** A session cap far below the local quote of any ride here: only a HOSAKA ride can be signed in this session. */
const SESSION_CAP = 0.05

async function startAgent(stateDir: string, operator: string): Promise<Agent> {
  const agent = await Agent.start({
    stateDir, relays: [CANONICAL, MINE], operator, capCallSeconds: 30, capSessionSeconds: SESSION_CAP, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1500, lookupRelays: [GENERAL],
    manifestUrl: MANIFEST_URL, lineFetch: fakeFetch(served), rideThreads: 0, hosakaUrl: HOSAKA, hosakaFetch: hosaka.fetch, hosakaPollMs: 20,
  })
  running.push(agent)
  return agent
}

async function stopAgent(a: Agent): Promise<void> {
  await a.stop()
  running.splice(running.indexOf(a), 1)
}

/**
 * Forget what setup work (a hop, a station sync) spent. The budget is spent
 * in real wall time, which grows with machine load: under a parallel suite a
 * hop and a sync alone overshot SESSION_CAP, so boarding (which costs
 * nothing) was refused and every later test in the file failed with it. The
 * cap is here to keep rides off the local prover, not to price the setup.
 */
function setupSpendForgotten(a: Agent): void {
  a.budget.spentSeconds = 0
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try { await p } catch (err) { if (err instanceof Refusal) return err.message; throw err }
  throw new Error('expected a refusal')
}

/** The HOSAKA ride's own state, from ride_status (in memory). */
function hosakaState(a: Agent): string | null {
  const ride = a.rideStatus().data.ride as { state?: string } | undefined
  return ride?.state ?? null
}

const hyperjumps = (): NostrEvent[] => canonical.all().filter((e) => e.kind === 3333 && tagValue(e, 'A') === 'hyperjump')

describe('a ride bought from HOSAKA, paid by the operator, followed in the background', () => {
  let sk: Uint8Array
  let S: number
  let dir: string
  let a: Agent
  const opSk = generateSecretKey()
  const op = getPublicKey(opSk)
  const dms = (): string[] => dmsTo(inbox, opSk)

  beforeAll(async () => {
    line = await probeLine()
    ;({ sk, S } = cheapKey(line))
  }, 60_000)

  it('the HOSAKA URL is a flag and a config.json key, and defaults to the production API', () => {
    expect(settingsFrom(parseArgs(['--state', '/x']), {}).hosakaUrl).toBe(HOSAKA_DEFAULT_URL)
    expect(settingsFrom(parseArgs(['--state', '/x']), { hosakaUrl: 'http://127.0.0.1:8765/' }).hosakaUrl).toBe('http://127.0.0.1:8765')
    expect(settingsFrom(parseArgs(['--state', '/x', '--hosaka-url', 'https://h.example']), { hosakaUrl: 'http://127.0.0.1:8765' }).hosakaUrl).toBe('https://h.example')
    expect(() => parseArgs(['--hosaka-url', 'ftp://h.example'])).toThrow(/http\(s\) URL/)
  })

  it('boards; a ride too long for the caps is refused locally, and refused from HOSAKA while the operator has no DM inbox, before anything is submitted', async () => {
    dir = dirWithKey(sk)
    a = await startAgent(dir, op)
    await a.identity({ name: 'courier' })
    await a.hop({ target: { dx: 5, dy: 0, dz: 0 } })
    await a.station({ sync: true, budget_seconds: 30 })
    setupSpendForgotten(a)
    await a.board()
    expect(await refusal(a.ride({ to: S + RIDE_LENGTH }))).toMatch(/session has .* left[\s\S]*prover: "hosaka"/)
    const words = await refusal(a.ride({ to: S + RIDE_LENGTH, prover: 'hosaka' }))
    expect(words).toMatch(/no DM inbox/)
    expect(words).toMatch(/nothing was submitted to HOSAKA and no invoice exists/)
    expect(hosaka.requests).toEqual([])
    expect(a.transit.riding).toBe(false)
  })

  it('refuses a HOSAKA that does not sell rides, or does not honor idempotency keys, without submitting or reserving the head', async () => {
    general.seed(finalizeEvent({ kind: 10050, created_at: nowSeconds(), tags: [['relay', INBOX]], content: '' }, opSk) as NostrEvent)
    general.seed(finalizeEvent({ kind: 3, created_at: nowSeconds(), tags: [['p', getPublicKey(sk)]], content: '' }, opSk) as NostrEvent)
    hosaka.sellsRides = false
    expect(await refusal(a.ride({ to: S + RIDE_LENGTH, prover: 'hosaka' }))).toMatch(/does not sell rides/)
    hosaka.sellsRides = true
    hosaka.honorsKeys = false
    expect(await refusal(a.ride({ to: S + RIDE_LENGTH, prover: 'hosaka' }))).toMatch(/does not say it honors idempotency keys/)
    hosaka.honorsKeys = true
    expect(hosaka.submits()).toBe(0)
    expect(a.transit.riding).toBe(false)
    expect(dms()).toEqual([])
  })

  it('a forged proof from HOSAKA fails Level 1 in the background and is never signed; the waker hears failed; cancel lets it go', async () => {
    const to = S + 2
    const r = await a.ride({ to, prover: 'hosaka' })
    expect((r.data.ride as { state: string }).state).toBe('awaiting_payment')
    expect(r.text).toMatch(/does not pay this invoice itself \(no wallet is connected/)
    // The invoice goes to the operator by the background, with no ride call.
    await until(() => dms().length === 1, 'the invoice DM')
    expect((await a.ordersWaiting()).data.ride).toMatchObject({ state: 'awaiting_payment', to, prover: 'hosaka' })
    const job = [...hosaka.jobs.values()].at(-1)!
    hosaka.pay(job.deposit!)
    await until(() => hosakaState(a) === 'computing', 'computing')
    hosaka.complete(job.id, true)
    await until(() => hosakaState(a) === 'failed', 'the forged proof refused')
    expect(a.transit.rideState()).toMatchObject({ state: 'failed', prover: 'hosaka', reason: expect.stringMatching(/failed Level 1 self-verification/) })
    const before = hyperjumps().length
    const words = await refusal(a.ride({ to }))
    expect(words).toMatch(/failed Level 1 self-verification/)
    expect(words).toMatch(/never signed/)
    expect(hyperjumps().length).toBe(before)
    const c = await a.ride({ to, cancel: true })
    expect(c.text).toMatch(/was paid for and its proof refused/)
    expect(a.transit.riding).toBe(false)
  })

  it('a lost submit answer is asked again in the background with the same key; a restart reserves the head again; one invoice reaches the operator', async () => {
    const to = S + RIDE_LENGTH
    const jobsBefore = hosaka.jobs.size
    const dmsBefore = dms().length
    hosaka.loseNextSubmitAnswer = true
    const r = await a.ride({ to, prover: 'hosaka' })
    expect((r.data.ride as { state: string }).state).toBe('submitting')
    expect(r.text).toMatch(/answer to the submit was lost/)
    const saved = JSON.parse(readFileSync(join(dir, 'hosaka-ride.json'), 'utf8')) as { key: string }
    expect(saved.key).toBe(rideIdempotencyKey(a.keeper.head()!.id, S, to))
    await until(() => hosakaState(a) === 'awaiting_payment' && dms().length === dmsBefore + 1, 'the same job, and its invoice to the operator')
    expect(hosaka.jobs.size).toBe(jobsBefore + 1)

    // A restart in the middle: the record and the reservation come back before any tool runs.
    await stopAgent(a)
    a = await startAgent(dir, op)
    await expect(a.hop({ target: { dx: 1, dy: 0, dz: 0 } })).rejects.toThrow(/already in flight/)
    expect(await refusal(a.ride({ to: to - 1 }))).toMatch(/HOSAKA ride to block/)
    await settle()
    const s = a.rideStatus()
    const ride = s.data.ride as { state: string; invoice: { bolt11: string }; invoiceSentToOperator: boolean }
    expect(ride.state).toBe('awaiting_payment')
    expect(ride.invoiceSentToOperator).toBe(true)
    expect(hosaka.jobs.size).toBe(jobsBefore + 1)
    expect(dms().length).toBe(dmsBefore + 1)
    const dm = dms().at(-1)!
    expect(dm).toContain(`${RIDE_MSATS / 1000} sats`)
    expect(dm).toContain(`from block ${S} to block ${to}`)
    expect(dm).toContain(ride.invoice.bolt11)
    expect(dm).toMatch(/I did not pay it myself: no wallet is connected/)
    expect(dm).not.toMatch(/\u2014/)
  })

  it('an expired invoice releases the head; ride asks for a fresh one, which alone is sent; payment starts the job once', async () => {
    const to = S + RIDE_LENGTH
    const job = [...hosaka.jobs.values()].at(-1)!
    const first = job.deposit!
    hosaka.expire(first)
    await until(() => hosakaState(a) === 'expired', 'expired')
    expect((a.rideStatus().data.ride as { headReserved: boolean }).headReserved).toBe(false)
    expect(a.transit.rideState()).toMatchObject({ state: 'failed', reason: expect.stringMatching(/expired/) })
    const dmsBefore = dms().length

    const r = await a.ride({ to })
    expect((r.data.ride as { state: string }).state).toBe('awaiting_payment')
    expect(r.text).toMatch(/fresh invoice/)
    expect(job.deposit).not.toBe(first)
    await until(() => dms().length === dmsBefore + 1, 'the fresh invoice DM')
    expect(dms().at(-1)).toContain(hosaka.deposits.get(job.deposit!)!.bolt11)
    await expect(a.hop({ target: { dx: 1, dy: 0, dz: 0 } })).rejects.toThrow(/already in flight/)

    const debitsBefore = hosaka.debits
    hosaka.pay(job.deposit!)
    await until(() => (a.rideStatus().data.ride as { progressPercent: number | null }).progressPercent === 42, 'computing with progress')
    expect(hosaka.debits).toBe(debitsBefore + 1)
    // A ride call while computing only reports: no second submit, no second charge.
    const submits = hosaka.submits()
    expect((await a.ride({ to })).text).toMatch(/HOSAKA is computing/)
    await settle()
    expect(hosaka.submits()).toBe(submits)
    expect(hosaka.debits).toBe(debitsBefore + 1)
  })

  it('done: checked here at Level 1, ready for the waker, then signed exactly as a local ride, with HOSAKA\'s compute not on the caps', async () => {
    const to = S + RIDE_LENGTH
    const job = [...hosaka.jobs.values()].at(-1)!
    hosaka.complete(job.id)
    // This process restarted since the ride was bought and has not verified the line again: the proof is in, unchecked, and the waker is woken.
    await until(() => hosakaState(a) === 'done', 'the proof in hand')
    expect((await a.ordersWaiting()).data.ride).toMatchObject({ state: 'ready', prover: 'hosaka' })
    expect(await refusal(a.ride({ to }))).toMatch(/cannot be checked[\s\S]*station with sync: true[\s\S]*proof is kept/)
    await a.station({ sync: true, budget_seconds: 30 })
    setupSpendForgotten(a)
    await until(() => hosakaState(a) === 'ready', 'checked in the background once the line holds the blocks')
    expect((a.rideStatus().data.ride as { verification: { ok: boolean } }).verification.ok).toBe(true)
    const r = await a.ride({ to })
    expect(r.data.action).toBe('hyperjump')
    expect(r.data.prover).toBe('hosaka')
    expect((r.data.verification as { ok: boolean; checked: number }).ok).toBe(true)
    const ev = canonical.all().find((e) => e.id === r.data.eventId)!
    expect(tagValue(ev, 'proof')).toBe((job.result as { root: string }).root)
    expect(tagValue(ev, 'B')).toBe(String(to))
    expect(tagValue(ev, 'from_height')).toBe(String(S))
    const chain = buildChain(canonical.all().filter((e) => e.pubkey === getPublicKey(sk) && e.kind === 3333), getPublicKey(sk))
    expect(chainStatus(chain)).toBe('valid')
    expect(chain.at(-1)!.id).toBe(ev.id)
    expect(parseAction(ev)?.type).toBe('hyperjump')
    expect(JSON.parse(readFileSync(join(dir, 'hosaka-ride.json'), 'utf8'))).toBeNull()
    expect(a.transit.riding).toBe(false)
    expect(a.rideStatus().data.inFlight).toBe(false)
    expect((r.data.budget as { spentSeconds: number }).spentSeconds).toBeLessThan(5)
  })

  it('a job that fails at HOSAKA is refunded to the balance; starting it again with the same key is paid from that refund, with no new invoice', async () => {
    // From the stop at S + 3 back to S + 1: the same cheap stretch of the line, ridden the other way.
    const to = S + 1
    const r = await a.ride({ to, prover: 'hosaka' })
    expect((r.data.ride as { state: string }).state).toBe('awaiting_payment')
    const job = [...hosaka.jobs.values()].at(-1)!
    hosaka.pay(job.deposit!)
    await until(() => hosakaState(a) === 'computing', 'computing')
    hosaka.fail(job.id, 'worker lost')
    await until(() => hosakaState(a) === 'failed', 'failed')
    const s = a.rideStatus()
    expect((s.data.ride as { headReserved: boolean }).headReserved).toBe(false)
    expect(s.text).toMatch(/worker lost/)

    const dmCount = dms().length
    const deposits = hosaka.deposits.size
    const again = await a.ride({ to })
    const ride = again.data.ride as { state: string; paidFromBalance: boolean; job: string }
    expect(ride.state).toBe('computing')
    expect(ride.paidFromBalance).toBe(true)
    expect(ride.job).not.toBe(job.id)
    expect(again.text).toMatch(/paid from that refund/)
    expect(hosaka.deposits.size).toBe(deposits)
    expect(dms().length).toBe(dmCount)

    hosaka.complete(ride.job)
    await until(() => hosakaState(a) === 'ready', 'ready')
    const signed = await a.ride({ to })
    expect(signed.data.action).toBe('hyperjump')
    expect(tagValue(canonical.all().find((e) => e.id === signed.data.eventId)!, 'from_height')).toBe(String(S + RIDE_LENGTH))
  })
})
