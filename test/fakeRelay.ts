// fakeRelay.ts: an in-memory nostr relay for the tests, at the wire level.
//
// It implements REQ, EVENT, CLOSE and AUTH as a relay does, behind a fake
// WebSocket class that nostr-tools' AbstractRelay drives exactly as it
// drives a real socket. So the server's own relay code, auth and all, runs
// unchanged in the tests, and nothing ever leaves the process. A relay's
// policy says what it refuses (OK false with a verbatim reason), whether it
// auth-gates reads, whether it answers at all, and how slow it is.

import { matchFilters, type Filter } from 'nostr-tools/filter'
import { verifyEvent } from 'nostr-tools/pure'
import { normalizeURL } from 'nostr-tools/utils'
import type { NostrEvent } from '../src/nostr/event.js'

export interface FakePolicy {
  /** Reads need NIP-42 auth first, as the canonical relay requires. */
  requireAuth: boolean
  /** The OK-false reason for an event, or null to accept it. */
  refuse: (ev: NostrEvent) => string | null
  /** A dead relay: it accepts connections and answers nothing, ever. */
  silent: boolean
  /** It delivers stored events but never says EOSE. */
  mute: boolean
  /** The connection fails. */
  reachable: boolean
  /** Milliseconds each message takes in each direction. */
  latencyMs: number
}

const DEFAULT_POLICY: FakePolicy = {
  requireAuth: true,
  refuse: () => null,
  silent: false,
  mute: false,
  reachable: true,
  latencyMs: 0,
}

interface Connection {
  socket: FakeSocket
  authed: boolean
  challenge: string
  subs: Map<string, Filter[]>
}

let challengeCounter = 0

function isReplaceable(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)
}
function isEphemeral(kind: number): boolean {
  return kind >= 20000 && kind < 30000
}
function isAddressable(kind: number): boolean {
  return kind >= 30000 && kind < 40000
}

export class FakeRelay {
  readonly url: string
  policy: FakePolicy
  /** What the relay stores, by its own key (id, or the replaceable address). */
  readonly events = new Map<string, NostrEvent>()
  /** Every event accepted over EVENT, in order. */
  readonly published: NostrEvent[] = []
  /** Every message received, parsed, for assertions. */
  readonly received: unknown[][] = []
  private readonly conns = new Set<Connection>()

  constructor(url: string, policy: Partial<FakePolicy> = {}) {
    this.url = normalizeURL(url)
    this.policy = { ...DEFAULT_POLICY, ...policy }
  }

  private keyOf(ev: NostrEvent): string {
    if (isReplaceable(ev.kind)) return `${ev.kind}:${ev.pubkey}`
    if (isAddressable(ev.kind)) return `${ev.kind}:${ev.pubkey}:${ev.tags.find((t) => t[0] === 'd')?.[1] ?? ''}`
    return ev.id
  }

  /** Store events as if another client had published them: no OK, no fanout. */
  seed(...events: NostrEvent[]): void {
    for (const ev of events) this.store(ev)
  }

  /** Every stored event, newest first. */
  all(): NostrEvent[] {
    return [...this.events.values()].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
  }

  private store(ev: NostrEvent): boolean {
    if (isEphemeral(ev.kind)) return true
    const key = this.keyOf(ev)
    const have = this.events.get(key)
    if (have && (have.created_at > ev.created_at || (have.created_at === ev.created_at && have.id < ev.id))) return false
    this.events.set(key, ev)
    return true
  }

  /** Store and hand to every matching subscription, as a publish from another client would. */
  inject(ev: NostrEvent): void {
    this.store(ev)
    this.fan(ev)
  }

  private fan(ev: NostrEvent): void {
    for (const conn of this.conns) {
      if (this.policy.silent) continue
      for (const [subid, filters] of conn.subs) {
        if (matchFilters(filters, ev)) this.reply(conn, ['EVENT', subid, ev])
      }
    }
  }

  connect(socket: FakeSocket): Connection {
    const conn: Connection = { socket, authed: false, challenge: `challenge-${++challengeCounter}`, subs: new Map() }
    this.conns.add(conn)
    if (this.policy.requireAuth && !this.policy.silent) this.reply(conn, ['AUTH', conn.challenge])
    return conn
  }

  disconnect(conn: Connection): void {
    this.conns.delete(conn)
  }

  private reply(conn: Connection, msg: unknown[]): void {
    conn.socket.deliver(JSON.stringify(msg), this.policy.latencyMs)
  }

  private stored(filters: Filter[]): NostrEvent[] {
    const limit = filters.reduce((m, f) => (f.limit !== undefined ? Math.min(m, f.limit) : m), Infinity)
    const out = this.all().filter((ev) => matchFilters(filters, ev))
    return Number.isFinite(limit) ? out.slice(0, limit) : out
  }

  handle(conn: Connection, raw: string): void {
    let msg: unknown[]
    try { msg = JSON.parse(raw) as unknown[] } catch { return }
    this.received.push(msg)
    if (this.policy.silent) return
    const [verb] = msg
    if (verb === 'REQ') {
      const subid = String(msg[1])
      const filters = msg.slice(2) as Filter[]
      if (this.policy.requireAuth && !conn.authed) {
        this.reply(conn, ['CLOSED', subid, 'auth-required: we only serve authenticated clients'])
        return
      }
      conn.subs.set(subid, filters)
      for (const ev of this.stored(filters)) this.reply(conn, ['EVENT', subid, ev])
      if (!this.policy.mute) this.reply(conn, ['EOSE', subid])
      return
    }
    if (verb === 'CLOSE') {
      conn.subs.delete(String(msg[1]))
      return
    }
    if (verb === 'EVENT') {
      const ev = msg[1] as NostrEvent
      if (!ev || !verifyEvent(ev)) {
        this.reply(conn, ['OK', ev?.id ?? '', false, 'invalid: bad signature'])
        return
      }
      const refusal = this.policy.refuse(ev)
      if (refusal) {
        this.reply(conn, ['OK', ev.id, false, refusal])
        return
      }
      const fresh = this.store(ev)
      this.published.push(ev)
      this.reply(conn, ['OK', ev.id, true, fresh ? '' : 'duplicate: already have this event'])
      if (fresh) this.fan(ev)
      return
    }
    if (verb === 'AUTH') {
      const ev = msg[1] as NostrEvent
      const challenge = ev?.tags?.find((t) => t[0] === 'challenge')?.[1]
      const relay = ev?.tags?.find((t) => t[0] === 'relay')?.[1]
      const ok = !!ev && ev.kind === 22242 && verifyEvent(ev) && challenge === conn.challenge && !!relay && normalizeURL(relay) === this.url
      conn.authed = ok
      this.reply(conn, ['OK', ev?.id ?? '', ok, ok ? '' : 'auth-required: bad auth event'])
      return
    }
  }
}

/** The relays a test's sockets can reach, by URL. */
export class FakeNetwork {
  readonly relays = new Map<string, FakeRelay>()

  add(url: string, policy: Partial<FakePolicy> = {}): FakeRelay {
    const relay = new FakeRelay(url, policy)
    this.relays.set(relay.url, relay)
    return relay
  }

  /** A WebSocket class bound to this network, for nostr-tools. */
  get WebSocket(): typeof FakeSocket {
    const network = this
    return class extends FakeSocket {
      constructor(url: string) {
        super(url, network)
      }
    }
  }
}

/** Just enough of a WebSocket for nostr-tools' AbstractRelay. */
export class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = FakeSocket.CONNECTING
  onopen: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: { message?: string }) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  private relay: FakeRelay | undefined
  private conn: Connection | null = null

  constructor(url: string, network: FakeNetwork) {
    this.relay = network.relays.get(normalizeURL(url))
    setTimeout(() => {
      if (this.readyState === FakeSocket.CLOSED) return
      if (!this.relay || !this.relay.policy.reachable) {
        this.readyState = FakeSocket.CLOSED
        this.onerror?.({})
        this.onclose?.({ message: 'connection refused' })
        return
      }
      this.readyState = FakeSocket.OPEN
      this.onopen?.({})
      this.conn = this.relay.connect(this)
    }, 0)
  }

  /** A frame sent on a socket that is not open is dropped, as a WebSocket drops it (WHATWG: no throw once closing or closed). */
  send(data: string): void {
    if (this.readyState !== FakeSocket.OPEN || !this.relay || !this.conn) return
    const relay = this.relay
    const conn = this.conn
    setTimeout(() => { if (this.readyState === FakeSocket.OPEN) relay.handle(conn, String(data)) }, relay.policy.latencyMs)
  }

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return
    this.readyState = FakeSocket.CLOSED
    if (this.conn) this.relay?.disconnect(this.conn)
    setTimeout(() => this.onclose?.({ message: 'closed' }), 0)
  }

  /** A message from the relay, delivered after the relay's latency. */
  deliver(json: string, latencyMs: number): void {
    setTimeout(() => { if (this.readyState === FakeSocket.OPEN) this.onmessage?.({ data: json }) }, latencyMs)
  }
}
