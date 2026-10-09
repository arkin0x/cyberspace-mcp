// selfCheck.ts: whether this identity already has a chain on the relays.
//
// Ported from ONOSENDAI src/lib/chainHold.ts at commit 8e4d0e3 (branch
// feat/keys-and-chests): decideSelfCheck, refusalText, summarizeChain. The
// held-chain machinery (a chain started before the relays could answer,
// kept on the device) is not ported: an agent that cannot tell whether it
// has a chain is refused a spawn instead, because a rival spawn is the one
// thing it must never publish by accident.
//
// The verdict, per relay outcome:
//
//   the chain came back with a hole no question could fill   unknown: unreachable, only part of the chain
//   any relay returned events that make a chain              found
//   the canonical relay answered and no relay returned a chain  none
//   the canonical relay refused                              unknown: refused, with its reason
//   the canonical relay did not answer                       unknown: unreachable
//
// Only the canonical relay can say "none", because it is where every chain
// is published; a private relay that answers "nothing" only knows about itself.

import { normalizeURL } from 'nostr-tools/utils'
import { sectorTag, xyzToSectorId, type Plane } from 'cyberspace-core'
import type { NostrEvent } from '../nostr/event.js'
import { PARTIAL_CHAIN_REASON, mergeAnswers, type RelayAnswer } from '../nostr/relayOutcome.js'
import type { Position } from '../space/coords.js'
import { buildChain } from './events.js'

export type CheckCause =
  | { kind: 'unreachable'; reason: string }
  | { kind: 'refused'; url: string; reason: string }

export type CheckVerdict =
  | { status: 'found'; events: NostrEvent[] }
  | { status: 'none' }
  | { status: 'unknown'; cause: CheckCause }

/** The table in the header, as a function. */
export function decideSelfCheck(answers: RelayAnswer[], canonical: string): CheckVerdict {
  const events = mergeAnswers(answers)
  if (answers.some((a) => a.outcome === 'unreachable' && a.reason === PARTIAL_CHAIN_REASON)) {
    return { status: 'unknown', cause: { kind: 'unreachable', reason: PARTIAL_CHAIN_REASON } }
  }
  if (events.length > 0 && buildChain(events).length > 0) return { status: 'found', events }
  const home = normalizeURL(canonical)
  const answer = answers.find((a) => normalizeURL(a.url) === home)
  if (answer?.outcome === 'answered') return { status: 'none' }
  if (answer?.outcome === 'refused') return { status: 'unknown', cause: { kind: 'refused', url: answer.url, reason: answer.reason } }
  return { status: 'unknown', cause: { kind: 'unreachable', reason: answer?.outcome === 'unreachable' ? answer.reason : 'not asked' } }
}

/** A relay's refusal in words a reader can act on. */
export function refusalText(reason: string): string {
  if (/^auth-required:/i.test(reason)) return 'it wants the identity to authenticate'
  if (/^rate-limited:/i.test(reason)) return 'too many requests, try again shortly'
  return reason
}

/** Why the relays could not say, as a short clause. */
export function causeWords(cause: CheckCause): string {
  switch (cause.kind) {
    case 'unreachable': return `the relays did not answer (${cause.reason})`
    case 'refused': return `the canonical relay refused: ${refusalText(cause.reason)}`
  }
}

/** One chain, summarized. */
export interface ChainSummary {
  startedAt: number
  actions: number
  lastActive: number
  position: Position
  plane: Plane
  sector: string
  headId: string
  spawnId: string
}

/** The active chain in `events`, summarized; null when there is none. */
export function summarizeChain(events: NostrEvent[]): ChainSummary | null {
  const chain = buildChain(events)
  if (chain.length === 0) return null
  const head = chain[chain.length - 1]
  return {
    startedAt: chain[0].createdAt,
    actions: chain.length,
    lastActive: head.createdAt,
    position: head.position,
    plane: head.plane,
    sector: sectorTag(xyzToSectorId(head.position.x, head.position.y, head.position.z)),
    headId: head.id,
    spawnId: chain[0].id,
  }
}
