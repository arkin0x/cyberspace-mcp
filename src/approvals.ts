// approvals.ts: the operator approves each payment first (arkinox,
// 2026-11-23: "the current limits are fine, but I would want to know when
// any spend happens, and I'd want xor to ask before spending every time").
//
// With paymentApproval "operator", a payment the wallet would make (within
// maxPaymentSats and maxDailySats, which still apply) is held as a request:
// the server, never a model, DMs the operator what it is for, the amount,
// who is paid and what is left of the day, with a short code. It is paid
// only when the operator's own DM (sealed by their key, checked by the
// operator channel) names that code; "no <code>" refuses it. A request
// expires after APPROVAL_TTL_MS with nothing paid. One approval is one
// payment of exactly that amount and payment hash, used once: there is no
// "approve all", and an approval already used, expired or refused is
// ignored. The code is never in a tool's answer, so a model cannot hand it
// on; it reaches only the operator, by DM.
//
// <state>/approvals.json keeps the requests (mode 600), so a restart waits
// on the same request instead of asking twice.

import { randomInt } from 'node:crypto'
import type { StateDir } from './state/dir.js'

export type PaymentApproval = 'none' | 'operator'

/** How long the operator has to answer a request. */
export const APPROVAL_TTL_MS = 30 * 60_000
/** How many requests are kept, newest last; settled ones older than a week go first. */
const KEPT = 200
const KEPT_MS = 7 * 24 * 60 * 60_000
const FILE = 'approvals.json'
/** No 0/O, 1/I/L: read aloud or typed on a phone without mistakes. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

export type ApprovalState = 'pending' | 'approved' | 'refused' | 'used' | 'expired'

export interface ApprovalRequest {
  /** The request's id: the code operators type, e.g. PAY-7KQ2XM. */
  code: string
  /** What is paid: HOSAKA's deposit id, and the invoice's own payment hash and amount. */
  depositId: string
  paymentHash: string
  sats: number
  /** What the payment is for and who is paid, as the DM said it. */
  purpose: string
  payee: string
  createdAt: number
  expiresAt: number
  state: ApprovalState
  /** When the operator's answer came, and the id of the DM that carried it. */
  answeredAt?: number
  answerId?: string
}

interface ApprovalsFile { version: 1; requests: ApprovalRequest[] }

/** What the payer is told about a deposit: whether it may be paid now. */
export type ApprovalVerdict =
  | { state: 'none' }
  | { state: 'pending'; request: ApprovalRequest }
  | { state: 'approved'; request: ApprovalRequest }
  | { state: 'refused' | 'expired' | 'used' | 'mismatch'; request: ApprovalRequest; reason: string }

export class Approvals {
  private requests: ApprovalRequest[]

  constructor(
    private readonly dir: StateDir,
    readonly mode: PaymentApproval,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = APPROVAL_TTL_MS,
  ) {
    const saved = dir.readJson<ApprovalsFile | null>(FILE, null)
    this.requests = saved?.version === 1 && Array.isArray(saved.requests) ? saved.requests : []
  }

  /** Whether every payment waits for the operator's approval. */
  get required(): boolean {
    return this.mode === 'operator'
  }

  private save(): void {
    const cutoff = this.now() - KEPT_MS
    this.requests = this.requests.filter((r) => r.state === 'pending' || r.state === 'approved' || r.createdAt >= cutoff).slice(-KEPT)
    this.dir.writeJson(FILE, { version: 1, requests: this.requests } satisfies ApprovalsFile)
  }

  /** Mark lapsed requests expired. Returns whether anything changed. */
  private expire(): boolean {
    const t = this.now()
    let changed = false
    for (const r of this.requests) {
      if ((r.state === 'pending' || r.state === 'approved') && t >= r.expiresAt) { r.state = 'expired'; changed = true }
    }
    if (changed) this.save()
    return changed
  }

  /** The newest request for a deposit, judged against the amount and payment hash about to be paid. */
  verdict(depositId: string, sats: number, paymentHash: string): ApprovalVerdict {
    this.expire()
    const r = [...this.requests].reverse().find((q) => q.depositId === depositId)
    if (!r) return { state: 'none' }
    if (r.state === 'pending') return { state: 'pending', request: r }
    if (r.state === 'expired') return { state: 'expired', request: r, reason: `your operator did not answer approval request ${r.code} within ${Math.round(this.ttlMs / 60_000)} minutes, so nothing was paid` }
    if (r.state === 'refused') return { state: 'refused', request: r, reason: `your operator refused approval request ${r.code}, so nothing was paid` }
    if (r.state === 'used') return { state: 'used', request: r, reason: `approval ${r.code} was already used for one payment; an approval is never used twice` }
    if (r.sats !== sats || r.paymentHash !== paymentHash.toLowerCase()) {
      return { state: 'mismatch', request: r, reason: `approval ${r.code} was for ${r.sats} sats and another invoice; this one is not what your operator approved, so nothing was paid` }
    }
    return { state: 'approved', request: r }
  }

  /** Hold a payment as a request with a fresh code. The caller DMs the operator the words requestWords gives. */
  request(input: { depositId: string; paymentHash: string; sats: number; purpose: string; payee: string }): ApprovalRequest {
    const used = new Set(this.requests.map((r) => r.code))
    let code: string
    do {
      code = 'PAY-' + Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
    } while (used.has(code))
    const t = this.now()
    const r: ApprovalRequest = { code, depositId: input.depositId, paymentHash: input.paymentHash.toLowerCase(), sats: input.sats, purpose: input.purpose, payee: input.payee, createdAt: t, expiresAt: t + this.ttlMs, state: 'pending' }
    this.requests.push(r)
    this.save()
    return r
  }

  /** Spend an approval on the one payment it covers, before the payment goes out. False when it is not (or no longer) an approval for exactly this. */
  use(code: string, sats: number, paymentHash: string): boolean {
    this.expire()
    const r = this.requests.find((q) => q.code === code)
    if (!r || r.state !== 'approved' || r.sats !== sats || r.paymentHash !== paymentHash.toLowerCase()) return false
    r.state = 'used'
    this.save()
    return true
  }

  /**
   * A DM from the operator (the caller has checked the seal: it is theirs,
   * to this agent). When it names a pending request's code it answers that
   * request: approved, or refused when it says no. Returns the request it
   * answered, or null when it names none (then it is an ordinary message).
   * The DM must be newer than the request it answers: an old message cannot
   * approve a new request.
   */
  answer(text: string, createdAtSeconds: number, messageId: string): ApprovalRequest | null {
    if (!this.required) return null
    this.expire()
    const upper = text.toUpperCase()
    const r = this.requests.find((q) => q.state === 'pending' && new RegExp(`(^|[^A-Z0-9-])${q.code}($|[^A-Z0-9])`).test(upper))
    if (!r) return null
    if (createdAtSeconds * 1000 < r.createdAt - 60_000) return null
    const refused = /(^|[^A-Z])(NO|DENY|DENIED|REFUSE|CANCEL|DON'?T|STOP)([^A-Z]|$)/.test(upper)
    r.state = refused ? 'refused' : 'approved'
    r.answeredAt = this.now()
    r.answerId = messageId
    this.save()
    return r
  }

  /** Requests still waiting on the operator, for the wallet tool (never with the code). */
  pending(): Array<Omit<ApprovalRequest, 'code' | 'answerId'>> {
    this.expire()
    return this.requests.filter((r) => r.state === 'pending').map(({ code: _c, answerId: _a, ...rest }) => rest)
  }
}

/** The DM that asks the operator to approve one payment. */
export function requestWords(r: ApprovalRequest, day: { spentSats: number; maxDailySats: number; maxPaymentSats: number }): string {
  const minutes = Math.round((r.expiresAt - r.createdAt) / 60_000)
  return [
    `May I pay ${r.sats} sats? ${r.purpose}`,
    `Paid to: ${r.payee}.`,
    `Today so far: ${day.spentSats} of ${day.maxDailySats} sats spent; after this, ${Math.max(0, day.maxDailySats - day.spentSats - r.sats)} left. One payment may be at most ${day.maxPaymentSats} sats.`,
    `To approve, reply with the code ${r.code}. To refuse, reply "no ${r.code}". It expires in ${minutes} minutes; if you do not answer, nothing is paid.`,
  ].join('\n')
}
