// itemModel.ts: the SNO an item wears in cyberspace, and how it moves.
//
// Ported from ONOSENDAI src/lib/itemModel.ts (branch feat/item-model,
// ONOSENDAI#439; spec draft DECK-0004 2.5, arkin0x/cyberspace#74). Only the
// tags are ported: this server reads and writes them so an item keeps its
// model and its motions wherever it goes (a bag, a chest, a copy). The
// motion, the box and the drawing are ONOSENDAI's alone.
//
// Both ride in the item itself (a kind 3340, hidden/bags.ts), sealed like
// every other tag:
//
//   ["model", "33331:<pubkey>:<d>", "<relay hint>"]
//   ["animate", "bob", "spin-y", "spin-x"]
//
// `model` names a public SNO object by its address (DECK-0003 3.1); the
// relay hint is optional and only a ws or wss URL is kept. `animate` lists
// any of the three motions, each at most once, in ANIMATIONS order; a reader
// skips a name it does not know, and reads motions only with a model. An
// item with neither tag reads exactly as before. The readers and the writer
// below must stay the same as ONOSENDAI's.

/** The kind a model must be: a SNO object (DECK-0003 3.1). */
export const MODEL_KIND = 33331
/** The tag that names an item's model. */
export const MODEL_TAG = 'model'
/** The tag that lists an item's motions. */
export const ANIMATE_TAG = 'animate'

/** One of the motions an item's model may have; they stack. */
export type ItemAnimation = 'bob' | 'spin-y' | 'spin-x'
/** Every motion, in the order a tag lists them. */
export const ANIMATIONS: readonly ItemAnimation[] = ['bob', 'spin-y', 'spin-x']

/** A model an item wears: a SNO object's address, and where it was seen. */
export interface ItemModelRef {
  /** `33331:<pubkey>:<d>`. */
  address: string
  /** A relay that holds it (ws or wss), when known. */
  relay?: string
}

const HEX_64 = /^[0-9a-f]{64}$/
/** Longest `d` an address may carry: a UUID is 36, an event id 64. */
const MAX_D = 128

/** Whether `address` is a SNO object's: `33331:<64 hex>:<d>`, with a `d` of 1 to 128 printable characters. */
export function isModelAddress(address: string): boolean {
  const first = address.indexOf(':')
  const second = address.indexOf(':', first + 1)
  if (first < 0 || second < 0) return false
  if (address.slice(0, first) !== String(MODEL_KIND)) return false
  if (!HEX_64.test(address.slice(first + 1, second))) return false
  const d = address.slice(second + 1)
  return d.length > 0 && d.length <= MAX_D && /^[\x21-\x7e]+$/.test(d)
}

/** A relay hint worth keeping: a ws or wss URL, else nothing. */
function relayHint(s: string | undefined): string | undefined {
  return typeof s === 'string' && /^wss?:\/\/[^\s]+$/.test(s) && s.length <= 256 ? s : undefined
}

/** A tag that is an array of strings, or null: anything else is passed over, as bags.ts does with every tag. */
function stringTag(t: unknown): string[] | null {
  return Array.isArray(t) && t.every((v) => typeof v === 'string') ? (t as string[]) : null
}

/** The model an item's tags name, or null: the first `model` tag whose address is a SNO object's. */
export function modelOf(tags: readonly unknown[]): ItemModelRef | null {
  for (const raw of tags) {
    const t = stringTag(raw)
    if (!t || t[0] !== MODEL_TAG || !isModelAddress(t[1] ?? '')) continue
    const relay = relayHint(t[2])
    return relay ? { address: t[1], relay } : { address: t[1] }
  }
  return null
}

/**
 * The motions an item's tags list, in ANIMATIONS order, each once. Every
 * `animate` tag counts, so a writer that split them across two is read the
 * same; a name this server does not know is skipped.
 */
export function animationOf(tags: readonly unknown[]): ItemAnimation[] {
  const on = new Set<string>()
  for (const raw of tags) {
    const t = stringTag(raw)
    if (t && t[0] === ANIMATE_TAG) for (const v of t.slice(1)) on.add(v)
  }
  return ANIMATIONS.filter((a) => on.has(a))
}

/**
 * The tags that carry a model and its motions, or none: no model, no tags,
 * because motions without a model have nothing to move. The motions go out
 * in ANIMATIONS order, each once, and only when there is at least one.
 */
export function modelTags(model: ItemModelRef | undefined, animation: readonly ItemAnimation[] | undefined): string[][] {
  if (!model || !isModelAddress(model.address)) return []
  const relay = relayHint(model.relay)
  const tags: string[][] = [relay ? [MODEL_TAG, model.address, relay] : [MODEL_TAG, model.address]]
  const moves = ANIMATIONS.filter((a) => animation?.includes(a))
  if (moves.length > 0) tags.push([ANIMATE_TAG, ...moves])
  return tags
}

/** What an item wears and how it moves: the two optional fields a key item and a held item share. */
export interface ItemLook {
  model?: ItemModelRef
  animation?: ItemAnimation[]
}

/**
 * The look of a key item or a held item, copied, with only the fields it
 * has: how a found item's model and motions are held, and how a held item
 * keeps them when it is copied into a chest. A held item written before
 * these tags existed has none, and gets none; motions come only with a
 * model, as the reader takes them.
 */
export function lookOf(x: ItemLook): ItemLook {
  return {
    ...(x.model ? { model: x.model.relay ? { address: x.model.address, relay: x.model.relay } : { address: x.model.address } } : {}),
    ...(x.model && x.animation && x.animation.length > 0 ? { animation: [...x.animation] } : {}),
  }
}
