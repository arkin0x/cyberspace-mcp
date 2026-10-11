// nwc.ts: Nostr Wallet Connect (NIP-47), the client side, as this server
// speaks it (arkinox, 2026-10-11: "yes, build in hosaka and whatever nwc
// tools the agent needs"). The human gives the server a connection string
// (nostr+walletconnect://<wallet service pubkey>?relay=...&secret=...); the
// server uses it for two requests only, get_info by the info event,
// get_balance and pay_invoice, over the relays the string names, signed with
// the string's own secret, never the agent's key.
//
// The connection string is a spending key. It lives in a Secret, which
// prints, logs and serializes as "[redacted]" whatever is done with it, so a
// stray template string, JSON.stringify or console.log cannot leak it; only
// parseNwc reads it, and every error here describes what is wrong without
// quoting it. Nothing in this file is reachable from a tool's input: the
// model never names a method, an invoice or an amount (wallet.ts decides
// what is paid).
//
// Encryption follows the wallet's info event (kind 13194): NIP-44 v2 when
// its encryption tag lists nip44_v2, else NIP-04, which is what an info
// event without the tag means. A wallet with no info event on its relays is
// not used at all, because what it supports is unknown.

import { inspect } from 'node:util'
import type { Filter } from 'nostr-tools/filter'
import * as nip04 from 'nostr-tools/nip04'
import { v2 as nip44 } from 'nostr-tools/nip44'
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { normalizeURL } from 'nostr-tools/utils'
import { HEX_64, hexToBytes, nowSeconds, type NostrEvent } from './nostr/event.js'
import { REFUSED, Relays } from './nostr/relays.js'

/** A value that never prints: a connection string, kept out of every log line, tool result and event. */
export class Secret {
  readonly #value: string
  constructor(value: string) {
    this.#value = value
  }
  /** The value, for the one parser that needs it. */
  reveal(): string {
    return this.#value
  }
  toString(): string {
    return '[redacted]'
  }
  toJSON(): string {
    return '[redacted]'
  }
  [inspect.custom](): string {
    return '[redacted]'
  }
}

export const NWC_INFO_KIND = 13194
export const NWC_REQUEST_KIND = 23194
export const NWC_RESPONSE_KIND = 23195

export interface NwcConnection {
  walletPubkey: string
  relays: string[]
  /** The client key the string carries; signs requests and decrypts answers. */
  clientSecret: Uint8Array
  clientPubkey: string
}

/**
 * Read a connection string, or throw a sentence that names what is wrong
 * with it and never quotes it (`where` says where it came from).
 */
export function parseNwc(secret: Secret, where: string): NwcConnection {
  const raw = secret.reveal().trim()
  const m = /^nostr\+walletconnect:\/\/([^?/#]*)\/?\?(.*)$/i.exec(raw)
  if (!m) throw new Error(`The wallet connection string in ${where} is not a nostr+walletconnect:// URI with parameters.`)
  const walletPubkey = m[1].toLowerCase()
  if (!HEX_64.test(walletPubkey)) throw new Error(`The wallet connection string in ${where} does not name the wallet service by a 64-character hex pubkey.`)
  const params = new URLSearchParams(m[2])
  const secretHex = (params.get('secret') ?? '').toLowerCase()
  if (!HEX_64.test(secretHex)) throw new Error(`The wallet connection string in ${where} carries no 64-character hex secret.`)
  const relays: string[] = []
  for (const r of params.getAll('relay')) {
    let u: URL
    try {
      u = new URL(r)
    } catch {
      throw new Error(`The wallet connection string in ${where} names a relay that is not a URL.`)
    }
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') throw new Error(`The wallet connection string in ${where} names a relay that is not ws:// or wss://.`)
    relays.push(normalizeURL(r))
  }
  if (relays.length === 0) throw new Error(`The wallet connection string in ${where} names no relay.`)
  const clientSecret = hexToBytes(secretHex)
  return { walletPubkey, relays: [...new Set(relays)], clientSecret, clientPubkey: getPublicKey(clientSecret) }
}

export type NwcEncryption = 'nip44_v2' | 'nip04'

export interface NwcInfo {
  methods: string[]
  encryption: NwcEncryption
}

/** A NIP-47 error the wallet answered with: its code and its message, verbatim. */
export class NwcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'NwcError'
  }
}

/**
 * A request whose outcome is not known: it may have reached the wallet,
 * and a payment may have been made. Never retried.
 */
export class NwcUnknownOutcome extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NwcUnknownOutcome'
  }
}

/** The request never left: every relay refused it outright, so the wallet cannot have seen it. */
export class NwcNotSent extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NwcNotSent'
  }
}

export interface NwcClientOptions {
  websocketImplementation?: unknown
  maxWaitMs?: number
  log?: (line: string) => void
}

/** How long a get_balance answer is waited for. */
const QUICK_REQUEST_MS = 15_000
/** How long a pay_invoice answer is waited for before its outcome is called unknown. */
export const PAY_REQUEST_MS = 60_000

export class NwcClient {
  private readonly relays: Relays
  private info: NwcInfo | null = null

  constructor(private readonly conn: NwcConnection, opts: NwcClientOptions = {}) {
    const sk = conn.clientSecret
    this.relays = new Relays({
      urls: conn.relays,
      // A wallet relay that asks for NIP-42 auth gets the connection's own key, never the agent's.
      signAuth: async (t) => finalizeEvent(t, sk),
      websocketImplementation: opts.websocketImplementation,
      maxWaitMs: opts.maxWaitMs,
      log: opts.log,
    })
  }

  /** The wallet's info event: what it supports and how it wants requests encrypted. Cached once read. */
  async getInfo(): Promise<NwcInfo> {
    if (this.info) return this.info
    const events = await this.relays.query({ kinds: [NWC_INFO_KIND], authors: [this.conn.walletPubkey], limit: 1 })
    const ev = events.filter((e) => e.pubkey === this.conn.walletPubkey && verifyEvent(e as Parameters<typeof verifyEvent>[0])).sort((a, b) => b.created_at - a.created_at)[0]
    if (!ev) throw new Error('The wallet service published no info event (kind 13194) on its relays, so what it supports is unknown; nothing was asked of it.')
    const methods = ev.content.split(/\s+/).filter(Boolean)
    const enc = (ev.tags.find((t) => t[0] === 'encryption')?.[1] ?? '').split(/\s+/)
    this.info = { methods, encryption: enc.includes('nip44_v2') ? 'nip44_v2' : 'nip04' }
    return this.info
  }

  private encrypt(enc: NwcEncryption, text: string): string {
    return enc === 'nip44_v2'
      ? nip44.encrypt(text, nip44.utils.getConversationKey(this.conn.clientSecret, this.conn.walletPubkey))
      : nip04.encrypt(this.conn.clientSecret, this.conn.walletPubkey, text)
  }

  private decrypt(enc: NwcEncryption, payload: string): string {
    // A wallet may answer in the scheme it was asked in, or in NIP-04 when it knows no other; try the one asked first.
    const order: NwcEncryption[] = enc === 'nip44_v2' ? ['nip44_v2', 'nip04'] : ['nip04', 'nip44_v2']
    let last: unknown = null
    for (const e of order) {
      try {
        return e === 'nip44_v2'
          ? nip44.decrypt(payload, nip44.utils.getConversationKey(this.conn.clientSecret, this.conn.walletPubkey))
          : nip04.decrypt(this.conn.clientSecret, this.conn.walletPubkey, payload)
      } catch (err) {
        last = err
      }
    }
    throw new Error(`the wallet's answer could not be decrypted (${last instanceof Error ? last.message : String(last)})`)
  }

  /**
   * One request and its answer. The subscription for the answer is open
   * before the request is sent. Throws NwcError for the wallet's own error,
   * NwcNotSent when no relay took the request, and NwcUnknownOutcome when it
   * was sent and no answer came in time.
   */
  async request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const info = await this.getInfo()
    if (!info.methods.includes(method)) throw new NwcError('NOT_IMPLEMENTED', `the wallet service does not offer ${method}`)
    const now = nowSeconds()
    const tags = [['p', this.conn.walletPubkey], ['expiration', String(now + Math.ceil(timeoutMs / 1000))]]
    if (info.encryption === 'nip44_v2') tags.push(['encryption', 'nip44_v2'])
    const request = finalizeEvent({ kind: NWC_REQUEST_KIND, created_at: now, tags, content: this.encrypt(info.encryption, JSON.stringify({ method, params })) }, this.conn.clientSecret) as NostrEvent
    const filter: Filter = { kinds: [NWC_RESPONSE_KIND], authors: [this.conn.walletPubkey], '#e': [request.id] }
    let resolveAnswer!: (ev: NostrEvent) => void
    const answer = new Promise<NostrEvent>((resolve) => { resolveAnswer = resolve })
    let resolveReady!: () => void
    const ready = new Promise<void>((resolve) => { resolveReady = resolve })
    const close = this.relays.subscribe(filter, (ev) => {
      if (ev.pubkey === this.conn.walletPubkey && ev.tags.some((t) => t[0] === 'e' && t[1] === request.id)) resolveAnswer(ev)
    }, () => resolveReady())
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      // The answer's subscription first, so an answer that comes fast is not missed; a relay slow to say EOSE is not waited for long.
      await Promise.race([ready, new Promise((r) => setTimeout(r, 2_000))])
      const sent = await this.relays.publish(request)
      if (!sent.ok) {
        const reasons = Object.values(sent.reasons)
        if (reasons.length > 0 && reasons.every((r) => REFUSED.test(r))) throw new NwcNotSent(`the wallet's relays refused the request (${reasons.join('; ')})`)
        throw new NwcUnknownOutcome(`the request may not have reached the wallet's relays (${sent.reason})`)
      }
      const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs) })
      const ev = await Promise.race([answer, late])
      if (!ev) throw new NwcUnknownOutcome(`the wallet service did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`)
      let body: { result_type?: unknown; error?: { code?: unknown; message?: unknown } | null; result?: unknown }
      try {
        body = JSON.parse(this.decrypt(info.encryption, ev.content)) as typeof body
      } catch (err) {
        throw new NwcUnknownOutcome(`the wallet's answer to ${method} could not be read: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (body.error) throw new NwcError(String(body.error.code ?? 'OTHER'), String(body.error.message ?? 'no message'))
      if (body.result_type !== undefined && body.result_type !== method) throw new NwcUnknownOutcome(`the wallet answered ${String(body.result_type)} to ${method}`)
      if (!body.result || typeof body.result !== 'object') throw new NwcUnknownOutcome(`the wallet's answer to ${method} carries no result`)
      return body.result as Record<string, unknown>
    } finally {
      if (timer !== null) clearTimeout(timer)
      close()
    }
  }

  /** get_balance, in millisats. */
  async getBalanceMsats(): Promise<number> {
    const r = await this.request('get_balance', {}, QUICK_REQUEST_MS)
    const b = Number(r.balance)
    if (!Number.isFinite(b) || b < 0) throw new NwcUnknownOutcome('the wallet answered get_balance without a balance')
    return b
  }

  /** pay_invoice: the preimage, and the fees in millisats when the wallet says. */
  async payInvoice(bolt11: string, timeoutMs = PAY_REQUEST_MS): Promise<{ preimage: string; feesPaidMsats: number | null }> {
    const r = await this.request('pay_invoice', { invoice: bolt11 }, timeoutMs)
    const preimage = typeof r.preimage === 'string' ? r.preimage.toLowerCase() : ''
    const fees = Number(r.fees_paid)
    return { preimage, feesPaidMsats: Number.isFinite(fees) && fees >= 0 ? fees : null }
  }

  close(): void {
    this.relays.close()
  }
}
