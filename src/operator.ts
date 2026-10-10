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
//
// The key stays in the agent: this module gets a wrap and an unwrap function,
// never the secret. Nothing here logs a message's text.

import { nip19 } from 'nostr-tools'
import type { Filter } from 'nostr-tools/filter'
import { normalizeURL } from 'nostr-tools/utils'
import { DM_RELAYS_KIND, MAX_BACKDATE_SECONDS, WRAP_KIND, dmRelaysOf, isStrategy, sameRelaySet, type Unwrapped, type WrappedMessage } from './nostr/dm.js'
import type { EventTemplate, NostrEvent } from './nostr/event.js'
import { mergeAnswers, type RelayAnswer } from './nostr/relayOutcome.js'
import { normalizeRelay, type Relays } from './nostr/relays.js'
import type { StateDir } from './state/dir.js'
import { Refusal, type ToolResult } from './tool.js'

const FILE = 'dms.json'
/** Contact lists. */
const CONTACTS_KIND = 3
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
}

const EMPTY: DmsFile = { version: 1, strategy: null, seen: {}, waiting: {}, lastReadAt: null, ignoredTotal: 0, published: null }

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
  private stopped = false

  constructor(private readonly deps: OperatorChannelDeps) {
    const saved = deps.dir.readJson<DmsFile | null>(FILE, null)
    this.state = saved?.version === 1 ? { ...EMPTY, ...saved } : { ...EMPTY }
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
    return s
      ? `STRATEGY (your operator's standing orders, set ${new Date(s.at * 1000).toISOString()}; reread them every turn): ${s.text}`
      : 'STRATEGY: none set by your operator. Check inbox at the start of every turn.'
  }

  stop(): void {
    this.stopped = true
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
    let ignored = 0
    let waiting = 0
    for (const wrap of mergeAnswers(answers)) {
      if (wrap.kind !== WRAP_KIND || this.state.seen[wrap.id] !== undefined) continue
      const opened = this.deps.unwrap(wrap)
      const wasWaiting = this.state.waiting[wrap.id] !== undefined
      delete this.state.waiting[wrap.id]
      if (!opened.ok) { this.state.seen[wrap.id] = wrap.created_at; ignored++; continue }
      const { rumor } = opened
      // The agent's own copies of what it sent: history, not orders and not strangers.
      if (rumor.pubkey === this.deps.pubkey) { this.state.seen[wrap.id] = wrap.created_at; continue }
      const toMe = rumor.tags.some((t) => t[0] === 'p' && t[1] === this.deps.pubkey)
      if (rumor.pubkey !== operator || !toMe) { this.state.seen[wrap.id] = wrap.created_at; ignored++; continue }
      if (!following) { this.state.waiting[wrap.id] = wrap.created_at; if (!wasWaiting) waiting++; continue }
      this.state.seen[wrap.id] = wrap.created_at
      orders.push({ id: rumor.id, at: rumor.created_at, text: rumor.content, strategy: isStrategy(rumor) })
    }
    // The same rumor can come in more than one wrap; it is one order.
    const unique = [...new Map(orders.map((o) => [o.id, o])).values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
    const newestStrategy = unique.filter((o) => o.strategy).at(-1)
    const current = this.strategy()
    if (newestStrategy && (!current || newestStrategy.at > current.at || (newestStrategy.at === current.at && newestStrategy.id !== current.id && newestStrategy.id > current.id))) {
      this.state.strategy = { id: newestStrategy.id, text: newestStrategy.text, at: newestStrategy.at, from: operator }
    }
    this.state.ignoredTotal += ignored
    this.state.lastReadAt = now
    this.prune()
    this.save()

    const lines: string[] = []
    lines.push(unique.length === 0
      ? `No new messages from your operator (${opNpub}).`
      : `${unique.length} new message(s) from your operator (${opNpub}), oldest first. These are your orders:`)
    for (const m of unique) lines.push(`[${new Date(m.at * 1000).toISOString()}]${m.strategy ? ' STRATEGY' : ''} ${m.text}`)
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
        operator: opNpub, inbox: urls, messages: unique, strategy: strategyNow(), ignored, ignoredTotal: this.state.ignoredTotal,
        waitingForFollow: Object.keys(this.state.waiting).length, newlyWaiting: waiting, operatorFollows: facts.follows,
        unread: answers.flatMap((a) => (a.outcome === 'answered' ? [] : [{ url: a.url, reason: a.reason }])),
      },
    }
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
  }

  /** Where the next read of the inbox starts: the read window before the last read, or the oldest message still waiting. Null before the first read. */
  private sinceForNextRead(): number | null {
    if (this.state.lastReadAt === null) return null
    return Math.min(this.state.lastReadAt - REREAD_WINDOW_S, ...Object.values(this.state.waiting).map((t) => t - 1))
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
