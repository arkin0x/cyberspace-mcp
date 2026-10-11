// follow.ts: the "follow my operator" watch (arkinox, 2026-10-11: "once XOR
// reaches me, will he see when I move and automatically move too if I have
// the strategy set to 'follow me'?"). Nothing woke the agent when its
// operator moved; this keeps watching for it.
//
//   - On and off by the follow_operator tool, kept in the state directory
//     (follow.json) so a restart keeps watching.
//   - Only the operator is watched: the operator the agent's own kind 0
//     names, under the same trust rules as orders (no contradiction with the
//     human's configuration, and the operator's newest kind 3 follows the
//     agent). A move is accepted only while the operator follows the agent.
//   - While on, one live subscription to the operator's kind 3333 events on
//     the configured relays. An event is a hint, never a fact: a forged
//     signature is dropped with a note, and anything else starts a read of
//     the operator's chain with the resolver every chain read uses
//     (chain/resolve.ts fetchChainEvents, then buildChain). A move counts
//     only when the chain is valid and the event read is its head; a fork,
//     a broken event or one that links to nothing is ignored with a note.
//   - Nothing here is awaited by another tool: the reads run in the
//     background, one at a time, and every signature check yields to the
//     event loop between small batches, so a long chain never stalls a call.
//     orders_waiting reads the newest move from memory.
//   - A move is unseen until follow_operator reports it. It never moves the
//     agent: moving stays the model's decision, guided by STRATEGY.

import type { Filter } from 'nostr-tools/filter'
import { getEventHash } from 'nostr-tools/pure'
import { ACTION_KIND } from './chain/builder.js'
import { actionLink, buildChain, chainStatus, firstBreak, type ActionEvent } from './chain/events.js'
import { ChainGapError, fetchChainEvents, isNewerAction, mergeEvents } from './chain/resolve.js'
import { isAuthentic, type NostrEvent } from './nostr/event.js'
import type { Relays } from './nostr/relays.js'
import type { StateDir } from './state/dir.js'

const FILE = 'follow.json'
/** Notes kept for the follow tool: what was ignored and why. */
const NOTES_KEPT = 20
/** Signatures checked between two yields to the event loop. */
const VERIFY_BATCH = 16
/** Seconds of overlap when the operator's chain is asked again from its newest known event. */
const REREAD_OVERLAP_S = 60
/** How long a read that found nothing (relays down, no chain yet) waits before trying again. */
const RETRY_MS = 30_000

/** One verified position of the operator: the head of their valid chain. */
export interface OperatorMove {
  eventId: string
  /** The 64-hex coordinate they stand on. */
  coordHex: string
  plane: 0 | 1
  /** The head's created_at, unix seconds. */
  at: number
  /** The action that put them there: hop, sidestep, hyperjump, spawn, ... */
  action: string
}

export interface FollowNote {
  at: number
  text: string
}

interface FollowFile {
  version: 1
  on: boolean
  /** The operator, hex, whose moves `latest` and `ackedId` are about. */
  operator: string | null
  latest: OperatorMove | null
  /** The move follow_operator last reported. */
  ackedId: string | null
}

const EMPTY: FollowFile = { version: 1, on: false, operator: null, latest: null, ackedId: null }

export interface FollowDeps {
  relays: Relays
  dir: StateDir
  /** The operator who may give orders right now, hex: the profile's, when nothing contradicts it; null otherwise. */
  operator: () => string | null
  /** Whether that operator's newest kind 3 follows the agent; null when it could not be told. */
  follows: () => Promise<boolean | null>
  now: () => number
  log: (line: string) => void
  retryMs?: number
}

export class OperatorWatch {
  private state: FollowFile
  /** The operator's chain events, every one checked authentic, of the current chain only. */
  private have: NostrEvent[] = []
  /** Signatures already verified, as "id:sig". A copy counts as one of these only when its content still hashes to its id. */
  private authentic = new Set<string>()
  /** Events already handed to a read, so the same event from a second relay does not start another. */
  private triggered = new Set<string>()
  private stopLive: (() => void) | null = null
  private subscribedFor: string | null = null
  private running: Promise<void> | null = null
  private again = false
  private pending: NostrEvent[] = []
  private retry: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  /** What was ignored and why, newest last; in memory only, so a flood of forged events never touches the disk. */
  private kept: FollowNote[] = []
  /** Our clock at the last read of the operator's chain that answered, or null. */
  lastReadAt: number | null = null

  constructor(private readonly deps: FollowDeps) {
    const saved = deps.dir.readJson<FollowFile | null>(FILE, null)
    this.state = saved?.version === 1 ? { ...EMPTY, ...saved } : { ...EMPTY }
  }

  private save(): void {
    this.deps.dir.writeJson(FILE, this.state)
  }

  get on(): boolean {
    return this.state.on
  }

  /** Whether a read of the operator's chain is in flight. */
  get reading(): boolean {
    return this.running !== null
  }

  notes(): FollowNote[] {
    return this.kept.slice()
  }

  /** Keep a note; the same words as the newest note are not kept twice, so a retry does not fill the list. */
  private note(text: string): void {
    if (this.kept.at(-1)?.text === text) return
    this.kept = [...this.kept, { at: this.deps.now(), text }].slice(-NOTES_KEPT)
    this.deps.log(`follow: ${text}`)
  }

  /** The operator's newest verified position, when it is about the current operator. */
  latest(): OperatorMove | null {
    const op = this.deps.operator()
    return op && this.state.operator === op ? this.state.latest : null
  }

  /** The newest move follow_operator has not reported yet, from memory: what orders_waiting carries. */
  unseen(): OperatorMove | null {
    if (!this.state.on) return null
    const m = this.latest()
    return m && m.eventId !== this.state.ackedId ? m : null
  }

  /** Mark the newest move as reported. */
  acknowledge(): void {
    const m = this.latest()
    if (!m || this.state.ackedId === m.eventId) return
    this.state.ackedId = m.eventId
    this.save()
  }

  /** Turn the watch on or off, and keep the choice. */
  setOn(on: boolean): void {
    if (this.state.on !== on) {
      this.state.on = on
      this.save()
    }
    this.refresh()
  }

  /**
   * Keep the subscription matching the switch and the operator: open it
   * when on, close it when off, move it when the profile names another
   * operator (whose moves start from nothing). Cheap; called by the tools.
   */
  refresh(): void {
    if (this.stopped) return
    const op = this.state.on ? this.deps.operator() : null
    if (op && this.state.operator !== op) {
      this.state = { ...this.state, operator: op, latest: null, ackedId: null }
      this.have = []
      this.save()
    }
    if (op === this.subscribedFor) return
    this.stopLive?.()
    this.stopLive = null
    this.subscribedFor = op
    if (this.retry) { clearTimeout(this.retry); this.retry = null }
    if (!op) return
    const filter: Filter = { kinds: [ACTION_KIND], authors: [op], since: this.deps.now() - REREAD_OVERLAP_S }
    this.stopLive = this.deps.relays.subscribe(filter, (ev) => this.ingest(ev))
    // What happened while nobody watched (a restart, the watch off) is read now.
    this.kick()
  }

  /** An event from the subscription: the operator's, authentic, and new, or it is dropped here. */
  ingest(ev: NostrEvent): void {
    const op = this.subscribedFor
    if (!op || this.stopped) return
    // A relay may send anything; only the operator's movement is watched, and a stranger's is not even noted.
    if (ev.kind !== ACTION_KIND || ev.pubkey !== op) return
    if (this.triggered.has(ev.id) || this.have.some((e) => e.id === ev.id)) return
    if (!isAuthentic(ev)) {
      this.note(`Ignored event ${ev.id.slice(0, 8)}...: it claims to be your operator's move, but its signature does not verify.`)
      return
    }
    this.authentic.add(`${ev.id}:${ev.sig}`)
    if (this.triggered.size > 1000) this.triggered.clear()
    this.triggered.add(ev.id)
    this.kick(ev)
  }

  /** Read the operator's chain now, or after the read in progress; resolves when the reads are done. */
  resolveNow(): Promise<void> {
    this.kick()
    return this.running ?? Promise.resolve()
  }

  private kick(trigger?: NostrEvent): void {
    if (trigger) this.pending.push(trigger)
    if (this.running) { this.again = true; return }
    this.running = (async () => {
      do {
        this.again = false
        const triggers = this.pending.splice(0)
        await this.resolveOnce(triggers)
      } while (this.again && !this.stopped)
    })().catch((err) => this.deps.log(`follow: ${err instanceof Error ? err.message : String(err)}`)).finally(() => { this.running = null })
  }

  /**
   * Keep only authentic events. The content hash is checked on every one
   * (cheap), and the signature on each id and signature pair once, in small
   * batches between yields to the event loop, so a tampered copy of a
   * verified event never passes and a long chain never stalls a tool call.
   */
  private async checked(events: NostrEvent[]): Promise<NostrEvent[]> {
    const out: NostrEvent[] = []
    let since = 0
    for (const e of events) {
      const key = `${e.id}:${e.sig}`
      if (!this.authentic.has(key)) {
        if (++since % VERIFY_BATCH === 0) await new Promise((r) => setImmediate(r))
        if (!isAuthentic(e)) continue
        this.authentic.add(key)
      } else if (hashOf(e) !== e.id) {
        continue
      }
      out.push(e)
    }
    return out
  }

  private scheduleRetry(): void {
    if (this.retry || this.stopped || !this.subscribedFor) return
    this.retry = setTimeout(() => { this.retry = null; this.kick() }, this.deps.retryMs ?? RETRY_MS)
    this.retry.unref?.()
  }

  private async resolveOnce(triggers: NostrEvent[]): Promise<void> {
    const op = this.subscribedFor
    if (!op || this.stopped || op !== this.deps.operator()) return
    const follows = await this.deps.follows().catch(() => null)
    if (op !== this.subscribedFor) return
    if (follows !== true) {
      this.note(follows === false
        ? 'Your operator does not follow you in their contact list (kind 3), so their moves are not reported: the same rule as their orders.'
        : 'Could not find your operator\'s contact list (kind 3), so whether they follow you is unknown and their moves are not reported yet.')
      this.scheduleRetry()
      return
    }
    const spawnId = this.have.length ? buildChain(this.have, op)[0]?.id : undefined
    const newest = this.have.reduce((m, e) => Math.max(m, e.created_at), 0)
    const since = spawnId ? newest - REREAD_OVERLAP_S : undefined
    let fetched: NostrEvent[]
    try {
      fetched = await fetchChainEvents(this.deps.relays, op, spawnId, this.have, since)
    } catch (err) {
      if (!(err instanceof ChainGapError)) throw err
      // Some event of the chain is on no relay: what links from the spawn still resolves, and what does not is ignored below.
      fetched = err.events
    }
    if (op !== this.subscribedFor || this.stopped) return
    const all = await this.checked(mergeEvents(this.have, [...fetched, ...triggers]).filter((e) => e.pubkey === op && e.kind === ACTION_KIND))
    const chain = buildChain(all, op)
    if (chain.length === 0) {
      this.scheduleRetry()
      return
    }
    this.lastReadAt = this.deps.now()
    const genesis = chain[0].id
    this.have = all.filter((e) => e.id === genesis || actionLink(e)?.genesisId === genesis)
    const status = chainStatus(chain)
    const head = chain[chain.length - 1]
    const inChain = new Set(chain.map((a) => a.id))
    if (status !== 'valid') {
      const broken = firstBreak(chain)
      this.note(status === 'dead'
        ? `Your operator's chain is dead${broken ? ` (${broken.action.breaks})` : ''}, so no move of theirs is reported until they respawn.`
        : `Ignored your operator's event ${broken!.action.id.slice(0, 8)}...: it is ${broken!.action.breaks}. Their position stays the last valid one.`)
      return
    }
    for (const t of triggers) {
      if (inChain.has(t.id)) continue
      this.note(`Ignored event ${t.id.slice(0, 8)}... by your operator: it is not on their live chain (it links to an event no relay has, to another spawn, or to nothing).`)
    }
    const move = toMove(head)
    const latest = this.state.latest
    if (latest && (latest.eventId === move.eventId || !isNewerAction({ createdAt: move.at, id: move.eventId }, { createdAt: latest.at, id: latest.eventId }))) return
    this.state.latest = move
    this.save()
    this.deps.log(`follow: your operator is at ${move.coordHex.slice(0, 12)}... (${move.action} ${move.eventId.slice(0, 8)}...)`)
  }

  /** The watch's state for the follow tool. */
  status(): { on: boolean; operator: string | null; subscribed: boolean } {
    return { on: this.state.on, operator: this.state.operator, subscribed: this.subscribedFor !== null }
  }

  stop(): void {
    this.stopped = true
    this.stopLive?.()
    this.stopLive = null
    this.subscribedFor = null
    if (this.retry) { clearTimeout(this.retry); this.retry = null }
  }
}

function hashOf(e: NostrEvent): string | null {
  try {
    return getEventHash({ pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content })
  } catch {
    return null
  }
}

function toMove(a: ActionEvent): OperatorMove {
  return { eventId: a.id, coordHex: a.coordHex, plane: a.plane as 0 | 1, at: a.createdAt, action: a.name }
}
