// regionKeys.ts: the region keys the server holds and the bags it has
// opened, kept in the state directory under keys/. A key is derived by
// cyberspace-core for an aligned cube at a height (spec 7.2); holding it is
// what lets the agent read a bag there, say a line there and hear one. The
// passive scan derives the keys of the cubes around where the agent stands,
// heights 1 to SCAN_MAX_HEIGHT, as ONOSENDAI's scan does; a hop, a hide and
// a find add the keys they derived.

import type { Plane } from 'cyberspace-core'
import { bytesToHex } from '../nostr/event.js'
import type { StateDir } from '../state/dir.js'
import { regionKeyAt } from '../hidden/crypto.js'
import type { HiddenType } from '../hidden/bags.js'
import type { HintHeights } from '../hidden/hint.js'
import type { Position } from './coords.js'

/** The widest cube the passive scan reaches, and the cube chat is sealed to (ONOSENDAI SCAN_MAX_HEIGHT). */
export const SCAN_MAX_HEIGHT = 12
/** The hard cap on what the core computes for a key, matching cyberspace-core's DEFAULT_MAX_COMPUTE_HEIGHT. */
export const MAX_COMPUTE_HEIGHT = 20
/** How many keys and opened bags are kept; the least recently used go first. */
export const KEYS_KEPT = 4000

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

const KEYS_FILE = 'keys/regions.json'
const BAGS_FILE = 'keys/bags.json'

export function alignedBaseOf(p: Position, height: number): { x: string; y: string; z: string } {
  const h = BigInt(height)
  return { x: ((p.x >> h) << h).toString(), y: ((p.y >> h) << h).toString(), z: ((p.z >> h) << h).toString() }
}

export class KeyStore {
  readonly keys = new Map<string, HeldKey>()
  readonly bags = new Map<string, OpenedBag>()

  constructor(private readonly dir: StateDir) {
    const keys = dir.readJson<KeysFile | null>(KEYS_FILE, null)
    if (keys?.version === 1) for (const k of keys.keys) this.keys.set(k.lookupId, k)
    const bags = dir.readJson<BagsFile | null>(BAGS_FILE, null)
    if (bags?.version === 1) for (const b of bags.bags) this.bags.set(b.lookupId, b)
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

  /** The keys of the cubes around a position, heights 1 to `maxHeight` (the passive scan, spec 7.4). */
  scanAround(position: Position, maxHeight: number = SCAN_MAX_HEIGHT, source: KeySource = 'scan'): HeldKey[] {
    const out: HeldKey[] = []
    for (let h = 1; h <= maxHeight; h++) out.push(this.keyAt(position, h, source))
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
