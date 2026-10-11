// chat.ts: talking to whoever is standing where the agent is, and hearing them.
//
// The sealing is ONOSENDAI's, ported from src/store/useChat.ts at commit
// c92fd3b and src/hooks/useChatFeed.ts at commit d1e4644 (branch
// feat/keys-and-chests): a line is a kind 23333 event, signed by the agent,
// sealed inside a kind 23330 ephemeral envelope keyed to the h12 cube it was
// said in (SCAN_MAX_HEIGHT); whoever stands in that cube has its key from
// their own scan and reads the words. One live subscription hears the
// envelopes of the agent's cube and the 26 cubes around it, so two people a
// gibson apart on either side of a wall still hear each other. The relay
// keeps none of these, so a line said before the server was listening is
// gone.
//
// The rules of the brief (ruling 8) are enforced here: one line per five
// seconds, 500 characters, and the quiet rule: at most one unprompted line
// per arrival, where a reply to a line that addressed the agent is never
// unprompted.
//
// The agent answers chat only when it is addressed (arkinox, 2026-10-11:
// "we don't want XOR to respond to every message I send in local chat. just
// when I address him via tag"). A line addresses the agent when it mentions
// it: a ["p", <agent hex>] tag on the inner event, as ONOSENDAI's Chat chip
// writes for an @mention (PR #305, read first), a nostr:npub1 or nostr:nprofile1 of the agent in
// the text (NIP-27), or the agent's name, npub or hex pubkey in the text (the
// rule this file already had). Its operator is no exception: the operator's
// unaddressed lines are context, never a call to speak. Every line is kept
// and listen shows them all; the unread ones are counted for orders_waiting
// (chatHeard), and only addressed ones say wake: the operator's at once, a
// stranger's at most once per chatWakeMinutes, in total and per speaker, so
// strangers cannot run up the agent's compute.

import { EventEmitter } from 'node:events'
import { nip19 } from 'nostr-tools'
import type { Filter } from 'nostr-tools/filter'
import { CHAT_BAG_KIND, MAX_CHAT_LENGTH, bagTemplate, chatInnerTemplate, chatInners } from './hidden/bags.js'
import { hexToBytes, nowSeconds, type EventTemplate, type NostrEvent } from './nostr/event.js'
import type { Relays } from './nostr/relays.js'
import { AXIS_LIMIT, type Place, type Position } from './space/coords.js'
import { SCAN_MAX_HEIGHT, type HeldKey, type KeyStore } from './space/regionKeys.js'
import type { StateDir } from './state/dir.js'

/** The least time between two lines the agent says. */
export const SAY_INTERVAL_S = 5
/** Lines kept, oldest dropped first. */
const CHAT_MAX = 500

export interface ChatLine {
  /** The inner event's id: the line's identity, what stops a repeat. */
  id: string
  from: string
  /** Text from cyberspace: untrusted. */
  text: string
  /** Seconds since the epoch, as the sender signed it. */
  at: number
  /** The region it was said in: the envelope's d. */
  region: string
  height: number
  mine: boolean
  /** Whether the line names the agent (its name, its npub or its pubkey). */
  addressed: boolean
  /** When this server heard it. */
  heardAt: number
  /** Not yet returned by listen. Lines kept before this field existed read as read. */
  unread?: boolean
}

/** What orders_waiting says about chat, from memory: lines from others that listen has not returned yet. */
export interface ChatHeard {
  /** Unread lines from others. */
  count: number
  /** Unread lines from others that address the agent (a mention). */
  addressed: number
  /** Of those, the ones from the operator. */
  addressedFromOperator: number
  /** Unread lines that do not address the agent: context, never a reason to speak. */
  unaddressed: number
  /** Unread lines from the operator, addressed or not. */
  fromOperator: number
  /** The newest unread line's time as its sender signed it, or null. */
  latestAt: number | null
  /**
   * Whether this report should wake the agent: "operator" for an addressed
   * operator line not reported before, "stranger" for an addressed stranger
   * line within the rate limit, or null. Each line wakes at most once.
   */
  wake: 'operator' | 'stranger' | null
}

interface ChatFile {
  version: 1
  lines: ChatLine[]
  lastSaidAt: number | null
  unpromptedAllowance: number
  lastListenAt: number | null
}

const FILE = 'chat.json'

/** The 26 positions one cube of side 2^h away from `at`, those inside cyberspace. */
export function neighborPositions(at: Position, h: number): Position[] {
  const side = 1n << BigInt(h)
  const out: Position[] = []
  for (const dx of [-1n, 0n, 1n]) for (const dy of [-1n, 0n, 1n]) for (const dz of [-1n, 0n, 1n]) {
    if (dx === 0n && dy === 0n && dz === 0n) continue
    const p = { x: at.x + dx * side, y: at.y + dy * side, z: at.z + dz * side }
    if (p.x < 0n || p.y < 0n || p.z < 0n || p.x >= AXIS_LIMIT || p.y >= AXIS_LIMIT || p.z >= AXIS_LIMIT) continue
    out.push(p)
  }
  return out
}

/** Which cube of side 2^h a position is in, as a string that changes only on crossing. */
function cubeKey(at: Position, h: number): string {
  const s = BigInt(h)
  return `${at.x >> s},${at.y >> s},${at.z >> s}`
}

/** Newest last, no repeats: one line per inner event id. */
export function mergeLines(have: ChatLine[], add: ChatLine[]): ChatLine[] {
  const seen = new Set(have.map((l) => l.id))
  const fresh = add.filter((l) => !seen.has(l.id))
  if (fresh.length === 0) return have
  return [...have, ...fresh].sort((a, b) => a.at - b.at).slice(-CHAT_MAX)
}

/** Whether a line's text mentions the agent: its npub (bare or nostr:), a nostr:nprofile of it, or its hex pubkey. Its plain name does not count. */
export function addressesMe(text: string, me: { pubkey: string; npub: string; name: string | null }): boolean {
  const lower = text.toLowerCase()
  if (lower.includes(me.npub) || lower.includes(me.pubkey)) return true
  for (const m of lower.matchAll(/nprofile1[02-9ac-hj-np-z]+/g)) {
    try {
      const d = nip19.decode(m[0])
      if (d.type === 'nprofile' && d.data.pubkey === me.pubkey) return true
    } catch { /* not an nprofile */ }
  }
  // The agent's plain name does not address it (arkinox, 2026-10-11: answer
  // "just when I address him via tag"): only a mention does, the p tag
  // ONOSENDAI's @mention writes, or its key in the text as NIP-27 writes it.
  return false
}

/** Whether an inner chat event mentions the agent: a p tag naming it (ONOSENDAI's @mention), or the text rules of addressesMe. */
export function mentionsMe(inner: { tags: string[][]; content: string }, me: { pubkey: string; npub: string; name: string | null }): boolean {
  if (inner.tags.some((t) => t[0] === 'p' && t[1] === me.pubkey)) return true
  return addressesMe(inner.content, me)
}

/** The default least time between two wakes for strangers' lines, in minutes. */
export const DEFAULT_CHAT_WAKE_MINUTES = 5

interface ChatOptions {
  pubkey: string
  name: () => string | null
  /** The locked operator, or null: whose lines are fromOperator. */
  operator?: () => string | null
  /** Least minutes between two wakes for strangers' addressed lines, in total and per speaker. */
  wakeMinutes?: number
  sign: (template: EventTemplate) => NostrEvent
  log?: (line: string) => void
}

export class Chat extends EventEmitter {
  lines: ChatLine[] = []
  lastSaidAt: number | null = null
  /** How many unprompted lines may still be said before the next arrival. */
  unpromptedAllowance = 1
  lastListenAt: number | null = null
  private current: HeldKey | null = null
  private neighbors = new Map<string, HeldKey>()
  private cube: string | null = null
  private stopLive: (() => void) | null = null
  private readonly npub: string
  /** Resolves when the current subscription has heard a relay say EOSE: it is listening. */
  private listeningPromise: Promise<void> = Promise.resolve()
  /** Lines already reported as wake, so each wakes at most once. In memory: a restart may wake once more, within the limits. */
  private readonly woken = new Set<string>()
  /** When a stranger's line last woke the agent, in total and per speaker. */
  private lastStrangerWake: number | null = null
  private readonly lastSpeakerWake = new Map<string, number>()

  constructor(
    private readonly dir: StateDir,
    private readonly relays: Relays,
    private readonly keys: KeyStore,
    private readonly me: ChatOptions,
  ) {
    super()
    this.npub = nip19.npubEncode(me.pubkey)
    const saved = dir.readJson<ChatFile | null>(FILE, null)
    if (saved?.version === 1) {
      this.lines = Array.isArray(saved.lines) ? saved.lines : []
      this.lastSaidAt = saved.lastSaidAt ?? null
      this.unpromptedAllowance = typeof saved.unpromptedAllowance === 'number' ? saved.unpromptedAllowance : 1
      this.lastListenAt = saved.lastListenAt ?? null
    }
  }

  private save(): void {
    this.dir.writeJson(FILE, {
      version: 1, lines: this.lines.slice(-CHAT_MAX), lastSaidAt: this.lastSaidAt, unpromptedAllowance: this.unpromptedAllowance, lastListenAt: this.lastListenAt,
    } satisfies ChatFile)
  }

  /** The key of the cube the agent stands in, and the lookup ids it listens on. */
  get room(): { current: HeldKey | null; regions: string[] } {
    return { current: this.current, regions: [...new Set([...(this.current ? [this.current.lookupId] : []), ...this.neighbors.keys()])] }
  }

  /**
   * Stand at a place: derive the h12 key of its cube and of the 26 cubes
   * around it, and listen on all 27. Recomputed only when the cube changes.
   */
  enter(place: Place): void {
    const key = cubeKey(place.position, SCAN_MAX_HEIGHT)
    if (key === this.cube && this.current) return
    this.cube = key
    this.current = this.keys.keyAt(place.position, SCAN_MAX_HEIGHT, 'scan')
    this.neighbors = new Map(neighborPositions(place.position, SCAN_MAX_HEIGHT).map((p) => {
      const k = this.keys.keyAt(p, SCAN_MAX_HEIGHT, 'scan')
      return [k.lookupId, k]
    }))
    this.listen()
  }

  private listen(): void {
    this.stopLive?.()
    const ids = this.room.regions
    if (ids.length === 0) { this.stopLive = null; return }
    const filter: Filter = { kinds: [CHAT_BAG_KIND], '#d': ids }
    let ready: () => void = () => {}
    this.listeningPromise = new Promise<void>((resolve) => { ready = resolve })
    this.stopLive = this.relays.subscribe(filter, (ev) => { void this.receive(ev) }, () => ready())
  }

  /** Resolves once a relay has acknowledged the current subscription (its EOSE), so a line said after that is heard. */
  listening(): Promise<void> {
    return this.listeningPromise
  }

  /** Someone arrived: one more unprompted line may be said. */
  arrival(): void {
    this.unpromptedAllowance = 1
    this.save()
  }

  /** Why a line may not be said now, or null. `replyTo` is the id of a heard line this one answers. */
  refusal(text: string, replyTo: string | undefined, now: number = nowSeconds()): string | null {
    if (!text.trim()) return 'Nothing to say: the line is empty.'
    if (text.length > MAX_CHAT_LENGTH) return `The line is ${text.length} characters; a chat line is at most ${MAX_CHAT_LENGTH}.`
    if (this.lastSaidAt !== null && now - this.lastSaidAt < SAY_INTERVAL_S) {
      return `Too soon: one line per ${SAY_INTERVAL_S} seconds, and the last was ${now - this.lastSaidAt} s ago.`
    }
    if (!this.current) return 'No room yet: the server does not hold the key of the cube it stands in. Call whereami first.'
    if (replyTo) {
      const line = this.lines.find((l) => l.id === replyTo)
      if (!line) return `No heard line has the id ${replyTo}; listen first, then reply to one of its lines.`
      if (line.mine) return 'That line is the agent\'s own; a reply answers someone else.'
      if (!line.addressed) return 'That line did not address the agent, so answering it counts as unprompted. The quiet rule allows one unprompted line per arrival.'
      return null
    }
    if (this.unpromptedAllowance <= 0) {
      return 'The quiet rule: one unprompted line per arrival, and that line has been said. Wait for someone to arrive or for a line that addresses the agent, then reply to it.'
    }
    return null
  }

  /** Say a line into the cube the agent stands in. The caller has checked `refusal`. */
  async say(text: string, place: Place, replyTo: string | undefined, now: number = nowSeconds()): Promise<{ id: string; region: string; accepted: string[]; reasons: Record<string, string> } | { refused: string }> {
    const why = this.refusal(text, replyTo, now)
    if (why) return { refused: why }
    const key = this.current!
    const inner = this.me.sign(chatInnerTemplate(text, place.position, place.plane, now, key.lookupId))
    const outer = this.me.sign(await bagTemplate([inner], hexToBytes(key.keyHex), key.lookupId, key.height, now, CHAT_BAG_KIND))
    const result = await this.relays.publish(outer)
    if (!result.ok) return { refused: `Not sent: ${result.reason}` }
    this.lastSaidAt = now
    if (!replyTo) this.unpromptedAllowance--
    const line: ChatLine = { id: inner.id, from: inner.pubkey, text: inner.content, at: inner.created_at, region: key.lookupId, height: key.height, mine: true, addressed: false, heardAt: now }
    this.lines = mergeLines(this.lines, [line])
    this.save()
    return { id: inner.id, region: key.lookupId, accepted: result.accepted, reasons: result.reasons }
  }

  /** An ephemeral envelope from a relay: open it with the keys held. */
  async receive(outer: NostrEvent, now: number = nowSeconds()): Promise<ChatLine[]> {
    const region = outer.tags.find((t) => t[0] === 'd')?.[1]
    if (!region) return []
    const key = this.current?.lookupId === region ? this.current : this.neighbors.get(region) ?? this.keys.byLookupId(region)
    if (!key) return []
    const inners = await chatInners(outer, hexToBytes(key.keyHex))
    if (inners.length === 0) return []
    const me = { pubkey: this.me.pubkey, npub: this.npub, name: this.me.name() }
    const add = inners.map((e): ChatLine => ({
      id: e.id, from: e.pubkey, text: e.content.slice(0, MAX_CHAT_LENGTH), at: e.created_at, region, height: key.height,
      mine: e.pubkey === this.me.pubkey, addressed: e.pubkey !== this.me.pubkey && mentionsMe(e, me), heardAt: now, unread: e.pubkey !== this.me.pubkey,
    }))
    const before = this.lines
    this.lines = mergeLines(before, add)
    if (this.lines === before) return []
    const fresh = add.filter((l) => !before.some((b) => b.id === l.id))
    this.save()
    for (const l of fresh) this.emit('line', l)
    return fresh
  }

  /** Lines heard since a time (inclusive), or since the last call with "last". */
  heard(since: number | 'last', now: number = nowSeconds()): ChatLine[] {
    const from = since === 'last' ? (this.lastListenAt ?? 0) : since
    const out = this.lines.filter((l) => l.heardAt >= from || l.at >= from)
    const read = new Set(out.map((l) => l.id))
    // Returned is read: what orders_waiting counts as unread is what listen has not shown.
    this.lines = this.lines.map((l) => (l.unread && read.has(l.id) ? { ...l, unread: false } : l))
    this.lastListenAt = now
    this.save()
    return out
  }

  /** The locked operator's pubkey, or null. */
  operator(): string | null {
    return this.me.operator?.() ?? null
  }

  /**
   * The unread lines from others, counted from memory, and whether to wake
   * the agent for them (orders_waiting's chatHeard). Only addressed lines
   * wake: the operator's at once, each once; a stranger's only when no
   * stranger's line woke the agent in the last wakeMinutes and this speaker's
   * did not either. A report that says wake records it, so the next poll
   * does not repeat it.
   */
  unreadSummary(now: number = nowSeconds()): ChatHeard {
    const op = this.operator()
    // Bounded by the lines kept: an id whose line has been dropped cannot wake again.
    if (this.woken.size > CHAT_MAX) {
      const kept = new Set(this.lines.map((l) => l.id))
      for (const id of this.woken) if (!kept.has(id)) this.woken.delete(id)
    }
    const unread = this.lines.filter((l) => l.unread && !l.mine)
    const addressed = unread.filter((l) => l.addressed)
    const fresh = addressed.filter((l) => !this.woken.has(l.id))
    const windowS = (this.me.wakeMinutes ?? DEFAULT_CHAT_WAKE_MINUTES) * 60
    let wake: ChatHeard['wake'] = null
    const fromOp = fresh.filter((l) => op !== null && l.from === op)
    if (fromOp.length > 0) {
      wake = 'operator'
      for (const l of fromOp) this.woken.add(l.id)
    } else if (this.lastStrangerWake === null || now - this.lastStrangerWake >= windowS) {
      const due = fresh.filter((l) => {
        const last = this.lastSpeakerWake.get(l.from)
        return last === undefined || now - last >= windowS
      })
      if (due.length > 0) {
        wake = 'stranger'
        this.lastStrangerWake = now
        for (const l of due) { this.woken.add(l.id); this.lastSpeakerWake.set(l.from, now) }
      }
    }
    return {
      count: unread.length,
      addressed: addressed.length,
      addressedFromOperator: addressed.filter((l) => op !== null && l.from === op).length,
      unaddressed: unread.length - addressed.length,
      fromOperator: unread.filter((l) => op !== null && l.from === op).length,
      latestAt: unread.length ? Math.max(...unread.map((l) => l.at)) : null,
      wake,
    }
  }

  stop(): void {
    this.stopLive?.()
    this.stopLive = null
  }
}
