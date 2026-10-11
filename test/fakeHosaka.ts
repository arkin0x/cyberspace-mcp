// fakeHosaka.ts: a fake HOSAKA for the tests, never the real one. It speaks
// the job API the way hosaka-api does for a sidestep (submit, invoice,
// claim, /start, poll token), plus the proposed ride job (src/hosaka.ts
// header): it checks every NIP-98 signature and refuses a reused one, keeps
// idempotency keys per pubkey, charges a job once, refunds a failed one to
// the balance, and computes a real proof over the fixture line, so the
// agent's Level 1 check is the real check. Its invoices are real bolt11
// strings with a payment hash whose preimage only it knows; payBolt11 is
// what a Lightning payment to it does (the fake wallet calls it), and pay
// is an operator paying from elsewhere. Moved here from test/hosaka.test.ts
// (PR #11) so the wallet tests share it (arkinox, 2026-10-11).

import { createHash } from 'node:crypto'
import { verifyEvent } from 'nostr-tools/pure'
import type { Line } from '../src/hyperspace/line.js'
import { buildRideProof, computeRideLeaf, rideBlocks } from '../src/hyperspace/ride.js'
import { bytesToHex, nowSeconds, tagValue, type NostrEvent } from '../src/nostr/event.js'
import { encodeBolt11 } from './fakeWallet.js'

/** What the fake charges for any ride, in millisats. */
export const RIDE_MSATS = 21_000

interface FakeDeposit { deposit_id: string; status: 'pending' | 'settled' | 'expired'; amount_msats: number; bolt11: string; payment_hash: string; preimage: string; expires_at: number; paid: boolean; credited: boolean }
interface FakeJob {
  id: string; pubkey: string; status: 'pending' | 'computing' | 'completed' | 'failed'; cost_msats: number; poll_token: string; result: unknown; error: string | null
  params: { previous_event_id: string; from_height: number; to_height: number }; deposit: string | null; key: string
}

export class FakeHosaka {
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

  /** Lightning payments that reached this node, by bolt11, in order (a second payment of one invoice is refused, as a node refuses it). */
  lightningPayments: string[] = []
  /** Claims answer 503: HOSAKA's node cannot be asked whether an invoice settled. */
  failClaims = false
  /** HOSAKA's node has not seen a payment yet: claims of a paid invoice still say pending. */
  hideSettlement = false
  /** The next invoice says a larger amount in the bolt11 than in its JSON (a HOSAKA that lies, or a bug). */
  inflateNextInvoice = false

  private newDeposit(msats: number): FakeDeposit {
    const preimage = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
    const payment_hash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex')
    const amount_msats = Math.ceil(msats / 1000) * 1000
    const billed = this.inflateNextInvoice ? amount_msats * 100 : amount_msats
    this.inflateNextInvoice = false
    const expires_at = nowSeconds() + 600
    const d: FakeDeposit = { deposit_id: this.id('dep'), status: 'pending', amount_msats, bolt11: encodeBolt11({ msats: billed, paymentHash: payment_hash, expirySeconds: 600 }), payment_hash, preimage, expires_at, paid: false, credited: false }
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
    return { deposit_id: d.deposit_id, status: d.status, amount_msats: d.amount_msats, bolt11: d.bolt11, payment_hash: d.payment_hash, expires_at: d.expires_at }
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
  /** The operator pays from their own wallet. */
  pay(depositId: string): void { this.deposits.get(depositId)!.paid = true }
  /** A Lightning payment of a bolt11 reaching this node: the preimage, or null when the invoice is unknown, settled, paid or expired. */
  payBolt11(bolt11: string): string | null {
    const d = [...this.deposits.values()].find((x) => x.bolt11 === bolt11)
    this.lightningPayments.push(bolt11)
    if (!d || d.paid || d.status !== 'pending' || d.expires_at < nowSeconds()) return null
    d.paid = true
    return d.preimage
  }
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
      if (this.failClaims) return json(503, { detail: 'the node is unavailable' })
      const d = this.deposits.get(claim[1])
      if (!d) return json(404, { detail: 'Deposit not found' })
      if (this.hideSettlement && d.paid) return json(200, this.depositView(d))
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
