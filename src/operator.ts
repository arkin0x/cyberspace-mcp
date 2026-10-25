// operator.ts: the private channel between the agent and its operator, by
// the operator DM contract (arkinox, 2026-10-10). Everything is a NIP-17 DM
// (nostr/dm.ts); nothing about it is public except the agent's own kind
// 10050, which names where the agent reads its DMs and carries no message.
//
//   - Inbox relays. The agent copies its operator's kind 10050: when the
//     operator lists DM relays and the agent's own list names a different
//     set (compared as normalized URLs), the agent publishes its kind 10050
//     with the same relay tags. An operator with no kind 10050 gets nothing
//     sent, and the tools say so plainly. The cyberspace relays are never
//     used for DMs; reading a kind 1059 needs NIP-42 AUTH, which the relay
//     client (relays.ts) does with the agent's key.
//   - Who the agent obeys. A message is an order only when its seal is
//     signed by the operator named in the agent's own kind 0, the rumor's
//     pubkey is the seal's, and the operator's newest kind 3 follows the
//     agent. Everything else is counted and never shown. An operator's
//     message that arrives before the operator follows the agent waits,
//     unread, until the follow is there.
//   - STRATEGY. The newest operator message carrying ["agent", "strategy"]
//     is the agent's standing orders, kept in the state directory so a
//     restart keeps it.
//   - CONTINUE (arkinox, 2026-10-11). An operator message carrying
//     ["agent", "continue"], read by inbox under the same rules, renews the
//     session budget (a fresh session of the configured cap; the cap is
//     never raised). Each such message renews once, ever: its rumor id is
//     recorded in the state directory before the inbox answers, so a second
//     wrap of it, a reread or a restart renews nothing. The words "keep
//     going" without the tag renew nothing, so neither the model nor text
//     read in cyberspace can grant budget.
//   - SEEN (arkinox, 2026-10-12: "ALWAYS react to the message with an 👀
//     emoji immediately when he sees it"). The first time the server sees an
//     order (by the rules above), in its own background poll, orders_waiting
//     or inbox, whichever comes first, it sends the operator a private kind 7
//     reaction "👀" to that message (nostr/dm.ts), on the operator's DM
//     relays, with a copy to itself. Once per message, ever: the rumor id is
//     recorded in the state directory before the reaction is sent, so a
//     second wrap, a reread or a restart never reacts twice. Never to the
//     agent's own messages, a stranger's, a reaction, or a message that
//     waits for the operator's follow. Sending never holds up the caller: it
//     runs in the background, and a failure is logged and retried once.
//   - STOP (arkinox, 2026-10-25: HOLD becomes a real control). An operator
//     message carrying ["agent", "stop"], read under the same rules, is a
//     control, never an order: the first time the server sees it (in its
//     poll, orders_waiting or inbox) it marks the wrap read, records the
//     rumor id in the state directory (each STOP acts once, ever), and hands
//     its targets (its e tags; none means every open job) to onStop, which
//     stops the turn, pauses the ride and closes the jobs. inbox never
//     returns it and it wakes no turn. A STOP halts everything (the
//     coordinator's ruling, 2026-10-25): halted() holds until the operator's
//     next message (a DM or an order in local chat; a reaction is not a
//     message), and an order it covers is read and dropped unread, never
//     counted, so no turn starts for it. A STOP covers the orders it names;
//     one that names none covers the unread orders the server had seen
//     before it saw the STOP, and, within that same check, those written
//     strictly before it. Coverage goes by the server's sight, not by the
//     operator's clocks, so a fresh order from a device whose clock lags is
//     never dropped by a STOP the server saw first (follow-up to #45). When
//     a STOP begins a halt, the operator gets one short DM saying so. A fresh state directory does
//     not act on a STOP older than the read window, as it sends no 👀 there.
//   - Job status (arkinox, 2026-10-25). status() sends the operator the same
//     private kind 7 as the 👀, with the job's state as its content (⚙️, ✅,
//     ⚠️, ⏹️), for chat orders too (with ["k", "23333"]); the waker decides
//     when and sends each once.
//   - The poll (arkinox, 2026-10-12: "Anything we can do to improve the
//     performance of the chat and responsiveness of the agent"). While an
//     operator may give orders, the server itself checks for new orders every
//     15 s, one check at a time, so the eyes arrive within seconds even in
//     the middle of a long turn, and every tool result can say NEW ORDERS
//     (newOrders) until inbox reads them.
//
// The key stays in the agent: this module gets a wrap and an unwrap function,
// never the secret. Nothing here logs a message's text.

import { nip19 } from 'nostr-tools'
import type { Filter } from 'nostr-tools/filter'
import { normalizeURL } from 'nostr-tools/utils'
import { DM_RELAYS_KIND, MAX_BACKDATE_SECONDS, RUMOR_KIND, SEEN_REACTION, WRAP_KIND, dmRelaysOf, isContinue, isStop, isStrategy, sameRelaySet, stopTargets, type Rumor, type Unwrapped, type WrappedMessage } from './nostr/dm.js'
import type { EventTemplate, NostrEvent } from './nostr/event.js'
import { mergeAnswers, type RelayAnswer } from './nostr/relayOutcome.js'
import { normalizeRelay, type Relays } from './nostr/relays.js'
import type { StateDir } from './state/dir.js'
import { Refusal, type ToolResult } from './tool.js'

const FILE = 'dms.json'
/** Contact lists. */
const CONTACTS_KIND = 3
/** How long ordersWaiting reuses the operator's lists (kind 10050 and kind 3) before reading them again. */
const FACTS_REUSE_S = 300
/** What inbox says with every new order (arkinox, 2026-10-12). */
export const ACKNOWLEDGE = 'Before starting work that takes more than a minute, tell your operator with message_operator in one short line what you are about to do ("On it: planting flowers around the disco floor."), not the plan.'
/** The longest message the agent sends its operator. */
export const MAX_OPERATOR_MESSAGE = 4000
/** How far back of the last read the inbox is asked again: a wrap is backdated up to two days, plus slack for clocks. */
const REREAD_WINDOW_S = MAX_BACKDATE_SECONDS + 60 * 60
/** The most wraps asked for on a first read, when there is no last read to start from. */
const FIRST_READ_LIMIT = 500
/** How long an operator's message waits for the operator's follow before it is forgotten. */
const WAITING_KEPT_S = 30 * 24 * 60 * 60

/** One order from the operator, as the inbox tool returns it. */
export interface OperatorMessage {
  id: string
  /** Unix seconds, as the operator's client stamped the rumor. */
  at: number
  text: string
  strategy: boolean
  /** The operator's CONTINUE (KEEP GOING), which renews the session budget. */
  continue: boolean
}

export interface Strategy {
  /** The rumor's id. */
  id: string
  text: string
  at: number
  /** The operator who set it, hex. A STRATEGY from an earlier operator is not shown. */
  from: string
}

interface DmsFile {
  version: 1
  strategy: Strategy | null
  /** Wraps handled (read, ignored, or the agent's own copies), by id, with the wrap's created_at for pruning. */
  seen: Record<string, number>
  /** Operator wraps that wait for the operator's follow, by id, with the wrap's created_at. */
  waiting: Record<string, number>
  /** Our clock at the last read of the inbox relays. */
  lastReadAt: number | null
  /** Messages ignored over the agent's life: not from the operator, or unreadable. */
  ignoredTotal: number
  /** The agent's kind 10050 as this server last published it. */
  published: { relays: string[]; eventId: string; at: number; accepted: string[] } | null
  /** CONTINUE orders that renewed the session budget, by rumor id, with our clock at the renewal: each renews once, ever. */
  renewals: Record<string, number>
  /** Orders the agent reacted to with 👀, by rumor id, with our clock when it was decided: each gets one, ever (arkinox, 2026-10-12). */
  reacted: Record<string, number>
  /** STOPs acted on, by rumor id, with our clock: each acts once, ever (arkinox, 2026-10-25). */
  stops: Record<string, number>
  /** Orders a STOP named, by rumor id, with our clock: read and dropped unread. */
  stoppedOrders: Record<string, number>
  /** Our clock when a STOP halted everything, until the operator's next message; null when not halted. */
  haltedAt: number | null
}

const EMPTY: DmsFile = { version: 1, strategy: null, seen: {}, waiting: {}, lastReadAt: null, ignoredTotal: 0, published: null, renewals: {}, reacted: {}, stops: {}, stoppedOrders: {}, haltedAt: null }
/** How long a 👀 mark is kept: longer than any read can return the message (a follow is waited for 30 days), plus a day. */
const REACTED_KEPT_S = WAITING_KEPT_S + REREAD_WINDOW_S + 24 * 60 * 60
/** How many 👀 marks are kept at most, newest first. */
const REACTED_MAX = 2000
/** How often the server checks for new orders on its own. */
export const ORDERS_POLL_MS = 15_000
/** How long a failed 👀 waits before its one retry. */
const REACTION_RETRY_MS = 5_000

/** What one check of the DM inbox found: the orders it counted, and which wraps they came in, so a read can retire them. */
interface OrdersCheck {
  /** The operator's unread messages that are orders now, by wrap id, with their rumor id. */
  orders: Map<string, string>
  strategy: boolean
  keepGoing: boolean
  /** The operator's messages that wait for their follow. */
  held: number
  facts: OperatorFacts
}
/** How many renewals are remembered; older ones fall long before any read window could return their wraps. */
const RENEWALS_KEPT = 500
/** How many DMs of this session the travel log's leak check remembers. */
const SPOKEN_KEPT = 200

/** A relay URL as the relay client keys it, or null when it is not a ws(s) URL with a real host. */
export function normalizeDmRelay(url: string): string | null {
  const n = normalizeRelay(url)
  return n ? normalizeURL(n) : null
}

/** What the relays said about the operator. */
interface OperatorFacts {
  operator: string
  /** The operator's DM relays, normalized; empty when the operator lists none. */
  inbox: string[]
  /** The relay tags exactly as the operator wrote them, valid ones only. */
  inboxTags: string[]
  /** Whether any relay answered the question at all; false means "could not tell". */
  answered: boolean
  /** Whether the operator's newest kind 3 has a p tag for the agent; null when no kind 3 was found. */
  follows: boolean | null
  /** The agent's own kind 10050 relays as the relays show them, normalized. */
  mine: string[]
  /** Set when this sync published the agent's kind 10050. */
  publishedNow?: { accepted: string[]; reasons: Record<string, string> }
}

export interface OperatorChannelDeps {
  pubkey: string
  relays: Relays
  dir: StateDir
  /** The operator the agent's own kind 0 names, hex, or null. */
  operator: () => string | null
  /** Why no operator may give orders right now although the profile names one (a profile that contradicts the human's configuration), or null. */
  operatorProblem?: () => string | null
  /** Where the operator's kind 10050 and kind 3 and the agent's own kind 10050 are looked up, besides the configured relays. */
  lookupRelays: string[]
  /** Sign an ordinary event with the agent's key (the client tag is added). */
  sign: (template: EventTemplate) => NostrEvent
  /** Wrap a message to `recipient` with the agent's key, and to the agent itself. */
  wrap: (recipient: string, text: string) => WrappedMessage
  /** Open a gift wrap with the agent's key. */
  unwrap: (wrap: NostrEvent) => Unwrapped
  now: () => number
  log: (line: string) => void
  maxWaitMs?: number
  /** Renew the session budget for the operator's CONTINUE; returns the sentence that says what was renewed. */
  renew?: () => string
  /** Wrap a reaction (the 👀, or a job's status emoji) to the operator's message `eventId` with the agent's key, to them and to the agent itself; without it no reaction is sent. */
  wrapReaction?: (recipient: string, eventId: string, content?: string, extraTags?: string[][]) => WrappedMessage
  /** The operator's STOP, once per STOP: the orders it names (empty: every open job). Called after the read marks are saved. */
  onStop?: (targets: string[], stopId: string, haltBegan: boolean) => void
  /** Unread orders a STOP dropped, by rumor id, so they can show ⏹️. */
  onStoppedUnread?: (ids: string[]) => void
  /** How long a failed reaction waits before its one retry; for tests. */
  reactionRetryMs?: number
}

/** The newest event of a kind by an author among these; relays may answer with anything, so both are checked. */
function newest(events: NostrEvent[], kind: number, author: string): NostrEvent | undefined {
  return events.filter((e) => e.kind === kind && e.pubkey === author).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))[0]
}

function relaysWords(urls: string[]): string {
  return urls.length ? urls.join(', ') : 'none'
}

export class OperatorChannel {
  private state: DmsFile
  private syncing: Promise<OperatorFacts | null> | null = null
  /**
   * The texts of the DMs read and sent this session, newest last, in memory
   * only, so the travel log can refuse to repeat them in public (arkinox,
   * 2026-10-11). Never written to disk: dms.json keeps read marks, not words.
   */
  private readonly spoken: string[] = []
  private stopped = false
  /** The check in flight, shared by the poll and orders_waiting. */
  private checking: Promise<OrdersCheck> | null = null
  /** What the newest check found; the notice counts what of it is still unread. */
  private lastCheck: OrdersCheck | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  /** The last poll failure logged, so a relay that stays down is logged once, not every 15 s. */
  private pollError: string | null = null
  /** Reactions being sent in the background. */
  private readonly sending = new Set<Promise<void>>()
  /** STOPs claimed in this read that began a halt (none held before), until actOnStops hands them on. */
  private readonly haltsBegun = new Set<string>()
  /** Who wants to know when a check finds unread orders (wait_for). */
  private readonly ordersListeners = new Set<(count: number) => void>()

  constructor(private readonly deps: OperatorChannelDeps) {
    const saved = deps.dir.readJson<DmsFile | null>(FILE, null)
    this.state = saved?.version === 1 ? { ...EMPTY, ...saved } : { ...EMPTY }
    this.state.reacted ??= {}
    this.state.stops ??= {}
    this.state.stoppedOrders ??= {}
    // Coverage by a STOP's own clock was replaced by the server's sight (follow-up to #45): an old mark would drop fresh orders forever.
    delete (this.state as Partial<DmsFile> & { stoppedBefore?: unknown }).stoppedBefore
    this.state.haltedAt ??= null
  }

  /** Whether a STOP halted everything and no message from the operator has come since. */
  halted(): boolean {
    return this.state.haltedAt !== null
  }

  /** The operator spoke again (an order from local chat): the halt is over. */
  clearHalt(): void {
    if (this.state.haltedAt === null) return
    this.state.haltedAt = null
    this.save()
    this.deps.log('STOP: the halt is over (a new message from the operator)')
  }

  /**
   * Whether the operator follows the agent by the newest check, the rule an
   * order needs (kind 3), read from memory for callers that cannot wait:
   * the operator's chat lines are orders only while this holds.
   */
  followedNow(): boolean {
    const c = this.lastCheck
    return !!c && !this.deps.operatorProblem?.() && c.facts.operator === this.deps.operator() && c.facts.follows === true
  }

  /** When a STOP's halt began (unix seconds, our clock), or null when nothing is halted. */
  haltedSince(): number | null {
    return this.state.haltedAt
  }

  /** The line the status tools show while a STOP holds, or null. */
  haltLine(): string | null {
    const at = this.state.haltedAt
    return at === null ? null : `Held by your operator's STOP since ${new Date(at * 1000).toISOString()}: nothing starts until their next message (a DM, or an order in local chat).`
  }

  /**
   * Whether a STOP covers this unread order: one that names it, or, for a
   * STOP that names none read in this same check (`cut`, its created_at),
   * one written strictly before it. Orders the server had already seen when
   * it saw such a STOP were recorded in stoppedOrders then.
   */
  private stoppedOrder(rumor: { id: string; created_at: number }, cut: { at: number | null }): boolean {
    return this.state.stoppedOrders[rumor.id] !== undefined || (cut.at !== null && rumor.created_at < cut.at)
  }

  /** The unread orders the newest check saw, by rumor id: what a STOP that names none covers by sight. */
  private seenUnread(): Set<string> {
    return new Set(this.lastCheck ? this.lastCheck.orders.values() : [])
  }

  private save(): void {
    this.deps.dir.writeJson(FILE, this.state)
  }

  /** The current STRATEGY, when the operator who set it is still the operator. */
  strategy(): Strategy | null {
    if (this.deps.operatorProblem?.()) return null
    const op = this.deps.operator()
    return this.state.strategy && op && this.state.strategy.from === op ? this.state.strategy : null
  }

  /** One line for the status tools: the standing orders, or that there are none. */
  strategyLine(): string {
    const s = this.strategy()
    const line = s
      ? `STRATEGY (your operator's standing orders, set ${new Date(s.at * 1000).toISOString()}; reread them every turn): ${s.text}`
      : 'STRATEGY: none set by your operator. Check inbox at the start of every turn.'
    // An operator who pressed STOP days ago sees why the agent is idle (follow-up to #45).
    const halt = this.haltLine()
    return halt ? `${line}
${halt}` : line
  }

  stop(): void {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  /**
   * Check for new orders every `everyMs` in the background (arkinox,
   * 2026-10-12), while an operator may give orders: one check at a time,
   * never in the way of a tool, and a check that fails is logged once and
   * tried again at the next tick. The first 👀 of an order is sent from here
   * when no tool saw it first.
   */
  startPolling(everyMs: number = ORDERS_POLL_MS): void {
    if (this.pollTimer || this.stopped || everyMs <= 0) return
    this.pollTimer = setInterval(() => { void this.pollOnce() }, everyMs)
    this.pollTimer.unref?.()
  }

  /** One background check; nothing when no operator may give orders or a check is already running. */
  async pollOnce(): Promise<void> {
    if (this.stopped || this.checking || !this.deps.operator() || this.deps.operatorProblem?.()) return
    try {
      await this.check()
      this.pollError = null
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message !== this.pollError) this.deps.log(`orders poll: ${message}`)
      this.pollError = message
    }
  }

  /**
   * How many of the operator's orders wait unread, from the newest check:
   * what it counted minus what inbox has read since, so the count drops to
   * zero the moment inbox reads them. Zero when no operator may give orders.
   */
  unreadOrders(): number {
    if (!this.lastCheck || this.deps.operatorProblem?.() || this.deps.operator() !== this.lastCheck.facts.operator) return 0
    const left = new Set<string>()
    for (const [wrapId, rumorId] of this.lastCheck.orders) if (this.state.seen[wrapId] === undefined) left.add(rumorId)
    return left.size
  }

  /** Call `fn` with the count each time a check finds unread orders; returns the unsubscribe. */
  onOrders(fn: (count: number) => void): () => void {
    this.ordersListeners.add(fn)
    return () => { this.ordersListeners.delete(fn) }
  }

  /** Whether a reaction is being sent right now. */
  reacting(): boolean {
    return this.sending.size > 0
  }

  /** Resolves once every reaction sent so far has been delivered or given up on; for tests and a clean stop. */
  async reactionsSettled(): Promise<void> {
    while (this.sending.size > 0) await Promise.allSettled([...this.sending])
  }

  /**
   * Whether this order gets its 👀 now: it never had one, and it is not old
   * history read for the first time (a fresh state directory reads back up
   * to 500 wraps, and the operator is not sent eyes on last month's
   * messages). Records the mark when it does; the caller saves it before
   * anything is sent.
   */
  private claimReaction(rumor: { id: string; created_at: number }, now: number): boolean {
    if (!this.deps.wrapReaction || this.stopped || this.state.reacted[rumor.id] !== undefined) return false
    if (this.state.lastReadAt === null && rumor.created_at < now - REREAD_WINDOW_S) return false
    this.state.reacted[rumor.id] = now
    return true
  }

  /** Send the 👀 for these orders in the background, after their marks are saved. */
  private react(facts: OperatorFacts, rumorIds: string[]): void {
    const selfRelays = facts.mine.length ? facts.mine : facts.inbox
    for (const id of rumorIds) {
      const p = this.sendReaction(facts.operator, id, facts.inbox, selfRelays).catch((err) => {
        this.deps.log(`👀 for ${id.slice(0, 8)}... failed: ${err instanceof Error ? err.message : String(err)}`)
      })
      this.sending.add(p)
      void p.finally(() => this.sending.delete(p))
    }
  }

  /** One reaction: to the operator's DM relays, retried once on failure, then the agent's own copy. Logs ids and relay words, never a message. */
  private async sendReaction(operator: string, rumorId: string, inbox: string[], selfRelays: string[], content: string = SEEN_REACTION, extraTags: string[][] = []): Promise<void> {
    const wrapped = this.deps.wrapReaction!(operator, rumorId, content, extraTags)
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (this.stopped) return
      let why: string
      try {
        const sent = await this.deps.relays.publishMany(inbox, wrapped.toRecipient)
        if (sent.ok) {
          const mine = await this.deps.relays.publishMany(selfRelays, wrapped.toSelf)
          this.deps.log(`${content} sent for ${rumorId.slice(0, 8)}... (accepted by ${sent.accepted.join(', ')}${mine.ok ? '' : `; own copy not stored: ${mine.reason}`})`)
          return
        }
        why = Object.entries(sent.reasons).map(([u, r]) => `${u}: ${r}`).join('; ') || sent.reason
      } catch (err) {
        why = err instanceof Error ? err.message : String(err)
      }
      this.deps.log(`${content} for ${rumorId.slice(0, 8)}... not delivered (attempt ${attempt} of 2): ${why}`)
      if (attempt === 1) await new Promise((r) => setTimeout(r, this.deps.reactionRetryMs ?? REACTION_RETRY_MS))
    }
  }

  /**
   * A job's status on the operator's order `rumorId` (arkinox, 2026-10-25):
   * the private kind 7 the 👀 is, with `emoji` as its content, on the
   * operator's DM relays with a copy to the agent. The caller sends each
   * state once; this sends it now, in the background, and never throws.
   */
  status(rumorId: string, emoji: string, extraTags: string[][] = []): Promise<void> {
    const p = (async () => {
      if (!this.deps.wrapReaction || this.stopped || this.deps.operatorProblem?.()) return
      const facts = await this.cachedFacts()
      if (!facts || facts.inbox.length === 0) { this.deps.log(`${emoji} for ${rumorId.slice(0, 8)}... not sent: no DM inbox known for the operator`); return }
      await this.sendReaction(facts.operator, rumorId, facts.inbox, facts.mine.length ? facts.mine : facts.inbox, emoji, extraTags)
    })().catch((err) => { this.deps.log(`${emoji} for ${rumorId.slice(0, 8)}... failed: ${err instanceof Error ? err.message : String(err)}`) })
    this.sending.add(p)
    void p.finally(() => this.sending.delete(p))
    return p
  }

  /**
   * A STOP seen for the first time: recorded, so it acts once, ever. The
   * caller saves the record with the read marks, then calls actOnStops.
   */
  private claimStop(rumor: Rumor, now: number, seen: Set<string>, cut: { at: number | null }): boolean {
    if (this.state.stops[rumor.id] !== undefined) return false
    this.state.stops[rumor.id] = now
    // The 👀 path's age rule: a fresh state directory reading old history acts on no STOP.
    if (this.state.lastReadAt === null && rumor.created_at < now - REREAD_WINDOW_S) return false
    const targets = stopTargets(rumor)
    for (const id of targets) this.state.stoppedOrders[id] = now
    if (targets.length === 0) {
      // By sight: what the server had seen unread when it saw this STOP, and in this same check what was written strictly before it.
      for (const id of seen) this.state.stoppedOrders[id] = now
      cut.at = Math.max(cut.at ?? 0, rumor.created_at)
    }
    if (this.state.haltedAt === null) this.haltsBegun.add(rumor.id)
    this.state.haltedAt = now
    return true
  }

  /** The orders a STOP dropped unread, each once, for their ⏹️. */
  private droppedByStop(rumors: Rumor[]): void {
    const ids = [...new Set(rumors.map((r) => r.id))]
    if (ids.length === 0) return
    this.deps.log(`STOP: ${ids.length} unread order(s) dropped`)
    try { this.deps.onStoppedUnread?.(ids) } catch (err) { this.deps.log(`STOP: could not mark the dropped orders: ${err instanceof Error ? err.message : String(err)}`) }
  }

  /** Hand each STOP claimed to onStop, after its record is saved. Logs ids, never words. */
  private actOnStops(stops: Rumor[]): void {
    for (const r of stops) {
      const targets = stopTargets(r)
      this.deps.log(`STOP from the operator (${r.id.slice(0, 8)}...): ${targets.length ? `${targets.length} job(s)` : 'every open job'}`)
      const began = this.haltsBegun.delete(r.id)
      try { this.deps.onStop?.(targets, r.id, began) } catch (err) { this.deps.log(`STOP could not be carried out: ${err instanceof Error ? err.message : String(err)}`) }
    }
  }

  /** The private words of this session: the STRATEGY and the DMs read and sent, for the travel log's leak check. */
  privateTexts(): string[] {
    const s = this.strategy()
    return s ? [s.text, ...this.spoken] : [...this.spoken]
  }

  private remember(text: string): void {
    this.spoken.push(text)
    if (this.spoken.length > SPOKEN_KEPT) this.spoken.splice(0, this.spoken.length - SPOKEN_KEPT)
  }

  private where(): string[] {
    return [...new Set([...this.deps.lookupRelays, ...this.deps.relays.urls].map((u) => normalizeDmRelay(u)).filter((u): u is string => !!u))]
  }

  /**
   * Read the operator's kind 10050 and newest kind 3, and the agent's own
   * kind 10050; publish the agent's when it names a different set of relays
   * than the operator's. One sync at a time; a call during one shares it.
   */
  sync(): Promise<OperatorFacts | null> {
    if (!this.syncing) {
      this.syncing = this.doSync().finally(() => { this.syncing = null })
    }
    return this.syncing
  }

  private async doSync(): Promise<OperatorFacts | null> {
    const operator = this.deps.operator()
    if (!operator || this.stopped || this.deps.operatorProblem?.()) return null
    const me = this.deps.pubkey
    const answers = await this.deps.relays.queryEach({ kinds: [CONTACTS_KIND, DM_RELAYS_KIND], authors: [operator, me] }, this.deps.maxWaitMs, this.where())
    const answered = answers.some((a) => a.outcome === 'answered')
    const events = mergeAnswers(answers)
    const opInbox = newest(events, DM_RELAYS_KIND, operator)
    const contacts = newest(events, CONTACTS_KIND, operator)
    const own = newest(events, DM_RELAYS_KIND, me)
    const inbox = dmRelaysOf(opInbox, normalizeDmRelay)
    const inboxTags = (opInbox?.tags ?? []).filter((t) => t[0] === 'relay' && typeof t[1] === 'string' && normalizeDmRelay(t[1])).map((t) => t[1].trim())
    const mineSeen = dmRelaysOf(own, normalizeDmRelay)
    const facts: OperatorFacts = {
      operator, inbox, inboxTags: [...new Set(inboxTags)], answered,
      follows: contacts ? contacts.tags.some((t) => t[0] === 'p' && t[1] === me) : null,
      mine: mineSeen,
    }
    if (inbox.length === 0 || this.stopped) return facts
    // What the agent's own list is: what the relays show, or, when they show none, what this server last had accepted.
    const pub = this.state.published
    const mine = own ? mineSeen : pub && pub.accepted.length > 0 ? pub.relays : []
    if (sameRelaySet(mine, inbox)) {
      facts.mine = mine
      return facts
    }
    const event = this.deps.sign({ kind: DM_RELAYS_KIND, created_at: Math.max(this.deps.now(), (own?.created_at ?? 0) + 1), tags: facts.inboxTags.map((u) => ['relay', u]), content: '' })
    const targets = [...new Set([...this.where(), ...inbox])]
    const result = await this.deps.relays.publishMany(targets, event)
    const accepted = result.ok ? result.accepted : []
    this.state.published = { relays: inbox, eventId: event.id, at: event.created_at, accepted }
    this.save()
    facts.publishedNow = { accepted, reasons: result.reasons }
    if (accepted.length > 0) facts.mine = inbox
    this.deps.log(`kind 10050 (DM relays ${inbox.join(', ')}) ${accepted.length ? `accepted by ${accepted.join(', ')}` : 'taken by no relay'}`)
    return facts
  }

  /** The operator, or a refusal that says how to name one. */
  private requireOperator(): string {
    const problem = this.deps.operatorProblem?.()
    if (problem) throw new Refusal(problem)
    const op = this.deps.operator()
    if (!op) throw new Refusal('Your profile names no operator, so there is nobody to talk with. Call identity with operator (your human\'s npub), or have the server started with --operator.')
    return op
  }

  private noInboxWords(facts: OperatorFacts): string {
    return facts.answered
      ? `Your operator has no DM inbox: they publish no kind 10050 (the list of relays where they read private messages). Nothing can be sent to them or read from them until they publish one; ONOSENDAI's AGENTS panel says how.`
      : 'Could not reach any relay to read your operator\'s DM inbox list (kind 10050), so the operator\'s inbox is unknown. Try again later.'
  }

  /** Where the agent reads its DMs: its own kind 10050 as known, and the operator's set, which it copies. */
  private readRelays(facts: OperatorFacts): string[] {
    return [...new Set([...facts.mine, ...facts.inbox])]
  }

  /**
   * The inbox tool: new orders from the operator since the last read, oldest
   * first, the current STRATEGY, and how many messages were ignored. Marks
   * what it returns as read.
   */
  async inbox(): Promise<ToolResult> {
    const operator = this.requireOperator()
    const facts = await this.sync()
    if (!facts) throw new Refusal('The operator channel is closed.')
    const opNpub = nip19.npubEncode(operator)
    const strategyNow = (): Record<string, unknown> | null => { const s = this.strategy(); return s ? { ...s } : null }
    if (facts.inbox.length === 0) {
      return { text: [this.noInboxWords(facts), this.strategyLine()].join('\n'), data: { operator: opNpub, inbox: null, messages: [], strategy: strategyNow(), ignored: 0, noInbox: true } }
    }
    const urls = this.readRelays(facts)
    const now = this.deps.now()
    const filter: Filter = { kinds: [WRAP_KIND], '#p': [this.deps.pubkey] }
    const since = this.sinceForNextRead()
    if (since !== null) filter.since = since
    else filter.limit = FIRST_READ_LIMIT
    const answers: RelayAnswer[] = await this.deps.relays.queryEach(filter, this.deps.maxWaitMs, urls)
    const read = answers.filter((a) => a.outcome === 'answered')
    if (read.length === 0) {
      const why = answers.map((a) => `${a.url}: ${a.outcome === 'answered' ? 'answered' : a.reason}`).join('; ')
      throw new Refusal(`Could not read your DM inbox on ${relaysWords(urls)}: ${why}. Nothing was marked read.`)
    }
    // From here to the save nothing is awaited, so a read that races this one sees these marks and hands out nothing twice.
    const following = facts.follows === true
    const orders: OperatorMessage[] = []
    const reactTo: string[] = []
    const stopping: Rumor[] = []
    const droppedStopped: Rumor[] = []
    const seenBefore = this.seenUnread()
    const cut: { at: number | null } = { at: null }
    let ignored = 0
    let waiting = 0
    for (const wrap of mergeAnswers(answers)) {
      if (wrap.kind !== WRAP_KIND || this.state.seen[wrap.id] !== undefined) continue
      const opened = this.deps.unwrap(wrap)
      const wasWaiting = this.state.waiting[wrap.id] !== undefined
      delete this.state.waiting[wrap.id]
      if (!opened.ok) { this.state.seen[wrap.id] = wrap.created_at; ignored++; continue }
      const { rumor } = opened
      // The agent's own copies of what it sent (messages and its 👀): history, not orders and not strangers.
      if (rumor.pubkey === this.deps.pubkey) { this.state.seen[wrap.id] = wrap.created_at; continue }
      const toMe = rumor.tags.some((t) => t[0] === 'p' && t[1] === this.deps.pubkey)
      if (rumor.pubkey !== operator || !toMe) { this.state.seen[wrap.id] = wrap.created_at; ignored++; continue }
      // The operator's reaction to one of the agent's messages: read, and never an order.
      if (rumor.kind !== RUMOR_KIND) { this.state.seen[wrap.id] = wrap.created_at; continue }
      if (!following) { this.state.waiting[wrap.id] = wrap.created_at; if (!wasWaiting) waiting++; continue }
      this.state.seen[wrap.id] = wrap.created_at
      if (this.claimReaction(rumor, now)) reactTo.push(rumor.id)
      // A STOP is a control the server carries out, never an order the model reads.
      if (isStop(rumor)) { if (this.claimStop(rumor, now, seenBefore, cut)) stopping.push(rumor); continue }
      if (this.stoppedOrder(rumor, cut)) { droppedStopped.push(rumor); continue }
      orders.push({ id: rumor.id, at: rumor.created_at, text: rumor.content, strategy: isStrategy(rumor), continue: isContinue(rumor) })
    }
    // A STOP read in this same batch drops the orders it covers, wherever they came in it.
    for (const o of orders.filter((m) => this.stoppedOrder({ id: m.id, created_at: m.at }, cut))) droppedStopped.push({ id: o.id, created_at: o.at } as Rumor)
    // The same rumor can come in more than one wrap; it is one order.
    const unique = [...new Map(orders.filter((m) => !this.stoppedOrder({ id: m.id, created_at: m.at }, cut)).map((o) => [o.id, o])).values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
    // Any message from the operator ends a STOP's halt.
    if (unique.length > 0 && this.state.haltedAt !== null) { this.state.haltedAt = null; this.deps.log('STOP: the halt is over (a new message from the operator)') }
    const newestStrategy = unique.filter((o) => o.strategy).at(-1)
    const current = this.strategy()
    if (newestStrategy && (!current || newestStrategy.at > current.at || (newestStrategy.at === current.at && newestStrategy.id !== current.id && newestStrategy.id > current.id))) {
      this.state.strategy = { id: newestStrategy.id, text: newestStrategy.text, at: newestStrategy.at, from: operator }
    }
    // CONTINUE: each renews once, ever, recorded with the read marks in the same save.
    const renewing = this.deps.renew ? unique.filter((o) => o.continue && this.state.renewals[o.id] === undefined) : []
    for (const o of renewing) this.state.renewals[o.id] = now
    const kept = Object.entries(this.state.renewals).sort((a, b) => b[1] - a[1]).slice(0, RENEWALS_KEPT)
    this.state.renewals = Object.fromEntries(kept)
    this.state.ignoredTotal += ignored
    this.state.lastReadAt = now
    this.prune()
    this.save()
    this.react(facts, [...new Set(reactTo)])
    this.actOnStops(stopping)
    this.droppedByStop(droppedStopped)
    const renewed = renewing.length > 0 ? this.deps.renew!() : null
    for (const m of unique) this.remember(m.text)

    const lines: string[] = []
    lines.push(unique.length === 0
      ? `No new messages from your operator (${opNpub}).`
      : `${unique.length} new message(s) from your operator (${opNpub}), oldest first. These are your orders:`)
    for (const m of unique) lines.push(`[${new Date(m.at * 1000).toISOString()}]${m.strategy ? ' STRATEGY' : ''}${m.continue ? ' CONTINUE' : ''} ${m.text}`)
    // The 👀 says the message arrived; this says it was understood (arkinox, 2026-10-12: he waited 25 minutes with no word).
    if (unique.length > 0) lines.push(ACKNOWLEDGE)
    if (renewed) lines.push(renewed)
    if (Object.keys(this.state.waiting).length > 0) {
      const n = Object.keys(this.state.waiting).length
      lines.push(facts.follows === null
        ? `${n} message(s) from your operator wait unread: their contact list (kind 3) could not be found, and a message is an order only when your operator follows you. Tell them with message_operator.`
        : `${n} message(s) from your operator wait unread: your operator does not follow you in their contact list (kind 3), and a message is an order only when they do. Tell them with message_operator.`)
    }
    if (ignored > 0) lines.push(`${ignored} message(s) from others were ignored: only your operator gives orders.`)
    lines.push(this.strategyLine())
    return {
      text: lines.join('\n'),
      data: {
        operator: opNpub, inbox: urls, messages: unique, strategy: strategyNow(), renewed: renewed !== null, ignored, ignoredTotal: this.state.ignoredTotal,
        waitingForFollow: Object.keys(this.state.waiting).length, newlyWaiting: waiting, operatorFollows: facts.follows,
        unread: answers.flatMap((a) => (a.outcome === 'answered' ? [] : [{ url: a.url, reason: a.reason }])),
      },
    }
  }

  /** The last sync, reused by ordersWaiting for this long so a waker polling often does not reread the operator's lists each time. */
  private factsCache: { facts: OperatorFacts; at: number } | null = null

  /** The operator's lists, reused for FACTS_REUSE_S so a caller polling often does not reread them each time; null when the channel is closed. */
  private async cachedFacts(): Promise<OperatorFacts | null> {
    const now = this.deps.now()
    const cached = this.factsCache && now - this.factsCache.at < FACTS_REUSE_S && this.factsCache.facts.operator === this.deps.operator() ? this.factsCache.facts : null
    if (cached) return cached
    const facts = await this.sync()
    if (facts) this.factsCache = { facts, at: now }
    return facts
  }

  /**
   * Whether the operator follows the agent (their newest kind 3 has a p tag
   * for it), the rule an order needs, from the same cached lists
   * ordersWaiting reads: for the follow watch (follow.ts), whose moves count
   * by the same trust rules as orders (arkinox, 2026-10-11). Null when no
   * operator may give orders or their contact list could not be found.
   */
  async operatorFollows(): Promise<boolean | null> {
    if (this.deps.operatorProblem?.() || !this.deps.operator()) return null
    return (await this.cachedFacts())?.follows ?? null
  }

  /**
   * Whether orders wait, without reading them (arkinox, 2026-10-11: the
   * agent waits for DMs from its operator). Counts the operator's messages
   * that inbox would return now, by the same rules (sealed by the operator,
   * addressed to the agent, the operator follows it), and marks nothing
   * read, so the inbox call that follows still returns them. For a waker
   * outside the model: it polls this, and starts a turn when orders wait.
   */
  async ordersWaiting(): Promise<ToolResult> {
    this.requireOperator()
    const c = await this.check()
    if (c.facts.inbox.length === 0) return { text: this.noInboxWords(c.facts), data: { orders: 0, continue: false, noInbox: true } }
    const orders = new Set(c.orders.values()).size
    const text = orders > 0
      ? `${orders} new message(s) from your operator wait${c.strategy ? ', including a STRATEGY' : ''}${c.keepGoing ? ', including a CONTINUE (KEEP GOING), which renews your session budget when inbox reads it' : ''}. Call inbox to read them.`
      : c.held > 0 ? `${c.held} message(s) from your operator wait for their follow; none are orders yet.` : 'No new orders.'
    return { text, data: { orders, strategy: c.strategy, continue: c.keepGoing, waitingForFollow: c.held } }
  }

  /** One check of the DM inbox at a time: the poll and orders_waiting share the one in flight. */
  private check(): Promise<OrdersCheck> {
    if (!this.checking) this.checking = this.doCheck().finally(() => { this.checking = null })
    return this.checking
  }

  /**
   * Count the operator's unread orders by inbox's rules, marking nothing
   * read, and send the 👀 for each order seen for the first time. The
   * reaction marks are saved before anything is sent.
   */
  private async doCheck(): Promise<OrdersCheck> {
    const operator = this.requireOperator()
    const facts = await this.cachedFacts()
    if (!facts) throw new Refusal('The operator channel is closed.')
    const empty: OrdersCheck = { orders: new Map(), strategy: false, keepGoing: false, held: 0, facts }
    if (facts.inbox.length === 0) { this.lastCheck = empty; return empty }
    const filter: Filter = { kinds: [WRAP_KIND], '#p': [this.deps.pubkey] }
    const since = this.sinceForNextRead()
    if (since !== null) filter.since = since
    else filter.limit = FIRST_READ_LIMIT
    const answers: RelayAnswer[] = await this.deps.relays.queryEach(filter, this.deps.maxWaitMs, this.readRelays(facts))
    if (!answers.some((a) => a.outcome === 'answered')) {
      throw new Refusal(`Could not read your DM inbox: ${answers.map((a) => `${a.url}: ${a.outcome === 'answered' ? 'answered' : a.reason}`).join('; ')}.`)
    }
    // The operator may have changed, or stopped following, while the relays answered: the rules are read now.
    const following = facts.follows === true && this.deps.operator() === operator
    const found = new Map<string, string>()
    let strategy = false
    let keepGoing = false
    let marked = false
    const reactTo: string[] = []
    const stopping: Rumor[] = []
    const seenOrders: Array<{ wrap: NostrEvent; rumor: Rumor }> = []
    const seenBefore = this.seenUnread()
    const cut: { at: number | null } = { at: null }
    const now = this.deps.now()
    // From here to the save nothing is awaited, so inbox and this check never both claim one 👀.
    for (const wrap of mergeAnswers(answers)) {
      if (wrap.kind !== WRAP_KIND || this.state.seen[wrap.id] !== undefined) continue
      const opened = this.deps.unwrap(wrap)
      if (!opened.ok) continue
      const { rumor } = opened
      // The agent's own copies are history, never orders, as in inbox.
      if (rumor.pubkey === this.deps.pubkey || rumor.pubkey !== operator || rumor.kind !== RUMOR_KIND || !rumor.tags.some((t) => t[0] === 'p' && t[1] === this.deps.pubkey)) continue
      // A STOP from the operator is carried out at once and read here: it is never an order, so nothing counts it or wakes a turn for it.
      if (isStop(rumor)) {
        if (!following) continue
        this.state.seen[wrap.id] = wrap.created_at
        if (this.claimReaction(rumor, now)) reactTo.push(rumor.id)
        if (this.claimStop(rumor, now, seenBefore, cut)) stopping.push(rumor)
        marked = true
        continue
      }
      seenOrders.push({ wrap, rumor })
      if (following && this.claimReaction(rumor, now)) reactTo.push(rumor.id)
    }
    // An order a STOP covers (one it names, or any written before a STOP that names none) is read now and dropped: no count, no turn.
    const droppedStopped: Rumor[] = []
    for (const { wrap, rumor } of seenOrders) {
      if (following && this.stoppedOrder(rumor, cut)) {
        this.state.seen[wrap.id] = wrap.created_at
        droppedStopped.push(rumor)
        marked = true
        continue
      }
      found.set(wrap.id, rumor.id)
      if (isStrategy(rumor)) strategy = true
      if (isContinue(rumor) && this.state.renewals[rumor.id] === undefined) keepGoing = true
    }
    if (reactTo.length > 0 || marked) {
      this.save()
      this.react(facts, [...new Set(reactTo)])
      this.actOnStops(stopping)
      this.droppedByStop(droppedStopped)
    }
    const result: OrdersCheck = following
      ? { orders: found, strategy, keepGoing, held: 0, facts }
      : { orders: new Map(), strategy: false, keepGoing: false, held: new Set(found.values()).size, facts }
    this.lastCheck = result
    const unread = this.unreadOrders()
    if (unread > 0) for (const fn of [...this.ordersListeners]) fn(unread)
    return result
  }

  /** Forget the wraps that fall before the next read's window. */
  private prune(): void {
    if (this.state.lastReadAt === null) return
    // An operator who never follows does not hold the read window open forever.
    const stale = this.state.lastReadAt - WAITING_KEPT_S
    for (const [id, at] of Object.entries(this.state.waiting)) if (at < stale) delete this.state.waiting[id]
    // A read mark is kept while the next read can still return its wrap: from the same floor that read asks from.
    const floor = (this.sinceForNextRead() ?? 0) - 60
    for (const [id, at] of Object.entries(this.state.seen)) if (at < floor) delete this.state.seen[id]
    // A 👀 mark outlives every read that could return its message.
    const reactedFloor = this.deps.now() - REACTED_KEPT_S
    const reacted = Object.entries(this.state.reacted).filter(([, at]) => at >= reactedFloor).sort((a, b) => b[1] - a[1]).slice(0, REACTED_MAX)
    this.state.reacted = Object.fromEntries(reacted)
    this.state.stops = Object.fromEntries(Object.entries(this.state.stops).filter(([, at]) => at >= reactedFloor).sort((a, b) => b[1] - a[1]).slice(0, REACTED_MAX))
    this.state.stoppedOrders = Object.fromEntries(Object.entries(this.state.stoppedOrders).filter(([, at]) => at >= reactedFloor).sort((a, b) => b[1] - a[1]).slice(0, REACTED_MAX))
  }

  /** Where the next read of the inbox starts: the read window before the last read, or the oldest message still waiting. Null before the first read. */
  private sinceForNextRead(): number | null {
    if (this.state.lastReadAt === null) return null
    return Math.min(this.state.lastReadAt - REREAD_WINDOW_S, ...Object.values(this.state.waiting).map((t) => t - 1))
  }

  /**
   * Why a DM to the operator could not be sent right now, or null when it
   * could: no operator, a profile that contradicts the human's
   * configuration, no DM inbox, or no relay that answered. Asked before any
   * work whose whole point is a message, such as a HOSAKA invoice, so that
   * nothing is bought that nobody can be told about.
   */
  async undeliverable(): Promise<string | null> {
    try {
      this.requireOperator()
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
    const facts = await this.sync()
    if (!facts) return 'The operator channel is closed.'
    return facts.inbox.length === 0 ? this.noInboxWords(facts) : null
  }

  /** The message_operator tool: a private DM to the operator, and the agent's own copy. */
  async message(text: string): Promise<ToolResult> {
    const operator = this.requireOperator()
    const body = text.trim()
    if (!body) throw new Refusal('Say something: the message is empty.')
    if (text.length > MAX_OPERATOR_MESSAGE) throw new Refusal(`The message is ${text.length} characters; the most is ${MAX_OPERATOR_MESSAGE}.`)
    const facts = await this.sync()
    if (!facts) throw new Refusal('The operator channel is closed.')
    if (facts.inbox.length === 0) throw new Refusal(`${this.noInboxWords(facts)} Nothing was sent.`)
    const wrapped = this.deps.wrap(operator, text)
    this.remember(text)
    const toThem = await this.deps.relays.publishMany(facts.inbox, wrapped.toRecipient)
    if (!toThem.ok) {
      throw new Refusal(`Not delivered: no relay of your operator's DM inbox took it (${Object.entries(toThem.reasons).map(([u, r]) => `${u}: ${r}`).join('; ') || toThem.reason}). The relays' words are verbatim.`)
    }
    const selfRelays = facts.mine.length ? facts.mine : facts.inbox
    const toMe = await this.deps.relays.publishMany(selfRelays, wrapped.toSelf)
    const opNpub = nip19.npubEncode(operator)
    const lines = [
      `Sent privately to your operator (${opNpub}): accepted by ${toThem.accepted.join(', ')}${Object.keys(toThem.reasons).length ? `; not by ${Object.entries(toThem.reasons).map(([u, r]) => `${u} (${r})`).join(', ')}` : ''}.`,
      toMe.ok ? `Your own copy is on ${toMe.accepted.join(', ')}.` : `Your own copy was not stored (${toMe.reason}); the message itself was delivered.`,
    ]
    return { text: lines.join('\n'), data: { id: wrapped.rumor.id, operator: opNpub, accepted: toThem.accepted, reasons: toThem.reasons, selfCopy: toMe.ok ? toMe.accepted : [] } }
  }
}
