// dm.ts: private direct messages between an agent and its operator, as
// NIP-17 lays them out, exactly as the operator DM contract (2026-10-10)
// fixes them. Pure: no relay, no state, no clock but the one passed in.
//
//   - The rumor is a kind 14, unsigned (id computed, no sig), pubkey the
//     sender, tags one p tag naming the recipient, plus ["agent", "strategy"]
//     when the message is a STRATEGY (standing orders). created_at is the
//     real time.
//   - The seal is a kind 13 signed by the sender, tags empty (no client tag:
//     a seal reveals nothing), content the rumor JSON encrypted with NIP-44
//     v2 from the sender's key to the recipient. created_at is randomized up
//     to two days into the past.
//   - The gift wrap is a kind 1059 signed by a fresh random key per wrap,
//     tags one p tag naming the recipient and nothing else, content the seal
//     JSON encrypted with NIP-44 v2 from that random key to the recipient.
//     created_at is randomized up to two days into the past.
//   - The sender wraps the same rumor to itself too, so its history survives.
//   - On receipt: unwrap, verify the seal's signature, and require the
//     rumor's pubkey to be the seal's. Anything else is dropped.
//
// Neither the seal nor the wrap goes through signEvent (event.ts), which
// adds the client tag to everything it signs: these two must carry no tag
// that names the app.

import { v2 as nip44 } from 'nostr-tools/nip44'
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure'
import { HEX_64, isAuthentic, type NostrEvent } from './event.js'

export const RUMOR_KIND = 14
export const SEAL_KIND = 13
export const WRAP_KIND = 1059
/** NIP-17 DM relay list: where a person reads its DMs. */
export const DM_RELAYS_KIND = 10050
/** The marker tag of a STRATEGY: the operator's standing orders. */
export const STRATEGY_TAG = ['agent', 'strategy'] as const
/** How far into the past a seal's and a wrap's created_at may be pushed (NIP-59: up to two days). */
export const MAX_BACKDATE_SECONDS = 2 * 24 * 60 * 60

/** A kind 14 as it travels inside a seal: an event with an id and no signature. */
export interface Rumor {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
}

/** A created_at between `now` and two days before it, uniformly. `random` is for tests. */
export function randomPast(now: number, random: () => number = Math.random): number {
  return now - Math.floor(random() * MAX_BACKDATE_SECONDS)
}

/** The rumor of one message from `senderPubkey` to `recipient`. */
export function createRumor(input: { senderPubkey: string; recipient: string; text: string; strategy?: boolean; createdAt: number }): Rumor {
  const tags: string[][] = [['p', input.recipient]]
  if (input.strategy) tags.push([...STRATEGY_TAG])
  const unsigned = { pubkey: input.senderPubkey, created_at: input.createdAt, kind: RUMOR_KIND, tags, content: input.text }
  return { id: getEventHash(unsigned), ...unsigned }
}

/** The seal: the rumor encrypted to `recipient`, signed by the sender, no tags. */
export function sealRumor(rumor: Rumor, senderSk: Uint8Array, recipient: string, createdAt: number): NostrEvent {
  const content = nip44.encrypt(JSON.stringify(rumor), nip44.utils.getConversationKey(senderSk, recipient))
  return finalizeEvent({ kind: SEAL_KIND, created_at: createdAt, tags: [], content }, senderSk) as NostrEvent
}

/** The gift wrap: the seal encrypted to `recipient` by a key used once, tagged with the recipient alone. */
export function wrapSeal(seal: NostrEvent, recipient: string, createdAt: number, wrapSk: Uint8Array = generateSecretKey()): NostrEvent {
  const content = nip44.encrypt(JSON.stringify(seal), nip44.utils.getConversationKey(wrapSk, recipient))
  return finalizeEvent({ kind: WRAP_KIND, created_at: createdAt, tags: [['p', recipient]], content }, wrapSk) as NostrEvent
}

export interface WrappedMessage {
  rumor: Rumor
  /** The wrap addressed to the recipient. */
  toRecipient: NostrEvent
  /** The same rumor wrapped to the sender, for the sender's own history. */
  toSelf: NostrEvent
}

/**
 * One message, ready to send: the rumor, sealed and wrapped once to the
 * recipient and once to the sender. Each seal and each wrap gets its own
 * randomized created_at, and each wrap its own fresh key.
 */
export function wrapMessage(input: { senderSk: Uint8Array; recipient: string; text: string; strategy?: boolean; now: number; random?: () => number }): WrappedMessage {
  const sender = getPublicKey(input.senderSk)
  const random = input.random ?? Math.random
  const rumor = createRumor({ senderPubkey: sender, recipient: input.recipient, text: input.text, strategy: input.strategy, createdAt: input.now })
  const wrapTo = (to: string): NostrEvent =>
    wrapSeal(sealRumor(rumor, input.senderSk, to, randomPast(input.now, random)), to, randomPast(input.now, random))
  return { rumor, toRecipient: wrapTo(input.recipient), toSelf: wrapTo(sender) }
}

export type Unwrapped =
  | { ok: true; rumor: Rumor; seal: NostrEvent }
  | { ok: false; reason: string }

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function isTags(v: unknown): v is string[][] {
  return Array.isArray(v) && v.every((t) => Array.isArray(t) && t.every((s) => typeof s === 'string'))
}

/**
 * Open a gift wrap addressed to the holder of `recipientSk`. The wrap's own
 * signature is checked, then the seal's, and the rumor must be a kind 14
 * whose id is its hash and whose pubkey is the seal's signer. The reason
 * says which check failed; nothing in it comes from the message.
 */
export function unwrapMessage(wrap: NostrEvent, recipientSk: Uint8Array): Unwrapped {
  if (wrap.kind !== WRAP_KIND) return { ok: false, reason: 'not a gift wrap' }
  if (!isAuthentic(wrap)) return { ok: false, reason: 'the gift wrap\'s signature is not valid' }
  let sealJson: string
  try {
    sealJson = nip44.decrypt(wrap.content, nip44.utils.getConversationKey(recipientSk, wrap.pubkey))
  } catch {
    return { ok: false, reason: 'the gift wrap did not decrypt with this key' }
  }
  const s = parseJson(sealJson)
  if (!s || typeof s.id !== 'string' || typeof s.pubkey !== 'string' || typeof s.sig !== 'string' || typeof s.content !== 'string' || typeof s.created_at !== 'number' || typeof s.kind !== 'number' || !isTags(s.tags)) {
    return { ok: false, reason: 'the gift wrap does not hold a seal' }
  }
  const seal: NostrEvent = { id: s.id, pubkey: s.pubkey, created_at: s.created_at, kind: s.kind, tags: s.tags, content: s.content, sig: s.sig }
  if (seal.kind !== SEAL_KIND) return { ok: false, reason: 'the gift wrap does not hold a kind 13 seal' }
  if (!isAuthentic(seal)) return { ok: false, reason: 'the seal\'s signature is not valid' }
  let rumorJson: string
  try {
    rumorJson = nip44.decrypt(seal.content, nip44.utils.getConversationKey(recipientSk, seal.pubkey))
  } catch {
    return { ok: false, reason: 'the seal did not decrypt with this key' }
  }
  const r = parseJson(rumorJson)
  if (!r || typeof r.pubkey !== 'string' || typeof r.content !== 'string' || typeof r.created_at !== 'number' || typeof r.kind !== 'number' || !isTags(r.tags)) {
    return { ok: false, reason: 'the seal does not hold a rumor' }
  }
  if (r.kind !== RUMOR_KIND) return { ok: false, reason: 'the rumor is not a kind 14 message' }
  if (!HEX_64.test(r.pubkey) || r.pubkey !== seal.pubkey) return { ok: false, reason: 'the rumor\'s author is not the seal\'s signer' }
  const unsigned = { pubkey: r.pubkey, created_at: r.created_at, kind: r.kind, tags: r.tags, content: r.content }
  const id = getEventHash(unsigned)
  if (typeof r.id === 'string' && r.id !== id) return { ok: false, reason: 'the rumor\'s id is not its hash' }
  return { ok: true, rumor: { id, ...unsigned }, seal }
}

/** Whether a rumor carries the STRATEGY marker. */
export function isStrategy(rumor: Pick<Rumor, 'tags'>): boolean {
  return rumor.tags.some((t) => t[0] === STRATEGY_TAG[0] && t[1] === STRATEGY_TAG[1])
}

/** The relays a kind 10050 names, valid ws(s) URLs only, in the order listed, each once. */
export function dmRelaysOf(ev: Pick<NostrEvent, 'tags'> | null | undefined, normalize: (url: string) => string | null): string[] {
  if (!ev) return []
  const out: string[] = []
  for (const t of ev.tags) {
    if (t[0] !== 'relay' || typeof t[1] !== 'string') continue
    const url = normalize(t[1])
    if (url && !out.includes(url)) out.push(url)
  }
  return out
}

/** Whether two relay lists name the same set of relays (already normalized). */
export function sameRelaySet(a: string[], b: string[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  return sa.size === sb.size && [...sa].every((u) => sb.has(u))
}
