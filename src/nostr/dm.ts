// dm.ts: private direct messages between an agent and its operator, as
// NIP-17 lays them out, exactly as the operator DM contract (2026-10-10)
// fixes them. Pure: no relay, no state, no clock but the one passed in.
//
//   - The rumor is a kind 14, unsigned (id computed, no sig), pubkey the
//     sender, tags one p tag naming the recipient, plus ["agent", "strategy"]
//     when the message is a STRATEGY (standing orders), or ["agent",
//     "continue"] when it is a CONTINUE (KEEP GOING: renew the session
//     budget; arkinox, 2026-10-11). created_at is the real time.
//   - The seal is a kind 13 signed by the sender, tags empty (no client tag:
//     a seal reveals nothing), content the rumor JSON encrypted with NIP-44
//     v2 from the sender's key to the recipient. created_at is randomized up
//     to two days into the past.
//   - The gift wrap is a kind 1059 signed by a fresh random key per wrap,
//     tags one p tag naming the recipient and nothing else, content the seal
//     JSON encrypted with NIP-44 v2 from that random key to the recipient.
//     created_at is randomized up to two days into the past.
//   - The sender wraps the same rumor to itself too, so its history survives.
//   - A reaction (arkinox, 2026-10-12: the agent's 👀 on an order it has
//     seen) is a kind 7 rumor, sealed and wrapped exactly like a message:
//     content "👀", tags ["e", <the rumor id reacted to>] and ["p", <its
//     author>], nothing else. It is the NIP-17 private reaction ONOSENDAI
//     unwraps and shows under the message.
//   - A job's status (arkinox, 2026-10-25: "i like the status emojis so we
//     can see the state"): the same private kind 7, from the agent, on the
//     operator's order, with the state as its content: 👀 seen, ⚙️ working,
//     ✅ done, ⚠️ given up, ⏹️ stopped. The newest one is the order's state.
//   - A STOP (arkinox, 2026-10-25: HOLD becomes a real control) is a kind 14
//     from the operator carrying ["agent", "stop"], and an ["e", <rumor id>]
//     per order it stops; with no e tag it stops every open job. It is a
//     control, never an order: the server acts on it, no model reads it.
//   - On receipt: unwrap, verify the seal's signature, and require the
//     rumor's pubkey to be the seal's, and its kind a 14 or a 7. Anything
//     else is dropped.
//
// Neither the seal nor the wrap goes through signEvent (event.ts), which
// adds the client tag to everything it signs: these two must carry no tag
// that names the app.

import { v2 as nip44 } from 'nostr-tools/nip44'
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure'
import { HEX_64, isAuthentic, type NostrEvent } from './event.js'

export const RUMOR_KIND = 14
/** A private reaction rumor (NIP-17 with a NIP-25 kind 7 inside): never an order. */
export const REACTION_KIND = 7
/** What the agent reacts with when it first sees an order: "seen, working on it" (arkinox, 2026-10-12). */
export const SEEN_REACTION = '👀'
/**
 * The states a job (an order from the operator) shows, each a reaction from
 * the agent on the order (arkinox, 2026-10-25). Sent once per order per
 * state; a client shows the newest one from the agent as the order's state.
 */
export const JOB_STATUS = {
  seen: SEEN_REACTION,
  working: '\u2699\ufe0f',
  done: '\u2705',
  gaveUp: '\u26a0\ufe0f',
  stopped: '\u23f9\ufe0f',
} as const
export type JobState = keyof typeof JOB_STATUS
export const SEAL_KIND = 13
export const WRAP_KIND = 1059
/** NIP-17 DM relay list: where a person reads its DMs. */
export const DM_RELAYS_KIND = 10050
/** The marker tag of a STRATEGY: the operator's standing orders. */
export const STRATEGY_TAG = ['agent', 'strategy'] as const
/**
 * The marker tag of a CONTINUE: the operator's KEEP GOING, which renews the
 * agent's session budget (arkinox, 2026-10-11: "if XOR runs out of time
 * budget, I want to be able to tell him keep going"). Only the tag counts;
 * the words "keep going" without it renew nothing.
 */
export const CONTINUE_TAG = ['agent', 'continue'] as const
/**
 * The marker tag of a STOP: the operator's control that stops jobs at once
 * (arkinox, 2026-10-25), enforced by the server, never by the model. An
 * ["e", <order rumor id>] per job it stops; none stops every open job.
 */
export const STOP_TAG = ['agent', 'stop'] as const
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
export function createRumor(input: { senderPubkey: string; recipient: string; text: string; strategy?: boolean; continue?: boolean; createdAt: number }): Rumor {
  const tags: string[][] = [['p', input.recipient]]
  if (input.strategy) tags.push([...STRATEGY_TAG])
  if (input.continue) tags.push([...CONTINUE_TAG])
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

/**
 * The rumor of a private reaction from `senderPubkey` to the message
 * `eventId` written by `recipient`: kind 7, the content the reaction, and
 * exactly the two tags ONOSENDAI reads, the e tag first.
 */
export function createReactionRumor(input: { senderPubkey: string; recipient: string; eventId: string; content?: string; createdAt: number }): Rumor {
  const unsigned = { pubkey: input.senderPubkey, created_at: input.createdAt, kind: REACTION_KIND, tags: [['e', input.eventId], ['p', input.recipient]], content: input.content ?? SEEN_REACTION }
  return { id: getEventHash(unsigned), ...unsigned }
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
  const rumor = createRumor({ senderPubkey: sender, recipient: input.recipient, text: input.text, strategy: input.strategy, createdAt: input.now })
  return wrapRumor(rumor, input.senderSk, input.recipient, input.now, input.random)
}

/** A private reaction to the message `eventId` from `recipient`, ready to send, wrapped exactly as a message is (arkinox, 2026-10-12). */
export function wrapReaction(input: { senderSk: Uint8Array; recipient: string; eventId: string; content?: string; now: number; random?: () => number }): WrappedMessage {
  const sender = getPublicKey(input.senderSk)
  const rumor = createReactionRumor({ senderPubkey: sender, recipient: input.recipient, eventId: input.eventId, content: input.content, createdAt: input.now })
  return wrapRumor(rumor, input.senderSk, input.recipient, input.now, input.random)
}

/** Any rumor sealed and wrapped once to the recipient and once to its sender, each seal and wrap with its own time and each wrap with its own key. */
function wrapRumor(rumor: Rumor, senderSk: Uint8Array, recipient: string, now: number, random: () => number = Math.random): WrappedMessage {
  const wrapTo = (to: string): NostrEvent =>
    wrapSeal(sealRumor(rumor, senderSk, to, randomPast(now, random)), to, randomPast(now, random))
  return { rumor, toRecipient: wrapTo(recipient), toSelf: wrapTo(rumor.pubkey) }
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
 * (a message) or a kind 7 (a reaction, which the caller tells apart) whose id is its hash and whose pubkey is the seal's signer. The reason
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
  if (r.kind !== RUMOR_KIND && r.kind !== REACTION_KIND) return { ok: false, reason: 'the rumor is not a kind 14 message or a kind 7 reaction' }
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

/** Whether a rumor carries the CONTINUE marker. */
export function isContinue(rumor: Pick<Rumor, 'tags'>): boolean {
  return rumor.tags.some((t) => t[0] === CONTINUE_TAG[0] && t[1] === CONTINUE_TAG[1])
}

/** Whether a rumor carries the STOP marker. */
export function isStop(rumor: Pick<Rumor, 'tags'>): boolean {
  return rumor.tags.some((t) => t[0] === STOP_TAG[0] && t[1] === STOP_TAG[1])
}

/** The orders a STOP names (its e tags, valid ids only, each once); empty means every open job. */
export function stopTargets(rumor: Pick<Rumor, 'tags'>): string[] {
  return [...new Set(rumor.tags.filter((t) => t[0] === 'e' && typeof t[1] === 'string' && HEX_64.test(t[1])).map((t) => t[1]))]
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
