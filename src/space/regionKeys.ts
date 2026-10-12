// regionKeys.ts: the region keys the server holds and the bags it has
// opened, kept in the state directory under keys/. A key is derived by
// cyberspace-core for an aligned cube at a height (spec 7.2); holding it is
// what lets the agent read a bag there, say a line there and hear one. The
// passive scan derives the keys of the cubes around where the agent stands,
// heights 0 to SCAN_MAX_HEIGHT, the thirteen ONOSENDAI's scan derives
// (useDiscovery: heights 0 through SCAN_MAX_HEIGHT; h0 is the one gibson you
// stand on, and ONOSENDAI hides there too; arkinox, 2026-10-12: XOR could
// not see a quest bag at h0); a hop, a hide and a find add the keys they
// derived.
//
// Items and chests (Keys and Chests B1, and its 2026-10-10 addendum: keys ARE
// items) live here too, as ONOSENDAI's ITEMS panel keeps them (src/lib/
// inventory.ts), per identity: the items the agent holds (a key item is held
// by whoever read its secret: forged, found in a bag, or found in a chest),
// the contents it took out of chests (TAKE copies, it never empties a chest),
// and the chests it has seen, so it can open one later with an item found
// since (arkinox, 2026-10-12: "I don't think the MCP server gives the agent
// any knowledge of items or sealed chests or how to use them"). An item's
// secret is kept here, mode 600 like the agent's own key, and never reported
// by any tool.

import type { Plane } from 'cyberspace-core'
import { bytesToHex } from '../nostr/event.js'
import type { StateDir } from '../state/dir.js'
import { regionKeyAt } from '../hidden/crypto.js'
import type { HiddenType } from '../hidden/bags.js'
import type { HintHeights } from '../hidden/hint.js'
import type { Position } from './coords.js'

/** The widest cube the passive scan reaches, and the cube chat is sealed to (ONOSENDAI SCAN_MAX_HEIGHT). */
export const SCAN_MAX_HEIGHT = 12
/** The narrowest: the cube of side 2^0, the gibson itself (ONOSENDAI scans from h0). */
export const SCAN_MIN_HEIGHT = 0
/** The hard cap on what the core computes for a key, matching cyberspace-core's DEFAULT_MAX_COMPUTE_HEIGHT. */
export const MAX_COMPUTE_HEIGHT = 20
/** How many keys and opened bags are kept; the least recently used go first. */
const KEYS_KEPT = 4000

export type KeySource = 'scan' | 'hop' | 'hide' | 'find' | 'hint'

export interface HeldKey {
  lookupId: string
  keyHex: string
  height: number
  /** The aligned base of the cube, as decimal strings. */
  base: { x: string; y: string; z: string }
  source: KeySource
  /** Unix seconds when it was derived or last used. */
  at: number
}

export interface EntrySummary {
  type: HiddenType
  eventId: string
  /** The item's author (the inner event's pubkey). */
  author: string
  at: { x: string; y: string; z: string }
  plane: Plane
  createdAt: number
  /** A message's preview, a shard's name, a key's or chest's name. Text from cyberspace: untrusted. */
  label: string
  /** A message that holds a Cashu token. */
  coin?: boolean
  byReference?: boolean
  /** A shard's bounds in gibsons at its unit, and its vertex and face counts. */
  shard?: { unit: number; vertices: number; faces: number; extent: number; mode: string }
  /** A key item: its public half and sentence. The secret is held in keys/items.json and never reported. */
  key?: { itemPubkey: string; about: string }
  /** A chest: whether this server could open it, and what it holds when it could. */
  chest?: { lock: string; requires: string; opened: boolean; openedWith?: 'own key' | 'held item'; contents?: Array<{ type: HiddenType; label: string; author: string; verified: boolean }> }
}

/** How a held item came to be held, as ONOSENDAI's inventory says it (HeldSource), less pasted. */
export type ItemSource = 'forged' | 'found' | 'taken'

/** Where something was found or hidden: the bag's region and the point. */
export interface ItemPlace {
  lookupId: string
  height: number
  x: string
  y: string
  z: string
  plane: Plane
}

/** The chest something came out of. */
export interface ItemFrom {
  chestId: string
  chestName: string
}

/** A key item this server holds (B1 2.1): reading it is holding it. One row per item public key; the first holding stands. */
export interface HeldItem {
  itemPubkey: string
  secretHex: string
  name: string
  about: string
  /** The bag it was found in (its lookup id). */
  foundIn: string
  at: number
  /** Forged by the agent, found in a bag or a chest, or taken out of a chest. Absent on items held before 2026-10-12. */
  source?: ItemSource
  /** Who signed the item event: its forger (a claim when the event was unsigned in a chest). */
  hider?: string
  /** The item event's id. */
  eventId?: string
  place?: ItemPlace
  from?: ItemFrom
}

/** A content taken out of a chest (B1 3.3 Taken): a copy, so the chest still holds it for whoever else opens it. */
export interface TakenItem {
  /** The content's event id. */
  id: string
  type: HiddenType
  name: string
  /** A message's text (untrusted). */
  text?: string
  /** The message holds a Cashu token: money. */
  coin?: boolean
  /** A shard's SNO payload, so render and place can use it after a restart. */
  payload?: unknown
  /** A key's public half; the key itself is a held item. */
  itemPubkey?: string
  author: string
  verified: boolean
  from: ItemFrom
  at: number
}

/** A chest the agent has seen (B1 2.2), sealed: everything needed to open it later with an item found since. */
export interface SeenChest {
  /** The chest event's id. */
  id: string
  name: string
  lockPubkey: string
  senderPubkey: string
  requires: string
  /** The NIP-44 payload, still sealed. */
  payload: string
  /** Who hid it. */
  author: string
  place: ItemPlace
  /** Set when it was found inside another chest. */
  inChest?: string
  /** The author of the bag it is in (for a chest inside a chest, the outer bag's): whom a comment on it, or on what it holds, answers. */
  bagAuthor?: string
  /** What it held when opened, by id and type only (never the contents), so a comment can answer one of them. */
  contents?: Array<{ id: string; type: HiddenType }>
  seenAt: number
}

export interface OpenedBag {
  lookupId: string
  bagId: string
  /** The bag's author: who placed what is in it. */
  author: string
  createdAt: number
  height: number
  base: { x: string; y: string; z: string }
  entries: EntrySummary[]
  /** Entries that were references this server could not retrieve. */
  missing: number
  riddle: string
  hint: HintHeights | null
  at: number
}

interface KeysFile { version: 1; keys: HeldKey[] }
interface BagsFile { version: 1; bags: OpenedBag[] }
interface ItemsFile { version: 1; items: HeldItem[] }
interface TakenFile { version: 1; taken: TakenItem[] }
interface ChestsFile { version: 1; chests: SeenChest[] }

const KEYS_FILE = 'keys/regions.json'
const BAGS_FILE = 'keys/bags.json'
const ITEMS_FILE = 'keys/items.json'
const TAKEN_FILE = 'keys/taken.json'
const CHESTS_FILE = 'keys/chests.json'
/** How many seen chests are kept; the oldest seen go first. */
const CHESTS_KEPT = 1000

function alignedBaseOf(p: Position, height: number): { x: string; y: string; z: string } {
  const h = BigInt(height)
  return { x: ((p.x >> h) << h).toString(), y: ((p.y >> h) << h).toString(), z: ((p.z >> h) << h).toString() }
}

export class KeyStore {
  readonly keys = new Map<string, HeldKey>()
  readonly bags = new Map<string, OpenedBag>()
  /** Key items held, by their public half. */
  readonly items = new Map<string, HeldItem>()
  /** Contents taken out of chests, by their event id. */
  readonly taken = new Map<string, TakenItem>()
  /** Chests seen, by their event id. */
  readonly chests = new Map<string, SeenChest>()

  constructor(private readonly dir: StateDir) {
    const keys = dir.readJson<KeysFile | null>(KEYS_FILE, null)
    if (keys?.version === 1) for (const k of keys.keys) this.keys.set(k.lookupId, k)
    const bags = dir.readJson<BagsFile | null>(BAGS_FILE, null)
    if (bags?.version === 1) for (const b of bags.bags) this.bags.set(b.lookupId, b)
    const items = dir.readJson<ItemsFile | null>(ITEMS_FILE, null)
    if (items?.version === 1) for (const i of items.items) this.items.set(i.itemPubkey, i)
    const taken = dir.readJson<TakenFile | null>(TAKEN_FILE, null)
    if (taken?.version === 1) for (const t of taken.taken) this.taken.set(t.id, t)
    const chests = dir.readJson<ChestsFile | null>(CHESTS_FILE, null)
    if (chests?.version === 1) for (const c of chests.chests) this.chests.set(c.id, c)
  }

  /**
   * Hold a key item: from now on a chest sealed to it opens. An item already
   * held keeps its row (ONOSENDAI addHeld), so a key read again, in a rescan
   * or inside a chest, is held once and its first holding stands. Returns
   * whether it was new.
   */
  holdItem(item: HeldItem): boolean {
    if (this.items.has(item.itemPubkey)) return false
    this.items.set(item.itemPubkey, item)
    this.dir.writeJson(ITEMS_FILE, { version: 1, items: [...this.items.values()] } satisfies ItemsFile)
    return true
  }

  /** Keep a content taken out of a chest. One row per content; returns whether it was new. */
  take(item: TakenItem): boolean {
    if (this.taken.has(item.id)) return false
    this.taken.set(item.id, item)
    this.dir.writeJson(TAKEN_FILE, { version: 1, taken: [...this.taken.values()] } satisfies TakenFile)
    return true
  }

  /** Remember a chest seen, sealed. A chest seen again keeps where it was first seen. */
  noteChest(chest: SeenChest): void {
    if (this.chests.has(chest.id)) return
    this.chests.set(chest.id, chest)
    if (this.chests.size > CHESTS_KEPT) {
      const oldest = [...this.chests.values()].sort((a, b) => a.seenAt - b.seenAt).slice(0, this.chests.size - CHESTS_KEPT)
      for (const c of oldest) this.chests.delete(c.id)
    }
    this.dir.writeJson(CHESTS_FILE, { version: 1, chests: [...this.chests.values()] } satisfies ChestsFile)
  }

  /** Record what an opened chest holds, by id and type. */
  noteChestContents(chestId: string, contents: Array<{ id: string; type: HiddenType }>): void {
    const c = this.chests.get(chestId)
    if (!c || (c.contents && c.contents.length === contents.length && c.contents.every((x, i) => x.id === contents[i].id))) return
    c.contents = contents
    this.dir.writeJson(CHESTS_FILE, { version: 1, chests: [...this.chests.values()] } satisfies ChestsFile)
  }

  /** The seen chests this item opens: those locked to its public key (ONOSENDAI chestsOpenedBy). */
  chestsOpenedBy(itemPubkey: string): SeenChest[] {
    return [...this.chests.values()].filter((c) => c.lockPubkey === itemPubkey)
  }

  /** The held items as a chest opener needs them. */
  heldItems(): Array<{ itemPubkey: string; secretHex: string }> {
    return [...this.items.values()].map((i) => ({ itemPubkey: i.itemPubkey, secretHex: i.secretHex }))
  }

  private save(): void {
    this.dir.writeJson(KEYS_FILE, { version: 1, keys: [...this.keys.values()] } satisfies KeysFile)
  }

  private saveBags(): void {
    this.dir.writeJson(BAGS_FILE, { version: 1, bags: [...this.bags.values()] } satisfies BagsFile)
  }

  private trim<V extends { at: number }>(map: Map<string, V>): void {
    if (map.size <= KEYS_KEPT) return
    const oldest = [...map.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, map.size - KEYS_KEPT)
    for (const [k] of oldest) map.delete(k)
  }

  /** The key for the cube of `height` containing `position`: held already, or derived now and held. */
  keyAt(position: Position, height: number, source: KeySource = 'scan', now: number = Math.floor(Date.now() / 1000)): HeldKey {
    const base = alignedBaseOf(position, height)
    for (const k of this.keys.values()) {
      if (k.height === height && k.base.x === base.x && k.base.y === base.y && k.base.z === base.z) {
        k.at = now
        return k
      }
    }
    const derived = regionKeyAt(position, height, MAX_COMPUTE_HEIGHT)
    const key: HeldKey = { lookupId: derived.lookupId, keyHex: bytesToHex(derived.key), height, base, source, at: now }
    this.keys.set(key.lookupId, key)
    this.trim(this.keys)
    this.save()
    return key
  }

  /** The keys of the cubes around a position, heights 0 to `maxHeight` (the passive scan, spec 7.4, as ONOSENDAI scans). */
  scanAround(position: Position, maxHeight: number = SCAN_MAX_HEIGHT, source: KeySource = 'scan'): HeldKey[] {
    const out: HeldKey[] = []
    for (let h = SCAN_MIN_HEIGHT; h <= maxHeight; h++) out.push(this.keyAt(position, h, source))
    return out
  }

  byLookupId(lookupId: string): HeldKey | undefined {
    return this.keys.get(lookupId)
  }

  /** Whether a cube of `height` at `base` contains `position`. */
  static contains(key: HeldKey, position: Position): boolean {
    const h = BigInt(key.height)
    return (position.x >> h) === (BigInt(key.base.x) >> h) && (position.y >> h) === (BigInt(key.base.y) >> h) && (position.z >> h) === (BigInt(key.base.z) >> h)
  }

  /** The held keys whose cube contains the position: what the agent can read where it stands. */
  keysContaining(position: Position): HeldKey[] {
    return [...this.keys.values()].filter((k) => KeyStore.contains(k, position)).sort((a, b) => a.height - b.height)
  }

  noteBag(bag: OpenedBag): void {
    this.bags.set(bag.lookupId, bag)
    this.trim(this.bags)
    this.saveBags()
  }

  forgetBag(lookupId: string): void {
    if (this.bags.delete(lookupId)) this.saveBags()
  }

  /** The opened bags whose cube contains the position. */
  bagsContaining(position: Position): OpenedBag[] {
    return [...this.bags.values()].filter((b) => {
      const h = BigInt(b.height)
      return (position.x >> h) === (BigInt(b.base.x) >> h) && (position.y >> h) === (BigInt(b.base.y) >> h) && (position.z >> h) === (BigInt(b.base.z) >> h)
    }).sort((a, b) => a.height - b.height)
  }
}
