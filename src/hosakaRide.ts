// hosakaRide.ts: a ride whose proof is bought from HOSAKA, run in the
// background like a ride computed here (arkinox, 2026-10-11: "yes, build in
// hosaka and whatever nwc tools the agent needs"). transit.ts owns it and
// routes `ride { to, prover: "hosaka" }`, ride_status and orders_waiting's
// data.ride to it; everything that touches HOSAKA or the wallet is here.
//
// The life of one ride:
//
//   1. ride { to, prover: "hosaka" }: the same plan as a local ride, then
//      every refusal that can come before anything is bought (the operator
//      can be sent a DM, HOSAKA sells rides and honors idempotency keys, the
//      head is confirmed), then the head is reserved, hosaka-ride.json is
//      written with the submit's idempotency key, and the job is submitted.
//      The call returns at once.
//   2. In the background, with no model turn: the invoice HOSAKA answered
//      with is paid by the server from the human's wallet when the human's
//      limits allow it (wallet.ts), and a receipt goes to the operator by
//      DM; otherwise the invoice itself goes to the operator by DM, as it
//      did before there was a wallet. Then HOSAKA is asked until the job is
//      paid (claim, /start), computing (poll token), and completed.
//   3. Still in the background: the proof is checked at Level 1 exactly as
//      the local runner checks its own, and the ride is `ready`.
//   4. ride { to } again signs it: confirm the head, the builder's and the
//      reader's checks, record, publish, forget. Never in the background.
//
// ride_status and orders_waiting read this in memory and never ask HOSAKA:
// the background does, every few seconds while something can change.
//
// What keeps money safe, in one place:
//
//   - The only invoice ever paid is the one in this ride's record, which
//     came from HOSAKA's own answer to this server's own submit or /start
//     for this ride's job, at the HOSAKA the human configured. No tool takes
//     an invoice; nothing read from a relay becomes one.
//   - Before a payment: HOSAKA is asked whether the invoice already settled
//     (an operator may have paid it), and the relays whether the head is
//     still the one the proof will be bound to. A proof that could never be
//     signed is not paid for.
//   - The decision to pay an invoice is made once per invoice and kept in
//     the record (payDecidedFor) and the attempt in payments.json before the
//     request goes out, so neither a restart nor a second background tick
//     pays it again. A ride is paid by the server at most once; a second
//     invoice for the same ride (an expired one paid by nobody is the
//     exception, when the attempt definitely failed) goes to the operator.
//   - An invoice is sent to the operator only when the server will not pay
//     it, never both.
//   - Every HOSAKA step runs one at a time (serial), background and tool
//     calls alike.
//
// The HOSAKA ride job contract this speaks is written out at the top of
// hosaka.ts.

import type { Budget } from './budget.js'
import type { ChainKeeper } from './chain/keeper.js'
import { HosakaError, honorsKeys, rideIdempotencyKey, rideResultOf, rideService, type HosakaClient, type HosakaJob } from './hosaka.js'
import type { LineStore } from './hyperspace/line.js'
import { verifyRideLevel1, type RideProof, type RideVerifyResult } from './hyperspace/ride.js'
import type { NostrEvent } from './nostr/event.js'
import type { StateDir } from './state/dir.js'
import { Refusal, type ToolResult } from './tool.js'
import type { RidePlan, RideStateData } from './transit.js'
import type { PayContext, Wallet } from './wallet.js'

/**
 * Where a HOSAKA ride stands. `submitting`: a submit whose answer has not
 * come back. `done`: HOSAKA's proof is in, not yet checked here (the line
 * did not hold its blocks). `ready`: checked at Level 1, waiting for a ride
 * call to sign it. The head is reserved in every state but the last two.
 */
export type HosakaRideState = 'submitting' | 'awaiting_payment' | 'computing' | 'done' | 'ready' | 'failed' | 'expired'

const HOLDS_HEAD: ReadonlySet<HosakaRideState> = new Set(['submitting', 'awaiting_payment', 'computing', 'done', 'ready'])
/** The states the background keeps asking HOSAKA about. */
const POLLED: ReadonlySet<HosakaRideState> = new Set(['submitting', 'awaiting_payment', 'computing', 'done'])

/** Past the invoice's expiry by this much with the node still saying pending, the invoice is taken as lapsed. */
const EXPIRY_GRACE_S = 30
/** The background's pace, and the most it backs off to after errors. */
const POLL_MS = 10_000
const MAX_BACKOFF_MS = 120_000

/** What the server did about the current invoice, for the agent and the waker. */
interface PaymentNote {
  depositId: string
  /** paid / failed / unknown: the wallet's outcome. sending: going out now. operator: the invoice went to the operator instead. */
  state: 'sending' | 'paid' | 'failed' | 'unknown' | 'operator'
  sats: number | null
  /** Why the server did not pay, or how paying failed. */
  reason: string | null
}

/** A ride bought from HOSAKA, between calls and across restarts: <state>/hosaka-ride.json. */
interface HosakaRide {
  version: 2
  apiUrl: string
  /** The submit's idempotency key; every submit for this ride sends it (hosaka.ts rideIdempotencyKey). */
  key: string
  state: HosakaRideState
  previousId: string
  prevCoordHex: string
  genesisId: string
  fromHeight: number
  toHeight: number
  asOf: number | null
  chained: boolean
  blocks: number
  createdAt: number
  jobId: string | null
  pollToken: string | null
  costMsats: number | null
  invoice: { depositId: string; bolt11: string; amountMsats: number; expiresAt: number; status: string; paymentHash: string | null } | null
  /** The invoice the server decided about (pay it, or send it to the operator), by deposit id: never decided twice. */
  payDecidedFor: string | null
  payment: PaymentNote | null
  /** The invoice the operator was sent, by deposit id, and when. */
  dm: { depositId: string; at: number } | null
  dmError: string | null
  /** The job was paid from the agent's HOSAKA balance (a refund of a failed job, or a payment credited earlier), with no invoice. */
  paidFromBalance: boolean
  proof: RideProof | null
  verification: RideVerifyResult | null
  /** HOSAKA's proof failed the agent's own check: it is never signed, and asking again returns the same proof. */
  badProof: boolean
  error: string | null
  progressPercent: number | null
  etaSeconds: number | null
  polledAt: number | null
}

const HOSAKA_FILE = 'hosaka-ride.json'

/** What transit.ts lends this module. */
export interface HosakaHost {
  dir: StateDir
  keeper: ChainKeeper
  budget: Budget
  store: LineStore
  hosaka: HosakaClient
  wallet: Wallet
  log: (line: string) => void
  refreshChain: () => Promise<void>
  /** The ride from the head to `to`, as a local ride would be planned; refuses in words. */
  planRide: (to: number, asOf: number | undefined) => Promise<RidePlan>
  /** Why a DM to the operator could not be sent now, or null. */
  undeliverable: () => Promise<string | null>
  /** A NIP-17 DM to the operator (the message_operator tool's own path). */
  messageOperator: (text: string) => Promise<ToolResult>
  /** Sign the hyperjump for a plan and a checked proof, record it, publish it; the relays' answers in words and data. */
  signAndPublish: (plan: RidePlan, proof: RideProof) => Promise<{ event: NostrEvent; words: string[]; data: Record<string, unknown> }>
  /** Words for where the agent stands after a ride to `to`, and its data. */
  stopWords: (to: number) => { text: string; data: Record<string, unknown> }
}

export interface HosakaRidesOptions {
  /** The background's pace in ms; tests pass a short one. */
  pollMs?: number
}

function words(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The record's state read fresh: absorb and verify change it behind TypeScript's narrowing. */
function stateOf(rec: HosakaRide): HosakaRideState {
  return rec.state
}

function satsOf(msats: number): number {
  return Math.ceil(msats / 1000)
}

export class HosakaRides {
  private rec: HosakaRide | null
  private release: (() => void) | null = null
  private busy: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private stopped = false
  /** HOSAKA steps queued or running (serial). */
  private pending = 0
  private readonly pollMs: number
  /** What the background noticed that the next ride call or ride_status should say once. */
  private notes: string[] = []
  /** A ride the background let go (its head moved), told once. */
  private ended: { to: number; reason: string } | null = null

  constructor(private readonly host: HosakaHost, opts: HosakaRidesOptions = {}) {
    this.pollMs = opts.pollMs ?? POLL_MS
    const saved = host.dir.readJson<HosakaRide | null>(HOSAKA_FILE, null)
    this.rec = saved?.version === 2 ? saved : null
    // A restart in the middle of a paid ride: the head is reserved again before
    // any tool runs, so no hop can sign from the head the proof is bound to.
    if (this.rec && HOLDS_HEAD.has(this.rec.state)) {
      try {
        this.holdHead()
      } catch (err) {
        host.log(`hosaka ride: the head could not be reserved again at start: ${words(err)}`)
      }
    }
  }

  /** Whether a HOSAKA ride is in hand (any state, until it is signed or let go). */
  get inHand(): boolean {
    return this.rec !== null
  }

  get toHeight(): number | null {
    return this.rec?.toHeight ?? null
  }

  /** Start the background after a restart; a no-op with no ride in hand. */
  resume(): void {
    this.schedule(0)
  }

  /**
   * Stop the background. Returns the step in progress to wait for, or null
   * when none is running, so a shutdown with no HOSAKA work keeps the timing
   * it had before this module existed.
   */
  stop(): Promise<void> | null {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    return this.pending > 0 ? this.busy.then(() => {}, () => {}) : null
  }

  // ---- plumbing ---------------------------------------------------------------

  /** Run HOSAKA steps one after another, so the background never races a ride call over the same job or invoice. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    this.pending++
    const next = this.busy.then(work, work).finally(() => { this.pending-- })
    this.busy = next.catch(() => {})
    return next
  }

  private save(): void {
    this.host.dir.writeJson(HOSAKA_FILE, this.rec)
  }

  /** Reserve the head for the ride, if it is not reserved already. Throws the keeper's words when a move holds it. */
  private holdHead(): void {
    if (!this.release) this.release = this.host.keeper.reserve()
  }

  private letGoOfHead(): void {
    this.release?.()
    this.release = null
  }

  /** Forget the ride: the file, the record and the reservation. */
  private drop(): void {
    this.rec = null
    this.save()
    this.letGoOfHead()
  }

  private setState(rec: HosakaRide, state: HosakaRideState): void {
    rec.state = state
    if (!HOLDS_HEAD.has(state)) this.letGoOfHead()
  }

  private where(): string {
    return `HOSAKA at ${this.host.hosaka.apiUrl}`
  }

  /** The next background step, after `ms`. */
  private schedule(ms: number): void {
    if (this.stopped || this.timer) return
    const rec = this.rec
    if (!rec || !POLLED.has(rec.state)) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.serial(() => this.tick()).catch((err) => this.host.log(`hosaka ride: ${words(err)}`)).finally(() => {
        const backoff = this.failures === 0 ? this.pollMs : Math.min(MAX_BACKOFF_MS, this.pollMs * 2 ** this.failures)
        this.schedule(backoff)
      })
    }, ms)
    this.timer.unref?.()
  }

  // ---- the background ------------------------------------------------------------

  /** One background step: move the ride along as far as HOSAKA and the wallet allow. */
  private async tick(): Promise<void> {
    const rec = this.rec
    if (!rec || this.stopped || !POLLED.has(rec.state)) return
    // The job lives at the HOSAKA it was bought from; another one would not know it, and nothing is paid to another.
    if (rec.apiUrl !== this.host.hosaka.apiUrl) return
    try {
      if (rec.state === 'submitting') {
        // The same key gets back the job the lost answer made, never a second one (hosaka-api #21).
        this.notes.push(...(await this.submit(rec, 'again')))
      } else if (rec.state === 'awaiting_payment') {
        await this.advancePayment(rec)
      } else if (rec.state === 'computing' && rec.jobId) {
        this.absorb(rec, rec.pollToken ? await this.host.hosaka.getJob(rec.jobId, rec.pollToken) : await this.host.hosaka.startJob(rec.jobId))
      }
      if (this.rec === rec && rec.state === 'done') await this.verify(rec)
      this.failures = 0
    } catch (err) {
      if (err instanceof Refusal) {
        // HOSAKA said no to a retry: the ride waits on the agent's decision instead of asking again forever.
        if (this.rec === rec) {
          rec.error = err.message
          this.setState(rec, 'failed')
        } else {
          this.ended = { to: rec.toHeight, reason: err.message }
        }
        return
      }
      this.failures++
      rec.error = `${this.where()} could not be asked about the job just now: ${words(err)}`
      this.host.log(`hosaka ride: ${rec.error}`)
    } finally {
      if (this.rec === rec) this.save()
    }
  }

  /**
   * An invoice is waiting. Ask HOSAKA first (an operator may have paid it,
   * or it lapsed); then, once per invoice, decide: the server pays it within
   * the human's limits, or the operator is sent it.
   */
  private async advancePayment(rec: HosakaRide): Promise<void> {
    const { hosaka } = this.host
    const inv = rec.invoice
    if (!rec.jobId) return
    if (!inv) {
      this.absorb(rec, await hosaka.startJob(rec.jobId))
      return
    }
    const dep = await hosaka.claimDeposit(inv.depositId)
    inv.status = dep.status
    if (dep.status === 'settled') {
      const ours = rec.payment?.state === 'paid' || rec.payment?.state === 'unknown'
      this.notes.push(ours ? 'HOSAKA has the payment; the job starts now.' : 'Your operator paid the invoice; HOSAKA starts the job now.')
      this.absorb(rec, await hosaka.startJob(rec.jobId))
      return
    }
    if (dep.status === 'expired' || Date.now() / 1000 > inv.expiresAt + EXPIRY_GRACE_S) {
      inv.status = 'expired'
      this.setState(rec, 'expired')
      return
    }
    if (rec.payDecidedFor === inv.depositId) {
      // Decided already. A payment cut short by a restart is unknown, and the operator hears of it once.
      if (rec.payment?.state === 'sending') {
        const attempt = this.host.wallet.attemptFor(inv.depositId)
        rec.payment = { ...rec.payment, state: attempt && attempt.state !== 'sending' ? attempt.state : 'unknown', reason: attempt?.error ?? 'the server stopped while the payment was going out' }
        this.save()
        if (rec.payment.state !== 'paid') await this.deliverInvoice(rec)
      } else if (rec.payment?.state !== 'paid') {
        // The DM that did not get through is tried again.
        await this.deliverInvoice(rec)
      }
      return
    }
    await this.decideAndPay(rec, inv)
  }

  private payContext(rec: HosakaRide, inv: NonNullable<HosakaRide['invoice']>): PayContext {
    return { depositId: inv.depositId, rideKey: rec.key, apiUrl: rec.apiUrl, jobId: rec.jobId, toHeight: rec.toHeight, expectedMsats: inv.amountMsats, expectedHash: inv.paymentHash }
  }

  private async decideAndPay(rec: HosakaRide, inv: NonNullable<HosakaRide['invoice']>): Promise<void> {
    const { wallet, keeper } = this.host
    const toOperator = async (reason: string): Promise<void> => {
      rec.payDecidedFor = inv.depositId
      rec.payment = { depositId: inv.depositId, state: 'operator', sats: satsOf(inv.amountMsats), reason }
      this.save()
      await this.deliverInvoice(rec)
    }
    const first = wallet.decide(inv.bolt11, this.payContext(rec, inv))
    if (!first.pay) {
      await toOperator(first.reason)
      return
    }
    // The proof will be bound to this head: do not pay for one that could never be signed.
    const unconfirmed = await keeper.confirmHead()
    if (unconfirmed) {
      this.host.log(`hosaka ride: payment waits for the relays to confirm the head: ${unconfirmed}`)
      return
    }
    if (keeper.head()?.id !== rec.previousId) {
      const head = keeper.head()
      this.ended = { to: rec.toHeight, reason: `The head moved before the HOSAKA ride to block ${rec.toHeight} was paid for: the relays hold a newer move (${head ? `${head.id.slice(0, 8)}...` : 'none'}). HOSAKA's proof would be bound to the old head and could never be signed, so nothing was paid and the ride was let go.` }
      this.drop()
      return
    }
    // Decided again after the relays were asked, with nothing awaited between this decision, the record and the request: time passed (an expiry may be near), and pay() refuses whatever decide() refuses.
    const decision = wallet.decide(inv.bolt11, this.payContext(rec, inv))
    if (!decision.pay) {
      await toOperator(decision.reason)
      return
    }
    rec.payDecidedFor = inv.depositId
    rec.payment = { depositId: inv.depositId, state: 'sending', sats: decision.sats, reason: null }
    this.save()
    const outcome = await wallet.pay(inv.bolt11, this.payContext(rec, inv))
    rec.payment = { depositId: inv.depositId, state: outcome.state, sats: decision.sats, reason: outcome.state === 'paid' ? null : outcome.reason }
    this.save()
    if (outcome.state === 'paid') {
      const fee = outcome.record.feesSats ? ` plus ${outcome.record.feesSats} sats in routing fees` : ''
      this.notes.push(`The server paid HOSAKA's invoice from your operator's wallet: ${decision.sats} sats${fee}.`)
      await this.receipt(rec, outcome.record.sats, outcome.record.feesSats, outcome.record.paymentHash)
      // HOSAKA learns of it from its own node; ask now rather than at the next tick.
      const dep = await this.host.hosaka.claimDeposit(inv.depositId)
      inv.status = dep.status
      if (dep.status === 'settled') this.absorb(rec, await this.host.hosaka.startJob(rec.jobId!))
      return
    }
    this.notes.push(`The server could not pay HOSAKA's invoice (${outcome.reason}); it went to your operator instead.`)
    await this.deliverInvoice(rec)
  }

  /** A receipt to the operator for a payment the server made. */
  private async receipt(rec: HosakaRide, sats: number, feesSats: number | null, paymentHash: string): Promise<void> {
    const { wallet } = this.host
    const text = [
      `Paid HOSAKA ${sats} sats${feesSats ? ` (plus ${feesSats} sats in routing fees)` : ''} from the wallet you connected, for my hyperspace ride from block ${rec.fromHeight} to block ${rec.toHeight} (${rec.blocks} blocks).`,
      `Job ${rec.jobId ?? '(unknown)'} at ${rec.apiUrl}. Payment hash ${paymentHash}.`,
      `Spent in the last 24 hours: ${wallet.spentLast24hSats()} of ${wallet.maxDailySats} sats; one payment may be at most ${wallet.maxPaymentSats} sats. I check the proof myself before I sign anything.`,
    ].join('\n')
    try {
      await this.host.messageOperator(text)
    } catch (err) {
      this.notes.push(`The receipt for the payment could NOT be sent to your operator: ${words(err)}. Tell them with message_operator.`)
    }
  }

  /**
   * Send the operator the invoice the job waits on, once per invoice, and
   * only when the server is not paying it. A DM that cannot be delivered is
   * tried again by the next background step; the invoice is in ride_status
   * too.
   */
  private async deliverInvoice(rec: HosakaRide): Promise<void> {
    const inv = rec.invoice
    if (rec.state !== 'awaiting_payment' || !inv || inv.status !== 'pending' || rec.dm?.depositId === inv.depositId) return
    if (rec.payDecidedFor !== inv.depositId || rec.payment?.state === 'paid' || rec.payment?.state === 'sending') return
    const sats = satsOf(inv.amountMsats)
    const costSats = rec.costMsats !== null ? satsOf(rec.costMsats) : null
    const minutes = Math.max(0, Math.round((inv.expiresAt - Date.now() / 1000) / 60))
    const why = rec.payment?.state === 'unknown'
      ? `My wallet MAY HAVE PAID it already: the payment's outcome is unknown (${rec.payment.reason}). Check your wallet before you pay; a Lightning invoice settles once.`
      : rec.payment?.state === 'failed'
        ? `The wallet you connected could not pay it (${rec.payment.reason}), so it is yours to pay or not.`
        : `I did not pay it myself: ${rec.payment?.reason ?? 'no wallet is connected'}.`
    const text = [
      `HOSAKA invoice for my hyperspace ride: ${sats} sats.`,
      `It pays HOSAKA to compute the proof for one ride, from block ${rec.fromHeight} to block ${rec.toHeight} (${rec.blocks} blocks), departing from my chain head ${rec.previousId.slice(0, 8)}. I check the proof myself before I sign anything.`,
      costSats !== null && costSats !== sats ? `The job costs ${costSats} sats; ${sats} sats are due now (HOSAKA invoices whole sats, and anything already in my HOSAKA balance counts).` : '',
      why,
      `It expires ${new Date(inv.expiresAt * 1000).toISOString()} (about ${minutes} min). If you do not pay, nothing happens: the invoice lapses and I stay where I am.`,
      `Job ${rec.jobId ?? '(unknown)'} at ${rec.apiUrl}.`,
      '',
      inv.bolt11,
    ].filter((l, i, all) => l !== '' || i === all.length - 2).join('\n')
    try {
      await this.host.messageOperator(text)
      rec.dm = { depositId: inv.depositId, at: Date.now() }
      rec.dmError = null
      this.save()
      this.notes.push(`The invoice (${sats} sats) was sent to your operator by DM.`)
    } catch (err) {
      rec.dmError = words(err)
      this.save()
      this.notes.push(`The invoice could NOT be sent to your operator: ${rec.dmError} It is tried again shortly; the invoice is also in ride_status, to pass on another way your operator asked for.`)
    }
  }

  /** HOSAKA's proof is in: check it at Level 1 here, as the local runner checks its own. A proof that fails is never signed. */
  private async verify(rec: HosakaRide): Promise<void> {
    const line = this.host.store.line
    const proof = rec.proof
    if (!proof) return
    if (!line.has(rec.fromHeight) || !line.has(rec.toHeight)) return
    const t0 = performance.now()
    let verification: RideVerifyResult
    try {
      verification = await verifyRideLevel1({
        previousEventIdHex: rec.previousId, fromHeight: rec.fromHeight, toHeight: rec.toHeight, rootHex: proof.rootHex, mp: proof.mp, mn: proof.mnHex,
        blockHashFor: (height) => {
          const hash = line.blockHash(height)
          if (!hash) throw new Error(`block ${height} is not verified by this process`)
          return hash
        },
      })
    } catch (err) {
      verification = { ok: false, checked: 0, reason: words(err), grandfathered: false }
    }
    // The check is this machine's work, so it is counted; HOSAKA's compute is not.
    this.host.budget.spendWork((performance.now() - t0) / 1000)
    rec.verification = verification
    if (!verification.ok || verification.grandfathered) {
      rec.badProof = true
      rec.error = `it failed Level 1 self-verification: ${verification.reason ?? 'a ride signed now needs an mn'}`
      this.setState(rec, 'failed')
    } else {
      this.setState(rec, 'ready')
    }
    this.save()
  }

  // ---- HOSAKA's answers ------------------------------------------------------------

  /**
   * Submit the ride with its key. A lost answer leaves the record in
   * `submitting`, asked again with the same key by the background; a refusal
   * drops a ride that has no job yet and is reported in HOSAKA's words.
   */
  private async submit(rec: HosakaRide, why: 'fresh' | 'again'): Promise<string[]> {
    let job: HosakaJob
    try {
      job = await this.host.hosaka.submitRide(rec.previousId, rec.fromHeight, rec.toHeight, rec.key)
    } catch (err) {
      if (err instanceof HosakaError && err.answerLost) {
        // A background retry that is lost again backs off; a first loss (fresh, or the restart of a failed job) hands the retry to the background.
        if (why === 'again' && rec.state === 'submitting') throw err
        this.setState(rec, 'submitting')
        this.save()
        return [`HOSAKA's answer to the submit was lost (${err.message}). It may have made the job; the server asks again in the background with the same idempotency key, which gets back that job and never a second one or a second invoice.`]
      }
      if (why === 'fresh' || !rec.jobId) {
        this.drop()
        throw new Refusal(`${this.where()} refused the ride: ${words(err)}. No job was made and no invoice exists; the head is released.`)
      }
      throw new Refusal(`${this.where()} refused to start the job again: ${words(err)}. The ride stays in hand; cancel: true lets it go.`)
    }
    if (job.idempotency_key !== undefined && job.idempotency_key !== rec.key) rec.error = 'HOSAKA echoed a different idempotency key than the one sent'
    if (job.status === 'computing' && job.balance_debited && !job.deposit) rec.paidFromBalance = true
    this.absorb(rec, job)
    this.save()
    return job.idempotent_replay ? ['HOSAKA answered with the job this ride already had (same idempotency key): nothing new was made or charged.'] : []
  }

  /** Fold a job answer into the record. */
  private absorb(rec: HosakaRide, job: HosakaJob): void {
    if (typeof job.id === 'string' && job.id) rec.jobId = job.id
    if (typeof job.poll_token === 'string' && job.poll_token) rec.pollToken = job.poll_token
    if (typeof job.cost_msats === 'number') rec.costMsats = job.cost_msats
    const d = job.deposit
    if (d && typeof d.bolt11 === 'string' && typeof d.deposit_id === 'string') {
      rec.invoice = {
        depositId: d.deposit_id, bolt11: d.bolt11, amountMsats: Number(d.amount_msats) || 0, expiresAt: Number(d.expires_at) || 0, status: d.status,
        paymentHash: typeof d.payment_hash === 'string' && /^[0-9a-f]{64}$/i.test(d.payment_hash) ? d.payment_hash.toLowerCase() : null,
      }
    }
    rec.polledAt = Date.now()
    const progress = (job.result ?? null) as { progress_percent?: unknown; eta_seconds?: unknown } | null
    if (job.status === 'computing' && progress && typeof progress === 'object') {
      rec.progressPercent = typeof progress.progress_percent === 'number' ? progress.progress_percent : rec.progressPercent
      rec.etaSeconds = typeof progress.eta_seconds === 'number' ? progress.eta_seconds : rec.etaSeconds
    }
    switch (job.status) {
      case 'completed': {
        const r = rideResultOf(job)
        if (typeof r === 'string') {
          rec.error = `HOSAKA says the job completed, but ${r}`
          rec.badProof = true
          this.setState(rec, 'failed')
        } else if (r.previous_event_id !== rec.previousId || r.from_height !== rec.fromHeight || r.to_height !== rec.toHeight) {
          rec.error = `HOSAKA returned a proof for another ride (head ${String(r.previous_event_id).slice(0, 8)}..., blocks ${r.from_height} to ${r.to_height})`
          rec.badProof = true
          this.setState(rec, 'failed')
        } else {
          rec.proof = { rootHex: r.root, mp: r.mp, mnHex: r.mn }
          rec.verification = null
          rec.error = null
          this.setState(rec, 'done')
        }
        break
      }
      case 'failed':
        rec.error = job.error || 'HOSAKA gave no reason'
        this.setState(rec, 'failed')
        break
      case 'computing':
        rec.error = null
        this.setState(rec, 'computing')
        break
      case 'pending':
        this.setState(rec, rec.invoice && rec.invoice.status === 'expired' ? 'expired' : 'awaiting_payment')
        break
    }
  }

  // ---- the tools -------------------------------------------------------------------

  /**
   * Buy a ride from HOSAKA: the plan, then every check that can refuse
   * before an invoice exists, then the reservation, the record with its key,
   * and the submit. Returns at once; the background pays or forwards the
   * invoice and follows the job.
   */
  start(to: number, asOfInput: number | undefined): Promise<ToolResult> {
    return this.serial(async () => {
      const { keeper, hosaka } = this.host
      if (this.rec) throw new Refusal(`A HOSAKA ride to block ${this.rec.toHeight} is already in hand (${this.stateWords(this.rec)}).`)
      const plan = await this.host.planRide(to, asOfInput)
      const undeliverable = await this.host.undeliverable()
      if (undeliverable) throw new Refusal(`${undeliverable} A HOSAKA ride needs a way to tell your operator about its invoice and its payment, so nothing was submitted to HOSAKA and no invoice exists.`)
      let provider
      try {
        provider = await hosaka.provider()
      } catch (err) {
        throw new Refusal(`${this.where()} could not be asked what it sells: ${words(err)}. Nothing was submitted.`)
      }
      const service = rideService(provider)
      if (!service) throw new Refusal(`${this.where()} does not sell rides (its /api/v1/provider lists no ride service). Nothing was submitted. Ride on this machine instead (station with destination quotes it), or tell your operator.`)
      if (service.maxBlocks !== null && plan.blocks > service.maxBlocks) throw new Refusal(`${this.where()} computes rides of at most ${service.maxBlocks} block(s), and this one passes ${plan.blocks}. Nothing was submitted. Pick a nearer block.`)
      if (!honorsKeys(provider)) throw new Refusal(`${this.where()} does not say it honors idempotency keys, so a submit whose answer was lost could not be asked about again without the risk of a second job and a second invoice. Nothing was submitted.`)
      try {
        this.holdHead()
      } catch (err) {
        throw new Refusal(words(err))
      }
      try {
        // The proof will be bound to this head (DECK-0001 5.3): confirm it before anyone pays for it.
        const unconfirmed = await keeper.confirmHead()
        if (unconfirmed) throw new Refusal(`${unconfirmed} Nothing was submitted to HOSAKA: a proof is bought only for a head the relays confirm.`)
        if (keeper.head()?.id !== plan.previousId) throw new Refusal(`The head moved while planning: the relays hold a newer move (${keeper.head()?.id.slice(0, 8)}...), adopted now. Nothing was submitted; call ride again from where you stand.`)
      } catch (err) {
        this.letGoOfHead()
        throw err
      }
      const rec: HosakaRide = {
        version: 2, apiUrl: hosaka.apiUrl, key: rideIdempotencyKey(plan.previousId, plan.fromHeight, plan.toHeight), state: 'submitting',
        previousId: plan.previousId, prevCoordHex: plan.prevCoordHex, genesisId: plan.genesisId, fromHeight: plan.fromHeight, toHeight: plan.toHeight,
        asOf: plan.asOf ?? null, chained: plan.chained, blocks: plan.blocks, createdAt: Date.now(),
        jobId: null, pollToken: null, costMsats: null, invoice: null, payDecidedFor: null, payment: null, dm: null, dmError: null, paidFromBalance: false,
        proof: null, verification: null, badProof: false, error: null, progressPercent: null, etaSeconds: null, polledAt: null,
      }
      // On disk before the submit goes out, so an answer lost on the way back, or a crash, asks again with this key.
      this.rec = rec
      this.ended = null
      this.save()
      const notes = [...plan.notes, ...(await this.submit(rec, 'fresh'))]
      notes.push(this.payPlanWords(rec))
      this.stopped = false
      this.schedule(0)
      return this.result(rec, notes)
    })
  }

  /** What will happen to the invoice, before the background does it: the same decision, made without paying. */
  private payPlanWords(rec: HosakaRide): string {
    const inv = rec.invoice
    if (rec.state !== 'awaiting_payment' || !inv) return ''
    const d = this.host.wallet.decide(inv.bolt11, this.payContext(rec, inv))
    return d.pay
      ? `The server pays HOSAKA's invoice (${d.sats} sats) from your operator's wallet in the background, within the limits they set, and sends them a receipt. You do nothing.`
      : `The server does not pay this invoice itself (${d.reason}): it goes to your operator by DM, for them to pay or not.`
  }

  /** A ride call on the HOSAKA ride in hand: report, take a decision the background cannot (a fresh invoice, a restart of a failed job), or sign once ready. */
  continue(to: number, waitSeconds: number | undefined, signal?: AbortSignal): Promise<ToolResult> {
    const rec0 = this.rec
    if (!rec0) throw new Refusal('No HOSAKA ride is in hand.')
    if (rec0.toHeight !== to) throw new Refusal(`A HOSAKA ride to block ${rec0.toHeight} is in hand (${this.stateWords(rec0)}). Call ride with to: ${rec0.toHeight} to continue it, ride_status to watch it, or cancel: true to let it go before riding elsewhere.`)
    return (async () => {
      if (waitSeconds !== undefined) await this.waitWhileWorking(rec0, Math.min(waitSeconds, this.host.budget.capCallSeconds), signal)
      return this.serial(async () => {
        const rec = this.rec
        if (rec !== rec0) throw new Refusal('The HOSAKA ride changed while this call waited (canceled or signed meanwhile). Call ride_status to see where you stand.')
        await this.host.refreshChain()
        this.refuseIfStale(rec)
        if (rec.badProof) throw new Refusal(`HOSAKA's job ${rec.jobId} for the ride to block ${rec.toHeight} returned a proof this server refuses (${rec.error}). It was never signed, and asking again returns the same proof. Tell your operator with message_operator (it was paid for), then cancel: true to let the ride go.`)
        const notes = this.takeNotes()
        if (rec.apiUrl !== this.host.hosaka.apiUrl) {
          notes.push(`This ride was bought from HOSAKA at ${rec.apiUrl}, but this server now talks to ${this.host.hosaka.apiUrl}, so the job is not asked about and nothing is paid. Ask your human to start the server with --hosaka-url ${rec.apiUrl} again, or cancel: true to let the ride go.`)
          return this.result(rec, notes)
        }
        if (rec.state === 'failed' || rec.state === 'expired') {
          try {
            this.holdHead()
          } catch (err) {
            throw new Refusal(words(err))
          }
          try {
            if (rec.state === 'failed') {
              const provider = await this.host.hosaka.provider()
              if (!honorsKeys(provider)) throw new Refusal(`${this.where()} no longer says it honors idempotency keys, so the job is not started again (it could make a second job). Ask your operator; cancel: true lets the ride go.`)
              notes.push('Starting the failed job again with the same key: HOSAKA refunded the failed job to this agent\'s HOSAKA balance, so the new job is paid from that refund, not by a new payment.')
              notes.push(...(await this.submit(rec, 'again')))
            } else {
              // /start credits an invoice paid even past its expiry; otherwise it issues a fresh one, which the background pays or forwards.
              this.absorb(rec, await this.host.hosaka.startJob(rec.jobId!))
              if (stateOf(rec) === 'awaiting_payment') notes.push(`HOSAKA issued a fresh invoice. ${this.payPlanWords(rec)}`)
            }
          } catch (err) {
            if (err instanceof Refusal) throw err
            notes.push(`${this.where()} could not be asked just now: ${words(err)}. Nothing changed; call ride again later.`)
          } finally {
            if (this.rec === rec) {
              if (!HOLDS_HEAD.has(rec.state)) this.letGoOfHead()
              this.save()
            }
          }
          this.stopped = false
          this.schedule(0)
          return this.result(rec, notes)
        }
        if (rec.state === 'done') await this.verify(rec)
        if (stateOf(rec) === 'done') throw new Refusal(`HOSAKA's proof is in, but this process does not hold blocks ${rec.fromHeight} to ${rec.toHeight} of the line (verified to block ${this.host.store.line.asOf()}), so it cannot be checked. Call station with sync: true, then ride again; the proof is kept.`)
        if (stateOf(rec) === 'failed') throw new Refusal(`HOSAKA's proof for the ride to block ${rec.toHeight} ${rec.error}. Nothing was signed and nothing reached a relay; the head is released. Tell your operator with message_operator: job ${rec.jobId} at ${rec.apiUrl} was paid for. cancel: true lets the ride go.`)
        if (stateOf(rec) !== 'ready') return this.result(rec, notes)
        return this.sign(rec, notes)
      })
    })()
  }

  /** Wait while the ride moves along by itself, for at most `seconds` or until the call is canceled. */
  private async waitWhileWorking(rec: HosakaRide, seconds: number, signal: AbortSignal | undefined): Promise<void> {
    const until = Date.now() + seconds * 1000
    while (this.rec === rec && POLLED.has(rec.state) && Date.now() < until && !signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, until - Date.now()))))
    }
  }

  /** Whether the head is still the one the ride departs from; lets the ride go and refuses when it is not. */
  private refuseIfStale(rec: HosakaRide): void {
    const head = this.host.keeper.head()
    if (head?.id === rec.previousId) return
    const paid = this.paid(rec)
    this.drop()
    throw new Refusal(`The head moved since the HOSAKA ride to block ${rec.toHeight} was bought: the relays hold a newer move (${head ? `${head.id.slice(0, 8)}...` : 'none'}). HOSAKA's proof is bound to the old head (DECK-0001 5.3) and can never be signed, so the ride was let go.${paid ? ` Its job (${rec.jobId}) was paid for; tell your operator with message_operator.` : rec.state === 'awaiting_payment' && rec.dm ? ' Its invoice was not paid; tell your operator not to pay it.' : ''} Board or ride again from where you stand.`)
  }

  /** Ready: confirm the head, sign through the builder's and the reader's checks, record, publish, forget. */
  private async sign(rec: HosakaRide, notes: string[]): Promise<ToolResult> {
    const { keeper, budget } = this.host
    const again = await keeper.confirmHead()
    if (again) throw new Refusal(`${again} HOSAKA's proof is verified and kept: call ride again with to: ${rec.toHeight} once the relays answer, and it is signed.`)
    this.refuseIfStale(rec)
    const plan: RidePlan = { previousId: rec.previousId, prevCoordHex: rec.prevCoordHex, genesisId: rec.genesisId, fromHeight: rec.fromHeight, toHeight: rec.toHeight, asOf: rec.asOf ?? undefined, chained: rec.chained, blocks: rec.blocks, notes: [] }
    const { event, words: relayWords, data } = await this.host.signAndPublish(plan, rec.proof!)
    // Only now, with the event recorded by publish, is the job forgotten: a crash before this resumes at ready, and the head check then sees the ride.
    this.drop()
    const where = this.host.stopWords(rec.toHeight)
    const verification = rec.verification!
    const paidBy = rec.payment?.state === 'paid' ? `paid by the server from your operator's wallet (${rec.payment.sats} sats)` : rec.paidFromBalance ? 'paid from this agent\'s HOSAKA balance' : 'paid by your operator'
    const text = [
      `Ride ${event.id.slice(0, 8)}... signed: block ${rec.fromHeight} to block ${rec.toHeight} (${rec.blocks} block(s)${rec.asOf !== null ? `, as_of ${rec.asOf}` : ''}), proof computed by HOSAKA (job ${rec.jobId}, ${paidBy}) and verified here at Level 1 (${verification.checked} openings). ${where.text}`,
      ...relayWords,
      ...notes,
      'Ride again to another block, or hop or sidestep to leave the line (a target away from this stop is priced by plan_hop).',
    ].join('\n')
    return {
      text,
      data: {
        ...data, eventId: event.id, action: 'hyperjump', prover: 'hosaka', job: rec.jobId, fromHeight: rec.fromHeight, toHeight: rec.toHeight, asOf: rec.asOf, blocks: rec.blocks, ...where.data,
        verification, root: rec.proof!.rootHex, mn: rec.proof!.mnHex, payment: rec.payment, notes, budget: budget.state(),
      },
    }
  }

  /** cancel or forget: let the ride go, release the head, tell the operator not to pay an invoice they were sent. */
  cancel(): Promise<ToolResult> {
    return this.serial(async () => {
      const rec = this.rec
      if (!rec) throw new Refusal('No HOSAKA ride is in hand; nothing to cancel.')
      const notes: string[] = []
      const inv = rec.invoice
      if (rec.state === 'awaiting_payment' && inv && rec.dm?.depositId === inv.depositId && inv.status === 'pending') {
        try {
          await this.host.messageOperator(`Canceled: please do NOT pay the HOSAKA invoice I sent for my ride to block ${rec.toHeight} (job ${rec.jobId}). If you already paid it, the sats are credited to my HOSAKA balance and pay for my next HOSAKA job.`)
          notes.push('Your operator was told by DM not to pay the invoice.')
        } catch (err) {
          notes.push(`Your operator could NOT be told not to pay the invoice (${words(err)}); tell them another way.`)
        }
      }
      if (rec.payment?.state === 'paid' && rec.state === 'awaiting_payment' && inv) {
        // The server's payment lands in the agent's HOSAKA balance either way; claiming it now keeps it from waiting on the next job.
        try {
          await this.host.hosaka.claimDeposit(inv.depositId)
        } catch (err) {
          this.host.log(`hosaka ride: claim at cancel: ${words(err)}`)
        }
        notes.push(`The ${rec.payment.sats} sats the server paid are in this agent's HOSAKA balance and pay for its next HOSAKA job.`)
      }
      const paid = this.paid(rec)
      const said = this.stateWords(rec)
      this.drop()
      return {
        text: [
          `Let go of the HOSAKA ride to block ${rec.toHeight} (${said}). The head is released for other moves.`,
          rec.badProof
            ? `Its job (${rec.jobId}) was paid for and its proof refused here; tell your operator with message_operator if you have not.`
            : paid ? `Its job (${rec.jobId}) was paid for. Its proof stays bound to head ${rec.previousId.slice(0, 8)}...: a ride with prover "hosaka" to the same block from that same head, within HOSAKA's key retention, gets the same job back without paying again.` : '',
          ...notes,
        ].filter(Boolean).join('\n'),
        data: { inFlight: false, canceled: this.data(rec), prover: 'hosaka' },
      }
    })
  }

  /** ride_status: in memory; HOSAKA is asked by the background, not here. */
  status(): ToolResult {
    const rec = this.rec
    if (!rec) throw new Refusal('No HOSAKA ride is in hand.')
    const stale = this.host.keeper.head()?.id !== rec.previousId
    const result = this.result(rec, stale ? ['The head is no longer the one this ride departs from, so its proof can never be signed; the next ride call lets it go.'] : this.takeNotes())
    return { ...result, data: { ...result.data, stale } }
  }

  /** The ride's state for orders_waiting and the waker: in memory, never a relay or HOSAKA. */
  rideState(): RideStateData | null {
    const rec = this.rec
    if (!rec) {
      if (this.ended) return { state: 'failed', to: this.ended.to, done: 0, total: 0, attempts: 0, attemptsExpected: 0, etaSeconds: null, reason: this.ended.reason, prover: 'hosaka' }
      return null
    }
    const state = rec.state === 'ready' || rec.state === 'done' ? 'ready'
      : rec.state === 'awaiting_payment' ? 'awaiting_payment'
        : rec.state === 'failed' || rec.state === 'expired' ? 'failed'
          : 'computing'
    const reason = rec.state === 'failed' || rec.state === 'expired' ? this.stateWords(rec) : rec.state === 'awaiting_payment' ? this.paymentWords(rec) : null
    return { state, to: rec.toHeight, done: 0, total: rec.blocks, attempts: 0, attemptsExpected: 0, etaSeconds: rec.state === 'computing' ? rec.etaSeconds : rec.state === 'ready' ? 0 : null, reason, prover: 'hosaka' }
  }

  /** What the background noticed since the last call, said once. */
  private takeNotes(): string[] {
    const out = this.notes
    this.notes = []
    if (this.ended) {
      out.unshift(this.ended.reason)
      this.ended = null
    }
    return out
  }

  /** The agent's notes when no ride is in hand: a ride the background let go. */
  endedWords(): string | null {
    if (!this.ended) return null
    const r = this.ended.reason
    this.ended = null
    return r
  }

  /** Whether money (the operator's, the wallet's, or a refund of either) went into this ride's job. */
  private paid(rec: HosakaRide): boolean {
    return rec.state === 'computing' || rec.state === 'done' || rec.state === 'ready' || rec.paidFromBalance || rec.badProof
  }

  private paymentWords(rec: HosakaRide): string {
    const p = rec.payment
    if (!p) return 'the server is deciding whether to pay it'
    switch (p.state) {
      case 'sending': return `the server is paying it from your operator's wallet (${p.sats} sats)`
      case 'paid': return `the server paid it from your operator's wallet (${p.sats} sats); HOSAKA starts the job once its node sees the payment`
      case 'failed': return `the wallet could not pay it (${p.reason}); it went to your operator`
      case 'unknown': return `the wallet's payment has an unknown outcome (${p.reason}); never paid again by the server, and your operator was told`
      case 'operator': return `the server did not pay it (${p.reason}); it ${rec.dm?.depositId === p.depositId ? 'was sent' : 'is being sent'} to your operator`
    }
  }

  private stateWords(rec: HosakaRide): string {
    const inv = rec.invoice
    const sats = inv ? satsOf(inv.amountMsats) : null
    switch (rec.state) {
      case 'submitting': return 'the submit\'s answer has not come back; the server asks again in the background with the same key'
      case 'awaiting_payment': return `awaiting payment: ${sats ?? '?'} sats, ${this.paymentWords(rec)}${inv ? `; the invoice expires ${new Date(inv.expiresAt * 1000).toISOString()}` : ''}`
      case 'computing': return `paid; HOSAKA is computing${rec.progressPercent !== null ? ` (${rec.progressPercent}%${rec.etaSeconds !== null ? `, about ${Math.round(rec.etaSeconds)} s to go` : ''})` : ''}${rec.paidFromBalance ? ', paid from this agent\'s HOSAKA balance' : ''}`
      case 'done': return 'HOSAKA\'s proof is in and waits to be checked here: the line must hold its blocks (station with sync: true), then a ride call checks and signs it'
      case 'ready': return 'ready: HOSAKA\'s proof is in and verified here at Level 1; the next ride call signs it'
      case 'failed': return rec.badProof ? `refused: ${rec.error}` : `failed at HOSAKA (${rec.error}); HOSAKA refunds a failed job to this agent's HOSAKA balance, and a ride call starts it again from that refund`
      case 'expired': return 'expired: the invoice lapsed unpaid and nothing was charged; a ride call asks HOSAKA for a fresh invoice'
    }
  }

  private data(rec: HosakaRide): Record<string, unknown> {
    return {
      prover: 'hosaka', state: rec.state, api: rec.apiUrl, job: rec.jobId, previousId: rec.previousId, fromHeight: rec.fromHeight, toHeight: rec.toHeight, asOf: rec.asOf, blocks: rec.blocks,
      costMsats: rec.costMsats, invoice: rec.invoice ? { sats: satsOf(rec.invoice.amountMsats), expiresAt: rec.invoice.expiresAt, status: rec.invoice.status, bolt11: rec.invoice.bolt11 } : null,
      payment: rec.payment, invoiceSentToOperator: !!rec.invoice && rec.dm?.depositId === rec.invoice.depositId, dmError: rec.dmError, paidFromBalance: rec.paidFromBalance,
      progressPercent: rec.progressPercent, etaSeconds: rec.etaSeconds, verification: rec.verification, error: rec.error, headReserved: HOLDS_HEAD.has(rec.state),
    }
  }

  /** The answer to a ride or ride_status call on a HOSAKA ride that is not signed yet. */
  private result(rec: HosakaRide, notes: string[]): ToolResult {
    const next: Record<HosakaRideState, string> = {
      submitting: 'The server asks HOSAKA again in the background; ride_status or orders_waiting show when it moves on.',
      awaiting_payment: rec.payment?.state === 'operator' || rec.payment?.state === 'failed' || rec.payment?.state === 'unknown'
        ? 'Nothing to do until your operator pays; the server notices by itself. Do not call ride for this in a loop: HOSAKA charges nothing until paid, and the head stays reserved.'
        : 'Nothing to do: the server follows the payment and the job in the background; ride_status or orders_waiting say when the proof is ready.',
      computing: `HOSAKA computes; the server follows it in the background and checks the proof when it arrives. When ride_status or orders_waiting say ready, call ride with to: ${rec.toHeight} to sign.`,
      done: `Call station with sync: true so the line holds blocks ${rec.fromHeight} to ${rec.toHeight}, then ride with to: ${rec.toHeight} to check and sign.`,
      ready: `Call ride with to: ${rec.toHeight} to sign the hyperjump.`,
      failed: rec.badProof ? 'Tell your operator with message_operator, then cancel: true.' : `Call ride with to: ${rec.toHeight} to start it again, or cancel: true.`,
      expired: `Call ride with to: ${rec.toHeight} for a fresh invoice, or cancel: true.`,
    }
    const inv = rec.invoice
    const showInvoice = rec.state === 'awaiting_payment' && inv && inv.status === 'pending' && rec.payment !== null && rec.payment.state !== 'paid' && rec.payment.state !== 'sending' && rec.dm?.depositId !== inv.depositId
    const text = [
      `HOSAKA ride to block ${rec.toHeight} from block ${rec.fromHeight} (${rec.blocks} block(s)${rec.asOf !== null ? `, as_of ${rec.asOf}` : ''}), job ${rec.jobId ?? '(not known yet)'}: ${this.stateWords(rec)}.`,
      ...notes.filter(Boolean),
      HOLDS_HEAD.has(rec.state) ? 'The head is reserved for this ride: no hop or other ride signs from it meanwhile.' : 'The head is not reserved while the ride waits on a decision.',
      showInvoice ? `Invoice (${satsOf(inv!.amountMsats)} sats), NOT yet delivered to your operator: ${inv!.bolt11}` : '',
      next[rec.state],
      'Nothing was signed. HOSAKA\'s compute is not counted against your caps; you never pay anything yourself.',
    ].filter(Boolean).join('\n')
    return { text, data: { done: false, inFlight: true, state: this.rideState()!.state, ride: this.data(rec), notes } }
  }
}
