// publicObject.ts: publishing an SNO object to the feed, a public kind 33331
// (DECK-0003 3.1). arkinox, 2026-10-13, amending the agents ruling D11: an
// agent may publish objects, so what it builds shows in the Shard Feed and
// other apps can copy it; placing a public shard in the world (kind 33332)
// still waits for a price, so there is no tool for that.
//
// The event is ONOSENDAI's publicObjectTemplate (src/lib/published.ts at
// origin/v2 a0fe92f), which is snocrash's tag for tag: `d`, `name`, `alt`,
// one `a`/`e` tag per object the payload places (sno-core refTags), and a
// remix's credit tags (sno-core creditTags). The `client` tag is the
// signer's (nostr/event.ts attributed), as it is in ONOSENDAI. The agent is
// marked as a bot by its kind 0, which names its operator, exactly as for
// every other public event this server signs; the object carries no marker
// of its own, so readers see one kind of object whichever app made it.
//
// Pure: signing, the daily limit's file and the outbox live in agent.ts.

import { randomUUID } from 'node:crypto'
import { nip19 } from 'nostr-tools'
import { creditOf, creditTags, objectAddress, SNO_KIND } from 'sno-core/feed'
import { refTags } from 'sno-core/parts'
import { toPayload, type ShardModel } from 'sno-core/shards'
import type { EventTemplate } from './nostr/event.js'
import { withAuthoredConstrain } from './walkConstrain.js'

export { SNO_KIND }

/** The most public objects an agent may publish in any 24 hours, unless its human sets another (publishMaxPerDay). */
export const DEFAULT_PUBLISH_PER_DAY = 20
/** The longest `d` this server signs. DECK-0003 sets no limit; a workshop's id is a UUID. */
export const MAX_D_LENGTH = 128
/** The longest `alt` (description), as a sentence for a client that cannot draw the object. */
export const MAX_ALT_LENGTH = 280
/** The longest name this server signs, a bound for a row in a feed. */
export const MAX_NAME_LENGTH = 120

/** A new object's `d`: random, like a workshop's id for a new shard, never derived from anything. */
export function newObjectId(): string {
  return randomUUID()
}

/** Why a `d` is not one this server signs, or null when it is. */
export function dProblem(d: string): string | null {
  if (d.length === 0) return 'd must not be empty.'
  if (d.length > MAX_D_LENGTH) return `d must be at most ${MAX_D_LENGTH} characters; got ${d.length}.`
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(d)) return 'd must not contain control characters.'
  // A hidden object's d (agent.ts place) is 32 random hex: a public object
  // under one would replace the sealed object a bag names, and with it what
  // was found there.
  if (/^[0-9a-f]{32}$/.test(d)) return 'd must not be 32 hex characters: that shape is the id of an object this server hid, and publishing under it would replace the hidden one. Leave d out for a new object, or give the d publish_object returned.'
  return null
}

/** The alt ONOSENDAI writes when the author gave none. */
export function defaultAlt(shard: ShardModel): string {
  return `a 3D object: ${shard.name}, ${shard.vertices.length} vertices${shard.parts?.length ? `, ${shard.parts.length} placed objects` : ''}`
}

/** The event a shard goes out as, a public object (DECK-0003 3.1): ONOSENDAI's publicObjectTemplate, with the author's `d` and `alt`, and its WALK setting ("opaque" when nobody chose, #476). */
export function publicObjectTemplate(shard: ShardModel, d: string, createdAt: number, alt?: string): EventTemplate {
  const credit = creditOf(shard)
  return {
    kind: SNO_KIND,
    created_at: createdAt,
    tags: [
      ['d', d],
      ['name', shard.name],
      ['alt', alt ?? defaultAlt(shard)],
      ...refTags(shard),
      ...(credit ? creditTags(credit, { notify: true }) : []),
    ],
    content: JSON.stringify(toPayload(withAuthoredConstrain(shard))),
  }
}

/** The object's address, "33331:<pubkey>:<d>", and its naddr with relay hints. */
export function objectPointers(pubkey: string, d: string, relays: string[]): { address: string; naddr: string } {
  return {
    address: objectAddress(pubkey, d),
    naddr: nip19.naddrEncode({ kind: SNO_KIND, pubkey, identifier: d, relays: relays.slice(0, 3) }),
  }
}
