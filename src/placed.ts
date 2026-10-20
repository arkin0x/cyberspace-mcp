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
import type { Relays } from './nostr/relays.js'
import { objectHandle } from './render.js'
import { parseCoordinate, placeOf, type CoordinateInput, type Place, type Position } from './space/coords.js'
import type { EntrySummary, HeldKey, ItemPlace, KeyStore, OpenedBag } from './space/regionKeys.js'
import { Refusal, type ToolResult } from './tool.js'

/** The words an agent may use for "the thing I placed most recently". */
const LAST_WORDS = new Set(['last', 'latest', 'newest', 'recent', 'most recent', 'the last one', 'it', 'this', 'that'])
/** The most of the agent's bags one listing reads. */
const MAX_OWN_BAGS = 1000
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
  /** This server signed a newer version than any relay that answered holds: changed only once that one is seen. */
  stale: boolean
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
  /** Relays that did not answer, with why. */
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

  /** The newest version of one of the agent's bags among these events and the outbox, or null when there is none or it was deleted since. */
  private newestOwn(lookupId: string, fromRelays: NostrEvent[]): NostrEvent | null {
    const me = this.host.pubkey
    const mineHere = (e: NostrEvent): boolean => e.kind === HIDDEN_KIND && e.pubkey === me && dOf(e) === lookupId
    let best: NostrEvent | null = null
    for (const e of fromRelays) if (mineHere(e) && newer(e, best)) best = e
    for (const o of this.host.outbox.entries) if (!o.dropped && mineHere(o.event) && newer(o.event, best)) best = o.event
    if (!best) return null
    // Taken down since: by this server's own record, or by a deletion it still has in its outbox.
    const address = `${HIDDEN_KIND}:${me}:${lookupId}`
    const deletedAt = Math.max(
      this.host.keys.mine.get(lookupId)?.deletedAt ?? 0,
      ...this.host.outbox.entries.filter((o) => !o.dropped && o.event.kind === 5 && o.event.pubkey === me && o.event.tags.some((t) => t[0] === 'a' && t[1] === address)).map((o) => o.event.created_at),
    )
    return deletedAt >= best.created_at ? null : best
  }

  /** Whether this server signed a newer version of the bag than `seen` (or the bag at all, when nothing was seen) and did not delete it since. */
  private staleAgainst(lookupId: string, seen: NostrEvent | null): boolean {
    const rec = this.host.keys.mine.get(lookupId)
    if (!rec || !rec.lastBagId) return false
    if ((rec.deletedAt ?? 0) >= rec.lastAt) return false
    return rec.lastAt > (seen?.created_at ?? 0)
  }

  private static answered(answers: RelayAnswer[]): RelayAnswer[] {
    return answers.filter((a) => a.outcome === 'answered')
  }

  private static silentWords(answers: RelayAnswer[]): string[] {
    return answers.flatMap((a) => (a.outcome === 'answered' ? [] : [`${a.url}: ${a.reason}`]))
  }

  /**
   * One of the agent's bags as it stands now, read before it is written:
   * the newest version any relay that answered holds or the outbox still
   * carries, and its entries, every one of them, whether or not this server
   * reads it. Refuses rather than read a partial picture.
   */
  async ownBag(lookupId: string, regionKey: Uint8Array): Promise<{ current: NostrEvent | null; entries: BagEntry[] }> {
    const answers = await this.host.relays.queryEach({ kinds: [HIDDEN_KIND], authors: [this.host.pubkey], '#d': [lookupId] })
    if (Placements.answered(answers).length === 0) {
      throw new Refusal(`No relay answered when asked for your bag in that cube (${Placements.silentWords(answers).join('; ')}). Nothing was changed: writing the bag without reading it first could drop what it holds. Try again shortly.`)
    }
    const current = this.newestOwn(lookupId, mergeAnswers(answers))
    if (this.staleAgainst(lookupId, current)) {
      throw new Refusal(`The relays that answered do not have the newest version of your bag in that cube (this server signed a newer one: ${this.host.keys.mine.get(lookupId)?.lastBagId?.slice(0, 8)}...). Nothing was changed, so that version's contents are not lost. Try again once the relays have it (outbox shows what is still owed).`)
    }
    if (!current) return { current: null, entries: [] }
    const entries = await openEntries(current, regionKey)
    if (entries === null) throw new Refusal(`Your bag in that cube (${current.id.slice(0, 8)}...) does not open with the key derived for it, so rewriting it would destroy what is there. Nothing was published.`)
    return { current, entries }
  }

  /** Every bag of the agent's on the relays (and in its outbox), opened where a key is held, each thing in it as a row. */
  private async readAll(): Promise<Reading> {
    const answers = await this.host.relays.queryEach({ kinds: [HIDDEN_KIND], authors: [this.host.pubkey], limit: MAX_OWN_BAGS })
    if (Placements.answered(answers).length === 0) {
      throw new Refusal(`No relay answered when asked for your bags (${Placements.silentWords(answers).join('; ')}). Try again shortly.`)
    }
    const events = mergeAnswers(answers)
    const ids = new Set<string>()
    for (const e of events) if (e.kind === HIDDEN_KIND && e.pubkey === this.host.pubkey) ids.add(dOf(e))
    for (const o of this.host.outbox.entries) if (!o.dropped && o.event.kind === HIDDEN_KIND && o.event.pubkey === this.host.pubkey) ids.add(dOf(o.event))
    const bags: OpenBag[] = []
    const unopened: string[] = []
    for (const lookupId of ids) {
      const ev = this.newestOwn(lookupId, events)
      if (!ev) continue
      const own = this.host.keys.mine.get(lookupId)
      const held = this.host.keys.byLookupId(lookupId)
      const keyHex = own?.keyHex ?? held?.keyHex ?? null
      const height = own?.height ?? held?.height ?? null
      const base = own?.base ?? held?.base ?? null
      const settings = bagSettingsOf(ev, height ?? 0)
      const bag: OpenBag = {
        lookupId, bagId: ev.id, height: height ?? -1, base, createdAt: ev.created_at, riddle: settings.riddle, entries: [], keyHeld: !!keyHex,
        stale: this.staleAgainst(lookupId, ev), event: ev, keyHex, rows: [],
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
    return { bags, unopened, silent: Placements.silentWords(answers) }
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

  /** The thing `target` names: "last", an id or lineage (at least 8 hex), an object address, or a name. */
  private resolve(reading: Reading, target: string): Row {
    const rows = Placements.rows(reading)
    const t = String(target ?? '').trim()
    const lower = t.toLowerCase()
    if (rows.length === 0) throw new Refusal('You have nothing placed that this server can open: placed lists your bags.')
    if (!t || LAST_WORDS.has(lower)) {
      const last = this.last(rows)!
      return last
    }
    const many = (hits: Row[], how: string): never => {
      const list = hits.slice(0, 10).map((r) => `${r.type} "${r.label}" id ${r.id.slice(0, 12)} at ${words(r.at)} (h${r.bag.height})`).join('; ')
      throw new Refusal(`${hits.length} things you placed ${how}: ${list}. Give the id (placed lists them), or "last" for the newest.`)
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
    const partial = rows.filter((r) => r.label.toLowerCase().includes(lower))
    if (partial.length === 1) return partial[0]
    if (partial.length > 1) many(partial, `match "${t}"`)
    throw new Refusal(`Nothing you placed is called "${t}" or has an id starting ${lower}. placed lists what you placed, with ids.`)
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
        ? `h${b.height} cube at base ${b.base ? words(b.base) : '?'}: bag ${b.bagId.slice(0, 8)}..., lookup id ${b.lookupId.slice(0, 12)}..., ${b.rows.length} thing(s)${b.riddle ? `, riddle "${b.riddle}"` : ''}${b.stale ? ' (STALE: a newer version you signed is not on the relays yet; it cannot be changed until it is)' : ''}`
        : `bag ${b.bagId.slice(0, 8)}..., lookup id ${b.lookupId.slice(0, 12)}...: this server holds no key for it, so what is inside cannot be read; remove_placed with bag ${b.lookupId.slice(0, 12)} and whole_bag takes it down`
      out.push(head)
      for (const r of b.rows) {
        const how = r.byReference === 'sealed' ? ' [by reference, sealed to this place]' : r.byReference === 'public' ? ' [a public object placed by reference]' : ''
        const moved = r.lineage && r.lineage !== r.id && /^[0-9a-f]{64}$/.test(r.lineage) ? `, moved (lineage ${r.lineage.slice(0, 12)})` : ''
        out.push(`  ${r.type} "${r.label}" id ${r.id.slice(0, 12)} at ${words(r.at)}${how}${moved}`)
      }
    }
    if (reading.silent.length) out.push(`Not answered: ${reading.silent.join('; ')}. A bag only those relays hold is not listed.`)
    out.push('To take one down: remove_placed with its target (an id, its name, or "last"); whole_bag: true takes down the bag it is in. To move one: move_placed with its target and by: { dz: 12 } for 12 gibsons toward Z+ (dx, dy, dz in gibsons, negative for X-, Y-, Z-), or to: a coordinate.')
    return {
      text: out.join('\n'),
      data: {
        bags: bags.map((b) => ({ lookupId: b.lookupId, bagId: b.bagId, height: b.height, base: b.base, createdAt: b.createdAt, riddle: b.riddle, keyHeld: b.keyHeld, stale: b.stale, entries: b.rows.map(Placements.publicRow) })),
        last: last ? Placements.publicRow(last) : null,
        unanswered: reading.silent,
      },
    }
  }

  // ---- publishing a bag change --------------------------------------------------

  /** Sign a bag version, write it to the outbox, send it, and record it as the newest this server signed. */
  private async publishBag(entries: BagEntry[], key: Pick<HeldKey, 'lookupId' | 'keyHex' | 'height' | 'base'>, settings: BagSettings, place: { position: Position; plane: Plane }, current: NostrEvent | null, record: 'always' | 'if accepted' = 'always'): Promise<{ event: NostrEvent; entry: OutboxEntry }> {
    const createdAt = Math.max(nowSeconds(), (current?.created_at ?? 0) + 1, this.host.keys.ownBagFloor(key.lookupId))
    // A hint that cannot contain this region is dropped rather than refused (ONOSENDAI resolveBagSettings).
    const event = this.host.sign(await bagTemplate(entries, hexToBytes(key.keyHex), key.lookupId, key.height, createdAt, HIDDEN_KIND, settings, { at: place.position, plane: place.plane }))
    const entry = this.host.outbox.add(event)
    await this.host.outbox.send(entry)
    if (record === 'always' || entry.accepted.length > 0) this.host.keys.noteOwnBag(key, createdAt, { bagId: event.id })
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
    const entry = this.host.outbox.add(event)
    await this.host.outbox.send(entry)
    if (key) this.host.keys.noteOwnBag(key, at, { deleted: true })
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
    const owed = this.host.outbox.entries.filter((o) => !o.dropped && o.accepted.length === 0 && o.event.pubkey === me && (
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

  async remove(input: { target?: string; bag?: string; whole_bag?: boolean }): Promise<ToolResult> {
    const reading = await this.readAll()
    if (input.bag !== undefined && input.target !== undefined) throw new Refusal('Give either target (one thing) or bag (a whole bag), not both.')
    if (input.bag !== undefined) {
      const want = String(input.bag).trim().toLowerCase()
      if (!/^[0-9a-f]{8,64}$/.test(want)) throw new Refusal('bag is at least 8 hex characters of a lookup id or bag id, as placed lists them.')
      const hits = reading.bags.filter((b) => b.lookupId.startsWith(want) || b.bagId.startsWith(want))
      if (hits.length === 0) throw new Refusal(`None of your bags has a lookup id or bag id starting ${want}. placed lists them.`)
      if (hits.length > 1) throw new Refusal(`${hits.length} of your bags start ${want}; give more of the id.`)
      return this.removeBag(hits[0], reading)
    }
    const row = this.resolve(reading, input.target ?? '')
    if (input.whole_bag) return this.removeBag(row.bag, reading)
    if (row.bag.stale) throw new Refusal('That bag has a newer version you signed that the relays do not show yet; nothing was changed. Try again once outbox shows it accepted.')
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
      if (Placements.answered(answers).length === 0) throw new Refusal(`No relay answered for that bag (${Placements.silentWords(answers).join('; ')}). Nothing was changed. Try again shortly.`)
      const current = this.newestOwn(bag.lookupId, mergeAnswers(answers)) ?? bag.event
      const key = bag.keyHex && bag.base && bag.height >= 0 ? { lookupId: bag.lookupId, keyHex: bag.keyHex, height: bag.height, base: bag.base } : null
      const { event, entry } = await this.deleteBag(bag.lookupId, current.id, Math.max(current.created_at, this.host.keys.ownBagFloor(bag.lookupId) - 1), key)
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

  async move(input: { target?: string; by?: { dx?: string | number; dy?: string | number; dz?: string | number }; to?: CoordinateInput; height?: number }): Promise<ToolResult> {
    if ((input.by === undefined) === (input.to === undefined)) throw new Refusal('Give exactly one of: by (an offset from where the thing is now, in gibsons: { dz: 12 } is 12 toward Z+), or to (a coordinate: 64 hex, { x, y, z, plane }, or { dx, dy, dz } from where you stand).')
    const reading = await this.readAll()
    const row = this.resolve(reading, input.target ?? '')
    if (row.type === 'unreadable') throw new Refusal(`That entry is one this server cannot read (${row.label}), so it cannot be moved; remove_placed can take it down.`)
    if (row.bag.stale) throw new Refusal('That bag has a newer version you signed that the relays do not show yet; nothing was changed. Try again once outbox shows it accepted.')
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
          // The old version, signed again a second newer: what goes back if the new bag reaches no relay (ONOSENDAI rollback, review of #369).
          rollback = this.host.sign({ kind: old.kind, created_at: objectAt + 1, content: old.content, tags: old.tags })
        }
        moved = [ref[0], ref[1], ref[2] ?? '', dest.hex]
      }

      // The new bag: the same bag with the old entry out and the new one in, or the destination's bag with it added.
      const dst = sameBag ? src : await this.ownBag(newKey.lookupId, hexToBytes(newKey.keyHex))
      const base = sameBag ? src.entries.filter((e) => entryKey(e) !== row.key) : dst.entries
      const entries = mergeEntries(base, [moved])
      const settings0 = dst.current ? bagSettingsOf(dst.current, height) : { heightTag: true, hint: null, riddle: '', contents: false, money: false }
      const settings: BagSettings = { ...settings0, hint: settings0.hint && hintFits(settings0.hint, height) ? settings0.hint : null }

      if (object) {
        const sent = await this.host.relays.publish(object)
        if (!sent.ok) throw new Refusal(`No relay took the shard's object sealed to its new place (${sent.reason}). Nothing was moved; it stays where it was.`)
      }
      // Recorded as the bag's newest only once a relay has it: a move no relay took is abandoned, and its bag dropped.
      const { event: newBag, entry: newEntry } = await this.publishBag(entries, newKey, settings, dest, dst.current, 'if accepted')
      if (newEntry.accepted.length === 0) {
        // A move whose new bag no relay took has not happened: the new bag must never land later beside the old copy.
        this.host.outbox.drop(newEntry, 'move abandoned: no relay took the new bag')
        let putBack = ''
        if (object && rollback) putBack = await this.putBack(rollback)
        throw new Refusal(`No relay took the bag at the new place (${relayWords(newEntry)}). Nothing was moved; it stays where it was.${putBack}`)
      }
      await this.noteOpened(newBag, newKey, settings)

      // Taken out of the old bag, as remove_placed would, except that a resealed object is the moved shard's now and stays.
      let oldWords = ''
      if (!sameBag) {
        const left = src.entries.filter((e) => entryKey(e) !== row.key)
        if (left.length > 0) {
          const oldSettings = bagSettingsOf(src.current!, oldKey.height)
          const { event, entry } = await this.publishBag(left, oldKey, oldSettings, from, src.current)
          await this.noteOpened(event, oldKey, oldSettings)
          oldWords = entry.accepted.length > 0
            ? ` The old bag was rewritten without it (${event.id.slice(0, 8)}..., ${left.length} thing(s) left): ${relayWords(entry)}.`
            : ` The old bag's rewrite reached no relay yet, so the old copy still shows until the outbox gets it through (${relayWords(entry)}).`
        } else {
          const { event, entry } = await this.deleteBag(oldKey.lookupId, src.current!.id, src.current!.created_at, oldKey)
          oldWords = entry.accepted.length > 0
            ? ` It was the last thing in its old bag, so that bag was deleted (kind 5 ${event.id.slice(0, 8)}...): ${relayWords(entry)}.`
            : ` The old bag's deletion reached no relay yet, so the old copy still shows until the outbox gets it through (${relayWords(entry)}).`
        }
      }
      const place: ItemPlace = { lookupId: newKey.lookupId, height, x: dest.position.x.toString(), y: dest.position.y.toString(), z: dest.position.z.toString(), plane: dest.plane }
      this.host.keys.notePlaced(newKey.lookupId, entryKey(moved), nowSeconds())
      if (!isReference(was) && !isReference(moved)) this.host.keys.movedItem((was as NostrEvent).id, (moved as NostrEvent).id, place)
      const newId = isReference(moved) ? (object ? object.id : (sealedOwn ? row.id : objectHandle(`${newKey.lookupId}/${entryKey(moved)}`))) : (moved as NostrEvent).id
      const lineage = isReference(moved) ? moved[1] : itemLineage(moved as NostrEvent)
      const delta = (['x', 'y', 'z'] as const).map((a) => [a, dest.position[a] - from.position[a]] as const).filter(([, d]) => d !== 0n).map(([a, d]) => `${d > 0n ? '+' : ''}${d} ${a}`)
      const text = [
        `Moved ${row.type} "${row.label}" from ${words(row.at)} to ${words(place)}${delta.length ? ` (${delta.join(', ')} gibsons)` : ''}${height !== oldKey.height ? `, from the h${oldKey.height} cube to h${height}` : ''}. Its new id is ${newId.slice(0, 12)}; ${isReference(moved) ? 'its object keeps its address' : `it keeps its lineage ${String(lineage).slice(0, 12)}`}, so its reactions follow it.`,
        sameBag
          ? `Same bag, rewritten in one step (${newBag.id.slice(0, 8)}..., ${entries.length} thing(s)): ${relayWords(newEntry)}.`
          : `New place: your h${height} bag at base ${words(newKey.base)} (${newBag.id.slice(0, 8)}..., ${entries.length} thing(s)): ${relayWords(newEntry)}. Key cost ${keyMs.toFixed(0)} ms.${oldWords} Comments are sealed to a bag, so comments left in the old cube stay there.`,
      ].join('\n')
      return {
        text,
        data: {
          moved: { ...Placements.publicRow(row), id: newId, lineage, at: { x: place.x, y: place.y, z: place.z }, plane: dest.plane },
          from: { ...row.at, plane: row.plane, height: oldKey.height, lookupId: oldKey.lookupId },
          to: { x: place.x, y: place.y, z: place.z, plane: dest.plane, height, lookupId: newKey.lookupId },
          sameBag, bagId: newBag.id, accepted: newEntry.accepted, refused: newEntry.refused ?? {}, keyMs: Math.round(keyMs), objectEventId: object?.id ?? null,
        },
      }
    })
  }

  /** Publish a failed move's old object version, retried; if no relay takes it, the outbox keeps sending it. Returns words for the answer. */
  private async putBack(rollback: NostrEvent): Promise<string> {
    for (let i = 0; ; i++) {
      const r = await this.host.relays.publish(rollback).catch(() => ({ ok: false as const, reason: 'failed', reasons: {} }))
      if (r.ok) return ' The shard\'s object was put back as it was.'
      if (i >= PUT_BACK_RETRY_MS.length) break
      await new Promise((res) => setTimeout(res, PUT_BACK_RETRY_MS[i]))
    }
    const entry = this.host.outbox.add(rollback)
    await this.host.outbox.send(entry)
    return ' Its object, already sealed to the new place, could not be put back yet; the outbox keeps sending the old version until a relay takes it, and until then the old copy may not open.'
  }
}

