// wallet.ts: the agent's wallet, as far as the agent has one (arkinox,
// 2026-10-11: "yes, build in hosaka and whatever nwc tools the agent
// needs"). The human connects a Nostr Wallet Connect wallet (nwc.ts) and
// sets two limits; the server then pays HOSAKA invoices for rides it bought
// itself, within those limits, and nothing else, ever.
//
// What the model can and cannot do with it:
//
//   - It can ask `wallet`: connected or not, the balance when the wallet
//     tells, what was spent in the last 24 hours, the limits. Read only.
//   - It cannot pay. No tool takes an invoice, an amount or a destination.
//     pay() is called by hosakaRide.ts alone, with the invoice HOSAKA's API
//     answered this server's own submit with, for the job that submit made.
//     An invoice in a DM, a chat line, a hidden message or a tool argument
//     never reaches here.
//   - It cannot change the limits or the connection: both come from the
//     human's configuration (config.ts), never from a tool.
//
// What keeps a payment from happening twice: the attempt is written to
// payments.json, state "sending", before pay_invoice goes out; an attempt
// already recorded for the invoice, or a paid or unknown one for the same
// ride, refuses another; a crash mid-payment leaves "sending", read back as
// "unknown", which is never retried and counts against the daily limit as
// if paid. Only an answer that says no money moved (the wallet's own
// PAYMENT_FAILED and the like, or every relay refusing the request) is
// "failed", and even then that invoice is not tried again.
//
// The limits are on the invoice's own amount (bolt11.ts), not on what any
// JSON beside it says. maxPaymentSats bounds one payment; maxDailySats
// bounds the sum of the last 24 hours (rolling), routing fees included once
// the wallet reports them. Either at 0 turns paying off.

import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync } from 'node:fs'
import { Approvals, type PaymentApproval } from './approvals.js'
import { decodeBolt11, type Bolt11 } from './bolt11.js'
import { NwcClient, NwcError, NwcNotSent, parseNwc, type NwcInfo, type Secret } from './nwc.js'
import type { StateDir } from './state/dir.js'
import type { ToolResult } from './tool.js'

export const DEFAULT_MAX_PAYMENT_SATS = 2000
export const DEFAULT_MAX_DAILY_SATS = 5000

const LEDGER_FILE = 'payments.json'
/** One line per payment's outcome, for the human: no invoice, no preimage. */
export const PAYMENTS_LOG = 'payments.log'
const DAY_MS = 24 * 60 * 60 * 1000
/** An invoice this close to its expiry is not paid: the payment could land after it and be lost in flight. */
const EXPIRY_MARGIN_S = 60

/**
 * Wallet error codes that say the payment did not happen (NIP-47). Any
 * other code, or none, leaves the outcome unknown.
 */
const DEFINITE_FAILURES = new Set(['PAYMENT_FAILED', 'INSUFFICIENT_BALANCE', 'QUOTA_EXCEEDED', 'RESTRICTED', 'UNAUTHORIZED', 'NOT_IMPLEMENTED', 'RATE_LIMITED', 'NOT_FOUND'])

export type PaymentState = 'sending' | 'paid' | 'failed' | 'unknown'

/** One attempt to pay one HOSAKA invoice, as payments.json keeps it. No invoice string, no preimage. */
export interface PaymentRecord {
  /** HOSAKA's deposit id for the invoice. */
  depositId: string
  /** The ride's idempotency key: one ride is paid for at most once. */
  rideKey: string
  apiUrl: string
  jobId: string | null
  toHeight: number
  paymentHash: string
  sats: number
  feesSats: number | null
  /** sha256 of the preimage the wallet returned; equal to paymentHash when the payment is proven. */
  preimageHash: string | null
  state: PaymentState
  /** When the attempt started (ms since the epoch). */
  at: number
  error: string | null
}

interface Ledger {
  version: 1
  payments: PaymentRecord[]
}

export interface WalletOptions {
  /** The connection string, or null when the human gave none. */
  nwc: Secret | null
  /** Where it came from, for error sentences (never the string itself). */
  source: string
  maxPaymentSats: number
  maxDailySats: number
  websocketImplementation?: unknown
  maxWaitMs?: number
  log?: (line: string) => void
  /** Called before every request to the wallet goes out (the state directory's lock, lock.ts). */
  beforePublish?: () => void
  /** Tests: the clock, in ms. */
  now?: () => number
  /** Tests: how long a pay_invoice answer is waited for. */
  payTimeoutMs?: number
  /** "operator": every payment needs the operator's approval first (approvals.ts). Default "none". */
  paymentApproval?: PaymentApproval
  /** Tests: how long an approval request waits for the operator. */
  approvalTtlMs?: number
  /** Why paying is switched off right now (a copy below the update notice's min_safe, updates.ts), or null. */
  refuse?: () => string | null
}

/** What the server may do with one invoice: pay it, or say why not. */
export type PayDecision = { pay: true; invoice: Bolt11; sats: number } | { pay: false; reason: string; invoice: Bolt11 | null }

export interface PayContext {
  depositId: string
  rideKey: string
  apiUrl: string
  jobId: string | null
  toHeight: number
  /** What HOSAKA says the invoice is for, in millisats; the invoice must agree. */
  expectedMsats: number
  /** The payment hash HOSAKA reported, when it did; the invoice must agree. */
  expectedHash: string | null
  /** With paymentApproval "operator": the code of the operator's approval for exactly this payment. Spent by pay(), once. */
  approvalCode?: string
  /** What the payment is for, in words, for the payments log. */
  purpose?: string
}

export type PayOutcome =
  | { state: 'paid'; record: PaymentRecord }
  | { state: 'failed'; record: PaymentRecord; reason: string }
  | { state: 'unknown'; record: PaymentRecord; reason: string }

function sha256Hex(hex: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null
  return createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex')
}

export class Wallet {
  readonly maxPaymentSats: number
  readonly maxDailySats: number
  private readonly client: NwcClient | null
  private readonly now: () => number
  private readonly payTimeoutMs: number | undefined
  private readonly refuse: () => string | null
  private ledger: Ledger
  private info: NwcInfo | null = null
  /** The operator's approvals, payment by payment (approvals.ts). */
  readonly approvals: Approvals
  private readonly pendingLog: PaymentRecord[] = []

  constructor(private readonly dir: StateDir, opts: WalletOptions) {
    this.maxPaymentSats = opts.maxPaymentSats
    this.maxDailySats = opts.maxDailySats
    this.now = opts.now ?? Date.now
    this.payTimeoutMs = opts.payTimeoutMs
    this.approvals = new Approvals(dir, opts.paymentApproval ?? 'none', this.now, opts.approvalTtlMs)
    this.refuse = opts.refuse ?? (() => null)
    this.client = opts.nwc ? new NwcClient(parseNwc(opts.nwc, opts.source), { websocketImplementation: opts.websocketImplementation, maxWaitMs: opts.maxWaitMs, log: opts.log, beforePublish: opts.beforePublish }) : null
    const saved = dir.readJson<Ledger | null>(LEDGER_FILE, null)
    this.ledger = saved?.version === 1 && Array.isArray(saved.payments) ? saved : { version: 1, payments: [] }
    // A payment that was going out when the process stopped may have gone out: unknown, never retried, counted.
    let changed = false
    for (const p of this.ledger.payments) {
      if (p.state === 'sending') {
        p.state = 'unknown'
        p.error = 'the server stopped while this payment was going out; whether it was paid is unknown'
        changed = true
        this.pendingLog.push(p)
      }
    }
    if (changed) this.save()
    // Each payment's outcome has its line, the one a restart decided included.
    for (const p of this.pendingLog.splice(0)) this.logSpend(p, { depositId: p.depositId, rideKey: p.rideKey, apiUrl: p.apiUrl, jobId: p.jobId, toHeight: p.toHeight, expectedMsats: p.sats * 1000, expectedHash: p.paymentHash })
  }

  /** Whether the human connected a wallet. */
  get connected(): boolean {
    return this.client !== null
  }

  private save(): void {
    this.dir.writeJson(LEDGER_FILE, this.ledger)
  }

  /** Sats spent, or possibly spent, in the rolling 24 hours: paid, unknown and in flight, with their fees. */
  spentLast24hSats(): number {
    const since = this.now() - DAY_MS
    return this.ledger.payments
      .filter((p) => p.at > since && p.state !== 'failed')
      .reduce((sum, p) => sum + p.sats + (p.feesSats ?? 0), 0)
  }

  /** The attempts recorded for a ride, oldest first. */
  attemptsFor(rideKey: string): PaymentRecord[] {
    return this.ledger.payments.filter((p) => p.rideKey === rideKey)
  }

  /** The attempt recorded for one invoice, if any. */
  attemptFor(depositId: string): PaymentRecord | undefined {
    return this.ledger.payments.find((p) => p.depositId === depositId)
  }

  /**
   * Whether the server may pay this invoice by itself, by the human's
   * limits and by what is already recorded. Pure: nothing is sent.
   */
  decide(bolt11: string, ctx: PayContext): PayDecision {
    let invoice: Bolt11
    try {
      invoice = decodeBolt11(bolt11)
    } catch (err) {
      return { pay: false, reason: `the invoice could not be read (${err instanceof Error ? err.message : String(err)})`, invoice: null }
    }
    const sats = Math.ceil(invoice.msats / 1000)
    const no = (reason: string): PayDecision => ({ pay: false, reason, invoice })
    if (!this.client) return no('no wallet is connected to this server')
    if (this.maxPaymentSats <= 0 || this.maxDailySats <= 0) return no('your operator set a limit of 0, which turns paying off')
    const off = this.refuse()
    if (off) return no(off)
    const earlier = this.attemptFor(ctx.depositId) ?? this.ledger.payments.find((p) => p.paymentHash === invoice.paymentHash)
    if (earlier) return no(`a payment of this invoice was already attempted (${earlier.state}), and an invoice is never paid twice`)
    const ride = this.attemptsFor(ctx.rideKey).find((p) => p.state !== 'failed')
    if (ride) return no(`a payment for this same ride is already recorded (${ride.sats} sats, ${ride.state}), and a ride is paid for at most once by this server`)
    if (invoice.msats !== ctx.expectedMsats) return no(`the invoice's own amount (${invoice.msats} msats) is not the ${ctx.expectedMsats} msats HOSAKA says it is for`)
    if (ctx.expectedHash && ctx.expectedHash.toLowerCase() !== invoice.paymentHash) return no('the invoice\'s payment hash is not the one HOSAKA reported for it')
    if (invoice.expiresAt - EXPIRY_MARGIN_S <= this.now() / 1000) return no('the invoice expires within a minute or has expired')
    if (sats > this.maxPaymentSats) return no(`${sats} sats is above the limit of ${this.maxPaymentSats} sats for one payment`)
    const spent = this.spentLast24hSats()
    if (spent + sats > this.maxDailySats) return no(`${sats} sats would bring the last 24 hours to ${spent + sats} sats, above the daily limit of ${this.maxDailySats} sats (${spent} spent)`)
    return { pay: true, invoice, sats }
  }

  /**
   * Pay one invoice that decide() allowed. The attempt is on disk before
   * the request goes out. Never throws for the payment itself: the outcome
   * says paid, failed (no money moved) or unknown.
   */
  async pay(bolt11: string, ctx: PayContext): Promise<PayOutcome> {
    const decision = this.decide(bolt11, ctx)
    if (!decision.pay) throw new Error(`not paid: ${decision.reason}`)
    // The operator's approval is checked here, at the last step before money moves, whatever the caller did: one approval, this amount, this invoice, once.
    if (this.approvals.required && (!ctx.approvalCode || !this.approvals.use(ctx.approvalCode, decision.sats, decision.invoice.paymentHash))) {
      throw new Error('not paid: your operator has not approved this exact payment')
    }
    const record: PaymentRecord = {
      depositId: ctx.depositId, rideKey: ctx.rideKey, apiUrl: ctx.apiUrl, jobId: ctx.jobId, toHeight: ctx.toHeight,
      paymentHash: decision.invoice.paymentHash, sats: decision.sats, feesSats: null, preimageHash: null, state: 'sending', at: this.now(), error: null,
    }
    this.ledger.payments.push(record)
    this.save()
    try {
      const { preimage, feesPaidMsats } = await this.client!.payInvoice(bolt11, this.payTimeoutMs)
      record.feesSats = feesPaidMsats === null ? null : Math.ceil(feesPaidMsats / 1000)
      record.preimageHash = sha256Hex(preimage)
      if (record.preimageHash === record.paymentHash) {
        record.state = 'paid'
        this.save()
        this.logSpend(record, ctx)
        return { state: 'paid', record }
      }
      record.state = 'unknown'
      record.error = 'the wallet said it paid, but the preimage it returned does not match the invoice\'s payment hash'
      this.save()
      this.logSpend(record, ctx)
      return { state: 'unknown', record, reason: record.error }
    } catch (err) {
      const words = err instanceof Error ? err.message : String(err)
      const definite = err instanceof NwcNotSent || (err instanceof NwcError && DEFINITE_FAILURES.has(err.code))
      record.state = definite ? 'failed' : 'unknown'
      record.error = err instanceof NwcError ? `${err.code}: ${words}` : words
      this.save()
      this.logSpend(record, ctx)
      return definite ? { state: 'failed', record, reason: record.error } : { state: 'unknown', record, reason: record.error }
    }
  }

  /**
   * One line per payment's outcome in <state>/payments.log (mode 600): when,
   * how much, what for, the result and the day's total. No invoice, no
   * preimage, nothing that could be spent or replayed.
   */
  private logSpend(record: PaymentRecord, ctx: PayContext): void {
    try {
      this.dir.guard('write payments.log')
      const line = {
        at: new Date(record.at).toISOString(), state: record.state, sats: record.sats, feesSats: record.feesSats, purpose: ctx.purpose ?? `HOSAKA ride to block ${ctx.toHeight}`,
        payee: ctx.apiUrl, jobId: ctx.jobId, depositId: record.depositId, paymentHash: record.paymentHash, approval: ctx.approvalCode ?? null, error: record.error,
        spentLast24hSats: this.spentLast24hSats(), maxDailySats: this.maxDailySats,
      }
      appendFileSync(this.dir.file(PAYMENTS_LOG), JSON.stringify(line) + '\n', { mode: 0o600 })
      // The mode is set only when the file is made: a file that was already there is held to 600 too.
      chmodSync(this.dir.file(PAYMENTS_LOG), 0o600)
    } catch { /* the ledger has it; a log that cannot be written never undoes a payment */ }
  }

  /** The wallet tool: connected or not, the balance when the wallet tells, today's spend, the limits. Never the connection string. */
  async status(): Promise<ToolResult> {
    const spent = this.spentLast24hSats()
    const limits = { maxPaymentSats: this.maxPaymentSats, maxDailySats: this.maxDailySats }
    const recent = this.ledger.payments.slice(-5).map((p) => ({ jobId: p.jobId, toHeight: p.toHeight, sats: p.sats, feesSats: p.feesSats, state: p.state, at: new Date(p.at).toISOString(), paymentHash: p.paymentHash, error: p.error }))
    const approval = this.approvals.required
      ? ' Your operator approves every payment first: the server holds each one and DMs them a code; it pays only when they answer with it, within 30 minutes, and tells them after. You cannot approve anything, and you never see the code.'
      : ''
    const rules = `You never pay anything yourself: no tool takes an invoice. The server pays only HOSAKA invoices for rides it bought for you (ride with prover: "hosaka"), within these limits; above them, or if a payment fails, the invoice goes to your operator by DM.${approval} Only your operator can connect a wallet or change the limits.`
    const approvalData = { paymentApproval: this.approvals.mode, awaitingApproval: this.approvals.pending() }
    if (!this.client) {
      return {
        text: `No wallet is connected. A HOSAKA ride's invoice goes to your operator by DM for them to pay. Your operator can connect a Nostr Wallet Connect wallet in the server's configuration (wallet.json in the state directory), with limits per payment and per day. ${rules}`,
        data: { connected: false, reachable: null, balanceSats: null, spentLast24hSats: spent, remainingTodaySats: Math.max(0, this.maxDailySats - spent), limits, payments: recent, ...approvalData },
      }
    }
    let reachable = true
    let problem: string | null = null
    let balanceSats: number | null = null
    let canPay = false
    try {
      this.info = await this.client.getInfo()
      canPay = this.info.methods.includes('pay_invoice')
      if (this.info.methods.includes('get_balance')) balanceSats = Math.floor((await this.client.getBalanceMsats()) / 1000)
    } catch (err) {
      reachable = this.info !== null
      problem = err instanceof Error ? err.message : String(err)
    }
    const text = [
      `A Nostr Wallet Connect wallet is connected${reachable ? '' : ', but it could not be reached just now'}.${problem ? ` (${problem})` : ''}`,
      balanceSats !== null ? `Balance: ${balanceSats} sats.` : reachable ? 'The wallet does not report its balance.' : '',
      reachable && !canPay ? 'The wallet does not offer pay_invoice, so nothing can be paid from it.' : '',
      this.refuse() ? `Paying is switched off: ${this.refuse()}.` : '',
      `Spent in the last 24 hours: ${spent} of ${this.maxDailySats} sats; one payment may be at most ${this.maxPaymentSats} sats.`,
      rules,
    ].filter(Boolean).join(' ')
    return {
      text,
      data: { connected: true, reachable, canPay, paymentsOff: this.refuse(), encryption: this.info?.encryption ?? null, balanceSats, spentLast24hSats: spent, remainingTodaySats: Math.max(0, this.maxDailySats - spent), limits, payments: recent, problem, ...approvalData },
    }
  }

  stop(): void {
    this.client?.close()
  }
}
