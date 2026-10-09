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
// an entry that the next start replays. An event no relay has taken yet is
// sent only when the guard the agent provides says the chain is clear: the
// guard reads the relays, and a fork (another device moved from the same
// point meanwhile) drops the entry with a note, while relays that cannot be
// read leave it pending rather than publish blind.

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
  /** Why it was dropped, when it was. */
  dropped?: string
}

/**
 * What the guard says about sending an event no relay has taken: clear
 * (send), fork (drop, with the reason), or unknown (the relays could not
 * say; leave it pending, with the reason).
 */
export type GuardVerdict = { verdict: 'clear' } | { verdict: 'fork'; reason: string } | { verdict: 'unknown'; reason: string }

interface OutboxFile { version: 1; entries: OutboxEntry[] }

const FILE = 'outbox.json'
/** First wait before the canonical relay is asked again; doubles up to the cap. */
export const CANONICAL_RETRY_MS = 5_000
const RETRY_MAX_MS = 60_000
/** Refused and dropped entries kept for the outbox tool to show. */
const HISTORY_KEPT = 50

export interface OutboxOptions {
  log?: (line: string) => void
  /** Called when a relay takes an event, so the chain's published status and the holders follow. */
  onAccepted?: (event: NostrEvent, urls: string[]) => void
  /** Asked before an event no relay has taken is sent, at replay and at every retry. Without one, such events are sent. */
  guard?: (event: NostrEvent) => Promise<GuardVerdict>
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
  private readonly guard?: (event: NostrEvent) => Promise<GuardVerdict>
  private stopped = false

  constructor(private readonly dir: StateDir, private readonly relays: Relays, opts: OutboxOptions = {}) {
    const saved = dir.readJson<OutboxFile | null>(FILE, null)
    this.entries = saved?.version === 1 && Array.isArray(saved.entries) ? saved.entries : []
    this.retryMs = opts.retryMs ?? CANONICAL_RETRY_MS
    this.backoff = this.retryMs
    this.log = opts.log ?? (() => {})
    this.onAccepted = opts.onAccepted
    this.guard = opts.guard
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
   * retry when the canonical relay did not take it and did not refuse it.
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

  /**
   * Whether an entry may be sent now. An event some relay already took is
   * public, so re-sending it changes nothing about forks; one no relay has
   * taken is asked of the guard. Resolves to the reason it must wait or be
   * dropped, or null when it may go.
   */
  private async guarded(entry: OutboxEntry): Promise<'send' | 'wait' | 'dropped'> {
    if (entry.accepted.length > 0 || !this.guard) return 'send'
    const g = await this.guard(entry.event).catch((err): GuardVerdict => ({ verdict: 'unknown', reason: `the guard failed: ${err instanceof Error ? err.message : String(err)}` }))
    if (g.verdict === 'clear') return 'send'
    if (g.verdict === 'fork') {
      entry.dropped = g.reason
      this.save()
      return 'dropped'
    }
    entry.lastError = g.reason
    this.save()
    return 'wait'
  }

  private scheduleRetry(): void {
    if (this.stopped || this.timer !== null || this.pending().length === 0) return
    this.timer = setTimeout(() => { this.timer = null; void this.retry() }, this.backoff)
  }

  /** Ask the relays once more for everything pending, each entry through the guard first. */
  async retry(): Promise<void> {
    if (this.stopped) return
    let allSettled = true
    for (const entry of this.pending()) {
      const may = await this.guarded(entry)
      if (may === 'dropped') continue
      if (may === 'wait') { allSettled = false; continue }
      await this.send(entry).catch((err) => this.log(`retry failed: ${err instanceof Error ? err.message : String(err)}`))
      if (!this.settled(entry)) allSettled = false
    }
    if (allSettled || this.pending().length === 0) { this.backoff = this.retryMs; return }
    this.backoff = Math.min(this.backoff * 2, RETRY_MAX_MS)
    if (this.timer === null && !this.stopped) this.timer = setTimeout(() => { this.timer = null; void this.retry() }, this.backoff)
  }

  /**
   * At startup: every pending entry goes through the guard. Clear ones are
   * sent, forks are dropped with the reason, unknown ones stay pending and
   * the retry asks again.
   */
  async replay(): Promise<{ sent: OutboxEntry[]; dropped: OutboxEntry[]; waiting: OutboxEntry[] }> {
    const sent: OutboxEntry[] = []
    const dropped: OutboxEntry[] = []
    const waiting: OutboxEntry[] = []
    for (const entry of this.pending()) {
      const may = await this.guarded(entry)
      if (may === 'dropped') { dropped.push(entry); continue }
      if (may === 'wait') { waiting.push(entry); continue }
      await this.send(entry).catch((err) => this.log(`replay failed: ${err instanceof Error ? err.message : String(err)}`))
      sent.push(entry)
    }
    if (waiting.length > 0) this.scheduleRetry()
    return { sent, dropped, waiting }
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
