// hosaka.ts: the HOSAKA cloud-compute API, the part of it a ride needs, as
// this server speaks it. Ported from ONOSENDAI src/lib/hosaka.ts (branch v2
// at 6f29bc9): the error shape and its transient and answerLost readings,
// the NIP-98 authorization with a nonce tag per request, the request timeout,
// the bigint-free JSON, the poll token for reading a job without signing,
// the deposit claim, /start, and the idempotency key on every priced submit,
// a pure function of what the submit asks for, so every attempt at one job
// names the same job and a provider that honors keys answers a retry with
// the job it already made instead of charging twice.
//
// What is not ported: quotes, limits, hops, sidesteps, region keys, deposits
// bought on their own, the balance, and the waiting loops. The agent polls
// through its own tool calls (transit.ts), never in the background, and the
// lost-answer retry is the next tool call, with the key persisted in the
// state directory, instead of a timer.
//
// THE RIDE JOB IS A PROPOSED CONTRACT. hosaka-api has no ride route yet
// (onosendai-launch #35, phases P2 to P4). This file speaks the shape the
// existing jobs have, with the fields a ride needs, so the server side can be
// built to it:
//
//   - GET /api/v1/provider lists {"type": "ride", "max_blocks": <n>} among
//     its services when it sells rides, and `idempotency` when it honors
//     keys. Without both, nothing is submitted.
//   - POST /api/v1/ride, NIP-98 signed, body {previous_event_id, from_height,
//     to_height, idempotency_key}, answers as /api/v1/sidestep does: the job,
//     its poll token, and either balance_debited or payment_required with a
//     deposit (deposit_id, bolt11, amount_msats, expires_at).
//   - A completed ride job's result is {root, mp, mn, previous_event_id,
//     from_height, to_height}: the hyperjump's proof, mp and mn tags.
//
// Money never touches this file. HOSAKA issues the invoice, the operator's
// wallet pays it, and the node's own answer is the payment: the agent only
// sends the invoice on and asks whether it settled.

import { createHash } from 'node:crypto'
import * as nip98 from 'nostr-tools/nip98'
import { bytesToHex, type EventTemplate, type NostrEvent } from './nostr/event.js'

/** The production API, the same one ONOSENDAI uses (VITE_HOSAKA_URL there, --hosaka-url here). */
export const HOSAKA_DEFAULT_URL = 'https://arkin0x--hosaka-api-api-server.modal.run'

/** One request outstanding longer than this is a dead connection, not a slow one. */
const REQUEST_TIMEOUT_MS = 20_000

/** GET /api/v1/provider: how the provider presents itself and what it sells. */
export interface HosakaProvider {
  version?: number
  name?: string
  services?: Array<{ type: string; max_height?: number; max_blocks?: number; min_msats?: number }>
  payments?: { invoice_ttl_seconds?: number }
  /** Present on a provider that honors idempotency keys on priced submits (hosaka-api #21). */
  idempotency?: { header?: string; body_field?: string; retention_seconds?: number; scope?: string }
}

export type HosakaDepositStatus = 'pending' | 'settled' | 'expired'

/** An invoice HOSAKA's own node issued for the agent's pubkey. */
export interface HosakaDeposit {
  deposit_id: string
  status: HosakaDepositStatus
  amount_msats: number
  bolt11: string
  payment_hash?: string
  /** Seconds since the epoch. */
  created_at?: number
  expires_at: number
  settled_at?: number | null
}

export type HosakaJobStatus = 'pending' | 'computing' | 'completed' | 'failed'

/** `result` of a completed ride job (proposed): the hyperjump's proof, mp and mn tags, and what it was computed for. */
export interface CloudRideResult {
  root: string
  mp: string
  mn: string
  previous_event_id: string
  from_height: number
  to_height: number
}

/** A job as the API returns it: the row, plus the payment fields a submit or a start adds. */
export interface HosakaJob {
  id: string
  status: HosakaJobStatus
  job_type?: string
  cost_msats?: number
  /** Shown in the creation response and in a replay of it. */
  poll_token?: string
  result: unknown
  error: string | null
  payment_required?: boolean
  amount_due_msats?: number
  balance_debited?: boolean
  deposit?: HosakaDeposit
  next?: string
  /** The submit's idempotency key, echoed by a provider that honors it. */
  idempotency_key?: string
  /** True when this answer is the job an earlier attempt with the same key made. */
  idempotent_replay?: boolean
}

/**
 * What the API said no to, or what stopped the request. `code` is the
 * server's machine-readable `error` when it sent one, `network` when the
 * request never got an answer.
 */
export class HosakaError extends Error {
  readonly status: number
  readonly code: string | null
  readonly detail: unknown

  constructor(status: number, code: string | null, message: string, detail?: unknown) {
    super(message)
    this.name = 'HosakaError'
    this.status = status
    this.code = code
    this.detail = detail
  }

  static fromResponse(status: number, body: unknown): HosakaError {
    const detail = body !== null && typeof body === 'object' && 'detail' in body ? (body as { detail: unknown }).detail : body
    let code: string | null = null
    let message = `HOSAKA answered ${status}`
    if (typeof detail === 'string') {
      message = detail
    } else if (detail !== null && typeof detail === 'object' && !Array.isArray(detail)) {
      const d = detail as Record<string, unknown>
      if (typeof d.error === 'string') code = d.error
      const text = typeof d.hint === 'string' ? d.hint : typeof d.message === 'string' ? d.message : null
      message = [code, text].filter((s): s is string => !!s).join(': ') || message
    }
    return new HosakaError(status, code, message, detail)
  }

  /**
   * The request went out and its outcome is unknown: the connection dropped
   * or timed out, or the server failed while answering. A priced submit with
   * a lost answer may have made its job; asking again is safe only with the
   * same idempotency key.
   */
  get answerLost(): boolean {
    return (this.status === 0 && this.code === 'network') || this.status >= 500
  }
}

/** JSON with object keys sorted at every level: the same value, the same text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** The body of a ride submit, before its key is added: the chain head the leaves are seeded by and the blocks passed. */
export function rideBody(previousEventId: string, fromHeight: number, toHeight: number): Record<string, unknown> {
  return { previous_event_id: previousEventId, from_height: fromHeight, to_height: toHeight }
}

/**
 * The idempotency key of one ride: a hash of what the proof is (the head
 * and the two blocks), so the same ride from the same head is always the
 * same key. It survives a restart, a lost answer, a canceled ride asked for
 * again, and a failed job started again (HOSAKA lets a failed key start a
 * new job, paid from the refund it left in the balance). A ride from another
 * head is another key, which is right: its leaves are other leaves.
 */
export function rideIdempotencyKey(previousEventId: string, fromHeight: number, toHeight: number): string {
  const digest = createHash('sha256').update(`cyberspace-mcp/1\nride\n${canonicalJson(rideBody(previousEventId, fromHeight, toHeight))}`).digest('hex')
  return `cyberspace-mcp-${digest}`
}

/** Whether the provider says it sells rides, and the most blocks one may pass when it says. */
export function rideService(p: HosakaProvider): { maxBlocks: number | null } | null {
  const s = p.services?.find((x) => x?.type === 'ride')
  if (!s) return null
  return { maxBlocks: typeof s.max_blocks === 'number' && s.max_blocks > 0 ? s.max_blocks : null }
}

/** Whether the provider says it honors idempotency keys. */
export function honorsKeys(p: HosakaProvider): boolean {
  return typeof p.idempotency === 'object' && p.idempotency !== null
}

/** A completed job's result as a ride proof, or the reason it is not one. */
export function rideResultOf(job: HosakaJob): CloudRideResult | string {
  const r = job.result as Partial<CloudRideResult> | null
  if (!r || typeof r !== 'object') return 'the job carries no result'
  if (typeof r.root !== 'string' || typeof r.mp !== 'string' || typeof r.mn !== 'string') return 'the result has no root, mp and mn'
  if (typeof r.previous_event_id !== 'string' || typeof r.from_height !== 'number' || typeof r.to_height !== 'number') return 'the result does not say which ride it proves'
  return r as CloudRideResult
}

export interface HosakaClientOptions {
  apiUrl: string
  /** Signs the kind 27235 auth event with the agent's key. */
  sign: (template: EventTemplate) => NostrEvent
  /** Tests inject one. */
  fetch?: typeof globalThis.fetch
}

export interface HosakaClient {
  readonly apiUrl: string
  provider: () => Promise<HosakaProvider>
  /** A priced submit; the key goes in the body, as ONOSENDAI sends it. */
  submitRide: (previousEventId: string, fromHeight: number, toHeight: number, key: string) => Promise<HosakaJob>
  /** Reads with the poll token; no signature. */
  getJob: (jobId: string, pollToken: string) => Promise<HosakaJob>
  /** Charges and enqueues a pending job once its invoice is paid; answers with a fresh invoice when the old one cannot be paid any more. */
  startJob: (jobId: string) => Promise<HosakaJob>
  /** Asks HOSAKA's node whether the invoice settled, and credits it when it did. */
  claimDeposit: (depositId: string) => Promise<HosakaDeposit>
}

function randomNonce(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

export function createHosaka(opts: HosakaClientOptions): HosakaClient {
  const apiUrl = opts.apiUrl.replace(/\/+$/, '')
  const doFetch: typeof globalThis.fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))

  /**
   * A fresh kind 27235 event per request. HOSAKA remembers every event id it
   * accepted for the freshness window, so a token is never sent twice; the
   * nonce tag makes two requests signed in the same second distinct events.
   */
  const authorization = (url: string, method: string): Promise<string> =>
    nip98.getToken(url, method, (template) => opts.sign({ ...template, tags: [...template.tags, ['nonce', randomNonce()]] }), true)

  const request = async <T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown; auth?: boolean; headers?: Record<string, string> }): Promise<T> => {
    const url = apiUrl + path
    const headers: Record<string, string> = { accept: 'application/json', ...(init.headers ?? {}) }
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    if (init.auth) headers.authorization = await authorization(url, init.method)
    let res: Response
    try {
      res = await doFetch(url, { method: init.method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (err) {
      throw new HosakaError(0, 'network', err instanceof Error ? err.message : String(err))
    }
    let text: string
    try {
      text = await res.text()
    } catch (err) {
      throw new HosakaError(0, 'network', err instanceof Error ? err.message : String(err))
    }
    let data: unknown = null
    if (text) {
      try { data = JSON.parse(text) } catch { data = text }
    }
    if (!res.ok) throw HosakaError.fromResponse(res.status, data)
    return data as T
  }

  return {
    apiUrl,
    provider: () => request<HosakaProvider>('/api/v1/provider', { method: 'GET' }),
    submitRide: (previousEventId, fromHeight, toHeight, key) =>
      request<HosakaJob>('/api/v1/ride', { method: 'POST', auth: true, body: { ...rideBody(previousEventId, fromHeight, toHeight), idempotency_key: key } }),
    getJob: (jobId, pollToken) => request<HosakaJob>(`/api/v1/jobs/${encodeURIComponent(jobId)}`, { method: 'GET', headers: { 'X-Job-Token': pollToken } }),
    startJob: (jobId) => request<HosakaJob>(`/api/v1/jobs/${encodeURIComponent(jobId)}/start`, { method: 'POST', auth: true }),
    claimDeposit: (depositId) => request<HosakaDeposit>(`/api/v1/deposit/${encodeURIComponent(depositId)}/claim`, { method: 'POST', auth: true }),
  }
}
