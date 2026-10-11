// travel.ts: the travel log (agents plan A4; arkinox, 2026-10-11). A travel
// log is a public kind 1 note the agent signs about where it went and what
// it saw, so people can follow its journeys. Everything else the agent says
// to its operator is a private DM; the travel log is the one public
// narrative, so it is off unless the human turns it on (--travel-log or
// travelLog in config.json), never by a tool, and it is rate limited.
//
//   - Where it goes: the agent's own NIP-65 write relays (its kind 10002),
//     or, when it has none, the general relays the DM code looks things up
//     on (GENERAL_RELAYS), and then the server publishes a kind 10002 naming
//     those, so readers find the notes where NIP-65 says to look. Never the
//     canonical relay: the cyberspace relays hold movement and refuse kind 1.
//   - What it carries: the model's text, bounded; the client tag; a t tag
//     "cyberspace"; and, unless the call says not to, the place as the spec
//     writes places (a C tag with the coordinate, whose low bit is the plane,
//     and the sector tags X, Y, Z and S computed from it, spec 2 and 10).
//   - What it never carries: the operator. No p tag and no mention of the
//     operator unless the human configured tagOperator. Text that repeats the
//     STRATEGY or a DM read or sent this session is refused: private orders
//     stay private.
//   - Nothing here makes another tool wait: the relay list is read in the
//     background, a post waits for the relays a few seconds at most and then
//     finishes on its own, and no head or lock is held.

import { nip19 } from 'nostr-tools'
import { normalizeURL } from 'nostr-tools/utils'
import type { EventTemplate, NostrEvent } from './nostr/event.js'
import { normalizeRelay, type PublishResult, type Relays } from './nostr/relays.js'
import { describePlace, sectorTags, type Place } from './space/coords.js'
import type { StateDir } from './state/dir.js'
import { Refusal, type ToolResult } from './tool.js'

const FILE = 'travel.json'
/** NIP-65 relay list. */
export const RELAY_LIST_KIND = 10002
/** The longest travel log note, in characters. */
export const MAX_TRAVEL_LOG = 1000
/** Posts a day when the human turned the log on and named no limit. */
export const DEFAULT_TRAVEL_PER_DAY = 6
/** The window the daily limit counts in: any 24 hours, not the calendar day, so a restart or midnight resets nothing. */
const DAY_S = 24 * 60 * 60
/** How long a post waits for the relays before it answers and finishes in the background. */
const POST_WAIT_MS = 4000
/** How long a post waits for a relay list still being read before it uses the defaults. */
const LIST_WAIT_MS = 2500
/** A private text repeated for this many characters in a row (spaces and case aside) is a leak. */
const LEAK_RUN = 40
/** A private text shorter than this is too common to match ("hold", "keep going"). */
const LEAK_MIN = 16

export interface TravelLogSettings {
  enabled: boolean
  maxPerDay: number
  /** The human allows the note to name the operator (a p tag, and mentions in the text). Off by default. */
  tagOperator: boolean
}

interface TravelFile {
  version: 1
  /** Unix seconds of each post in the last day, oldest first. */
  posts: number[]
  /** The write relays last resolved, and where they came from. */
  relays: { urls: string[]; source: 'own' | 'published'; at: number; eventId?: string } | null
}

const EMPTY: TravelFile = { version: 1, posts: [], relays: null }

export interface TravelLogDeps {
  settings: TravelLogSettings
  pubkey: string
  relays: Relays
  dir: StateDir
  /** The general relays: where the agent's kind 10002 is looked for, and its write relays when it has none. */
  defaults: string[]
  /** Every pubkey that is or may be the operator (the profile's and the configured), hex; and the one a p tag may name, or null. */
  operators: () => { all: string[]; tag: string | null }
  /** Where the agent stands, and whether that is a place on a chain (false before the spawn). */
  place: () => { place: Place; onChain: boolean }
  /** The private texts of this session: the STRATEGY and every DM read or sent. */
  privateTexts: () => string[]
  sign: (template: EventTemplate) => NostrEvent
  now: () => number
  log: (line: string) => void
  maxWaitMs?: number
}

function norm(url: string): string | null {
  const n = normalizeRelay(url)
  return n ? normalizeURL(n) : null
}

function unique(urls: string[]): string[] {
  return [...new Set(urls.map(norm).filter((u): u is string => !!u))]
}

/** The write relays a kind 10002 names: r tags without a marker or marked write (NIP-65), valid URLs, each once. */
export function writeRelaysOf(ev: Pick<NostrEvent, 'tags'>): string[] {
  return unique(ev.tags.filter((t) => t[0] === 'r' && typeof t[1] === 'string' && (t[2] === undefined || t[2] === '' || t[2] === 'write')).map((t) => t[1]))
}

function squash(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Whether `text` repeats a private text: all of a short one, or any LEAK_RUN characters in a row of a long one. */
export function repeatsPrivate(text: string, privates: string[]): boolean {
  const t = squash(text)
  for (const raw of privates) {
    const p = squash(raw)
    if (p.length < LEAK_MIN) continue
    if (p.length <= LEAK_RUN) { if (t.includes(p)) return true; continue }
    for (let i = 0; i + LEAK_RUN <= p.length; i++) if (t.includes(p.slice(i, i + LEAK_RUN))) return true
  }
  return false
}

/**
 * Whether `text` names this pubkey: its hex, an npub or nprofile of it, or
 * an nevent or naddr that names it as the author, with or without nostr:.
 */
export function namesPubkey(text: string, pubkey: string): boolean {
  const lower = text.toLowerCase()
  if (lower.includes(pubkey)) return true
  for (const m of lower.matchAll(/\b((?:npub|nprofile|nevent|naddr)1[02-9ac-hj-np-z]+)\b/g)) {
    try {
      const d = nip19.decode(m[1] as `${string}1${string}`)
      if (d.type === 'npub' && d.data === pubkey) return true
      if (d.type === 'nprofile' && d.data.pubkey === pubkey) return true
      if (d.type === 'nevent' && d.data.author === pubkey) return true
      if (d.type === 'naddr' && d.data.pubkey === pubkey) return true
    } catch { /* not an entity */ }
  }
  return false
}

export class TravelLog {
  private state: TravelFile
  private resolving: Promise<string[] | null> | null = null
  private resolvedThisSession = false

  constructor(private readonly deps: TravelLogDeps) {
    const saved = deps.dir.readJson<TravelFile | null>(FILE, null)
    this.state = saved?.version === 1 ? { ...EMPTY, ...saved } : { ...EMPTY }
  }

  get enabled(): boolean {
    return this.deps.settings.enabled
  }

  private save(): void {
    this.deps.dir.writeJson(FILE, this.state)
  }

  /** At start: read the relay list in the background when the log is on, so the first post does not wait for it. */
  start(): void {
    if (this.enabled) void this.resolveRelays()
  }

  private get canonical(): string {
    return this.deps.relays.canonical
  }

  /**
   * The agent's write relays, read from its kind 10002 on the general and
   * configured relays. With none found where some relay answered, the
   * defaults are published as its kind 10002 and used. Null when no relay
   * answered: the defaults are used for now and nothing is published.
   */
  resolveRelays(): Promise<string[] | null> {
    this.resolving ??= this.readRelayList()
      .catch((err) => { this.deps.log(`travel log: relay list: ${err instanceof Error ? err.message : String(err)}`); return null })
      .finally(() => { this.resolving = null })
    return this.resolving
  }

  private async readRelayList(): Promise<string[] | null> {
    const where = unique([...this.deps.defaults, ...this.deps.relays.urls])
    const answers = await this.deps.relays.queryEach({ kinds: [RELAY_LIST_KIND], authors: [this.deps.pubkey] }, this.deps.maxWaitMs, where)
    if (!answers.some((a) => a.outcome === 'answered')) {
      this.deps.log(`travel log: no relay answered for the agent's relay list (kind 10002); posting to the defaults for now`)
      return null
    }
    const own = answers.flatMap((a) => a.events).filter((e) => e.kind === RELAY_LIST_KIND && e.pubkey === this.deps.pubkey)
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))[0]
    if (own) {
      const urls = writeRelaysOf(own)
      this.state.relays = { urls, source: 'own', at: this.deps.now(), eventId: own.id }
      this.save()
      this.resolvedThisSession = true
      return urls
    }
    // A list this server published before and a relay lost (or one that did not answer holds) is not signed again: its relays are used.
    if (this.state.relays?.source === 'published') {
      this.resolvedThisSession = true
      return this.state.relays.urls
    }
    const urls = unique(this.deps.defaults)
    // The list is written as people write relay URLs (no trailing slash); the sockets use the normalized form.
    const written = [...new Set(this.deps.defaults.map((u) => normalizeRelay(u)).filter((u): u is string => !!u))]
    const event = this.deps.sign({ kind: RELAY_LIST_KIND, created_at: this.deps.now(), tags: written.map((u) => ['r', u]), content: '' })
    const result = await this.deps.relays.publishMany(urls, event)
    this.deps.log(`travel log: the agent had no relay list; published its kind 10002 (${urls.join(', ')}) ${result.ok ? `accepted by ${result.accepted.join(', ')}` : `taken by no relay (${result.reason})`}`)
    if (result.ok) {
      this.state.relays = { urls, source: 'published', at: this.deps.now(), eventId: event.id }
      this.save()
      this.resolvedThisSession = true
    }
    return urls
  }

  /** Where a post goes now: the known write relays without the canonical relay, else the defaults. Waits briefly for a first read. */
  private async targets(): Promise<{ urls: string[]; source: string }> {
    let known = this.state.relays?.urls ?? null
    if (!this.resolvedThisSession) {
      const reading = this.resolveRelays()
      if (!known) known = await Promise.race([reading, new Promise<null>((r) => setTimeout(() => r(null), LIST_WAIT_MS))])
    }
    const canonical = this.canonical
    const fromList = (known ?? []).filter((u) => u !== canonical)
    if (fromList.length) return { urls: fromList, source: this.state.relays?.source === 'own' ? 'your relay list (kind 10002)' : 'your relay list (kind 10002, published by this server with the general relays)' }
    return { urls: unique(this.deps.defaults).filter((u) => u !== canonical), source: 'the general relays (no relay list of yours was found yet)' }
  }

  /** Posts in the last day, pruned. */
  private recent(now: number): number[] {
    this.state.posts = this.state.posts.filter((t) => t > now - DAY_S)
    return this.state.posts
  }

  /** The state, for the tool's refusals and the budget. */
  status(): { enabled: boolean; maxPerDay: number; postedToday: number; left: number } {
    const posted = this.recent(this.deps.now()).length
    return { enabled: this.enabled, maxPerDay: this.deps.settings.maxPerDay, postedToday: posted, left: Math.max(0, this.deps.settings.maxPerDay - posted) }
  }

  /** The log_travel tool. */
  async post(input: { text: string; place?: boolean }): Promise<ToolResult> {
    const { settings } = this.deps
    if (!settings.enabled) {
      throw new Refusal('Your travel log is off. It is a public note anyone can read, so only your human can turn it on, by starting this server with --travel-log (or travelLog.enabled in config.json). Nothing was posted. Tell your operator about your travels with message_operator instead.')
    }
    const text = input.text.trim()
    if (!text) throw new Refusal('Write something: the travel log entry is empty.')
    if (input.text.length > MAX_TRAVEL_LOG) throw new Refusal(`The entry is ${input.text.length} characters; the most is ${MAX_TRAVEL_LOG}. Shorten it.`)
    const operators = this.deps.operators()
    if (!settings.tagOperator && operators.all.some((k) => namesPubkey(text, k))) {
      throw new Refusal('The entry names your operator. Your travel log is public, and your human has not allowed it to name them, so leave them out. Nothing was posted.')
    }
    if (repeatsPrivate(text, this.deps.privateTexts())) {
      throw new Refusal('The entry repeats your operator\'s private words (a DM or the STRATEGY). Your travel log is public: describe where you went and what you saw in your own words, and never what your operator told you. Nothing was posted.')
    }
    const now = this.deps.now()
    const posts = this.recent(now)
    if (posts.length >= settings.maxPerDay) {
      const next = posts[0] + DAY_S
      throw new Refusal(`You have posted ${posts.length} travel log entries in the last 24 hours, the most your human allows. The next one may go after ${new Date(next * 1000).toISOString()}. Nothing was posted.`)
    }
    // The slot is taken before anything is awaited, so two calls at once cannot pass the limit.
    posts.push(now)
    this.save()

    const tags: string[][] = [['t', 'cyberspace']]
    const where = this.deps.place()
    const withPlace = input.place !== false && where.onChain
    if (withPlace) tags.push(['C', where.place.hex], ...sectorTags(where.place.position))
    if (operators.tag && settings.tagOperator) tags.push(['p', operators.tag])
    const event = this.deps.sign({ kind: 1, created_at: now, tags, content: text })

    const targets = await this.targets()
    if (targets.urls.length === 0) {
      this.unpost(now)
      throw new Refusal('There is no relay to post the travel log to: your relay list names only the cyberspace relay, which holds movement and not notes. Nothing was posted.')
    }
    const sending = this.deps.relays.publishMany(targets.urls, event)
    const result = await Promise.race([sending, new Promise<null>((r) => setTimeout(() => r(null), POST_WAIT_MS))])
    const placeWords = withPlace ? ` It is tagged with your place, ${describePlace(where.place).hex.slice(0, 16)}... in ${describePlace(where.place).planeName} (sector ${describePlace(where.place).sector}).` : ''
    const left = Math.max(0, settings.maxPerDay - this.recent(now).length)
    const data = { id: event.id, kind: 1, relays: targets.urls, source: targets.source, place: withPlace ? where.place.hex : null, left, maxPerDay: settings.maxPerDay }
    if (result === null) {
      void sending.then((r) => this.deps.log(`travel log ${event.id.slice(0, 8)}: ${r.ok ? `accepted by ${r.accepted.join(', ')}` : `taken by no relay (${r.reason})`}`), () => {})
      return { text: `Travel log entry signed (${event.id.slice(0, 8)}...) and still being sent to ${targets.urls.join(', ')} (${targets.source}); the relays had not all answered in ${POST_WAIT_MS / 1000} s, and it finishes on its own.${placeWords} It is public. Entries left in the last 24 hours: ${left}.`, data: { ...data, accepted: [], pending: true } }
    }
    if (!result.ok) {
      this.unpost(now)
      throw new Refusal(`Not posted: no relay took the travel log entry (${reasonsWords(result)}). The relays' words are verbatim. It does not count against your daily limit.`)
    }
    return {
      text: `Posted to your public travel log (kind 1, ${event.id.slice(0, 8)}...): accepted by ${result.accepted.join(', ')} (${targets.source})${Object.keys(result.reasons).length ? `; not by ${reasonsWords(result)}` : ''}.${placeWords} Entries left in the last 24 hours: ${left}.`,
      data: { ...data, accepted: result.accepted, reasons: result.reasons, pending: false },
    }
  }

  /** Give back the slot of a post no relay took. */
  private unpost(at: number): void {
    const i = this.state.posts.lastIndexOf(at)
    if (i >= 0) this.state.posts.splice(i, 1)
    this.save()
  }
}

function reasonsWords(r: PublishResult): string {
  const entries = Object.entries(r.reasons)
  return entries.length ? entries.map(([u, why]) => `${u}: ${why}`).join('; ') : r.ok ? 'none' : r.reason
}
