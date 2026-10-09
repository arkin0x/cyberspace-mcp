// chests.ts: sealing a chest and opening one (Keys and Chests B1 2.2), and
// forging a key item (B1 2.1).
//
// Ported from ONOSENDAI src/lib/chests.ts at commit 123cb55 (branch
// feat/keys-and-chests). The signer-based opener is replaced by the
// agent's own secret, which it holds locally.
//
// A chest is a bag item whose content is a list of entries, in exactly the
// shape of a bag's plaintext (spec 7.6), sealed with NIP-44 v2 to a public
// key instead of to a place: an item's public key (a key item found
// somewhere else) or a person's pubkey, which is how a chest becomes a gift.
// The seal is the gift-wrap pattern: a fresh keypair used once as the NIP-44
// sender, its public half written into the chest's lock tag, its secret
// discarded.

import { v2 as nip44 } from 'nostr-tools/nip44'
import { generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes, isAuthentic, type NostrEvent } from '../nostr/event.js'
import { isReference, readItem, type BagEntry, type ChestItem, type ItemBody, type KeyItem } from './bags.js'

/** A new key item: a fresh keypair under a name (B1 3.1). */
export function forgeKey(name: string, about = ''): KeyItem {
  const sk = generateSecretKey()
  return { name, about, itemPubkey: getPublicKey(sk), secretHex: bytesToHex(sk) }
}

/** NIP-44 v2 seals at most this many bytes of plaintext. */
export const NIP44_MAX_PLAINTEXT = 65_535

export function plaintextBytes(entries: BagEntry[]): number {
  return new TextEncoder().encode(JSON.stringify(entries)).length
}

/** Why a list of this many bytes cannot be sealed, in words, or null when it fits. */
export function sizeRefusal(bytes: number): string | null {
  if (bytes <= NIP44_MAX_PLAINTEXT) return null
  return `Too large to seal: ${bytes} of ${NIP44_MAX_PLAINTEXT} bytes. Take something out.`
}

export interface Sealed {
  payload: string
  senderPubkey: string
}

/** Seal a list of entries to a public key with a one-time sender key. Throws with sizeRefusal's words when too large. */
export function sealEntries(entries: BagEntry[], lockPubkey: string): Sealed {
  const plaintext = JSON.stringify(entries)
  const refusal = sizeRefusal(new TextEncoder().encode(plaintext).length)
  if (refusal) throw new Error(refusal)
  const senderSecret = generateSecretKey()
  const senderPubkey = getPublicKey(senderSecret)
  const payload = nip44.encrypt(plaintext, nip44.utils.getConversationKey(senderSecret, lockPubkey))
  senderSecret.fill(0)
  return { payload, senderPubkey }
}

/** The entries a decrypted chest holds. Anything that is not a list is a chest this server cannot read. */
export function parseChestPlaintext(plaintext: string): BagEntry[] {
  let parsed: unknown
  try { parsed = JSON.parse(plaintext) } catch { throw new Error('This chest holds something this server cannot read.') }
  if (!Array.isArray(parsed)) throw new Error('This chest holds something this server cannot read.')
  return parsed.filter((e): e is BagEntry => isReference(e) || (!!e && typeof e === 'object' && !Array.isArray(e) && typeof (e as NostrEvent).kind === 'number'))
}

/** Open a chest with a secret: a held key item's, or the agent's own when the chest is sealed to its pubkey. Throws on the wrong key. */
export function openWithSecret(chest: Pick<ChestItem, 'senderPubkey' | 'payload'>, secretHex: string): BagEntry[] {
  const key = nip44.utils.getConversationKey(hexToBytes(secretHex), chest.senderPubkey)
  return parseChestPlaintext(nip44.decrypt(chest.payload, key))
}

/** One thing inside an opened chest, readable. */
export interface ChestEntry {
  id: string
  event: NostrEvent
  /** The event carried a signature and it checked out; an unsigned item's author is a claim. */
  verified: boolean
  body: ItemBody
}

/** The readable contents of an opened chest. A signed item that fails to verify is dropped; a reference is skipped. */
export function readContents(entries: BagEntry[]): ChestEntry[] {
  const out: ChestEntry[] = []
  for (const e of entries) {
    if (isReference(e)) continue
    const ev = e as NostrEvent
    const signed = typeof ev.sig === 'string' && ev.sig.length > 0
    if (signed && !isAuthentic(ev)) continue
    let id: string
    try { id = typeof ev.id === 'string' && /^[0-9a-f]{64}$/.test(ev.id) ? ev.id : getEventHash(ev) } catch { continue }
    const body = readItem({ ...ev, id })
    if (!body) continue
    out.push({ id, event: { ...ev, id, sig: signed ? ev.sig : '' }, verified: signed, body })
  }
  return out
}

/** A key as the opener needs it. */
export interface OpeningKey {
  itemPubkey: string
  secretHex: string
}

export type Opener = { by: 'key'; key: OpeningKey } | { by: 'self' } | null

/** Which of the reader's keys opens this chest, or that the lock is the reader's own pubkey, or null. */
export function openerFor(chest: Pick<ChestItem, 'lockPubkey'>, keys: OpeningKey[], me: string): Opener {
  const key = keys.find((k) => k.itemPubkey === chest.lockPubkey)
  if (key) return { by: 'key', key }
  return chest.lockPubkey === me ? { by: 'self' } : null
}

/** What a reader who cannot open a chest is told. */
export function requiresLabel(chest: Pick<ChestItem, 'requires'>): string {
  return chest.requires || 'an item you have not found'
}
