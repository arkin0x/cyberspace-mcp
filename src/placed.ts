// placed.ts: what the agent has placed, and taking it down or moving it
// (arkinox, 2026-10-20: "xor doesn't know how to delete shards or bags he's
// placed ... and how to edit their shards if you tell them 'move this 12
// gibsons toward Z+'").
//
// The semantics are ONOSENDAI's, so what an agent removes or moves reads in
// ONOSENDAI exactly as if a person had done it there (origin/v2 9a1072f and
// later, src/store/useShards.ts deleteInstance and deploy's EDIT, PR #369):
//
//   - DELETE of one thing rewrites the region's bag (kind 33330, d = lookup
//     id) without it, from the bag as the relays hold it now, so nothing
//     else in the bag is lost; when it was the last thing, the envelope
//     itself is deleted (NIP-09 kind 5 naming the bag's address and id).
//   - A shard hidden by reference is also its own kind 33331, sealed to the
//     place. Once no bag of the agent's names it, and the relays hold this
//     very version, it is taken down too (NIP-09). An object someone else
//     published (a LIVE LINK) is never taken down, and neither is a public
//     object of the agent's own: removing a placement does not unpublish it.
//   - A MOVE signs the item again at its new place with `["d", <first
//     version's id>]` (its lineage), so comments and reactions follow it; a
//     reference keeps its object's `d` and is never retracted by a move. A
//     move inside one bag is one rewrite; to another region, the new bag is
//     written first and the old one rewritten without it after. A shard by
//     reference that changes region is sealed again to the new region under
//     the same `d`, and the old version signed again is kept to put back if
//     the new bag reaches no relay.
//
// Every rewrite reads the bag first: the newest version any relay that
// answered returns, or that this server signed and still has in its outbox.
// It refuses when no relay answered, when the bag does not open with the
// key, and when this server signed a newer version than any it can see,
// because writing over a bag it cannot see whole is how things get lost.
// One bag is changed by one call at a time (withBags).

import { coordToXyz, hexToCoord, type Plane } from 'cyberspace-core'
import {
  HIDDEN_KIND, OBJECT_KIND, bagSettingsOf, bagTemplate, ciphertextOf, editedTemplate, entryKey, isReference, itemLineage, messagePreview, resealedObject, unbag,
  type BagEntry, type BagSettings, type Hidden, type HiddenType, type Reference,
} from './hidden/bags.js'
import { decryptForRegion } from './hidden/crypto.js'
import { hintFits } from './hidden/hint.js'
import { hexToBytes, nowSeconds, type EventTemplate, type NostrEvent } from './nostr/event.js'
import type { Outbox, OutboxEntry } from './nostr/outbox.js'
import { mergeAnswers, type RelayAnswer } from './nostr/relayOutcome.js'
import { normalizeURL } from 'nostr-tools/utils'
import type { Relays } from './nostr/relays.js'
import { objectHandle } from './render.js'
import { parseCoordinate, placeOf, type CoordinateInput, type Place, type Position } from './space/coords.js'
import type { EntrySummary, HeldKey, ItemPlace, KeyStore, OpenedBag } from './space/regionKeys.js'
import { Refusal, type ToolResult } from './tool.js'

/** The words an agent may use for "the thing I placed most recently". */
const LAST_WORDS = new Set(['last', 'latest', 'newest', 'recent', 'most recent', 'the last one', 'it', 'this', 'that'])
/** The most of the agent's bags one listing asks a relay for: what strfry gives at most by default; a full answer is read as possibly cut short. */
const MAX_OWN_BAGS = 500
/** The kinds a target's type names, for "the shard", "the message". */
const TYPE_WORDS: Record<string, HiddenType> = { shard: 'shard', object: 'shard', message: 'message', note: 'message', key: 'key', item: 'key', chest: 'chest' }
/** How long a put-back waits between its tries, in ms. */
const PUT_BACK_RETRY_MS = [500, 1500]

/** What `placed` lists for one thing in one of the agent's bags. */
export interface PlacedEntry {
  /** What remove_placed and move_placed take: the item's event id; for a reference, its object's id, or a hash of the bag and the entry when it was not retrieved or is a LIVE LINK. */
  id: string
  /** What comments and reactions name it by: the first version's id (an inline item), or the object's address (a reference). */
  lineage: string | null
  type: HiddenType | 'unreadable'
  /** A message's preview, a shard's name, a key's or a chest's name. */
  label: string
  at: { x: string; y: string; z: string }
  plane: Plane
  createdAt: number
  /** How it is carried, when it is not inline: an object sealed to this place, or a public object placed by reference. */
  byReference?: 'sealed' | 'public'
  objectAddress?: string
}

/** What `placed` lists for one of the agent's bags. */
export interface PlacedBag {
  lookupId: string
  bagId: string
  height: number
  base: { x: string; y: string; z: string } | null
  createdAt: number
  riddle: string
  entries: PlacedEntry[]
  /** No key held for it: it can only be removed whole. */
  keyHeld: boolean
  /** Only this server's own record holds this version: no relay that answered has it (yet). */
  onlyHere: boolean
}

/** One thing in a bag, with what an operation on it needs. */
interface Row extends PlacedEntry {
  key: string
  entry: BagEntry
  hidden: Hidden | null
  bag: OpenBag
}

interface OpenBag extends PlacedBag {
  event: NostrEvent
  keyHex: string | null
  rows: Row[]
}

/** Everything `placed` read: the agent's bags, newest first, and whether the reading is whole. */
interface Reading {
  bags: OpenBag[]
  /** Bags that did not open, by lookup id: references in them could not be checked. */
  unopened: string[]
  /** Relays that did not answer, with why, and answers that may have been cut short. */
  silent: string[]
}

/** What the agent hands this module: its key's signature and the parts of itself a bag change touches. */
export interface PlacedHost {
  pubkey: string
  relays: Relays
  outbox: Outbox
  keys: KeyStore
  sign: (t: EventTemplate) => NostrEvent
  resolveReference: (ref: Reference) => Promise<NostrEvent | null>
  /** The key for a cube, priced against the caps and spent (Refusal above them). */
  keyFor: (at: Position, height: number) => { key: HeldKey; ms: number }
  /** File an opened item, as find files it. */
  summarize: (h: Hidden, lookupId: string) => EntrySummary
  /** Where the agent stands, for a destination given as an offset from there. */
  here: () => Place
  maxHeight: number
  minHeight: number
  log: (line: string) => void
}

/** The entries of an envelope, opened with its region key; null when it does not open (the wrong key, or not a list). */
export async function openEntries(outer: NostrEvent, regionKey: Uint8Array): Promise<BagEntry[] | null> {
  const ct = ciphertextOf(outer)
  if (!ct) return null
  const json = await decryptForRegion(regionKey, ct)
  if (json === null) return null
  let arr: unknown
  try { arr = JSON.parse(json) } catch { return null }
  if (!Array.isArray(arr)) return null
  return arr.filter((e): e is BagEntry => isReference(e) || (!!e && !Array.isArray(e) && typeof e === 'object' && typeof (e as NostrEvent).kind === 'number'))
}

/** Union of bag entries by identity, order kept (ONOSENDAI mergeEntries). */
function mergeEntries(a: BagEntry[], b: BagEntry[]): BagEntry[] {
  const seen = new Set(a.map(entryKey))
  const out = a.slice()
  for (const e of b) { const k = entryKey(e); if (!seen.has(k)) { seen.add(k); out.push(e) } }
  return out
}

function dOf(ev: Pick<NostrEvent, 'tags'>): string {
  return ev.tags.find((t) => t[0] === 'd')?.[1] ?? ''
}

/** Newer by created_at; on a tie the lower id, as a relay keeps (NIP-01). */
function newer(a: NostrEvent, b: NostrEvent | null): boolean {
  return !b || a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id)
}

/** The point a bag entry sits at: an inline item's C tag, a reference's coordinate, or null. */
function entryPoint(e: BagEntry): { position: Position; plane: Plane } | null {
  const hex = isReference(e) ? e[3] : (e as NostrEvent).tags?.find((t) => t[0] === 'C')?.[1]
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) return null
  const { x, y, z, plane } = coordToXyz(hexToCoord(hex))
  return { position: { x, y, z }, plane }
}

function labelOf(h: Hidden): string {
  return h.type === 'message' ? messagePreview(h.text ?? '', 60) : h.type === 'shard' ? (h.shard?.name ?? 'shard') : h.type === 'key' ? (h.key?.name ?? 'key') : (h.chest?.name ?? 'chest')
}

function words(p: { x: string; y: string; z: string }): string {
  return `x ${p.x} y ${p.y} z ${p.z}`
}

function relayWords(entry: OutboxEntry): string {
  const refused = Object.entries(entry.refused ?? {}).map(([u, r]) => `${u}: ${r}`)
  return [
    entry.accepted.length ? `accepted by ${entry.accepted.join(', ')}` : 'no relay accepted it yet (the outbox retries)',
    refused.length ? `refused by ${refused.join('; ')} (verbatim)` : '',
  ].filter(Boolean).join('; ')
}

export class Placements {
  private readonly locks = new Map<string, Promise<void>>()

  constructor(private readonly host: PlacedHost) {
    // Bags hidden before this record existed (2026-10-20): every bag of the
    // agent's that find or hide noted, with the key still held, is its own.
    for (const b of host.keys.bags.values()) {
      if (b.author !== host.pubkey || host.keys.mine.has(b.lookupId)) continue
      const key = host.keys.byLookupId(b.lookupId)
      if (key) host.keys.noteOwnBag(key, b.createdAt, { bagId: b.bagId })
    }
    // A move the server stopped in the middle of: its new bag recorded means it finished, and the rollback is not needed; else the old object goes back.
    for (const p of [...host.keys.putBacks]) {
      if (host.keys.mine.get(p.newLookupId)?.lastBagId !== p.newBagId) {
        host.outbox.add(p.rollback)
        host.log(`placed: a move stopped midway; its shard's old object ${p.rollback.id.slice(0, 8)}... goes back out through the outbox`)
      }
      host.keys.settlePutBack(p.rollback.id)
    }
  }

  /** The canonical relay, as relays name themselves in answers and outbox entries. */
  private get canonical(): string {
    return normalizeURL(this.host.relays.canonical)
  }

  /** Whether a deletion in the outbox counts: the canonical relay took it, or may still take it (not dropped, not refused there). A lesser relay taking it is not enough (review of #32, round 3). */
  private liveDeletion(o: OutboxEntry): boolean {
    return !o.dropped && o.refused?.[this.canonical] === undefined
  }

  /** The least created_at the next version of an own bag may carry: newer than every version this server signed and every deletion of it it sent. */
  floor(lookupId: string): number {
    const address = `${HIDDEN_KIND}:${this.host.pubkey}:${lookupId}`
    const deletions = this.host.outbox.entries.filter((o) => o.event.kind === 5 && o.event.pubkey === this.host.pubkey && o.event.tags.some((t) => t[0] === 'a' && t[1] === address)).map((o) => o.event.created_at + 1)
    return Math.max(this.host.keys.ownBagFloor(lookupId), ...deletions)
  }

  // ---- one bag at a time ------------------------------------------------------

  /** Run `fn` holding every bag of `ids`: one change to a bag at a time, in lookup id order so two calls never wait on each other. */
  async withBags<T>(ids: string[], fn: () => Promise<T>): Promise<T> {
    const releases: Array<() => void> = []
    try {
      for (const id of [...new Set(ids)].sort()) releases.push(await this.lock(id))
      return await fn()
    } finally {
      for (const r of releases.reverse()) r()
    }
  }

  private lock(id: string): Promise<() => void> {
    const prev = this.locks.get(id) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((r) => { release = r })
    const tail = prev.then(() => mine)
    this.locks.set(id, tail)
    return prev.then(() => () => {
      release()
      if (this.locks.get(id) === tail) this.locks.delete(id)
    })
  }

  // ---- reading the agent's own bags ------------------------------------------

  /**
   * The newest version of one of the agent's bags among these events, the
   * outbox, and the newest version this server signed (kept whole in
   * keys/mine.json), or null when there is none or it was deleted since. So
   * a rewrite never builds on an older copy than one this server wrote.
   */
  private newestOwn(lookupId: string, fromRelays: NostrEvent[]): NostrEvent | null {
    const me = this.host.pubkey
    const mineHere = (e: NostrEvent): boolean => e.kind === HIDDEN_KIND && e.pubkey === me && dOf(e) === lookupId
    let best: NostrEvent | null = null
    for (const e of fromRelays) if (mineHere(e) && newer(e, best)) best = e
    for (const o of this.host.outbox.entries) if (!o.dropped && mineHere(o.event) && newer(o.event, best)) best = o.event
    const kept = this.host.keys.mine.get(lookupId)?.lastEvent
    if (kept && mineHere(kept) && newer(kept, best)) best = kept
    if (!best) return null
    // Taken down since: a deletion a relay took (the record), or one in the outbox that a relay took or may still take.
    const address = `${HIDDEN_KIND}:${me}:${lookupId}`
    const deletedAt = Math.max(
      this.host.keys.mine.get(lookupId)?.deletedAt ?? 0,
      ...this.host.outbox.entries.filter((o) => o.event.kind === 5 && o.event.pubkey === me && o.event.tags.some((t) => t[0] === 'a' && t[1] === address) && this.liveDeletion(o)).map((o) => o.event.created_at),
    )
    return deletedAt >= best.created_at ? null : best
  }

  /**
   * Which of these versions, held only by this server, a deletion on the
   * relays took down: a kind 5 by the agent naming the bag's address or the
   * version's id, at least as new (review of #32, round 2: another session's
   * deletion, or one the outbox no longer carries). By lookup id. Each one
   * found is recorded, so the next version is newer than the deletion and no
   * relay takes it down with the old one.
   */
  private async deletedElsewhere(versions: NostrEvent[]): Promise<Set<string>> {
    const out = new Set<string>()
    if (versions.length === 0) return out
    const me = this.host.pubkey
    const byAddress = new Map(versions.map((v) => [`${HIDDEN_KIND}:${me}:${dOf(v)}`, v]))
    const byId = new Map(versions.map((v) => [v.id, v]))
    const answers = await Promise.all([
      this.host.relays.queryEach({ kinds: [5], authors: [me], '#a': [...byAddress.keys()] }),
      this.host.relays.queryEach({ kinds: [5], authors: [me], '#e': [...byId.keys()] }),
    ])
    for (const del of mergeAnswers(answers.flat())) {
      for (const t of del.tags) {
        const v = t[0] === 'a' ? byAddress.get(t[1]) : t[0] === 'e' ? byId.get(t[1]) : undefined
        if (v && (t[0] === 'e' || del.created_at >= v.created_at)) {
          out.add(dOf(v))
          this.host.keys.noteOwnDeletion(dOf(v), Math.max(del.created_at, v.created_at), true)
        }
      }
    }
    return out
  }

  private static answered(answers: RelayAnswer[]): RelayAnswer[] {
    return answers.filter((a) => a.outcome === 'answered')
  }

  private static silentWords(answers: RelayAnswer[]): string[] {
    return answers.flatMap((a) => (a.outcome === 'answered' ? [] : [`${a.url}: ${a.reason}`]))
  }

  /**
   * One of the agent's bags as it stands now, read before it is written:
   * the newest version the relays that answered hold, the outbox carries, or
   * this server signed last, and its entries, every one of them, whether or
   * not this server reads it. The canonical relay must answer, since it is
   * where every reader looks and where a rewrite lands (review of #32: a
   * rewrite from a lesser relay's older copy dropped what only the canonical
   * relay held).
   */
  async ownBag(lookupId: string, regionKey: Uint8Array): Promise<{ current: NostrEvent | null; entries: BagEntry[]; silent: string[] }> {
    const answers = await this.host.relays.queryEach({ kinds: [HIDDEN_KIND], authors: [this.host.pubkey], '#d': [lookupId] })
    const silent = Placements.silentWords(answers)
    if (!answers.some((a) => a.outcome === 'answered' && normalizeURL(a.url) === this.canonical)) {
      throw new Refusal(`The canonical relay did not answer when asked for your bag in that cube (${silent.join('; ') || 'no answer'}). Nothing was changed: writing the bag without reading it there first could drop what it holds. Try again shortly.`)
    }
    const events = mergeAnswers(answers)
    let current = this.newestOwn(lookupId, events)
    if (current && !events.some((e) => e.id === current!.id) && (await this.deletedElsewhere([current])).has(lookupId)) current = null
    if (!current) return { current: null, entries: [], silent }
    const entries = await openEntries(current, regionKey)
    if (entries === null) throw new Refusal(`Your bag in that cube (${current.id.slice(0, 8)}...) does not open with the key derived for it, so rewriting it would destroy what is there. Nothing was published.`)
    return { current, entries, silent }
  }

  /** Every bag of the agent's on the relays (and in its outbox), opened where a key is held, each thing in it as a row. */
  private async readAll(): Promise<Reading> {
    const answers = await this.host.relays.queryEach({ kinds: [HIDDEN_KIND], authors: [this.host.pubkey], limit: MAX_OWN_BAGS })
    if (Placements.answered(answers).length === 0) {
      throw new Refusal(`No relay answered when asked for your bags (${Placements.silentWords(answers).join('; ')}). Try again shortly.`)
    }
    const events = mergeAnswers(answers)
    const silent = Placements.silentWords(answers)
    for (const a of answers) if (a.outcome === 'answered' && a.events.length >= MAX_OWN_BAGS) silent.push(`${a.url}: returned ${a.events.length} bags, the most it gives at once, so some may be missing`)
    const ids = new Set<string>()
    for (const e of events) if (e.kind === HIDDEN_KIND && e.pubkey === this.host.pubkey) ids.add(dOf(e))
    for (const o of this.host.outbox.entries) if (!o.dropped && o.event.kind === HIDDEN_KIND && o.event.pubkey === this.host.pubkey) ids.add(dOf(o.event))
    for (const b of this.host.keys.mine.values()) if (b.lastEvent) ids.add(b.lookupId)
    // A version only this server holds, that a deletion on the relays (another session's, or one the outbox no longer carries) took down, is gone.
    const onlyHere = [...ids].map((d) => this.newestOwn(d, events)).filter((e): e is NostrEvent => !!e && !events.some((x) => x.id === e.id))
    const deleted = await this.deletedElsewhere(onlyHere)
    const bags: OpenBag[] = []
    const unopened: string[] = []
    for (const lookupId of ids) {
      const ev = this.newestOwn(lookupId, events)
      if (!ev || deleted.has(lookupId)) continue
      const own = this.host.keys.mine.get(lookupId)
      const held = this.host.keys.byLookupId(lookupId)
      const keyHex = own?.keyHex ?? held?.keyHex ?? null
      const height = own?.height ?? held?.height ?? null
      const base = own?.base ?? held?.base ?? null
      const settings = bagSettingsOf(ev, height ?? 0)
      const bag: OpenBag = {
        lookupId, bagId: ev.id, height: height ?? -1, base, createdAt: ev.created_at, riddle: settings.riddle, entries: [], keyHeld: !!keyHex,
        onlyHere: !events.some((e) => e.id === ev.id), event: ev, keyHex, rows: [],
      }
      const raw = keyHex ? await openEntries(ev, hexToBytes(keyHex)) : null
      if (!raw || !keyHex || height === null || !base) {
        unopened.push(lookupId)
        bags.push(bag)
        continue
      }
      if (!own && held) this.host.keys.noteOwnBag(held, ev.created_at, { bagId: ev.id })
      const origin = { at: { x: BigInt(base.x), y: BigInt(base.y), z: BigInt(base.z) }, plane: 0 as Plane }
      const opened = await unbag(ev, hexToBytes(keyHex), (ref) => this.host.resolveReference(ref), origin, height)
      for (const e of raw) bag.rows.push(this.rowOf(e, opened, bag))
      bag.entries = bag.rows.map(Placements.publicRow)
      bags.push(bag)
    }
    bags.sort((a, b) => b.createdAt - a.createdAt)
    return { bags, unopened, silent }
  }

  private rowOf(e: BagEntry, opened: Hidden[], bag: OpenBag): Row {
    const key = entryKey(e)
    const h = opened.find((x) => (isReference(e) ? !!x.ref && entryKey(x.ref) === key : !x.ref && x.inner.id === (e as NostrEvent).id)) ?? null
    const point = entryPoint(e)
    const at = h ? { x: h.at.x.toString(), y: h.at.y.toString(), z: h.at.z.toString() } : point ? { x: point.position.x.toString(), y: point.position.y.toString(), z: point.position.z.toString() } : (bag.base ?? { x: '?', y: '?', z: '?' })
    const plane = (h?.plane ?? point?.plane ?? 0) as Plane
    if (isReference(e)) {
      const sealed = !!h && h.inner.kind === OBJECT_KIND && h.inner.tags.some((t) => t[0] === 'encrypted')
      const id = sealed ? h!.inner.id : objectHandle(`${bag.lookupId}/${key}`)
      return {
        id, lineage: e[0] === 'a' ? e[1] : null, type: h ? h.type : 'unreadable', label: h ? labelOf(h) : `a reference this server could not retrieve (${e[1].slice(0, 24)}...)`,
        at, plane, createdAt: h?.createdAt ?? bag.createdAt, byReference: h ? (sealed ? 'sealed' : 'public') : undefined, objectAddress: e[0] === 'a' ? e[1] : undefined,
        key, entry: e, hidden: h, bag,
      }
    }
    const inner = e as NostrEvent
    return {
      id: String(inner.id ?? objectHandle(`${bag.lookupId}/${key}`)), lineage: h ? itemLineage(h.inner) : null, type: h ? h.type : 'unreadable',
      label: h ? labelOf(h) : `an entry of kind ${inner.kind} this server does not read (kept as it is)`,
      at, plane, createdAt: typeof inner.created_at === 'number' ? inner.created_at : bag.createdAt, key, entry: e, hidden: h, bag,
    }
  }

  private static publicRow(r: Row): PlacedEntry {
    const { id, lineage, type, label, at, plane, createdAt, byReference, objectAddress } = r
    return { id, lineage, type, label, at, plane, createdAt, ...(byReference ? { byReference } : {}), ...(objectAddress ? { objectAddress } : {}) }
  }

  private static rows(reading: Reading): Row[] {
    return reading.bags.flatMap((b) => b.rows)
  }

  /**
   * The newest thing placed or moved: what "this" and "last" mean. The one
   * this server last hid or moved, while it is still there; else the newest
   * by its signature's time.
   */
  private last(rows: Row[]): Row | null {
    const noted = this.host.keys.lastPlaced
    const hit = noted ? rows.find((r) => r.bag.lookupId === noted.lookupId && r.key === noted.entryKey) : undefined
    if (hit) return hit
    return rows.reduce<Row | null>((best, r) => (!best || r.createdAt > best.createdAt || (r.createdAt === best.createdAt && r.bag.createdAt > best.bag.createdAt) ? r : best), null)
  }

  /**
   * The thing `target` names, of `type` when given: "last" (the newest
   * thing placed or moved, of that type), an id or lineage (at least 8 hex),
   * an object address, or a name, exactly. Never a part of a name: "shard"
   * must not take down a message that mentions a shard (review of #32).
   * Several fits are refused with the candidates.
   */
  private resolve(reading: Reading, target: string | undefined, type?: string): Row {
    const want = type === undefined ? undefined : TYPE_WORDS[String(type).trim().toLowerCase()]
    if (type !== undefined && !want) throw new Refusal('type is one of: shard, message, key, chest.')
    const rows = Placements.rows(reading).filter((r) => !want || r.type === want)
    const t = String(target ?? '').trim()
    const lower = t.toLowerCase()
    if (!t) throw new Refusal('Say which thing (target): "last" for the newest thing you placed or moved, its name, or its id; placed lists them. Nothing was changed.')
    if (rows.length === 0) throw new Refusal(`You have no${want ? ` ${want}` : 'thing'} placed that this server can open: placed lists your bags. Nothing was changed.`)
    if (LAST_WORDS.has(lower)) return this.last(rows)!
    const many = (hits: Row[], how: string): never => {
      const list = hits.slice(0, 10).map((r) => `${r.type} "${r.label}" id ${r.id.slice(0, 12)} at ${words(r.at)} (h${r.bag.height})`).join('; ')
      throw new Refusal(`${hits.length} things you placed ${how}: ${list}. Give the id (placed lists them). Nothing was changed.`)
    }
    if (/^[0-9a-f]{8,64}$/.test(lower)) {
      const hits = rows.filter((r) => r.id.startsWith(lower) || (r.lineage !== null && /^[0-9a-f]{64}$/.test(r.lineage) && r.lineage.startsWith(lower)))
      const unique = [...new Map(hits.map((r) => [`${r.bag.lookupId}/${r.key}`, r])).values()]
      if (unique.length === 1) return unique[0]
      if (unique.length > 1) many(unique, `have ids starting ${lower}`)
    }
    const byAddress = rows.filter((r) => r.objectAddress === t)
    if (byAddress.length === 1) return byAddress[0]
    if (byAddress.length > 1) many(byAddress, `name the object ${t}`)
    const exact = rows.filter((r) => r.label.toLowerCase() === lower)
    if (exact.length === 1) return exact[0]
    if (exact.length > 1) many(exact, `are called "${t}"`)
    const close = rows.filter((r) => r.label.toLowerCase().includes(lower)).slice(0, 5).map((r) => `${r.type} "${r.label}" id ${r.id.slice(0, 12)}`)
    throw new Refusal(`Nothing you placed${want ? ` of type ${want}` : ''} is called exactly "${t}" or has an id starting ${lower}.${close.length ? ` Close: ${close.join('; ')}.` : ''} placed lists what you placed, with ids. Nothing was changed.`)
  }

  // ---- placed -----------------------------------------------------------------

  async list(input: { match?: string } = {}): Promise<ToolResult> {
    const reading = await this.readAll()
    const match = String(input.match ?? '').trim().toLowerCase()
    const bags = reading.bags.map((b) => ({ ...b, rows: match ? b.rows.filter((r) => r.label.toLowerCase().includes(match)) : b.rows })).filter((b) => !match || b.rows.length > 0)
    const rows = bags.flatMap((b) => b.rows)
    const last = this.last(Placements.rows(reading))
    const out: string[] = []
    if (reading.bags.length === 0) out.push('You have no bags on the relays that answered: nothing placed.')
    else out.push(`Your bags: ${reading.bags.length}, holding ${Placements.rows(reading).length} thing(s)${match ? `; ${rows.length} match "${match}"` : ''}. Newest bag first; names and messages are your own words, read back.`)
    if (last) out.push(`The newest thing you placed or moved ("last"): ${last.type} "${last.label}" id ${last.id.slice(0, 12)} at ${words(last.at)} (h${last.bag.height}).`)
    for (const b of bags) {
      const head = b.keyHeld
        ? `h${b.height} cube at base ${b.base ? words(b.base) : '?'}: bag ${b.bagId.slice(0, 8)}..., lookup id ${b.lookupId.slice(0, 12)}..., ${b.rows.length} thing(s)${b.riddle ? `, riddle "${b.riddle}"` : ''}${b.onlyHere ? ' (this version is in your own record; no relay that answered has it yet)' : ''}`
        : `bag ${b.bagId.slice(0, 8)}..., lookup id ${b.lookupId.slice(0, 12)}...: this server holds no key for it, so what is inside cannot be read; remove_placed with bag ${b.lookupId.slice(0, 12)} and whole_bag takes it down`
      out.push(head)
      for (const r of b.rows) {
        const how = r.byReference === 'sealed' ? ' [by reference, sealed to this place]' : r.byReference === 'public' ? ' [a public object placed by reference]' : ''
        const moved = r.lineage && r.lineage !== r.id && /^[0-9a-f]{64}$/.test(r.lineage) ? `, moved (lineage ${r.lineage.slice(0, 12)})` : ''
        out.push(`  ${r.type} "${r.label}" id ${r.id.slice(0, 12)} at ${words(r.at)}${how}${moved}`)
      }
    }
    if (reading.silent.length) out.push(`Not answered: ${reading.silent.join('; ')}. A bag only those relays hold is not listed.`)
    out.push('To take one down: remove_placed with its target (its id, its exact name, or "last" for the newest of any type; add type: "shard" for the newest shard); whole_bag: true takes down the bag it is in. To move one: move_placed with its target and by: { dz: 12 } for 12 gibsons toward Z+ (dx, dy, dz in gibsons, negative for X-, Y-, Z-), or to: a coordinate.')
    return {
      text: out.join('\n'),
      data: {
        bags: bags.map((b) => ({ lookupId: b.lookupId, bagId: b.bagId, height: b.height, base: b.base, createdAt: b.createdAt, riddle: b.riddle, keyHeld: b.keyHeld, onlyHere: b.onlyHere, entries: b.rows.map(Placements.publicRow) })),
        last: last ? Placements.publicRow(last) : null,
        unanswered: reading.silent,
      },
    }
  }

  // ---- publishing a bag change --------------------------------------------------

  /** Sign a bag version, newer than every version and deletion this server signed for it. */
  private async signBag(entries: BagEntry[], key: Pick<HeldKey, 'lookupId' | 'keyHex' | 'height' | 'base'>, settings: BagSettings, place: { position: Position; plane: Plane }, current: NostrEvent | null): Promise<NostrEvent> {
    const createdAt = Math.max(nowSeconds(), (current?.created_at ?? 0) + 1, this.floor(key.lookupId))
    return this.host.sign(await bagTemplate(entries, hexToBytes(key.keyHex), key.lookupId, key.height, createdAt, HIDDEN_KIND, settings, { at: place.position, plane: place.plane }))
  }

  /** Sign a bag version, record it whole as the newest this server signed, write it to the outbox and send it. */
  private async publishBag(entries: BagEntry[], key: Pick<HeldKey, 'lookupId' | 'keyHex' | 'height' | 'base'>, settings: BagSettings, place: { position: Position; plane: Plane }, current: NostrEvent | null): Promise<{ event: NostrEvent; entry: OutboxEntry }> {
    const event = await this.signBag(entries, key, settings, place, current)
    this.host.keys.noteOwnBag(key, event.created_at, { bagId: event.id, event })
    const entry = this.host.outbox.add(event)
    await this.host.outbox.send(entry)
    return { event, entry }
  }

  /** Delete one of the agent's bags whole (NIP-09), by its address and its newest id, exactly as ONOSENDAI deletes an emptied one. */
  private async deleteBag(lookupId: string, bagId: string | null, createdAt: number, key: Pick<HeldKey, 'lookupId' | 'keyHex' | 'height' | 'base'> | null): Promise<{ event: NostrEvent; entry: OutboxEntry }> {
    const at = Math.max(nowSeconds(), createdAt)
    const event = this.host.sign({
      kind: 5,
      created_at: at,
      content: 'hidden content removed',
      // kind 33330 is addressable, so the address is what a relay replaces and what NIP-09 asks for; the event id goes too, for relays that only match that.
      tags: [['a', `${HIDDEN_KIND}:${this.host.pubkey}:${lookupId}`], ...(bagId ? [['e', bagId]] : []), ['k', String(HIDDEN_KIND)]],
    })
    // The version kept whole goes now, before anything is sent: it must never bring the bag back (review of #32, round 2).
    this.host.keys.noteOwnDeletion(lookupId, at, false)
    const entry = this.host.outbox.add(event)
    await this.host.outbox.send(entry)
    // Recorded as done only once the canonical relay took it: one it refused leaves the bag listed, so it can be removed again (review of #32).
    if (key && entry.accepted.includes(this.canonical)) this.host.keys.noteOwnBag(key, at, { deleted: true })
    const noted = this.host.keys.bags.get(lookupId)
    if (noted?.author === this.host.pubkey) this.host.keys.forgetBag(lookupId)
    return { event, entry }
  }

  /** File a bag version as find files one, so find, comment and render see it as it is now. */
  private async noteOpened(event: NostrEvent, key: Pick<HeldKey, 'lookupId' | 'keyHex' | 'height' | 'base'>, settings: BagSettings): Promise<void> {
    const base = { x: BigInt(key.base.x), y: BigInt(key.base.y), z: BigInt(key.base.z) }
    const opened = await unbag(event, hexToBytes(key.keyHex), (r) => this.host.resolveReference(r), { at: base, plane: 0 }, key.height)
    const refs = (await openEntries(event, hexToBytes(key.keyHex)) ?? []).filter(isReference).length
    const bag: OpenedBag = {
      lookupId: key.lookupId, bagId: event.id, author: this.host.pubkey, createdAt: event.created_at, height: key.height, base: key.base,
      entries: opened.map((h) => this.host.summarize(h, key.lookupId)), missing: refs - opened.filter((h) => h.ref).length, riddle: settings.riddle, hint: settings.hint, at: nowSeconds(),
    }
    this.host.keys.noteBag(bag)
  }

  /**
   * Whether the event at an object's address is still this very version, as
   * the relays answer (ONOSENDAI addressStillThis, review of #369): newer
   * when one holds a newer version, silent when none answered, since a
   * retraction by address deletes whatever the address holds.
   */
  private async addressStillThis(object: NostrEvent): Promise<'this' | 'newer' | 'silent'> {
    try {
      const answers = Placements.answered(await this.host.relays.queryEach({ kinds: [object.kind], authors: [object.pubkey], '#d': [dOf(object)] }))
      if (answers.length === 0) return 'silent'
      return answers.some((a) => a.events.some((e) => e.id !== object.id && e.created_at >= object.created_at)) ? 'newer' : 'this'
    } catch {
      return 'silent'
    }
  }

  /**
   * Take down a sealed object of the agent's that no bag names any more
   * (ONOSENDAI deleteInstance), with the deletion ONOSENDAI's RETRACT sends.
   * Only when every one of the agent's bags was read, none of them names it,
   * and the relays hold this very version. Returns what happened, in words.
   */
  private async retractIfUnnamed(row: Row, reading: Reading, goneFrom: Set<string>): Promise<string> {
    const object = row.hidden?.inner
    if (!object || row.byReference !== 'sealed' || object.pubkey !== this.host.pubkey || !row.objectAddress) return ''
    if (reading.unopened.length > 0 || reading.silent.length > 0) return ' Its sealed object (kind 33331) was left up: not every bag of yours could be read, so another may still name it.'
    const named = Placements.rows(reading).some((r) => r.objectAddress === row.objectAddress && !goneFrom.has(`${r.bag.lookupId}/${r.key}`))
    if (named) return ' Its sealed object stays: another of your placements names it.'
    const still = await this.addressStillThis(object)
    if (still !== 'this') return ` Its sealed object was left up: ${still === 'newer' ? 'the relays hold a newer version of it' : 'no relay answered about it'}.`
    const del = this.host.sign({ kind: 5, created_at: nowSeconds(), content: 'hidden object removed', tags: [['a', row.objectAddress], ['e', object.id], ['k', String(OBJECT_KIND)]] })
    const entry = this.host.outbox.add(del)
    await this.host.outbox.send(entry)
    return ` Its sealed object (kind 33331) was taken down too: ${relayWords(entry)}.`
  }

  /** Refuse while an earlier change to one of these bags (or this object) has reached no relay at all: building on top of it now could lose it or bring it back. */
  private unsentGuard(lookupIds: string[], objectD: string | null): void {
    const me = this.host.pubkey
    // Owed: no relay took it yet and some relay may still take it. One every relay refused is settled, and building on it loses nothing.
    const owed = this.host.outbox.entries.filter((o) => !o.dropped && o.accepted.length === 0 && Object.keys(o.refused ?? {}).length < this.host.relays.urls.length && o.event.pubkey === me && (
      (o.event.kind === HIDDEN_KIND && lookupIds.includes(dOf(o.event))) ||
      (objectD !== null && o.event.kind === OBJECT_KIND && dOf(o.event) === objectD) ||
      (o.event.kind === 5 && o.event.tags.some((t) => t[0] === 'a' && lookupIds.some((l) => t[1] === `${HIDDEN_KIND}:${me}:${l}`)))
    ))
    if (owed.length > 0) throw new Refusal(`An earlier change to that bag has not reached any relay yet (outbox: ${owed.map((o) => `kind ${o.event.kind} ${o.event.id.slice(0, 8)}...`).join(', ')}). Nothing was changed; the outbox retries it. Try again once outbox shows it accepted.`)
  }

  private keyOf(bag: OpenBag): Pick<HeldKey, 'lookupId' | 'keyHex' | 'height' | 'base'> {
    if (!bag.keyHex || !bag.base || bag.height < 0) throw new Refusal('This server holds no key for that bag, so it cannot be rewritten; remove_placed with whole_bag: true takes it down whole.')
    return { lookupId: bag.lookupId, keyHex: bag.keyHex, height: bag.height, base: bag.base }
  }

  // ---- remove_placed -------------------------------------------------------------

  async remove(input: { target?: string; type?: string; bag?: string; whole_bag?: boolean }): Promise<ToolResult> {
    if (input.bag !== undefined && input.target !== undefined) throw new Refusal('Give either target (one thing) or bag (a whole bag), not both.')
    if (input.bag === undefined && (input.target === undefined || !String(input.target).trim())) throw new Refusal('Say what to remove: target ("last" for the newest thing you placed or moved, its exact name, or its id), or bag (a lookup id from placed). Nothing was changed.')
    const reading = await this.readAll()
    if (input.bag !== undefined) {
      const want = String(input.bag).trim().toLowerCase()
      if (!/^[0-9a-f]{8,64}$/.test(want)) throw new Refusal('bag is at least 8 hex characters of a lookup id or bag id, as placed lists them.')
      const hits = reading.bags.filter((b) => b.lookupId.startsWith(want) || b.bagId.startsWith(want))
      if (hits.length === 0) throw new Refusal(`None of your bags has a lookup id or bag id starting ${want}. placed lists them.`)
      if (hits.length > 1) throw new Refusal(`${hits.length} of your bags start ${want}; give more of the id.`)
      return this.removeBag(hits[0], reading)
    }
    const row = this.resolve(reading, input.target, input.type)
    if (input.whole_bag) return this.removeBag(row.bag, reading)
    const key = this.keyOf(row.bag)
    return this.withBags([key.lookupId], async () => {
      this.unsentGuard([key.lookupId], null)
      const { current, entries } = await this.ownBag(key.lookupId, hexToBytes(key.keyHex))
      if (!current || !entries.some((e) => entryKey(e) === row.key)) throw new Refusal(`${row.type} "${row.label}" is no longer in that bag; nothing was changed. placed shows what is there now.`)
      const left = entries.filter((e) => entryKey(e) !== row.key)
      const what = `${row.type} "${row.label}" (id ${row.id.slice(0, 12)}) at ${words(row.at)} in your h${key.height} bag`
      if (left.length > 0) {
        const settings = bagSettingsOf(current, key.height)
        const { event, entry } = await this.publishBag(left, key, settings, { position: { x: BigInt(key.base.x), y: BigInt(key.base.y), z: BigInt(key.base.z) }, plane: row.plane }, current)
        await this.noteOpened(event, key, settings)
        const retract = entry.accepted.length > 0 ? await this.retractIfUnnamed(row, reading, new Set([`${row.bag.lookupId}/${row.key}`])) : ''
        return {
          text: `Removed ${what}. The bag was rewritten without it (${event.id.slice(0, 8)}...), keeping the other ${left.length} thing(s): ${relayWords(entry)}.${retract}`,
          data: { removed: Placements.publicRow(row), bagId: event.id, lookupId: key.lookupId, left: left.length, deletedBag: false, accepted: entry.accepted, refused: entry.refused ?? {} },
        }
      }
      const { event, entry } = await this.deleteBag(key.lookupId, current.id, current.created_at, key)
      const retract = entry.accepted.length > 0 ? await this.retractIfUnnamed(row, reading, new Set([`${row.bag.lookupId}/${row.key}`])) : ''
      return {
        text: `Removed ${what}. It was the last thing in the bag, so the bag itself was deleted (NIP-09 kind 5 ${event.id.slice(0, 8)}...): ${relayWords(entry)}.${retract}`,
        data: { removed: Placements.publicRow(row), deletionId: event.id, lookupId: key.lookupId, left: 0, deletedBag: true, accepted: entry.accepted, refused: entry.refused ?? {} },
      }
    })
  }

  private async removeBag(bag: OpenBag, reading: Reading): Promise<ToolResult> {
    return this.withBags([bag.lookupId], async () => {
      this.unsentGuard([bag.lookupId], null)
      // The newest version, read again, so the deletion names the id the relays hold now.
      const answers = await this.host.relays.queryEach({ kinds: [HIDDEN_KIND], authors: [this.host.pubkey], '#d': [bag.lookupId] })
      if (!answers.some((a) => a.outcome === 'answered' && normalizeURL(a.url) === this.canonical)) throw new Refusal(`The canonical relay did not answer for that bag (${Placements.silentWords(answers).join('; ')}). Nothing was changed. Try again shortly.`)
      const current = this.newestOwn(bag.lookupId, mergeAnswers(answers)) ?? bag.event
      const key = bag.keyHex && bag.base && bag.height >= 0 ? { lookupId: bag.lookupId, keyHex: bag.keyHex, height: bag.height, base: bag.base } : null
      const { event, entry } = await this.deleteBag(bag.lookupId, current.id, Math.max(current.created_at, this.floor(bag.lookupId) - 1), key)
      const gone = new Set(bag.rows.map((r) => `${bag.lookupId}/${r.key}`))
      const notes: string[] = []
      if (entry.accepted.length > 0) {
        for (const r of bag.rows) {
          const n = await this.retractIfUnnamed(r, reading, gone)
          if (n) notes.push(n.trim())
        }
      }
      const what = bag.keyHeld ? `your h${bag.height} bag at base ${bag.base ? words(bag.base) : '?'} and the ${bag.rows.length} thing(s) in it${bag.rows.length ? ` (${bag.rows.slice(0, 8).map((r) => `"${r.label}"`).join(', ')}${bag.rows.length > 8 ? ', ...' : ''})` : ''}` : `your bag ${bag.lookupId.slice(0, 12)}... (no key held, so what it held was not read)`
      return {
        text: `Deleted ${what} (NIP-09 kind 5 ${event.id.slice(0, 8)}... naming 33330:<you>:${bag.lookupId.slice(0, 12)}...): ${relayWords(entry)}.${notes.length ? ` ${notes.join(' ')}` : ''}`,
        data: { deletedBag: true, lookupId: bag.lookupId, bagId: current.id, deletionId: event.id, removed: bag.rows.map(Placements.publicRow), accepted: entry.accepted, refused: entry.refused ?? {} },
      }
    })
  }

  // ---- move_placed ---------------------------------------------------------------

  async move(input: { target?: string; type?: string; by?: { dx?: string | number; dy?: string | number; dz?: string | number }; to?: CoordinateInput; height?: number }): Promise<ToolResult> {
    if ((input.by === undefined) === (input.to === undefined)) throw new Refusal('Give exactly one of: by (an offset from where the thing is now, in gibsons: { dz: 12 } is 12 toward Z+), or to (a coordinate: 64 hex, { x, y, z, plane }, or { dx, dy, dz } from where you stand).')
    if (input.target === undefined || !String(input.target).trim()) throw new Refusal('Say what to move: target ("last" for the newest thing you placed or moved, its exact name, or its id). Nothing was changed.')
    const reading = await this.readAll()
    const row = this.resolve(reading, input.target, input.type)
    if (row.type === 'unreadable') throw new Refusal(`That entry is one this server cannot read (${row.label}), so it cannot be moved; remove_placed can take it down.`)
    // The things sealed in a chest keep the point they were sealed at, and ONOSENDAI shows them there (review of #32): a chest is not moved.
    if (row.type === 'chest') throw new Refusal(`A chest cannot be moved: what is sealed inside it keeps the place it was sealed at, so it would show at the old place. To have it elsewhere, seal a new chest there with seal_chest and take this one down with remove_placed. Nothing was changed.`)
    const from = placeOf({ x: BigInt(row.at.x), y: BigInt(row.at.y), z: BigInt(row.at.z) }, row.plane)
    let dest: Place
    try {
      if (input.by !== undefined) {
        const by = input.by as Record<string, unknown>
        if (Object.keys(by).some((k) => !['dx', 'dy', 'dz'].includes(k))) throw new Error('by takes only dx, dy and dz, in gibsons')
        dest = parseCoordinate({ dx: input.by.dx ?? 0, dy: input.by.dy ?? 0, dz: input.by.dz ?? 0 }, from)
      } else {
        dest = parseCoordinate(input.to as CoordinateInput, this.host.here())
      }
    } catch (err) {
      throw new Refusal(err instanceof Error ? err.message : String(err))
    }
    const oldKey = this.keyOf(row.bag)
    const height = input.height ?? oldKey.height
    if (!Number.isInteger(height) || height < this.host.minHeight || height > this.host.maxHeight) throw new Refusal(`height must be an integer from ${this.host.minHeight} to ${this.host.maxHeight}.`)
    if (dest.hex === from.hex && height === oldKey.height) throw new Refusal(`${row.type} "${row.label}" is already at ${words(row.at)} in your h${height} bag; nothing was changed.`)
    const { key: newHeld, ms: keyMs } = this.host.keyFor(dest.position, height)
    const newKey = { lookupId: newHeld.lookupId, keyHex: newHeld.keyHex, height: newHeld.height, base: newHeld.base }
    const sameBag = newKey.lookupId === oldKey.lookupId
    const isRef = isReference(row.entry)
    const sealedOwn = isRef && row.byReference === 'sealed' && row.hidden?.inner.pubkey === this.host.pubkey
    return this.withBags([oldKey.lookupId, newKey.lookupId], async () => {
      this.unsentGuard([oldKey.lookupId, newKey.lookupId], sealedOwn ? dOf(row.hidden!.inner) : null)
      const src = await this.ownBag(oldKey.lookupId, hexToBytes(oldKey.keyHex))
      if (!src.current) throw new Refusal(`${row.type} "${row.label}" is no longer placed; nothing was changed.`)
      const was = src.entries.find((e) => entryKey(e) === row.key)
      if (!was) throw new Refusal(`${row.type} "${row.label}" is no longer in that bag; nothing was changed. placed shows what is there now.`)
      const now = nowSeconds()

      // The thing at its new place: signed again with its lineage, or its reference pointed at the new point.
      let moved: BagEntry
      let object: NostrEvent | null = null
      let rollback: NostrEvent | null = null
      if (!isReference(was)) {
        const inner = was as NostrEvent
        moved = this.host.sign(editedTemplate({ kind: inner.kind, created_at: now, content: inner.content, tags: [['C', dest.hex]] }, inner))
      } else {
        const ref = was as Reference
        if (sealedOwn && !sameBag) {
          const old = row.hidden!.inner
          const still = await this.addressStillThis(old)
          if (still !== 'this') throw new Refusal(still === 'newer' ? 'The relays hold a newer version of that shard\'s object than the one in your bag (moved from somewhere else?). Nothing was changed; call placed again.' : 'No relay answered about that shard\'s object, so sealing it again could overwrite a version this server cannot see. Nothing was changed; try again shortly.')
          const objectAt = Math.max(now, old.created_at + 1)
          const t = await resealedObject(old, hexToBytes(oldKey.keyHex), hexToBytes(newKey.keyHex), objectAt)
          if (!t) throw new Refusal('That shard\'s object does not open with its bag\'s key, so it cannot be sealed to the new place. Nothing was changed.')
          object = this.host.sign(t)
          // The old version, signed again a second newer: what goes back if the move does not land (ONOSENDAI rollback, review of #369).
          rollback = this.host.sign({ kind: old.kind, created_at: objectAt + 1, content: old.content, tags: old.tags })
        }
        moved = [ref[0], ref[1], ref[2] ?? '', dest.hex]
      }

      // Inside one bag: one rewrite, which loses nothing whichever relays take it.
      if (sameBag) {
        const entries = mergeEntries(src.entries.filter((e) => entryKey(e) !== row.key), [moved])
        const settings = bagSettingsOf(src.current, height)
        const { event: newBag, entry } = await this.publishBag(entries, newKey, settings, dest, src.current)
        await this.noteOpened(newBag, newKey, settings)
        return this.moved(row, moved, null, from, dest, oldKey, newKey, height, keyMs, true, `Same bag, rewritten in one step (${newBag.id.slice(0, 8)}..., ${entries.length} thing(s)): ${relayWords(entry)}.`, newBag, entry.accepted, entry.refused ?? {})
      }

      // To another bag: the destination's bag with it added, signed before anything goes out.
      const dst = await this.ownBag(newKey.lookupId, hexToBytes(newKey.keyHex))
      const entries = mergeEntries(dst.entries, [moved])
      const settings0 = dst.current ? bagSettingsOf(dst.current, height) : { heightTag: true, hint: null, riddle: '', contents: false, money: false }
      const settings: BagSettings = { ...settings0, hint: settings0.hint && hintFits(settings0.hint, height) ? settings0.hint : null }
      const newBag = await this.signBag(entries, newKey, settings, dest, dst.current)
      const canonical = this.canonical

      if (object && rollback) {
        // On disk before anything is published, so a server stopped mid-move puts the old object back at its next start.
        this.host.keys.holdPutBack({ rollback, newLookupId: newKey.lookupId, newBagId: newBag.id })
        const sent = await this.host.relays.publish(object).catch((err) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err), reasons: {} as Record<string, string> }))
        if (!sent.ok || !sent.accepted.includes(canonical)) {
          const back = await this.putBack(rollback)
          throw new Refusal(`The canonical relay did not take the shard's object sealed to its new place (${sent.ok ? `only ${sent.accepted.join(', ')} did` : sent.reason}${Object.entries(sent.reasons).length ? `; ${Object.entries(sent.reasons).map(([u, r]) => `${u}: ${r}`).join('; ')}` : ''}). Nothing was moved; it stays where it was.${back}`)
        }
      }
      // The new bag goes to the relays directly, not through the outbox first, so no retry can send it after the move is given up.
      const sent = await this.host.relays.publish(newBag).catch((err) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err), reasons: {} as Record<string, string> }))
      const accepted = sent.ok ? sent.accepted : []
      const said = Object.entries(sent.reasons).map(([u, r]) => `${u}: ${r}`).join('; ')
      if (!accepted.includes(canonical)) {
        const back = object && rollback ? await this.putBack(rollback) : ''
        if (accepted.length > 0 && !object) {
          // A lesser relay holds the new copy: it is recorded, so no later rewrite there drops it, and the old copy stays everywhere.
          this.host.keys.noteOwnBag(newKey, newBag.created_at, { bagId: newBag.id, event: newBag })
          const entry = this.host.outbox.add(newBag)
          await this.host.outbox.send(entry)
          throw new Refusal(`The canonical relay did not take the bag at the new place${said ? ` (${said})` : ''}; only ${accepted.join(', ')} did. The old copy stays where it was everywhere; on ${accepted.join(', ')} the thing now also shows at the new place (and on the canonical relay too if a retry gets it there). remove_placed takes down the copy you do not want.`)
        }
        throw new Refusal(`The canonical relay did not take the bag at the new place${said ? ` (${said})` : sent.ok ? '' : ` (${sent.reason})`}. Nothing was moved; it stays where it was.${back}${accepted.length > 0 ? ` ${accepted.join(', ')} took the new bag, whose reference no longer opens now that the object is back; it is harmless and placed shows it as unreadable there.` : ''}${sent.ok ? '' : ' A relay whose answer timed out may still have stored the new bag; placed shows what is there.'}`)
      }
      this.host.keys.noteOwnBag(newKey, newBag.created_at, { bagId: newBag.id, event: newBag })
      if (rollback) this.host.keys.settlePutBack(rollback.id)
      const newEntry = this.host.outbox.add(newBag)
      await this.host.outbox.send(newEntry)
      await this.noteOpened(newBag, newKey, settings)

      // Taken out of the old bag only now that the canonical relay has the new one, as remove_placed would, except that a resealed object is the moved shard's now and stays.
      let oldWords: string
      const left = src.entries.filter((e) => entryKey(e) !== row.key)
      if (left.length > 0) {
        const oldSettings = bagSettingsOf(src.current, oldKey.height)
        const { event, entry } = await this.publishBag(left, oldKey, oldSettings, from, src.current)
        await this.noteOpened(event, oldKey, oldSettings)
        oldWords = entry.accepted.length > 0
          ? ` The old bag was rewritten without it (${event.id.slice(0, 8)}..., ${left.length} thing(s) left): ${relayWords(entry)}.`
          : ` The old bag's rewrite reached no relay yet, so the old copy still shows until the outbox gets it through (${relayWords(entry)}).`
      } else {
        const { event, entry } = await this.deleteBag(oldKey.lookupId, src.current.id, src.current.created_at, oldKey)
        oldWords = entry.accepted.length > 0
          ? ` It was the last thing in its old bag, so that bag was deleted (kind 5 ${event.id.slice(0, 8)}...): ${relayWords(entry)}.`
          : ` The old bag's deletion reached no relay yet, so the old copy still shows until the outbox gets it through (${relayWords(entry)}).`
      }
      return this.moved(row, moved, object, from, dest, oldKey, newKey, height, keyMs, false, `New place: your h${height} bag at base ${words(newKey.base)} (${newBag.id.slice(0, 8)}..., ${entries.length} thing(s)): ${relayWords(newEntry)}. Key cost ${keyMs.toFixed(0)} ms.${oldWords} Comments are sealed to a bag, so comments left in the old cube stay there.`, newBag, newEntry.accepted, newEntry.refused ?? {})
    })
  }

  /** The answer to a move that happened, and the records that follow it. */
  private moved(row: Row, moved: BagEntry, object: NostrEvent | null, from: Place, dest: Place, oldKey: Pick<HeldKey, 'height' | 'lookupId'>, newKey: Pick<HeldKey, 'lookupId' | 'base'>, height: number, keyMs: number, sameBag: boolean, bagWords: string, newBag: NostrEvent, accepted: string[], refused: Record<string, string>): ToolResult {
    const place: ItemPlace = { lookupId: newKey.lookupId, height, x: dest.position.x.toString(), y: dest.position.y.toString(), z: dest.position.z.toString(), plane: dest.plane }
    this.host.keys.notePlaced(newKey.lookupId, entryKey(moved), nowSeconds())
    if (!isReference(row.entry) && !isReference(moved)) this.host.keys.movedItem((row.entry as NostrEvent).id, (moved as NostrEvent).id, place)
    const newId = isReference(moved) ? (object ? object.id : (row.byReference === 'sealed' ? row.id : objectHandle(`${newKey.lookupId}/${entryKey(moved)}`))) : (moved as NostrEvent).id
    const lineage = isReference(moved) ? moved[1] : itemLineage(moved as NostrEvent)
    const delta = (['x', 'y', 'z'] as const).map((a) => [a, dest.position[a] - from.position[a]] as const).filter(([, d]) => d !== 0n).map(([a, d]) => `${d > 0n ? '+' : ''}${d} ${a}`)
    const text = [
      `Moved ${row.type} "${row.label}" from ${words(row.at)} to ${words(place)}${delta.length ? ` (${delta.join(', ')} gibsons)` : ''}${height !== oldKey.height ? `, from the h${oldKey.height} cube to h${height}` : ''}. Its new id is ${newId.slice(0, 12)}; ${isReference(moved) ? 'its object keeps its address' : `it keeps its lineage ${String(lineage).slice(0, 12)}`}, so its reactions follow it.`,
      bagWords,
    ].join('\n')
    return {
      text,
      data: {
        moved: { ...Placements.publicRow(row), id: newId, lineage, at: { x: place.x, y: place.y, z: place.z }, plane: dest.plane },
        from: { ...row.at, plane: row.plane, height: oldKey.height, lookupId: oldKey.lookupId },
        to: { x: place.x, y: place.y, z: place.z, plane: dest.plane, height, lookupId: newKey.lookupId },
        sameBag, bagId: newBag.id, accepted, refused, keyMs: Math.round(keyMs), objectEventId: object?.id ?? null,
      },
    }
  }

  /** Publish a failed move's old object version, retried; if no relay takes it, the outbox keeps sending it. Returns words for the answer. */
  private async putBack(rollback: NostrEvent): Promise<string> {
    for (let i = 0; ; i++) {
      const r = await this.host.relays.publish(rollback).catch(() => ({ ok: false as const, reason: 'failed', reasons: {} }))
      if (r.ok && r.accepted.includes(this.canonical)) {
        this.host.keys.settlePutBack(rollback.id)
        return ' The shard\'s object was put back as it was.'
      }
      if (i >= PUT_BACK_RETRY_MS.length) break
      await new Promise((res) => setTimeout(res, PUT_BACK_RETRY_MS[i]))
    }
    const entry = this.host.outbox.add(rollback)
    await this.host.outbox.send(entry)
    this.host.keys.settlePutBack(rollback.id)
    return ' Its old object version could not be put back on the canonical relay yet; the outbox keeps sending it. Where a relay took the object sealed to the new place, the old copy does not open until the old version lands there.'
  }
}
