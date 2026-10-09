// outbox.ts: signed events not yet confirmed by the canonical relay, and
// their retry, persisted across restarts.
//
// The retry to the canonical relay is ported from ONOSENDAI
// src/lib/publisher.ts at commit 3756962 (branch feat/keys-and-chests):
// published counts once any relay took the event; the canonical relay is
// where every other reader looks, so when it was not among them the event is
// asked of it again in the background, with the state saved beside the
// chain so a restart still knows what is owed.
//
// Crash safety (brief, ruling 6): an event is written here before it is
// sent anywhere, so a server killed between signing and confirmation leaves
// an entry that the next start replays. A replay first asks whether the
// event would fork the chain (chain/divergence.ts), and drops it with a
// note rather than publish a fork.

import { normalizeURL } from 'nostr-tools/utils'
import type { StateDir } from '../state/dir.js'
import type { NostrEvent } from './event.js'
import { REFUSED, type PublishResult, type Relays } from './relays.js'

export interface OutboxEntry {
  event: NostrEvent
  /** Unix seconds when it was signed. */
  signedAt: number
  /** Relays that answered OK true, normalized. */
  accepted: string[]
  attempts: number
  lastError?: string
  /** A relay's own refusal, verbatim, by relay: never retried there. */
  refused?: Record<string, string>
  /** Why it was dropped at replay, when it was. */
  dropped?: string
}

interface OutboxFile { version: 1; entries: OutboxEntry[] }

const FILE = 'outbox.json'
/** First wait before the canonical relay is asked again; doubles up to the cap. */
export const CANONICAL_RETRY_MS = 5_000
export const RETRY_MAX_MS = 60_000
/** Refused and dropped entries kept for the outbox tool to show. */
const HISTORY_KEPT = 50

export interface OutboxOptions {
  log?: (line: string) => void
  /** Called when a relay takes a chain event, so the chain's published status and the holders follow. */
  onAccepted?: (event: NostrEvent, urls: string[]) => void
  /** Retry timing, for tests. */
  retryMs?: number
}

export class Outbox {
  entries: OutboxEntry[]
  private timer: ReturnType<typeof setTimeout> | null = null
  private backoff: number
  private readonly retryMs: number
  private readonly log: (line: string) => void
  private readonly onAccepted?: (event: NostrEvent, urls: string[]) => void
  private stopped = false

  constructor(private readonly dir: StateDir, private readonly relays: Relays, opts: OutboxOptions = {}) {
    const saved = dir.readJson<OutboxFile | null>(FILE, null)
    this.entries = saved?.version === 1 && Array.isArray(saved.entries) ? saved.entries : []
    this.retryMs = opts.retryMs ?? CANONICAL_RETRY_MS
    this.backoff = this.retryMs
    this.log = opts.log ?? (() => {})
    this.onAccepted = opts.onAccepted
  }

  private save(): void {
    const history = this.entries.filter((e) => e.dropped || this.settled(e))
    if (history.length > HISTORY_KEPT) {
      const drop = new Set(history.slice(0, history.length - HISTORY_KEPT).map((e) => e.event.id))
      this.entries = this.entries.filter((e) => !drop.has(e.event.id))
    }
    this.dir.writeJson(FILE, { version: 1, entries: this.entries } satisfies OutboxFile)
  }

  /** Whether an entry has nothing left to do: the canonical relay took it, or refused it outright. */
  private settled(e: OutboxEntry): boolean {
    return e.accepted.includes(this.relays.canonical) || (e.refused?.[this.relays.canonical] !== undefined)
  }

  /** The entries still owed to the canonical relay. */
  pending(): OutboxEntry[] {
    return this.entries.filter((e) => !e.dropped && !this.settled(e))
  }

  /** Record a signed event before anything is sent. */
  add(event: NostrEvent, now: number = Math.floor(Date.now() / 1000)): OutboxEntry {
    const entry: OutboxEntry = { event, signedAt: now, accepted: [], attempts: 0 }
    this.entries.push(entry)
    this.save()
    return entry
  }

  /**
   * Send an entry to every relay that has not taken it. Resolves to the
   * publish result; the entry records what each relay said. Schedules the
   * canonical retry when the canonical relay did not take it and did not
   * refuse it.
   */
  async send(entry: OutboxEntry): Promise<PublishResult> {
    const urls = this.relays.urls.filter((u) => !entry.accepted.includes(u) && entry.refused?.[u] === undefined)
    entry.attempts++
    const result = urls.length === 0
      ? { ok: true as const, accepted: [], reasons: {} }
      : await this.relays.publishMany(urls, entry.event)
    const newly = result.ok ? result.accepted.filter((u) => !entry.accepted.includes(u)) : []
    entry.accepted = [...new Set([...entry.accepted, ...newly])]
    for (const [url, reason] of Object.entries(result.reasons)) {
      if (REFUSED.test(reason)) entry.refused = { ...(entry.refused ?? {}), [normalizeURL(url)]: reason }
      else entry.lastError = `${url}: ${reason}`
    }
    if (result.ok && newly.length === 0 && urls.length > 0) entry.lastError = Object.values(result.reasons)[0] ?? entry.lastError
    this.save()
    if (newly.length > 0) this.onAccepted?.(entry.event, newly)
    if (!this.settled(entry)) this.scheduleRetry()
    return result.ok && entry.accepted.length > 0 ? { ok: true, accepted: entry.accepted, reasons: result.reasons } : result
  }

  private scheduleRetry(): void {
    if (this.stopped || this.timer !== null || this.pending().length === 0) return
    this.timer = setTimeout(() => { this.timer = null; void this.retry() }, this.backoff)
  }

  /** Ask the canonical relay (and any other relay still owed) once more for everything pending. */
  async retry(): Promise<void> {
    if (this.stopped) return
    let allSettled = true
    for (const entry of this.pending()) {
      await this.send(entry).catch((err) => this.log(`retry failed: ${err instanceof Error ? err.message : String(err)}`))
      if (!this.settled(entry)) allSettled = false
    }
    if (allSettled || this.pending().length === 0) { this.backoff = this.retryMs; return }
    this.backoff = Math.min(this.backoff * 2, RETRY_MAX_MS)
    if (this.timer === null) this.timer = setTimeout(() => { this.timer = null; void this.retry() }, this.backoff)
  }

  /**
   * At startup: every pending entry is sent again, unless `check` says why it
   * must not be (an event that would fork the chain), in which case it is
   * dropped with that reason.
   */
  async replay(check: (event: NostrEvent) => Promise<string | null>): Promise<{ sent: OutboxEntry[]; dropped: OutboxEntry[] }> {
    const sent: OutboxEntry[] = []
    const dropped: OutboxEntry[] = []
    for (const entry of this.pending()) {
      const why = await check(entry.event)
      if (why) {
        entry.dropped = why
        dropped.push(entry)
        this.save()
        continue
      }
      await this.send(entry).catch((err) => this.log(`replay failed: ${err instanceof Error ? err.message : String(err)}`))
      sent.push(entry)
    }
    return { sent, dropped }
  }

  /** What the outbox tool shows. */
  state(): { pending: OutboxEntry[]; refused: OutboxEntry[]; dropped: OutboxEntry[]; nextRetryMs: number | null } {
    return {
      pending: this.pending(),
      refused: this.entries.filter((e) => e.refused && this.settled(e) && !e.dropped),
      dropped: this.entries.filter((e) => e.dropped),
      nextRetryMs: this.timer === null ? null : this.backoff,
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }
}
