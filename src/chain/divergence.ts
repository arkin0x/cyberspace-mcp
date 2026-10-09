// divergence.ts: this server's unpublished moves against moves the relays
// already hold, from the same point of the same chain.
//
// Ported from ONOSENDAI src/lib/branchConflict.ts at commit 8e4d0e3 (branch
// feat/keys-and-chests): findDivergence. The prompt and the fold that
// ONOSENDAI builds on it are not ported; here the question is asked once,
// when the outbox replays after a restart: an event signed before a crash,
// whose previous has meanwhile gained another child on the relays, must not
// be published, because together they would fork the chain and a fork kills
// it for every reader (spec 8.7.3 rule 4). The outbox drops such an event
// and says so.

import type { NostrEvent } from '../nostr/event.js'
import { actionLink, buildChain, type ActionEvent } from './events.js'

export interface Divergence {
  forkId: string
  /** Position of the fork point in the local chain (0 is the spawn). */
  forkIndex: number
  /** This server's actions after the fork, oldest first. All unpublished. */
  local: ActionEvent[]
  /** The relays' actions after the fork, as the walk from the spawn reads them, oldest first. */
  relay: ActionEvent[]
}

/**
 * Where this server's unpublished moves fork against moves the relays hold,
 * or null when they do not. A fork needs all of: a relay action of the same
 * chain (same genesis) that this server does not have, naming an action of
 * the local chain as its previous, where the local chain's own next action
 * from that point is one this server has not published. A relay action that
 * extends the local head is not a fork.
 */
export function findDivergence(
  localEvents: NostrEvent[],
  published: Record<string, string | undefined>,
  relayEvents: NostrEvent[],
): Divergence | null {
  const chain = buildChain(localEvents)
  if (chain.length === 0) return null
  const genesis = chain[0].id
  const index = new Map(chain.map((a, i) => [a.id, i]))
  const localIds = new Set(localEvents.map((e) => e.id))
  let forkIndex = -1
  for (const ev of relayEvents) {
    if (localIds.has(ev.id)) continue
    const a = actionLink(ev)
    if (!a || a.genesisId !== genesis) continue
    const at = index.get(a.previousId)
    if (at === undefined || at >= chain.length - 1) continue
    const ours = chain[at + 1]
    if (published[ours.id] === 'ok') continue
    if (forkIndex === -1 || at < forkIndex) forkIndex = at
  }
  if (forkIndex === -1) return null
  const fork = chain[forkIndex]
  const sharedEvents = localEvents.filter((e) => {
    const i = index.get(e.id)
    return i !== undefined && i <= forkIndex
  })
  const relayVersion = buildChain([...sharedEvents, ...relayEvents.filter((e) => !localIds.has(e.id) || index.get(e.id)! <= forkIndex)])
  const relay = relayVersion[0]?.id === genesis ? relayVersion.slice(forkIndex + 1) : []
  const local = chain.slice(forkIndex + 1)
  if (relay.length === 0 || local.length === 0) return null
  return { forkId: fork.id, forkIndex, local, relay }
}
