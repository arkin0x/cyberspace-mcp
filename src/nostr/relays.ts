// relays.ts: the relays this server talks to, and how.
//
// Ported from ONOSENDAI src/lib/relay.ts at commit c9dbf53 and
// src/store/useRelays.ts at commit 8e4d0e3 (branch feat/keys-and-chests),
// rebuilt on one nostr-tools AbstractRelay per URL instead of the pool, so
// that every question is asked of each relay on its own and each relay's
// answer is kept apart (relayOutcome.ts). The policy is ONOSENDAI's:
//
//   - publishing counts on any OK true; a refusal (a NIP-01 machine-readable
//     prefix) is returned verbatim and never retried; when every relay
//     failed for a reason that is not a refusal the sockets are presumed dead,
//     dropped once, and the event is sent once more over fresh ones;
//   - every read authenticates first (NIP-42), because the canonical relay
//     auth-gates reads and answers an unauthenticated REQ with CLOSED;
//   - nostr-tools' own EOSE timer is pushed far past any deadline of ours, so
//     "answered" always means the relay said so, and our own timer decides
//     "no answer";
//   - queryEachSettled waits for the primary relay and the relays that hold
//     the chain, for up to maxWait from when the requests went out, and for
//     no other (the head-confirmation rule, chain/resolve.ts).
//
// The WebSocket implementation is injectable so the tests run this very code
// against the in-memory relay. One deliberate difference from ONOSENDAI:
// `relay.onauth` is never set, because nostr-tools rethrows an AUTH failure
// out of its own promise chain as an unhandled rejection, which ends a Node
// process; the server authenticates explicitly and catches its own errors.

import { AbstractRelay } from 'nostr-tools/abstract-relay'
import type { EventTemplate as AuthTemplate, VerifiedEvent } from 'nostr-tools/core'
import type { Filter } from 'nostr-tools/filter'
import { verifyEvent } from 'nostr-tools/pure'
import { normalizeURL } from 'nostr-tools/utils'
import type { NostrEvent } from './event.js'
import { LiveRegistry, type Handlers } from './liveSub.js'
import { classifyClose, mergeAnswers, type RelayAnswer } from './relayOutcome.js'
import { GuardedWebSocket } from './websocket.js'

/** The canonical relay (brief, ruling 9). Configurable; this is the default. */
export const DEFAULT_RELAY = 'wss://onosendai.feeds.relay.tools'

/** ws:// or wss:// with a real host; null for anything else. */
export function normalizeRelay(input: string): string | null {
  const s = input.trim()
  if (!s || /\s/.test(s)) return null
  const withScheme = /^wss?:\/\//i.test(s) ? s : `wss://${s}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null
    if (!/^[a-z0-9.-]+$/i.test(u.hostname) || (!u.hostname.includes('.') && u.hostname !== 'localhost')) return null
    const path = u.pathname === '/' ? '' : u.pathname
    return `${u.protocol}//${u.host}${path}`.replace(/\/$/, '')
  } catch {
    return null
  }
}

export type AuthSigner = (template: AuthTemplate) => Promise<VerifiedEvent>

export interface RelaysOptions {
  /** The relays, the canonical one first. */
  urls: string[]
  /** Signs a NIP-42 AUTH template with the identity's key. */
  signAuth: AuthSigner
  /** A WebSocket class to use instead of the global one (tests). */
  websocketImplementation?: unknown
  /** How long a publish or a one-shot query waits before giving up. */
  maxWaitMs?: number
  /** Where a line of diagnostics goes; never stdout, which is the MCP channel. */
  log?: (line: string) => void
}

/** `accepted`: the relays that took the event (normalized URLs). `reasons`: each failure, verbatim, by relay. */
export type PublishResult =
  | { ok: true; accepted: string[]; reasons: Record<string, string> }
  | { ok: false; reason: string; reasons: Record<string, string> }

/** A relay's own final refusal (NIP-01 OK false prefixes): asking again would get the same answer. */
export const REFUSED = /^(blocked|invalid|duplicate|pow|restricted|error|mute)\b/i
/** A relay's answer that may change by itself: not retried at once, left to the outbox's backoff. */
export const TRANSIENT = /^(rate-limited|auth-required)\b/i

/** What nostr-tools is told to wait for an EOSE: far longer than any deadline of ours. */
const NOSTR_TOOLS_EOSE_MS = 10 * 60_000

interface OpenSub {
  close(reason?: string): void
  eoseTimeoutHandle?: ReturnType<typeof setTimeout>
}

interface AuthRelay {
  challenge?: string
}

interface AskOptions {
  answerMs?: number
  onSent?: () => void
  stop?: AbortSignal
  onEvent?: (ev: NostrEvent) => void
}

export class Relays {
  readonly canonical: string
  readonly urls: string[]
  private readonly maxWaitMs: number
  private readonly signAuth: AuthSigner
  private readonly websocketImplementation: unknown
  private readonly log: (line: string) => void
  private pool = new Map<string, AbstractRelay>()
  private authedFor = new Map<string, string>()
  private noChallenge = new Set<string>()
  private authSigning = new Map<string, number>()
  private registries = new Map<string, LiveRegistry>()
  private closed = false

  constructor(opts: RelaysOptions) {
    const urls = [...new Set(opts.urls.map((u) => normalizeURL(u)))]
    if (urls.length === 0) throw new Error('at least one relay is needed')
    this.canonical = urls[0]
    this.urls = urls
    this.maxWaitMs = opts.maxWaitMs ?? 8000
    this.signAuth = opts.signAuth
    // Node's own WebSocket, behind the guard of websocket.ts, unless a test hands in the fake one.
    this.websocketImplementation = opts.websocketImplementation ?? GuardedWebSocket
    this.log = opts.log ?? (() => {})
  }

  /** The relays other than the canonical one. */
  get others(): string[] {
    return this.urls.filter((u) => u !== this.canonical)
  }

  /** The connection to one relay, opened if it is not. Throws when it cannot be reached in time. */
  async ensureRelay(url: string, connectionTimeout = 3000): Promise<AbstractRelay> {
    if (this.closed) throw new Error('relays closed')
    const norm = normalizeURL(url)
    let relay = this.pool.get(norm)
    if (!relay) {
      relay = new AbstractRelay(norm, {
        verifyEvent: (ev) => verifyEvent(ev),
        websocketImplementation: this.websocketImplementation as typeof WebSocket | undefined,
        enablePing: false,
        enableReconnect: false,
      })
      relay.onnotice = (msg) => this.log(`NOTICE from ${norm}: ${msg}`)
      relay.publishTimeout = this.maxWaitMs
      const mine = relay
      relay.onclose = () => {
        if (this.pool.get(norm) === mine) this.pool.delete(norm)
        this.authedFor.delete(norm)
      }
      this.pool.set(norm, relay)
    }
    try {
      await relay.connect({ timeout: connectionTimeout })
    } catch (err) {
      if (this.pool.get(norm) === relay) this.pool.delete(norm)
      try { relay.close() } catch { /* never opened */ }
      throw err instanceof Error ? err : new Error(String(err ?? 'connection failed'))
    }
    return relay
  }

  /** Whether an AUTH for this relay is waiting on the signer. */
  authPending(url: string): boolean {
    return this.authSigning.has(normalizeURL(url))
  }

  private async sign(template: AuthTemplate): Promise<VerifiedEvent> {
    const relayTag = template.tags.find((t) => t[0] === 'relay')?.[1]
    const key = relayTag ? normalizeURL(relayTag) : null
    if (key) this.authSigning.set(key, (this.authSigning.get(key) ?? 0) + 1)
    try {
      return await this.signAuth(template)
    } finally {
      if (key) {
        const left = (this.authSigning.get(key) ?? 1) - 1
        if (left > 0) this.authSigning.set(key, left)
        else this.authSigning.delete(key)
      }
    }
  }

  /**
   * Make sure the connection is authenticated before a read or write. The
   * relay is opened, its challenge waited for briefly, and the challenge
   * answered up front; a relay that never challenged is not waited for again.
   */
  async authRelay(url: string): Promise<void> {
    const norm = normalizeURL(url)
    if (this.noChallenge.has(norm)) return
    try {
      const relay = await this.ensureRelay(norm)
      const r = relay as unknown as AuthRelay
      for (let i = 0; i < 10 && !r.challenge; i++) await new Promise((res) => setTimeout(res, 40))
      if (r.challenge) {
        if (this.authedFor.get(norm) !== r.challenge) {
          await relay.auth((t) => this.sign(t))
          this.authedFor.set(norm, r.challenge)
        }
      } else {
        this.noChallenge.add(norm)
      }
    } catch (err) {
      this.log(`auth with ${norm} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async authAll(urls: string[]): Promise<void> {
    await Promise.allSettled(urls.map((u) => this.authRelay(u)))
  }

  /** Drop the sockets to these relays so the next operation opens fresh ones. Also forgets their auth. */
  dropRelays(urls: string[]): void {
    for (const url of urls) {
      const norm = normalizeURL(url)
      const relay = this.pool.get(norm)
      this.pool.delete(norm)
      this.authedFor.delete(norm)
      try { relay?.close() } catch { /* nothing open */ }
    }
  }

  private async publishOnce(urls: string[], event: NostrEvent): Promise<PublishResult> {
    await this.authAll(urls)
    const results = await Promise.allSettled(urls.map(async (url) => {
      const relay = await this.ensureRelay(url)
      return relay.publish(event)
    }))
    const accepted: string[] = []
    const reasons: Record<string, string> = {}
    results.forEach((r, i) => {
      const url = normalizeURL(urls[i])
      if (r.status === 'fulfilled') accepted.push(url)
      else reasons[url] = r.reason instanceof Error ? r.reason.message : String(r.reason ?? 'connection failure')
    })
    if (accepted.length > 0) return { ok: true, accepted, reasons }
    const reason = Object.values(reasons).find(Boolean)
    return { ok: false, reason: reason || 'no relay accepted it', reasons }
  }

  /**
   * Send to a set of relays; ok if any accepts, the first failure otherwise.
   * When every relay failed for a reason that is not a refusal (a timeout, a
   * closed socket), the sockets are presumed dead: they are dropped and the
   * event is sent once more over fresh ones. A refusal is never retried; a
   * rate limit or an auth demand is left to the outbox's backoff.
   */
  async publishMany(urls: string[], event: NostrEvent): Promise<PublishResult> {
    if (urls.length === 0) return { ok: false, reason: 'no relays configured', reasons: {} }
    const first = await this.publishOnce(urls, event)
    if (first.ok || REFUSED.test(first.reason) || TRANSIENT.test(first.reason)) return first
    this.dropRelays(urls)
    return this.publishOnce(urls, event)
  }

  /** Send one event to every configured relay. */
  publish(event: NostrEvent): Promise<PublishResult> {
    return this.publishMany(this.urls, event)
  }

  /**
   * Ask one relay, and say which of the three things happened. A CLOSED with
   * auth-required is answered with NIP-42 auth and asked once more.
   */
  async askOne(url: string, filter: Filter, deadline: number, opts: AskOptions = {}): Promise<RelayAnswer> {
    const { answerMs, onSent, stop, onEvent } = opts
    const norm = normalizeURL(url)
    const remaining = (): number => Math.max(0, deadline - Date.now())
    const late = (events: NostrEvent[] = []): RelayAnswer => ({ url: norm, outcome: 'unreachable', reason: 'no answer in time', events })
    if (stop?.aborted) return late()
    let relay: AbstractRelay
    try {
      relay = await this.ensureRelay(norm, Math.max(answerMs === undefined ? 1 : 1_000, remaining()))
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err ?? '')
      return { url: norm, outcome: 'unreachable', reason: reason || 'connection failed', events: [] }
    }
    if (stop?.aborted) return late()
    return new Promise((resolve) => {
      const events = new Map<string, NostrEvent>()
      const got = (): NostrEvent[] => [...events.values()]
      let settled = false
      let sub: OpenSub | null = null
      let authTried = false
      const onStop = (): void => finish(late(got()))
      stop?.addEventListener('abort', onStop, { once: true })
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (answer: RelayAnswer): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        stop?.removeEventListener('abort', onStop)
        if (sub) {
          clearTimeout(sub.eoseTimeoutHandle)
          try { sub.close() } catch { /* already closed */ }
        }
        resolve(answer)
      }
      const arm = (ms: number): void => { clearTimeout(timer); timer = setTimeout(() => finish(late(got())), ms) }
      if (answerMs === undefined) arm(remaining())
      const open = (): void => {
        try {
          sub = relay.subscribe([filter], {
            onevent: (e) => {
              if (settled || events.has(e.id)) return
              events.set(e.id, e as NostrEvent)
              onEvent?.(e as NostrEvent)
            },
            oneose: () => finish({ url: norm, outcome: 'answered', events: got() }),
            onclose: (reason) => {
              if (settled) return
              if (/^auth-required:/i.test(reason) && !authTried) {
                authTried = true
                relay.auth((t) => this.sign(t)).then(
                  () => { if (!settled) open() },
                  (err) => finish({ url: norm, outcome: 'refused', reason: `auth-required: ${err instanceof Error ? err.message : String(err)}`, events: got() }),
                )
                return
              }
              finish(classifyClose(norm, reason, got()))
            },
            eoseTimeout: NOSTR_TOOLS_EOSE_MS,
          }) as unknown as OpenSub
          if (answerMs !== undefined && timer === undefined) arm(answerMs)
          onSent?.()
        } catch (err) {
          finish({ url: norm, outcome: 'unreachable', reason: err instanceof Error ? err.message : String(err), events: got() })
        }
      }
      open()
    })
  }

  /** One-shot query, each relay asked and answered on its own, then closed. */
  async queryEach(filter: Filter, maxWait = this.maxWaitMs, urls: string[] = this.urls): Promise<RelayAnswer[]> {
    const list = [...new Set(urls.map((r) => normalizeURL(r)))]
    await this.authAll(list)
    const deadline = Date.now() + maxWait
    return Promise.all(list.map((url) => this.askOne(url, filter, deadline)))
  }

  /** One-shot query, merged across relays. */
  async query(filter: Filter, maxWait = this.maxWaitMs, urls: string[] = this.urls): Promise<NostrEvent[]> {
    return mergeAnswers(await this.queryEach(filter, maxWait, urls))
  }

  /**
   * Ask several relays at once, each on its own, and settle as soon as the
   * answers that matter are in: when `primary` has answered and every relay
   * of `waitFor` has answered or given up, or `maxWait` after this question's
   * first REQ went out with `primary` answered, or when every relay has
   * answered, or at `stop`, whichever comes first. A relay that has not
   * answered by then reads as unreachable ("no answer in time"); an answer
   * that comes after is handed to `onLate`.
   */
  queryEachSettled(
    urls: string[],
    filter: Filter,
    maxWait: number,
    primary: string,
    waitFor: string[],
    opts: { onSent?: () => void; stop?: AbortSignal; onLate?: (answer: RelayAnswer) => void } = {},
  ): Promise<RelayAnswer[]> {
    const list = [...new Set(urls.map((r) => normalizeURL(r)))]
    const main = normalizeURL(primary)
    const held = new Set(waitFor.map((r) => normalizeURL(r)).filter((url) => list.includes(url) && url !== main))
    const unanswered = (url: string): RelayAnswer => ({ url, outcome: 'unreachable', reason: 'no answer in time', events: [] })
    if (opts.stop?.aborted) return Promise.resolve(list.map(unanswered))
    const deadline = Date.now() + maxWait
    const answers = new Map<string, RelayAnswer>()
    const done = new AbortController()
    let primaryAnswered = false
    let firstSent: number | undefined
    const onSent = (): void => { firstSent ??= Date.now(); opts.onSent?.() }
    let cap: ReturnType<typeof setTimeout> | undefined
    return new Promise((resolve) => {
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        clearTimeout(backstop)
        clearTimeout(cap)
        opts.stop?.removeEventListener('abort', settle)
        done.abort()
        resolve(list.map((url) => answers.get(url) ?? unanswered(url)))
      }
      opts.stop?.addEventListener('abort', settle, { once: true })
      const backstop = setTimeout(settle, 4 * maxWait + 50)
      const enough = (): boolean => answers.size === list.length || (primaryAnswered && [...held].every((url) => answers.has(url)))
      for (const url of list) {
        const left = (): number => Math.max(0, deadline - Date.now())
        const ask: AskOptions = held.has(url) ? { answerMs: maxWait, onSent, stop: done.signal } : { answerMs: maxWait, onSent }
        void Promise.race([this.authRelay(url), new Promise<void>((r) => setTimeout(r, left()))])
          .then(() => this.askOne(url, filter, deadline, ask))
          .then((answer) => {
            if (settled) { opts.onLate?.(answer); return }
            answers.set(url, answer)
            if (url === main && answer.outcome === 'answered') {
              primaryAnswered = true
              cap = setTimeout(settle, Math.max(0, (firstSent ?? Date.now()) + maxWait - Date.now()))
            }
            if (enough()) settle()
          })
      }
    })
  }

  private registryFor(url: string): LiveRegistry {
    let reg = this.registries.get(url)
    if (reg) return reg
    reg = new LiveRegistry({
      open: async (filter, handlers: Handlers, onClose) => {
        await this.authRelay(url)
        const relay = await this.ensureRelay(url)
        const sub = relay.subscribe([filter], {
          onevent: (e) => handlers.onEvent(e as NostrEvent),
          oneose: () => handlers.onEose?.(),
          onclose: (reason) => onClose(reason),
          eoseTimeout: NOSTR_TOOLS_EOSE_MS,
        }) as unknown as OpenSub
        return () => {
          clearTimeout(sub.eoseTimeoutHandle)
          try { sub.close() } catch { /* already closed */ }
        }
      },
    })
    this.registries.set(url, reg)
    return reg
  }

  /**
   * A live subscription on every configured relay that stays open for the
   * life of its closer: reissued after any close a relay makes. Events are
   * handed over as they land, from whichever relay sent them; consumers
   * merge by id.
   */
  subscribe(filter: Filter, onEvent: (ev: NostrEvent) => void, onEose?: () => void): () => void {
    const closers = this.urls.map((url) => this.registryFor(url).subscribe(filter, { onEvent, onEose }))
    return () => { for (const c of closers) c() }
  }

  /** Close every subscription and every socket. */
  close(): void {
    this.closed = true
    for (const reg of this.registries.values()) reg.closeAll()
    this.registries.clear()
    for (const relay of this.pool.values()) { try { relay.close() } catch { /* already closed */ } }
    this.pool.clear()
  }
}
