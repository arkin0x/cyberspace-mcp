// bags.ts: content hidden at a location.
//
// Ported from ONOSENDAI src/lib/hidden.ts at commit f9db752 (origin/v2, PR
// #256: the secret rides in its own tag, the title tag names keys and
// chests). Trimmed: the credit tags a copied object carries
// (this server copies nothing), and the LIVE LINK bookkeeping of the deploy
// bar; everything that reads or writes a bag is kept.
//
// A hidden thing is a nostr event, wrapped: signed, or for a message an
// unsigned rumor (2026-10-20, innerAuthentic). The inner event is
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

import { getEventHash, getPublicKey } from 'nostr-tools/pure'
import { coordToXyz, hexToCoord, type Plane } from 'cyberspace-core'
import { fromPayload, toPayload, type ShardModel } from 'sno-core/shards'
import { bytesToHex, hexToBytes, isAuthentic, type EventTemplate, type NostrEvent } from '../nostr/event.js'
import { positionHex, type Position } from '../space/coords.js'
import { ALGO, decryptForRegion, encryptForRegion } from './crypto.js'
import { hintFits, hintTags, parseHint, type HintHeights } from './hint.js'
import { animationOf, modelOf, modelTags, type ItemAnimation, type ItemModelRef } from './itemModel.js'
import { nftLinkCount } from './nftLink.js'

/** The location-encrypted envelope (spec 8.6). */
export const HIDDEN_KIND = 33330
/** The same envelope in the ephemeral range: chat. A 23330 is a 33330 in every respect but the kind. */
export const CHAT_BAG_KIND = 23330
/**
 * The bag's height tag (spec 8.6): ["H", "<height>"] on a 33330 bag and a
 * 23330 chat envelope. Uppercase since 2026-10-21 (arkinox), because NIP-29
 * reads `h` on every kind as a group id. `h` is read only on events written
 * before then (heightHint) and never written.
 */
export const HEIGHT_TAG = 'H'
export const LEGACY_HEIGHT_TAG = 'h'
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
/**
 * An event as a bag or a chest carries it: signed, or a rumor with no `sig`
 * (a chat line, and a message since 2026-10-20). A signed event is one of
 * these too.
 */
export type Rumor = Omit<NostrEvent, 'sig'> & { sig?: string }
/** One entry of a bag's list: an inline item, signed or a rumor, or a reference. */
export type BagEntry = NostrEvent | Rumor | Reference
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

/**
 * A kind 33331 object hidden by reference, sealed again to another region
 * under the same `d` (ONOSENDAI #369: a move "reseals the same object under
 * its own d, which replaces it on the relays and keeps its address, the thing
 * its comments and reactions name"). The payload is opened with the old
 * region's key and sealed with the new one; every other tag and the public
 * preview stay as they were. Null when it does not open with `fromKey`.
 */
export async function resealedObject(object: NostrEvent, fromKey: Uint8Array, toKey: Uint8Array, createdAt: number): Promise<EventTemplate | null> {
  const at = object.tags.findIndex((t) => t[0] === 'encrypted')
  if (object.kind !== OBJECT_KIND || at < 0 || object.tags[at][1] !== ALGO || !object.tags[at][2]) return null
  const plain = await decryptForRegion(fromKey, object.tags[at][2])
  if (plain === null) return null
  const sealed = [...object.tags[at]]
  sealed[2] = await encryptForRegion(toKey, plain)
  if (sealed.length < 4) sealed[3] = REGION_KEY_DERIVATION
  const tags = object.tags.map((t, i) => (i === at ? sealed : [...t]))
  return { kind: OBJECT_KIND, created_at: createdAt, content: object.content, tags }
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
  /**
   * The SNO the item wears in cyberspace, by its address, and how it moves
   * (hidden/itemModel.ts, ONOSENDAI#439). Optional; an item without a model
   * is drawn as the note's cube. `animation` is only read or written with a
   * model, and is absent when the model stands still.
   */
  model?: ItemModelRef
  animation?: ItemAnimation[]
  /**
   * The item event's own tags past the ones keyInnerTemplate writes itself
   * (carriedTags), for a copy: written back verbatim, in their order, in
   * place of the model and animate tags built from the fields above. Never
   * set by keyItemOf; a held item fills it (space/regionKeys.ts keyItemOfHeld).
   */
  carried?: string[][]
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
  // The model and its motions, read as ONOSENDAI reads them
  // (hidden/itemModel.ts); motions with no model move nothing, and are not read.
  const model = modelOf(ev.tags)
  const animation = model ? animationOf(ev.tags) : []
  return {
    name: nameOf(ev.tags, 'key'), about, itemPubkey, secretHex,
    ...(model ? { model } : {}),
    ...(animation.length > 0 ? { animation } : {}),
  }
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
  /**
   * The inner event itself, verified (innerAuthentic): signed, or for a
   * message a rumor with no `sig`, vouched for by the bag's signature. For
   * a reference, the referenced event, which is always signed.
   */
  inner: Rumor
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

/**
 * NIP-70's protected tag (ONOSENDAI #409). Every item sealed in a bag or a
 * chest carries it (arkinox, 2026-10-20): a relay that honours it accepts
 * the event only from its author, so a finder cannot republish the hider's
 * item. Never on what is published on its own (a kind 33331 object, which
 * others place by reference), never on the envelope, never on chat.
 */
export const PROTECTED_TAG: readonly string[] = ['-']

/** Whether a list of tags carries NIP-70's `-`. */
export function isProtectedTags(tags: readonly (readonly string[])[]): boolean {
  return tags.some((t) => Array.isArray(t) && t[0] === '-')
}

/** The inner shard event template (kind 3330), signed by the author, with NIP-70's `-`. */
export function shardInnerTemplate(shard: ShardModel, at: Position, plane: Plane, createdAt: number): EventTemplate {
  return {
    kind: SHARD_KIND,
    created_at: createdAt,
    content: JSON.stringify(toPayload(shard)),
    tags: [['C', positionHex(at, plane)], [...PROTECTED_TAG]],
  }
}

/**
 * The inner message event template (kind 1), with NIP-70's `-`. It is
 * sealed as a rumor (rumorOf), never signed: a signed kind 1 lifted out of
 * the bag would show anywhere as the hider's own public note, with the exact
 * coordinate it was hidden at, and a rumor proves nothing once copied
 * (arkinox, 2026-10-20). This holds in a chest as in a bag.
 */
export function messageInnerTemplate(text: string, at: Position, plane: Plane, createdAt: number): EventTemplate {
  return {
    kind: MESSAGE_KIND,
    created_at: createdAt,
    content: text.slice(0, MAX_MESSAGE_LENGTH),
    tags: [['C', positionHex(at, plane)], [...PROTECTED_TAG]],
  }
}

/**
 * The inner key event template (kind 3340), signed by the hider (B1 2.1).
 * The secret rides in its own tag and the sentence is the content, so a
 * client that does not know the kind shows the sentence and never the
 * secret; title names it the way other nostr kinds name things; item is its
 * public key, so a reader can check one against the other; the NIP-70 `-`
 * tag keeps a finder from republishing it. The model and its motions follow,
 * in a `model` and an `animate` tag, when the item has them
 * (hidden/itemModel.ts, ONOSENDAI#439); a reader that does not know them
 * skips them.
 */
export function keyInnerTemplate(key: KeyItem, at: Position, plane: Plane, createdAt: number): EventTemplate {
  const tags: string[][] = [['C', positionHex(at, plane)], ['title', key.name.slice(0, MAX_ITEM_NAME)], ['item', key.itemPubkey], ['secret', key.secretHex], ['-']]
  // A copy writes the item's own tags back as they were (an imeta ahead of
  // the model, as ONOSENDAI writes them, and tags this server does not
  // know); otherwise the model and its motions from the fields.
  tags.push(...(key.carried !== undefined ? carriedTags(key.carried) : modelTags(key.model, key.animation)))
  return { kind: KEY_KIND, created_at: createdAt, content: key.about.slice(0, MAX_ABOUT), tags }
}

/**
 * Tag names a copy of a key item never carries over from the item event:
 * the ones keyInnerTemplate writes itself (C, title, item, secret, `-`), the
 * older name and about, d, and the client tag its signer adds; and two that
 * make a claim about the original event which is false once the agent signs
 * the copy (NIP-26 delegation, NIP-13 nonce). Every one-character name is
 * dropped as well (below).
 */
const NOT_CARRIED = new Set(['C', 'd', 'title', 'name', 'item', 'secret', 'about', '-', 'client', 'delegation', 'nonce'])
/** Most tags a copy carries over: room for an imeta, a model, an animate tag and a dozen more. */
export const MAX_CARRIED_TAGS = 16
/** Most bytes of JSON the carried tags may take together: enough for an imeta holding an 8192-character data URI. */
export const MAX_CARRIED_BYTES = 12 * 1024

/**
 * The tags of a key item event that a copy of it carries, in their order:
 * how a copy sealed into a chest keeps the item's picture, model, motions
 * and any tag added later. The agent signs the copy, so it re-signs what
 * another hider wrote, and only what is harmless is kept: a tag must be a
 * non-empty array of strings; a name of one character is dropped (every
 * single-letter tag is one relays index, NIP-01, and e, p, a, q, t and the
 * like point at or notify someone), as is every name in NOT_CARRIED; at
 * most MAX_CARRIED_TAGS tags and MAX_CARRIED_BYTES of JSON are kept, a tag
 * that would pass the byte cap skipped and the rest still read.
 */
export function carriedTags(tags: readonly unknown[]): string[][] {
  const out: string[][] = []
  let bytes = 0
  for (const raw of tags) {
    if (out.length >= MAX_CARRIED_TAGS) break
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every((v) => typeof v === 'string')) continue
    const tag = raw as string[]
    if (tag[0].length <= 1 || NOT_CARRIED.has(tag[0])) continue
    const size = new TextEncoder().encode(JSON.stringify(tag)).length
    if (bytes + size > MAX_CARRIED_BYTES) continue
    bytes += size
    out.push([...tag])
  }
  return out
}

/**
 * The inner chest event template (kind 3341), signed by the hider (B1 2.2),
 * with NIP-70's `-` as every item. A chest stays signed: its signature is
 * what vouches for the messages sealed inside it, which are rumors
 * (hidden/chests.ts readContents).
 */
export function chestInnerTemplate(chest: ChestItem, at: Position, plane: Plane, createdAt: number): EventTemplate {
  return {
    kind: CHEST_KIND,
    created_at: createdAt,
    content: chest.payload,
    tags: [['C', positionHex(at, plane)], ['title', chest.name.slice(0, MAX_ITEM_NAME)], ['lock', chest.lockPubkey, chest.senderPubkey], ['requires', chest.requires], [...PROTECTED_TAG]],
  }
}

/** The inner chat event template (kind 23333). Never published bare: it only ever travels inside a CHAT_BAG_KIND envelope, as a rumor (chatRumor). */
export function chatInnerTemplate(text: string, at: Position, plane: Plane, createdAt: number, lookupId: string): EventTemplate {
  return {
    kind: CHAT_KIND,
    created_at: createdAt,
    content: text.slice(0, MAX_CHAT_LENGTH),
    tags: [['d', lookupId], ['C', positionHex(at, plane)]],
  }
}

/**
 * A chat line as it is sealed: an unsigned rumor, the way NIP-17 carries a
 * kind 14 (arkinox, 2026-10-13). Its id is computed, so replies and mentions
 * still name it, but it has no signature: a signed line could be lifted out
 * of the envelope and shown anywhere as standalone proof of who said it, and
 * a rumor cannot be republished as a valid event. The envelope, which the
 * speaker signs, vouches for who said it (chatInners).
 */
export type ChatRumor = Rumor

/**
 * Seal-ready rumor of a template, by `pubkey`: its id computed as NIP-01
 * computes it, and no signature. A chat line and a message are sealed this
 * way; `pubkey` must be the key that signs the envelope (or the chest) that
 * carries it, or no reader will accept it.
 */
export function rumorOf(template: EventTemplate, pubkey: string): Rumor {
  const unsigned = { kind: template.kind, created_at: template.created_at, tags: template.tags, content: template.content, pubkey }
  return { ...unsigned, id: getEventHash(unsigned) }
}

/** Seal-ready rumor of a chat template, said by `pubkey`. */
export const chatRumor: (template: EventTemplate, pubkey: string) => ChatRumor = rumorOf

/**
 * Whether a rumor is what it says: its fields have their types and its `id`
 * is the hash of them (NIP-01). Says nothing of who wrote it; that is the
 * signer of whatever carries it.
 */
export function rumorHolds(ev: Partial<Rumor>): boolean {
  if (typeof ev.kind !== 'number' || typeof ev.created_at !== 'number' || typeof ev.content !== 'string' || typeof ev.pubkey !== 'string' || typeof ev.id !== 'string') return false
  if (!Array.isArray(ev.tags) || !ev.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))) return false
  try {
    return getEventHash({ kind: ev.kind, created_at: ev.created_at, tags: ev.tags, content: ev.content, pubkey: ev.pubkey }) === ev.id
  } catch { return false }
}

/**
 * Whether an inline item of a bag is authentic for the key that signed the
 * bag (ONOSENDAI innerAuthentic, #409; arkinox, 2026-10-20). Its `pubkey`
 * must be the bag's signer, always. Then a message (kind 1) with no `sig`
 * is a rumor, accepted when its id is its hash, its author vouched for by
 * the bag's signature; anything that carries a `sig` must verify, so a
 * signed message from before 2026-10-20 still reads; any other kind without
 * a `sig` is dropped.
 */
export function innerAuthentic(inner: Partial<Rumor>, signer: string): boolean {
  if (!inner || typeof inner !== 'object' || Array.isArray(inner) || typeof inner.kind !== 'number' || inner.pubkey !== signer) return false
  // No `sig`, or an empty one, is unsigned (spec 7.6), as the chest reader has it.
  if (inner.sig === undefined || inner.sig === '') return inner.kind === MESSAGE_KIND && rumorHolds(inner)
  return isAuthentic(inner as NostrEvent)
}

/**
 * The identity an item keeps across a move (ONOSENDAI lib/hidden.ts
 * itemLineage, #369; arkinox, 2026-10-16: "keep the d tag so comments and
 * reactions aren't lost"). An item carried inline is a regular event, so
 * moving it signs a new one with a new id; the new one carries
 * `["d", <first version's id>]`, and comments and reactions name that id,
 * whichever version they were made on. The tag is sealed in the bag like the
 * rest of the item. An item with no `d` is its own first version. A shard
 * hidden by reference is a kind 33331 object with a `d` of its own, which a
 * move keeps, so it needs nothing here (null).
 */
export function itemLineage(inner: Pick<NostrEvent, 'id' | 'kind' | 'tags'> | undefined): string | null {
  if (!inner || inner.kind === OBJECT_KIND) return null
  // Only an event id: a `d` of any other shape is not a lineage, and is ignored.
  return inner.tags.find((t) => t[0] === 'd' && /^[0-9a-f]{64}$/.test(t[1] ?? ''))?.[1] ?? inner.id
}

/**
 * A moved item's template (ONOSENDAI editedTemplate, #369): the new place
 * (`C`, from `next`) and the lineage `d`, then every other tag the version it
 * replaces carried (a credit, a title, a lock), so a move changes only where
 * it is.
 */
export function editedTemplate(next: EventTemplate, previous: Pick<NostrEvent, 'id' | 'kind' | 'tags'>): EventTemplate {
  const at = next.tags.find((t) => t[0] === 'C')
  const lineage = itemLineage(previous) ?? previous.id
  const kept = previous.tags.filter((t) => t[0] !== 'C' && t[0] !== 'd')
  // NIP-70's `-` goes out when `next` carries it, so an item hidden before
  // every item carried it gains it on its first move, and never twice.
  const protect = isProtectedTags(next.tags) && !isProtectedTags(kept) ? [[...PROTECTED_TAG]] : []
  return { ...next, tags: [...(at ? [at] : []), ['d', lineage], ...kept, ...protect] }
}

/**
 * What a bag says in public about itself, beyond its lookup id (spec 8.6,
 * 7.7), as ONOSENDAI's BagSettings: the H tag, the hint, the riddle, and
 * ONOSENDAI's contents and money hints (2026-10-18, `contents` tags). Every
 * rewrite of a bag carries them forward, so removing or moving one thing
 * never changes what the bag says about itself.
 */
export interface BagSettings {
  heightTag: boolean
  hint: HintHeights | null
  riddle: string
  /** Publish what is inside, by kind and count (`contents` tags). */
  contents?: boolean
  /** Publish that money is inside while a Cashu token is (a `contents` tag for cashu alone). */
  money?: boolean
}

const DEFAULT_BAG_SETTINGS: BagSettings = { heightTag: true, hint: null, riddle: '', contents: false, money: false }

/** A Cashu token as written, as ONOSENDAI counts them (lib/cashu.ts TOKEN). */
const CASHU_AS_WRITTEN = /cashu[AB][A-Za-z0-9_\-+/=]{16,}/g

/** The order a bag's `contents` tags are written in (ONOSENDAI CONTENTS_KINDS, `nft` after `cashu` since #441). */
const CONTENTS_KINDS = ['shard', 'message', 'key', 'chest', 'cashu', 'nft'] as const
type ContentsKind = typeof CONTENTS_KINDS[number]

/**
 * What a bag holds, by kind (ONOSENDAI bagContents): shards inline or by
 * reference, messages, keys, chests, and the Cashu tokens and nonfungible.cash
 * claim links (nftLink.ts) written in its messages. What a chest holds is
 * sealed, so a chest counts as a chest and nothing inside it is counted.
 */
function bagContents(entries: readonly (BagEntry | ChatRumor)[]): Record<ContentsKind, number> {
  const out: Record<ContentsKind, number> = { shard: 0, message: 0, key: 0, chest: 0, cashu: 0, nft: 0 }
  for (const e of entries) {
    if (isReference(e)) { out.shard++; continue }
    if (e.kind === SHARD_KIND) out.shard++
    else if (e.kind === MESSAGE_KIND) { out.message++; out.cashu += (typeof e.content === 'string' ? e.content.match(CASHU_AS_WRITTEN) ?? [] : []).length; out.nft += nftLinkCount(e.content) }
    else if (e.kind === KEY_KIND) out.key++
    else if (e.kind === CHEST_KIND) out.chest++
  }
  return out
}

/**
 * The public `contents` tags a bag's settings write, worked out from what is
 * in it now (ONOSENDAI bagContentsTags): with `contents`, one counted row per
 * kind present, `nft` included; with `money` alone, `["contents", "cashu"]`
 * while a token is inside. There is no NFT-alone form: an NFT is not money.
 */
function bagContentsTags(entries: readonly (BagEntry | ChatRumor)[], settings: Pick<BagSettings, 'contents' | 'money'>): string[][] {
  if (!settings.contents && !settings.money) return []
  const c = bagContents(entries)
  if (settings.contents) return CONTENTS_KINDS.filter((k) => c[k] > 0).map((k) => ['contents', k, String(c[k])])
  return c.cashu > 0 ? [['contents', 'cashu']] : []
}

/**
 * A count as spec 7.7 writes one (ONOSENDAI CONTENTS_COUNT): a positive
 * integer in decimal, with no sign and no leading zeros (the rules of spec 10),
 * and no cap. "03", "+3", "1e2" and "0" are not counts.
 */
const CONTENTS_COUNT = /^[1-9][0-9]*$/

/**
 * The settings a published bag carries (ONOSENDAI bagSettingsOf). A bag read
 * by a legacy `h` reads as heightTag: true, so its next rewrite says `H`.
 */
export function bagSettingsOf(ev: NostrEvent, height: number): BagSettings {
  const h = heightHint(ev)
  const hint = parseHint(ev.tags, h ?? height)
  const rows = ev.tags.filter((t) => t[0] === 'contents' && (CONTENTS_KINDS as readonly string[]).includes(t[1] ?? ''))
  // A row whose count is there but is not a count is ignored (spec 7.7 Reading contents; CONTENTS_COUNT).
  const counted = rows.some((t) => typeof t[2] === 'string' && CONTENTS_COUNT.test(t[2]))
  // Money as a setting only in its own form: a counted cashu row is the contents hint speaking.
  const moneyAlone = rows.some((t) => t[1] === 'cashu' && t[2] === undefined)
  return { heightTag: h !== null, hint: hint ? hint.heights : null, riddle: ev.content.slice(0, MAX_RIDDLE_LENGTH), contents: counted, money: moneyAlone }
}

interface BagPlace { at: Position; plane: Plane }

/**
 * Wrap a bag of entries into one region envelope template (spec 8.6): keyed
 * by d = lookup_id, so there is one per author, region and height; kind
 * 33330 is addressable, so republishing it replaces the old one. The caller
 * signs and publishes, with a created_at that exceeds the previous bag's.
 * The height goes out as `H` (HEIGHT_TAG) unless settings turn it off, and
 * never as `h`; chat envelopes are written here too.
 */
export async function bagTemplate(entries: readonly (BagEntry | ChatRumor)[], regionKey: Uint8Array, lookupId: string, height: number, createdAt: number, kind: number = HIDDEN_KIND, settings: BagSettings = DEFAULT_BAG_SETTINGS, place?: BagPlace): Promise<EventTemplate> {
  const tags: string[][] = [['d', lookupId], ['encrypted', ALGO, await encryptForRegion(regionKey, JSON.stringify(entries))], ['version', '2']]
  if (settings.heightTag) tags.push([HEIGHT_TAG, String(height)])
  if (settings.hint) {
    if (!place) throw new Error('A hint needs the place it points to.')
    if (!hintFits(settings.hint, height)) throw new Error(`A hint box of heights ${settings.hint.join(', ')} cannot contain a height ${height} region.`)
    tags.push(...hintTags(place.at, place.plane, settings.hint))
  }
  tags.push(...bagContentsTags(entries, settings))
  return { kind, created_at: createdAt, content: settings.riddle.trim().slice(0, MAX_RIDDLE_LENGTH), tags }
}

function tag(ev: Pick<NostrEvent, 'tags'>, name: string): string | undefined {
  return ev.tags.find((t) => t[0] === name)?.[1]
}

/** The ciphertext out of an envelope, or null if it is not one. */
export function ciphertextOf(ev: NostrEvent): string | null {
  if (ev.kind !== HIDDEN_KIND && ev.kind !== CHAT_BAG_KIND) return null
  const enc = ev.tags.find((t) => t[0] === 'encrypted')
  if (!enc || enc[1] !== ALGO || !enc[2]) return null
  return enc[2]
}

/**
 * The bag's height tag (spec 8.6), or null when it states no height (ONOSENDAI
 * heightHint). The tag is `H` since 2026-10-21; it was `h`, which NIP-29 reads
 * on any kind as a group id. An event that carries any `H` is read by `H`
 * alone and its `h` tags are ignored; one without `H` is read by a legacy `h`.
 * The tag read must appear exactly once with a canonical decimal value; more
 * than one, or a malformed value, and the bag states no height (it still opens).
 */
export function heightHint(ev: Pick<NostrEvent, 'tags'>): number | null {
  const name = ev.tags.some((t) => t[0] === HEIGHT_TAG) ? HEIGHT_TAG : LEGACY_HEIGHT_TAG
  const found = ev.tags.filter((t) => t[0] === name)
  if (found.length !== 1) return null
  const h = found[0][1]
  if (h === undefined || !/^(0|[1-9][0-9]*)$/.test(h)) return null
  return Number(h)
}

interface BagFacts { height: number; bag: BagSettings }

/** One inner event of a bag -> a Hidden, or null if it is not authentic for the bag's author (innerAuthentic). */
function fromInner(inner: Rumor, outer: NostrEvent, keyHex: string, facts: BagFacts): Hidden | null {
  if (!innerAuthentic(inner, outer.pubkey)) return null
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
 * derived for; it wins over the bag's height tag.
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
  const out: (Hidden | null)[] = entries.map((entry) => (Array.isArray(entry) ? null : fromInner(entry as Rumor, outer, keyHex, facts)))
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

/**
 * The chat lines in an ephemeral envelope: every inner that is a CHAT_KIND,
 * is said by the key that signed the envelope, and whose id is its own hash.
 * A line is a rumor (chatRumor) with no signature; a line from an older
 * client that does carry one must verify (both accepted while clients catch
 * up). A `sig` that is the empty string is no signature (DECK-0005 §3.2
 * rule 5, spec §7.6 Rumors), so that line is read as a rumor.
 */
export async function chatInners(outer: NostrEvent, regionKey: Uint8Array): Promise<ChatRumor[]> {
  if (outer.kind !== CHAT_BAG_KIND) return []
  const ct = ciphertextOf(outer)
  if (!ct) return []
  const json = await decryptForRegion(regionKey, ct)
  if (!json) return []
  let arr: unknown
  try { arr = JSON.parse(json) } catch { return [] }
  if (!Array.isArray(arr)) return []
  return arr.filter((e): e is ChatRumor => isChatLine(e, outer.pubkey))
}

/** One sealed chat line, checked as chatInners describes. */
function isChatLine(e: unknown, speaker: string): boolean {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false
  const ev = e as ChatRumor
  if (ev.kind !== CHAT_KIND || ev.pubkey !== speaker) return false
  if (typeof ev.content !== 'string' || ev.content.length === 0) return false
  if (typeof ev.created_at !== 'number' || !Array.isArray(ev.tags) || typeof ev.id !== 'string') return false
  try {
    if (getEventHash({ kind: ev.kind, created_at: ev.created_at, tags: ev.tags, content: ev.content, pubkey: ev.pubkey }) !== ev.id) return false
  } catch { return false }
  // No `sig`, or an empty one, is unsigned (DECK-0005 §3.2 rule 5), as innerAuthentic has it.
  return ev.sig === undefined || ev.sig === '' || isAuthentic(ev as NostrEvent)
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

