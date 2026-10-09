// bags.ts: content hidden at a location.
//
// Ported from ONOSENDAI src/lib/hidden.ts at commit f9db752 (origin/v2, PR
// #256: the secret rides in its own tag, the title tag names keys and
// chests). Trimmed: the credit tags a copied object carries
// (this server copies nothing), and the LIVE LINK bookkeeping of the deploy
// bar; everything that reads or writes a bag is kept.
//
// A hidden thing is a full signed nostr event, wrapped: the inner event is
// serialized, encrypted to the region key for where it sits (spec 7), and
// carried inside a kind 33330 envelope (spec 8.6) whose only public parts
// are the lookup id and a height hint. A bag is a list of entries (spec
// 7.6). An entry that is an event is an item carried inline: a shard (kind
// 3330), a message (kind 1), a key (kind 3340, Keys and Chests B1 2.1) or a
// chest (kind 3341, B1 2.2). An entry that is an array is a reference,
// ["a", "<kind>:<pubkey>:<d>", relay, coord] or ["e", id, relay, coord],
// naming an event published on its own, FF-1 partially encrypted with the
// same region key (DECK-0003 3.4). Chat lives in the same envelope in the
// ephemeral range, kind 23330.
//
// Pure: signing happens in the agent, which holds the key.

import { getPublicKey } from 'nostr-tools/pure'
import { coordToXyz, hexToCoord, type Plane } from 'cyberspace-core'
import { fromPayload, toPayload, type ShardModel } from 'sno-core/shards'
import { bytesToHex, hexToBytes, isAuthentic, type EventTemplate, type NostrEvent } from '../nostr/event.js'
import { positionHex, type Position } from '../space/coords.js'
import { ALGO, decryptForRegion, encryptForRegion } from './crypto.js'
import { hintFits, hintTags, parseHint, type HintHeights } from './hint.js'

/** The location-encrypted envelope (spec 8.6). */
export const HIDDEN_KIND = 33330
/** The same envelope in the ephemeral range: chat. A 23330 is a 33330 in every respect but the kind. */
export const CHAT_BAG_KIND = 23330
/** A chat line, inside the ephemeral envelope. */
export const CHAT_KIND = 23333
/** Longest chat line (brief, ruling 8). */
export const MAX_CHAT_LENGTH = 500
/** A shard, inside the envelope (v1's shard kind). */
export const SHARD_KIND = 3330
/** A plain note, inside the envelope. */
export const MESSAGE_KIND = 1
/** A key, inside the envelope (B1 2.1): an item that is a keypair, its private key in the content. */
export const KEY_KIND = 3340
/** A chest, inside the envelope (B1 2.2): a list of entries sealed to a public key. */
export const CHEST_KIND = 3341
/** Longest name a key or a chest carries: a label for a row, not a letter. The requires label is capped the same. */
export const MAX_ITEM_NAME = 64
/** Longest about a key carries: a sentence. */
export const MAX_ABOUT = 280
/** A standalone SNO object (DECK-0003 3.1); a shard hidden by reference is one of these (3.4). */
export const OBJECT_KIND = 33331
/** FF-1's key derivation for a key computed from a place rather than served (spec 7.6). */
const REGION_KEY_DERIVATION = 'cyberspace:region'
/** The public face of an object hidden by reference. */
const OBJECT_PREVIEW = 'This object is hidden at a place in cyberspace. Find it with ONOSENDAI: https://onosendai.tech'
/** A shard whose payload is larger than this is hidden by reference (DECK-0003 3.2). */
export const REFERENCE_THRESHOLD_BYTES = 16_384
/** Longest hidden message. */
export const MAX_MESSAGE_LENGTH = 10_000
/** Longest riddle a bag carries in its content (spec 7.7 "Riddles"). */
export const MAX_RIDDLE_LENGTH = 280
/** The most references one bag may make this server fetch, and how many at once. */
const MAX_REFERENCES_PER_BAG = 64
const REFERENCE_CONCURRENCY = 4

/** A reference entry (spec 7.6): ["a" | "e", target, relay hint, coord hex]. */
export type Reference = string[]
/** One entry of a bag's list: an inline item, or a reference. */
export type BagEntry = NostrEvent | Reference
/** Fetches the event a reference names, or null. Injected so this file stays pure. */
export type ResolveReference = (ref: Reference) => Promise<NostrEvent | null>

/** A well-formed reference entry: an a or e tag of strings. */
export function isReference(x: unknown): x is Reference {
  return Array.isArray(x) && (x[0] === 'a' || x[0] === 'e') && typeof x[1] === 'string' && x[1].length > 0 && x.every((v) => typeof v === 'string')
}

/** A stable identity for an entry, for de-duplicating a bag's list. */
export function entryKey(e: BagEntry): string {
  return isReference(e) ? `${e[0]}:${e[1]}@${e[3] ?? ''}` : e.id
}

/** Where a reference without its own point is drawn: the base of the region the bag is sealed to. */
export interface RegionOrigin { at: Position; plane: Plane }

/** The bytes a shard's payload takes on the wire. */
function payloadBytes(shard: ShardModel): number {
  return new TextEncoder().encode(JSON.stringify(toPayload(shard))).length
}

/** Whether a shard is large enough to hide by reference. */
export function wantsReference(shard: ShardModel): boolean {
  return payloadBytes(shard) > REFERENCE_THRESHOLD_BYTES
}

/**
 * The kind 33331 object a large shard is hidden as (DECK-0003 3.4): the
 * payload sealed with the region key, a public preview, and a fresh random
 * d per placement. No name, C, h, hint or sector tag: nothing that could say
 * where.
 */
export async function objectTemplate(shard: ShardModel, regionKey: Uint8Array, d: string, createdAt: number): Promise<EventTemplate> {
  const ciphertext = await encryptForRegion(regionKey, JSON.stringify(toPayload(shard)))
  return {
    kind: OBJECT_KIND,
    created_at: createdAt,
    content: OBJECT_PREVIEW,
    tags: [['d', d], ['alt', OBJECT_PREVIEW], ['encrypted', ALGO, ciphertext, REGION_KEY_DERIVATION]],
  }
}

/** The reference entry that hides a signed object at a point (spec 7.6). */
export function referenceTo(object: NostrEvent, at: Position, plane: Plane, relayHint: string): Reference {
  const d = object.tags.find((t) => t[0] === 'd')?.[1] ?? ''
  return ['a', `${object.kind}:${object.pubkey}:${d}`, relayHint, positionHex(at, plane)]
}

export type HiddenType = 'shard' | 'message' | 'key' | 'chest'

/** What a key item carries (B1 2.1). */
export interface KeyItem {
  name: string
  about: string
  /** The item's public key: the lock a chest names when it is sealed to this key. */
  itemPubkey: string
  /** The item's private key, 64 lowercase hex. Holding it is holding the item. */
  secretHex: string
}

/** What a chest item carries (B1 2.2); the payload is still sealed. */
export interface ChestItem {
  name: string
  lockPubkey: string
  senderPubkey: string
  requires: string
  payload: string
}

const HEX_64 = /^[0-9a-f]{64}$/

function tagValue(tags: string[][], name: string): string | undefined {
  return tags.find((t) => Array.isArray(t) && t[0] === name)?.[1]
}

/** A tag's value trimmed, its whitespace collapsed, and cut to `max`; empty when absent. */
function capped(tags: string[][], name: string, max: number): string {
  return (tagValue(tags, name) ?? '').trim().replace(/\s+/g, ' ').slice(0, max)
}

/** Whether an item's content and tags have the shape every reading below assumes: an unsigned entry may have any shape at all. */
function wellShaped(ev: Pick<NostrEvent, 'content' | 'tags'>): boolean {
  return typeof ev.content === 'string' && Array.isArray(ev.tags)
}

/** A key's or a chest's name: its title tag, the tag other nostr kinds use for a human name; the older name tag; else `fallback`. */
function nameOf(tags: string[][], fallback: string): string {
  return capped(tags, 'title', MAX_ITEM_NAME) || capped(tags, 'name', MAX_ITEM_NAME) || fallback
}

/**
 * A key item out of its event, or null when it is not one this server can
 * hold: the secret tag must be a valid 32-byte secret, and an item tag,
 * when carried, must be the public key that secret derives. Keys forged on
 * 2026-10-09, before the secret moved into its tag, carry it as the content
 * and their sentence in an about tag; they are still read.
 */
export function keyItemOf(ev: Pick<NostrEvent, 'kind' | 'content' | 'tags'>): KeyItem | null {
  if (ev.kind !== KEY_KIND || !wellShaped(ev)) return null
  const tagged = tagValue(ev.tags, 'secret')
  const secretHex = (tagged ?? ev.content).trim()
  if (!HEX_64.test(secretHex)) return null
  let itemPubkey: string
  try { itemPubkey = getPublicKey(hexToBytes(secretHex)) } catch { return null }
  const claimed = tagValue(ev.tags, 'item')
  if (claimed !== undefined && claimed !== itemPubkey) return null
  const about = tagged !== undefined
    ? ev.content.trim().replace(/\s+/g, ' ').slice(0, MAX_ABOUT)
    : capped(ev.tags, 'about', MAX_ABOUT)
  return { name: nameOf(ev.tags, 'key'), about, itemPubkey, secretHex }
}

/** A chest item out of its event, or null when its lock tag or payload is malformed. */
export function chestItemOf(ev: Pick<NostrEvent, 'kind' | 'content' | 'tags'>): ChestItem | null {
  if (ev.kind !== CHEST_KIND || !wellShaped(ev)) return null
  const lock = ev.tags.find((t) => Array.isArray(t) && t[0] === 'lock')
  if (!lock || typeof lock[1] !== 'string' || typeof lock[2] !== 'string' || !HEX_64.test(lock[1]) || !HEX_64.test(lock[2])) return null
  if (!ev.content) return null
  return { name: nameOf(ev.tags, 'chest'), lockPubkey: lock[1], senderPubkey: lock[2], requires: capped(ev.tags, 'requires', MAX_ITEM_NAME), payload: ev.content }
}

/** What an inline item is, by its kind. */
export interface ItemBody {
  type: HiddenType
  shard?: ShardModel
  text?: string
  key?: KeyItem
  chest?: ChestItem
}

/** Read an inline item by its kind, or null for a kind this server does not know or an item that does not parse. */
export function readItem(inner: Pick<NostrEvent, 'kind' | 'content' | 'tags' | 'id'>): ItemBody | null {
  if (inner.kind === SHARD_KIND) {
    let raw: unknown
    try { raw = JSON.parse(inner.content) } catch { return null }
    const shard = fromPayload(raw, inner.id)
    return shard ? { type: 'shard', shard } : null
  }
  if (inner.kind === MESSAGE_KIND) {
    return inner.content ? { type: 'message', text: inner.content.slice(0, MAX_MESSAGE_LENGTH) } : null
  }
  if (inner.kind === KEY_KIND) {
    const key = keyItemOf(inner)
    return key ? { type: 'key', key } : null
  }
  if (inner.kind === CHEST_KIND) {
    const chest = chestItemOf(inner)
    return chest ? { type: 'chest', chest } : null
  }
  return null
}

/** A short one-line look at a message. */
export function messagePreview(text: string, max = 48): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > max ? `${t.slice(0, max)}...` : t || 'empty'
}

/** What a decoded hidden thing carries. */
export interface Hidden {
  /** The item's stable identity: its inner event id, or for a public reference the bag and the entry. */
  eventId: string
  /** The signed inner event itself, verified. */
  inner: NostrEvent
  /** The region key that opened its bag, as hex. */
  keyHex: string
  bagId: string
  lookupId: string
  /** The bag's author: who placed it. */
  author: string
  at: Position
  plane: Plane
  height: number
  bag: BagSettings
  createdAt: number
  type: HiddenType
  shard?: ShardModel
  text?: string
  key?: KeyItem
  chest?: ChestItem
  /** Set when the item was hidden by reference: the entry itself. */
  ref?: Reference
}

/** The inner shard event template (kind 3330), signed by the author. */
export function shardInnerTemplate(shard: ShardModel, at: Position, plane: Plane, createdAt: number): EventTemplate {
  return {
    kind: SHARD_KIND,
    created_at: createdAt,
    content: JSON.stringify(toPayload(shard)),
    tags: [['C', positionHex(at, plane)]],
  }
}

/** The inner message event template (kind 1), signed by the author. */
export function messageInnerTemplate(text: string, at: Position, plane: Plane, createdAt: number): EventTemplate {
  return {
    kind: MESSAGE_KIND,
    created_at: createdAt,
    content: text.slice(0, MAX_MESSAGE_LENGTH),
    tags: [['C', positionHex(at, plane)]],
  }
}

/**
 * The inner key event template (kind 3340), signed by the hider (B1 2.1).
 * The secret rides in its own tag and the sentence is the content, so a
 * client that does not know the kind shows the sentence and never the
 * secret; title names it the way other nostr kinds name things; item is its
 * public key, so a reader can check one against the other; the NIP-70 `-`
 * tag keeps a finder from republishing it.
 */
export function keyInnerTemplate(key: KeyItem, at: Position, plane: Plane, createdAt: number): EventTemplate {
  const tags: string[][] = [['C', positionHex(at, plane)], ['title', key.name.slice(0, MAX_ITEM_NAME)], ['item', key.itemPubkey], ['secret', key.secretHex], ['-']]
  return { kind: KEY_KIND, created_at: createdAt, content: key.about.slice(0, MAX_ABOUT), tags }
}

/** The inner chest event template (kind 3341), signed by the hider (B1 2.2). */
export function chestInnerTemplate(chest: ChestItem, at: Position, plane: Plane, createdAt: number): EventTemplate {
  return {
    kind: CHEST_KIND,
    created_at: createdAt,
    content: chest.payload,
    tags: [['C', positionHex(at, plane)], ['title', chest.name.slice(0, MAX_ITEM_NAME)], ['lock', chest.lockPubkey, chest.senderPubkey], ['requires', chest.requires]],
  }
}

/** The inner chat event template (kind 23333). Never published bare: it only ever travels inside a CHAT_BAG_KIND envelope. */
export function chatInnerTemplate(text: string, at: Position, plane: Plane, createdAt: number, lookupId: string): EventTemplate {
  return {
    kind: CHAT_KIND,
    created_at: createdAt,
    content: text.slice(0, MAX_CHAT_LENGTH),
    tags: [['d', lookupId], ['C', positionHex(at, plane)]],
  }
}

/** What a bag says in public about itself, beyond its lookup id (spec 8.6, 7.7). */
export interface BagSettings {
  heightTag: boolean
  hint: HintHeights | null
  riddle: string
}

const DEFAULT_BAG_SETTINGS: BagSettings = { heightTag: true, hint: null, riddle: '' }

/** The settings a published bag carries. */
export function bagSettingsOf(ev: NostrEvent, height: number): BagSettings {
  const h = heightHint(ev)
  const hint = parseHint(ev.tags, h ?? height)
  return { heightTag: h !== null, hint: hint ? hint.heights : null, riddle: ev.content.slice(0, MAX_RIDDLE_LENGTH) }
}

interface BagPlace { at: Position; plane: Plane }

/**
 * Wrap a bag of entries into one region envelope template (spec 8.6): keyed
 * by d = lookup_id, so there is one per author, region and height; kind
 * 33330 is addressable, so republishing it replaces the old one. The caller
 * signs and publishes, with a created_at that exceeds the previous bag's.
 */
export async function bagTemplate(entries: BagEntry[], regionKey: Uint8Array, lookupId: string, height: number, createdAt: number, kind: number = HIDDEN_KIND, settings: BagSettings = DEFAULT_BAG_SETTINGS, place?: BagPlace): Promise<EventTemplate> {
  const tags: string[][] = [['d', lookupId], ['encrypted', ALGO, await encryptForRegion(regionKey, JSON.stringify(entries))], ['version', '2']]
  if (settings.heightTag) tags.push(['h', String(height)])
  if (settings.hint) {
    if (!place) throw new Error('A hint needs the place it points to.')
    if (!hintFits(settings.hint, height)) throw new Error(`A hint box of heights ${settings.hint.join(', ')} cannot contain a height ${height} region.`)
    tags.push(...hintTags(place.at, place.plane, settings.hint))
  }
  return { kind, created_at: createdAt, content: settings.riddle.trim().slice(0, MAX_RIDDLE_LENGTH), tags }
}

function tag(ev: NostrEvent, name: string): string | undefined {
  return ev.tags.find((t) => t[0] === name)?.[1]
}

/** The ciphertext out of an envelope, or null if it is not one. */
export function ciphertextOf(ev: NostrEvent): string | null {
  if (ev.kind !== HIDDEN_KIND && ev.kind !== CHAT_BAG_KIND) return null
  const enc = ev.tags.find((t) => t[0] === 'encrypted')
  if (!enc || enc[1] !== ALGO || !enc[2]) return null
  return enc[2]
}

/** The bag's h tag, or null when it carries none or a malformed one. */
export function heightHint(ev: NostrEvent): number | null {
  const h = tag(ev, 'h')
  if (h === undefined || !/^(0|[1-9][0-9]*)$/.test(h)) return null
  return Number(h)
}

interface BagFacts { height: number; bag: BagSettings }

/** One inner event of a bag -> a Hidden, or null if it does not verify or was not signed by the bag's author. */
function fromInner(inner: NostrEvent, outer: NostrEvent, keyHex: string, facts: BagFacts): Hidden | null {
  if (!inner || typeof inner.kind !== 'number' || inner.pubkey !== outer.pubkey) return null
  if (!isAuthentic(inner)) return null
  const coordHex = tag(inner, 'C')
  if (!coordHex) return null
  const { x, y, z, plane } = coordToXyz(hexToCoord(coordHex))
  const base = {
    eventId: inner.id,
    inner,
    keyHex,
    bagId: outer.id,
    lookupId: tag(outer, 'd') ?? '',
    author: outer.pubkey,
    at: { x, y, z },
    plane,
    ...facts,
    createdAt: inner.created_at,
  }
  const body = readItem(inner)
  return body ? { ...base, ...body } : null
}

/**
 * Decrypt a region envelope and return every item in its bag, verified.
 * Empty covers every way it fails to open: not an envelope, the wrong key,
 * or a bag that is not an array. Each item that does not verify is dropped,
 * not the whole bag. `height` is the height of the region `regionKey` was
 * derived for; it wins over the bag's h tag.
 */
export async function unbag(outer: NostrEvent, regionKey: Uint8Array, resolve?: ResolveReference, origin?: RegionOrigin, height?: number): Promise<Hidden[]> {
  const ct = ciphertextOf(outer)
  if (!ct) return []
  const json = await decryptForRegion(regionKey, ct)
  if (!json) return []
  let entries: unknown
  try { entries = JSON.parse(json) } catch { return [] }
  if (!Array.isArray(entries)) return []
  const keyHex = bytesToHex(regionKey)
  const regionHeight = height ?? heightHint(outer) ?? 0
  const facts: BagFacts = { height: regionHeight, bag: bagSettingsOf(outer, regionHeight) }
  const out: (Hidden | null)[] = entries.map((entry) => (Array.isArray(entry) ? null : fromInner(entry as NostrEvent, outer, keyHex, facts)))
  if (resolve) {
    const refs = entries.map((e, i) => [e, i] as const).filter(([e]) => isReference(e)).slice(0, MAX_REFERENCES_PER_BAG)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < refs.length) {
        const [ref, i] = refs[next++]
        out[i] = await fromReference(ref as Reference, outer, regionKey, keyHex, resolve, facts, origin).catch(() => null)
      }
    }
    await Promise.all(Array.from({ length: Math.min(REFERENCE_CONCURRENCY, refs.length) }, worker))
  }
  return out.filter((h): h is Hidden => h !== null)
}

/** How many entries of a bag are references, so a reader can say "found but could not be retrieved". */
export async function referenceCount(outer: NostrEvent, regionKey: Uint8Array): Promise<number> {
  return (await bagEntries(outer, regionKey)).filter(isReference).length
}

/**
 * One reference entry of a bag -> a Hidden, or null. The referenced event
 * must verify, must be the one the reference names, and must open with this
 * bag's region key. It may be by another author: placing someone else's
 * object is a placement, attributed to the bag's author.
 */
async function fromReference(ref: Reference, outer: NostrEvent, regionKey: Uint8Array, keyHex: string, resolve: ResolveReference, facts: BagFacts, origin?: RegionOrigin): Promise<Hidden | null> {
  const coordHex = ref[3]
  if (!coordHex && !origin) return null
  const target = await resolve(ref)
  if (!target || !isAuthentic(target)) return null
  if (ref[0] === 'e' && target.id !== ref[1]) return null
  if (ref[0] === 'a') {
    const [kind, pubkey, ...rest] = ref[1].split(':')
    if (String(target.kind) !== kind || target.pubkey !== pubkey || tag(target, 'd') !== rest.join(':')) return null
  }
  const enc = target.tags.find((t) => t[0] === 'encrypted')
  let plain: string | null
  if (enc) {
    if (enc[1] !== ALGO || !enc[2]) return null
    plain = await decryptForRegion(regionKey, enc[2])
  } else {
    plain = target.kind === OBJECT_KIND ? target.content : null
  }
  if (plain === null) return null
  const { x, y, z, plane } = coordHex ? coordToXyz(hexToCoord(coordHex)) : { ...origin!.at, plane: origin!.plane }
  const base = {
    eventId: enc ? target.id : `${tag(outer, 'd') ?? ''}/${entryKey(ref)}`,
    inner: target,
    keyHex,
    ref,
    bagId: outer.id,
    lookupId: tag(outer, 'd') ?? '',
    author: outer.pubkey,
    at: { x, y, z },
    plane,
    ...facts,
    createdAt: target.created_at,
  }
  if (target.kind === OBJECT_KIND) {
    let raw: unknown
    try { raw = JSON.parse(plain) } catch { return null }
    const shard = fromPayload(raw, target.id)
    if (!shard) return null
    return { ...base, type: 'shard', shard }
  }
  if (target.kind === MESSAGE_KIND) {
    if (!plain) return null
    return { ...base, type: 'message', text: plain.slice(0, MAX_MESSAGE_LENGTH) }
  }
  return null
}

/** The chat lines in an ephemeral envelope: every inner that is a CHAT_KIND, verifies, and was signed by the same key that wrapped it. */
export async function chatInners(outer: NostrEvent, regionKey: Uint8Array): Promise<NostrEvent[]> {
  if (outer.kind !== CHAT_BAG_KIND) return []
  const inners = await bagInners(outer, regionKey)
  return inners.filter((e) => e.kind === CHAT_KIND && typeof e.content === 'string' && e.content.length > 0)
}

/**
 * Every entry currently in one of the agent's own envelopes, for rewriting
 * it, carried forward as it is: inline items whether or not this server can
 * render them, and every well-formed reference. A rewrite that kept only
 * what this server understands would silently drop the rest.
 */
export async function bagEntries(outer: NostrEvent, regionKey: Uint8Array): Promise<BagEntry[]> {
  const ct = ciphertextOf(outer)
  if (!ct) return []
  const json = await decryptForRegion(regionKey, ct)
  if (!json) return []
  try {
    const arr = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    return arr.filter((e): e is BagEntry => isReference(e) || (!!e && !Array.isArray(e) && typeof e === 'object' && typeof (e as NostrEvent).kind === 'number'))
  } catch { return [] }
}

/** The signed inner events currently in an envelope's bag, signed by its author and verified. */
async function bagInners(outer: NostrEvent, regionKey: Uint8Array): Promise<NostrEvent[]> {
  const ct = ciphertextOf(outer)
  if (!ct) return []
  const json = await decryptForRegion(regionKey, ct)
  if (!json) return []
  try {
    const arr = JSON.parse(json)
    return Array.isArray(arr) ? (arr as NostrEvent[]).filter((e) => e && !Array.isArray(e) && e.pubkey === outer.pubkey && isAuthentic(e)) : []
  } catch { return [] }
}
