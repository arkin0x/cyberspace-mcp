// relayOutcome.ts: what one relay said to one question, told apart.
//
// Ported from ONOSENDAI src/lib/relayOutcome.ts at commit d63e460 (branch
// feat/keys-and-chests), unchanged but for the event type.
//
// A one-shot query answered as a bare list of events makes an empty list
// mean three different things: the relay answered that it has nothing, the
// relay never answered, or the relay refused to answer. For the read that
// decides whether this identity already has a chain, that is the difference
// between continuing that chain and quietly starting a rival one. So every
// relay's answer is one of three outcomes:
//
//   answered     a real EOSE arrived before the deadline: the events are all it has
//   refused      the relay ended the subscription with a NIP-01 reason
//   unreachable  the connection failed, dropped, or no EOSE came by the deadline
//
// Pure: no sockets here.

import type { NostrEvent } from './event.js'

export type RelayAnswer =
  | { url: string; outcome: 'answered'; events: NostrEvent[] }
  | { url: string; outcome: 'refused'; reason: string; events: NostrEvent[] }
  | { url: string; outcome: 'unreachable'; reason: string; events: NostrEvent[] }

/** The machine-readable prefixes NIP-01 gives a relay for CLOSED (and OK false). */
const REFUSAL_PREFIXES = ['auth-required', 'restricted', 'blocked', 'rate-limited', 'invalid', 'error', 'pow', 'duplicate', 'mute'] as const
const REFUSAL = new RegExp(`^(${REFUSAL_PREFIXES.join('|')}):`, 'i')

/** The reason a relay's answer carries when it answered, but the chain it returned has a hole no further question could fill. */
export const PARTIAL_CHAIN_REASON = 'the relays returned only part of this chain'

/** True when a close reason is a relay's own refusal rather than a dropped connection. */
export function isRefusal(reason: string): boolean {
  return REFUSAL.test(reason.trim())
}

/** One relay's subscription ended before any EOSE: a refusal, or the connection going away. */
export function classifyClose(url: string, reason: string, events: NostrEvent[]): RelayAnswer {
  const r = reason.trim()
  return isRefusal(r)
    ? { url, outcome: 'refused', reason: r, events }
    : { url, outcome: 'unreachable', reason: r || 'connection closed', events }
}

/** Every event any relay returned, once each, in arrival order. */
export function mergeAnswers(answers: RelayAnswer[]): NostrEvent[] {
  const byId = new Map<string, NostrEvent>()
  for (const a of answers) for (const e of a.events) if (!byId.has(e.id)) byId.set(e.id, e)
  return [...byId.values()]
}
