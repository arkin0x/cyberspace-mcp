// hosaka.test.ts: a ride bought from HOSAKA, end to end over the fake relays
// and a fake HOSAKA, never the real one. The fake speaks the job API the way
// hosaka-api does for a sidestep (submit, invoice, claim, /start, poll token),
// plus the proposed ride job (hosaka.ts header): it checks every NIP-98
// signature and refuses a reused one, keeps idempotency keys per pubkey,
// charges a job once, refunds a failed one to the balance, and computes a
// real proof over the fixture line, so the agent's Level 1 check is the real
// check. The operator reads the invoice from a strict DM inbox relay.
//
// What would fail silently without these tests: an invoice bought for an
// operator who cannot be told about it; a submit asked again after a lost
// answer making a second job and a second invoice; a restart that forgets
// the job, or forgets to reserve the head it is bound to, letting a hop
// waste a paid proof; an expired invoice left as the one the operator is
// told to pay; a proof from HOSAKA signed without being checked; HOSAKA's
// compute charged to the agent's own caps.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as nip17 from 'nostr-tools/nip17'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { Agent, Refusal } from '../src/agent.js'
import { buildChain, chainStatus, parseAction } from '../src/chain/events.js'
import { parseArgs, settingsFrom } from '../src/config.js'
import { HOSAKA_DEFAULT_URL, rideIdempotencyKey } from '../src/hosaka.js'
import { LineStore, type Line } from '../src/hyperspace/line.js'
import { buildRideProof, computeRideLeaf, lineTerrainK, rideBlocks } from '../src/hyperspace/ride.js'
import { bytesToHex, nowSeconds, tagValue, type NostrEvent } from '../src/nostr/event.js'
import type { Calibration } from '../src/space/calibration.js'
import { placeOf, spawnPlace } from '../src/space/coords.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork } from './fakeRelay.js'
import { MANIFEST_URL, fakeFetch, servedFor } from './hyperspace/lineFixture.js'

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'
const GENERAL = 'wss://general.example'
const INBOX = 'wss://inbox.example/'
const HOSAKA = 'https://hosaka.test'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }
const TIP = 6143
const RIDE_LENGTH = 3
const CHEAP_K = 6
/** What the fake charges for any ride, in millisats. */
const RIDE_MSATS = 21_000

// ---------------------------------------------------------------------------
// The fake HOSAKA
// ---------------------------------------------------------------------------

interface FakeDeposit { deposit_id: string; status: 'pending' | 'settled' | 'expired'; amount_msats: number; bolt11: string; expires_at: number; paid: boolean; credited: boolean }
interface FakeJob {
  id: string; pubkey: string; status: 'pending' | 'computing' | 'completed' | 'failed'; cost_msats: number; poll_token: string; result: unknown; error: string | null
  params: { previous_event_id: string; from_height: number; to_height: number }; deposit: string | null; key: string
}

class FakeHosaka {
  sellsRides = true
  honorsKeys = true
  /** The next submit makes its job, then its answer is lost (a 502). */
  loseNextSubmitAnswer = false
  jobs = new Map<string, FakeJob>()
  deposits = new Map<string, FakeDeposit>()
  keys = new Map<string, string>()
  balance = new Map<string, number>()
  requests: Array<{ method: string; path: string }> = []
  debits = 0
  private seenAuth = new Set<string>()
  private n = 0

  constructor(private readonly line: () => Line) {}

  private id(prefix: string): string {
    return `${prefix}${(++this.n).toString().padStart(4, '0')}${bytesToHex(crypto.getRandomValues(new Uint8Array(4)))}`
  }

  private newDeposit(msats: number): FakeDeposit {
    const d: FakeDeposit = { deposit_id: this.id('dep'), status: 'pending', amount_msats: Math.ceil(msats / 1000) * 1000, bolt11: `lnbc${Math.ceil(msats / 1000)}n1${this.id('p')}`, expires_at: nowSeconds() + 600, paid: false, credited: false }
    this.deposits.set(d.deposit_id, d)
    return d
  }

  private view(job: FakeJob, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: job.id, status: job.status, job_type: 'ride', cost_msats: job.cost_msats, result: job.result, error: job.error, ...extra }
  }

  private credit(dep: FakeDeposit, pubkey: string): void {
    if (dep.paid && !dep.credited) {
      dep.credited = true
      dep.status = 'settled'
      this.balance.set(pubkey, (this.balance.get(pubkey) ?? 0) + dep.amount_msats)
    }
  }

  /** Charge and start once the balance covers it; else the job's invoice, or a fresh one when it cannot be paid. */
  private fund(job: FakeJob): Record<string, unknown> {
    const dep = job.deposit ? this.deposits.get(job.deposit)! : null
    if (dep) this.credit(dep, job.pubkey)
    const bal = this.balance.get(job.pubkey) ?? 0
    if (bal >= job.cost_msats) {
      this.balance.set(job.pubkey, bal - job.cost_msats)
      this.debits++
      job.status = 'computing'
      return this.view(job, { payment_required: false, balance_debited: true })
    }
    let d = dep
    if (!d || d.status !== 'pending' || d.expires_at < nowSeconds()) {
      if (d && d.status === 'pending') d.status = 'expired'
      d = this.newDeposit(job.cost_msats - bal)
      job.deposit = d.deposit_id
    }
    return this.view(job, { payment_required: true, deposit: this.depositView(d) })
  }

  private depositView(d: FakeDeposit): Record<string, unknown> {
    return { deposit_id: d.deposit_id, status: d.status, amount_msats: d.amount_msats, bolt11: d.bolt11, expires_at: d.expires_at }
  }

  private auth(req: Request, url: string): string | null {
    const header = req.headers.get('authorization') ?? ''
    if (!header.startsWith('Nostr ')) return null
    const ev = JSON.parse(Buffer.from(header.slice(6), 'base64').toString('utf8')) as NostrEvent
    if (!verifyEvent(ev as Parameters<typeof verifyEvent>[0]) || ev.kind !== 27235) return null
    if (tagValue(ev, 'u') !== url || tagValue(ev, 'method')?.toUpperCase() !== req.method) return null
    if (Math.abs(ev.created_at - nowSeconds()) > 60 || this.seenAuth.has(ev.id)) return null
    this.seenAuth.add(ev.id)
    return ev.pubkey
  }

  // Controls the test turns.
  pay(depositId: string): void { this.deposits.get(depositId)!.paid = true }
  expire(depositId: string): void { const d = this.deposits.get(depositId)!; d.status = 'expired'; d.expires_at = nowSeconds() - 120 }
  complete(jobId: string, forge = false): void {
    const job = this.jobs.get(jobId)!
    const { previous_event_id: prev, from_height: from, to_height: to } = job.params
    const leaves = rideBlocks(from, to).map((h) => computeRideLeaf(prev, h, this.line().blockHash(h)!))
    const proof = buildRideProof(prev, leaves)
    // A forged proof: the root and the nonce are real, one opening's first byte is not.
    const mp = forge ? `${proof.mp.slice(0, 0)}${proof.mp[0] === '0' ? '1' : '0'}${proof.mp.slice(1)}` : proof.mp
    job.status = 'completed'
    job.result = { root: proof.rootHex, mp, mn: proof.mnHex, previous_event_id: prev, from_height: from, to_height: to }
  }
  fail(jobId: string, why: string): void {
    const job = this.jobs.get(jobId)!
    job.status = 'failed'
    job.error = why
    this.balance.set(job.pubkey, (this.balance.get(job.pubkey) ?? 0) + job.cost_msats)
  }
  submits(): number { return this.requests.filter((r) => r.path === '/api/v1/ride').length }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input as string, init)
    const url = req.url
    const path = new URL(url).pathname
    this.requests.push({ method: req.method, path })
    const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (req.method === 'GET' && path === '/api/v1/provider') {
      return json(200, {
        version: 1, name: 'FAKE HOSAKA',
        services: [{ type: 'hop', max_height: 27 }, ...(this.sellsRides ? [{ type: 'ride', max_blocks: 100_000 }] : [])],
        ...(this.honorsKeys ? { idempotency: { header: 'Idempotency-Key', body_field: 'idempotency_key', retention_seconds: 86400, scope: 'pubkey' } } : {}),
      })
    }
    if (req.method === 'GET' && path.startsWith('/api/v1/jobs/')) {
      const job = this.jobs.get(path.split('/')[4])
      if (!job || req.headers.get('X-Job-Token') !== job.poll_token) return json(401, { detail: 'Job status needs the poll token' })
      return json(200, this.view(job, job.status === 'computing' ? { result: { progress_percent: 42, eta_seconds: 300, est_seconds: 600 } } : {}))
    }
    const pubkey = this.auth(req, url)
    if (!pubkey) return json(401, { detail: 'NIP-98 authorization missing or invalid' })
    if (req.method === 'POST' && path === '/api/v1/ride') {
      const body = JSON.parse(await req.text()) as { previous_event_id: string; from_height: number; to_height: number; idempotency_key: string }
      const k = `${pubkey}:${body.idempotency_key}`
      const known = this.keys.get(k)
      if (known && this.jobs.get(known)!.status !== 'failed') {
        const job = this.jobs.get(known)!
        const funded = job.status === 'pending' ? this.fund(job) : this.view(job)
        return json(200, { ...funded, poll_token: job.poll_token, idempotency_key: body.idempotency_key, idempotent_replay: true })
      }
      const job: FakeJob = {
        id: this.id('job'), pubkey, status: 'pending', cost_msats: RIDE_MSATS, poll_token: this.id('tok'), result: null, error: null,
        params: { previous_event_id: body.previous_event_id, from_height: body.from_height, to_height: body.to_height }, deposit: null, key: body.idempotency_key,
      }
      this.jobs.set(job.id, job)
      this.keys.set(k, job.id)
      const answer = { ...this.fund(job), poll_token: job.poll_token, idempotency_key: body.idempotency_key, ...(known ? { replaces_job_id: known } : {}) }
      if (this.loseNextSubmitAnswer) {
        this.loseNextSubmitAnswer = false
        return json(502, { detail: 'bad gateway' })
      }
      return json(201, answer)
    }
    const claim = /^\/api\/v1\/deposit\/([^/]+)\/claim$/.exec(path)
    if (req.method === 'POST' && claim) {
      const d = this.deposits.get(claim[1])
      if (!d) return json(404, { detail: 'Deposit not found' })
      this.credit(d, pubkey)
      if (d.status === 'pending' && d.expires_at < nowSeconds()) d.status = 'expired'
      return json(200, this.depositView(d))
    }
    const start = /^\/api\/v1\/jobs\/([^/]+)\/start$/.exec(path)
    if (req.method === 'POST' && start) {
      const job = this.jobs.get(start[1])
      if (!job || job.pubkey !== pubkey) return json(404, { detail: 'Job not found' })
      if (job.status !== 'pending') return json(200, this.view(job, { payment_required: false }))
      return json(200, this.fund(job))
    }
    return json(404, { detail: 'Not Found' })
  }
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

const network = new FakeNetwork()
const canonical = network.add(CANONICAL, { refuse: (ev) => (ev.kind === 1059 ? 'blocked: kind 1059 is not accepted here' : null) })
network.add(MINE)
const general = network.add(GENERAL, { requireAuth: false })
const inbox = network.add(INBOX, { challengeOnReq: true, protectWraps: true, requireAuthToPublish: true })
const served = servedFor(3)
let probeLine: Line
const hosaka = new FakeHosaka(() => probeLine)

function dirWithKey(sk: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-hosaka-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
  return dir
}

const running: Agent[] = []
afterAll(async () => { for (const a of running) await a.stop() })

/** A session cap far below the local quote of any ride here: only a HOSAKA ride can be signed in this session. */
const SESSION_CAP = 0.05

async function startAgent(stateDir: string, operator: string): Promise<Agent> {
  const agent = await Agent.start({
    stateDir, relays: [CANONICAL, MINE], operator, capCallSeconds: 30, capSessionSeconds: SESSION_CAP, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1500, lookupRelays: [GENERAL],
    manifestUrl: MANIFEST_URL, lineFetch: fakeFetch(served), rideThreads: 0, hosakaUrl: HOSAKA, hosakaFetch: hosaka.fetch,
  })
  running.push(agent)
  return agent
}

async function stopAgent(a: Agent): Promise<void> {
  await a.stop()
  running.splice(running.indexOf(a), 1)
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try { await p } catch (err) { if (err instanceof Refusal) return err.message; throw err }
  throw new Error('expected a refusal')
}

function cheapAbove(line: Line, s: number): boolean {
  if (s + RIDE_LENGTH > TIP) return false
  for (let h = s + 1; h <= s + RIDE_LENGTH; h++) if (lineTerrainK(line.blockHash(h)!) > CHEAP_K) return false
  return true
}

/** The DMs the operator can read on their inbox, oldest first. */
function dmsToOperator(opSk: Uint8Array): string[] {
  const op = getPublicKey(opSk)
  return inbox.published
    .filter((e) => e.kind === 1059 && e.tags.some((t) => t[0] === 'p' && t[1] === op))
    .map((w) => nip17.unwrapEvent(w as Parameters<typeof nip17.unwrapEvent>[0], opSk))
    .sort((a, b) => a.created_at - b.created_at)
    .map((r) => r.content)
}

const hyperjumps = (): NostrEvent[] => canonical.all().filter((e) => e.kind === 3333 && tagValue(e, 'A') === 'hyperjump')

describe('a ride bought from HOSAKA, paid by the operator', () => {
  let sk: Uint8Array
  let S: number
  let dir: string
  let a: Agent
  const opSk = generateSecretKey()
  const op = getPublicKey(opSk)

  beforeAll(async () => {
    const probe = LineStore.open(join(mkdtempSync(join(tmpdir(), 'cyberspace-mcp-hosaka-probe-')), 'line'), { manifestUrl: MANIFEST_URL, fetch: fakeFetch(served) })
    const sync = await probe.sync({ budgetSeconds: 60 })
    if (sync.asOf !== TIP) throw new Error(`the fixture line did not verify: ${sync.failure}`)
    probeLine = probe.line
    for (let tries = 0; ; tries++) {
      const candidate = generateSecretKey()
      const home = spawnPlace(getPublicKey(candidate))
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
    expect(dmsToOperator(opSk)).toEqual([])
  })

  it('a forged proof from HOSAKA fails Level 1 and is never signed; the operator is to be told, and cancel lets it go', async () => {
    const to = S + 2
    const r = await a.ride({ to, prover: 'hosaka' })
    expect((r.data.ride as { state: string }).state).toBe('awaiting_payment')
    const job = [...hosaka.jobs.values()].at(-1)!
    hosaka.pay(job.deposit!)
    expect(((await a.rideStatus()).data.ride as { state: string }).state).toBe('computing')
    hosaka.complete(job.id, true)
    expect(((await a.rideStatus()).data.ride as { state: string }).state).toBe('done')
    const before = hyperjumps().length
    const words = await refusal(a.ride({ to }))
    expect(words).toMatch(/failed Level 1 self-verification/)
    expect(words).toMatch(/Nothing was signed/)
    expect(hyperjumps().length).toBe(before)
    // Asking again returns the same proof, so it is refused at once.
    expect(await refusal(a.ride({ to }))).toMatch(/refuses/)
    const c = await a.ride({ to, cancel: true })
    expect(c.text).toMatch(/was paid and its proof refused/)
    expect(a.transit.riding).toBe(false)
  })

  it('a lost submit answer, then a restart: the same key gets the same job, the head stays reserved, and one invoice reaches the operator', async () => {
    const to = S + RIDE_LENGTH
    const jobsBefore = hosaka.jobs.size
    const dmsBefore = dmsToOperator(opSk).length
    hosaka.loseNextSubmitAnswer = true
    const r = await a.ride({ to, prover: 'hosaka' })
    expect((r.data.ride as { state: string }).state).toBe('submitting')
    expect(r.text).toMatch(/answer to the submit was lost/)
    expect(hosaka.jobs.size).toBe(jobsBefore + 1)
    expect(dmsToOperator(opSk).length).toBe(dmsBefore)
    const saved = JSON.parse(readFileSync(join(dir, 'hosaka-ride.json'), 'utf8')) as { key: string; state: string }
    const head = a.keeper.head()!
    expect(saved.key).toBe(rideIdempotencyKey(head.id, S, to))

    // A restart in the middle: the record and the reservation come back before any tool runs.
    await stopAgent(a)
    a = await startAgent(dir, op)
    await expect(a.hop({ target: { dx: 1, dy: 0, dz: 0 } })).rejects.toThrow(/already in flight/)
    expect(await refusal(a.ride({ to: to - 1 }))).toMatch(/HOSAKA ride to block/)

    const again = await a.ride({ to })
    const ride = again.data.ride as { state: string; job: string; invoice: { sats: number; bolt11: string }; invoiceSentToOperator: boolean }
    expect(ride.state).toBe('awaiting_payment')
    expect(again.text).toMatch(/same idempotency key/)
    expect(hosaka.jobs.size).toBe(jobsBefore + 1)
    expect(ride.invoiceSentToOperator).toBe(true)
    const dms = dmsToOperator(opSk)
    expect(dms.length).toBe(dmsBefore + 1)
    const dm = dms.at(-1)!
    expect(dm).toContain(`${RIDE_MSATS / 1000} sats`)
    expect(dm).toContain(`from block ${S} to block ${to}`)
    expect(dm).toContain(ride.invoice.bolt11)
    expect(dm).toMatch(/I hold no wallet/)
    expect(dm).not.toMatch(/\u2014/)

    // ride_status asks HOSAKA and leaves the invoice where it is; nothing is sent twice.
    const s = await a.rideStatus()
    expect((s.data.ride as { state: string }).state).toBe('awaiting_payment')
    expect(dmsToOperator(opSk).length).toBe(dmsBefore + 1)
  })

  it('an expired invoice releases the head; ride asks for a fresh one, which alone is sent; payment starts the job once', async () => {
    const to = S + RIDE_LENGTH
    const job = [...hosaka.jobs.values()].at(-1)!
    const first = job.deposit!
    hosaka.expire(first)
    const s = await a.rideStatus()
    expect((s.data.ride as { state: string; headReserved: boolean }).state).toBe('expired')
    expect((s.data.ride as { headReserved: boolean }).headReserved).toBe(false)
    const dmsBefore = dmsToOperator(opSk).length

    const r = await a.ride({ to })
    expect((r.data.ride as { state: string }).state).toBe('awaiting_payment')
    expect(job.deposit).not.toBe(first)
    const dms = dmsToOperator(opSk)
    expect(dms.length).toBe(dmsBefore + 1)
    expect(dms.at(-1)).toContain(hosaka.deposits.get(job.deposit!)!.bolt11)
    await expect(a.hop({ target: { dx: 1, dy: 0, dz: 0 } })).rejects.toThrow(/already in flight/)

    const debitsBefore = hosaka.debits
    hosaka.pay(job.deposit!)
    expect(((await a.rideStatus()).data.ride as { state: string }).state).toBe('computing')
    const s2 = await a.rideStatus()
    expect((s2.data.ride as { progressPercent: number }).progressPercent).toBe(42)
    expect(hosaka.debits).toBe(debitsBefore + 1)
    // A ride call while computing only reads the job: no second submit, no second charge.
    const submits = hosaka.submits()
    expect((await a.ride({ to })).text).toMatch(/HOSAKA is computing/)
    expect(hosaka.submits()).toBe(submits)
    expect(hosaka.debits).toBe(debitsBefore + 1)
  })

  it('done: verified here at Level 1, then signed exactly as a local ride, with HOSAKA\'s compute not on the caps', async () => {
    const to = S + RIDE_LENGTH
    const job = [...hosaka.jobs.values()].at(-1)!
    hosaka.complete(job.id)
    const s = await a.rideStatus()
    expect((s.data.ride as { state: string }).state).toBe('done')
    expect(s.text).toContain('Nothing was signed')

    // This process restarted since the ride was bought, and has not verified the line again: the proof waits, unchecked and unsigned.
    expect(await refusal(a.ride({ to }))).toMatch(/cannot be checked[\s\S]*station with sync: true[\s\S]*proof is kept/)
    expect(((await a.rideStatus()).data.ride as { state: string }).state).toBe('done')
    await a.station({ sync: true, budget_seconds: 30 })
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
    // Forgotten once recorded; the head is free; the session cap was never the HOSAKA job's.
    expect(JSON.parse(readFileSync(join(dir, 'hosaka-ride.json'), 'utf8'))).toBeNull()
    expect(a.transit.riding).toBe(false)
    expect((await a.rideStatus()).data.inFlight).toBe(false)
    expect((r.data.budget as { spentSeconds: number }).spentSeconds).toBeLessThan(5)
  })

  it('a job that fails at HOSAKA is refunded to the balance; starting it again with the same key is paid from that refund, with no new invoice', async () => {
    // From the stop at S + 3 back to S + 1: the same cheap stretch of the line, ridden the other way.
    const to = S + 1
    const r = await a.ride({ to, prover: 'hosaka' })
    expect((r.data.ride as { state: string }).state).toBe('awaiting_payment')
    const job = [...hosaka.jobs.values()].at(-1)!
    hosaka.pay(job.deposit!)
    expect(((await a.rideStatus()).data.ride as { state: string }).state).toBe('computing')
    hosaka.fail(job.id, 'worker lost')
    const s = await a.rideStatus()
    expect((s.data.ride as { state: string; headReserved: boolean }).state).toBe('failed')
    expect((s.data.ride as { headReserved: boolean }).headReserved).toBe(false)
    expect(s.text).toMatch(/worker lost/)

    const dms = dmsToOperator(opSk).length
    const deposits = hosaka.deposits.size
    const again = await a.ride({ to })
    const ride = again.data.ride as { state: string; paidFromBalance: boolean; job: string }
    expect(ride.state).toBe('computing')
    expect(ride.paidFromBalance).toBe(true)
    expect(ride.job).not.toBe(job.id)
    expect(again.text).toMatch(/paid from that refund/)
    expect(hosaka.deposits.size).toBe(deposits)
    expect(dmsToOperator(opSk).length).toBe(dms)

    hosaka.complete(ride.job)
    expect(((await a.rideStatus()).data.ride as { state: string }).state).toBe('done')
    const signed = await a.ride({ to })
    expect(signed.data.action).toBe('hyperjump')
    expect(tagValue(canonical.all().find((e) => e.id === signed.data.eventId)!, 'from_height')).toBe(String(S + RIDE_LENGTH))
  })
})
