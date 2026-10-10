// builder.ts: the one module that writes a movement event (kind 3333).
//
// Spec 8.3 to 8.5 and 10 say exactly which tags a spawn, a hop and a
// sidestep carry, DECK-0001 3.1 and 5.2 say which tags a boarding
// (enter-hyperspace) and a ride (hyperjump) carry, and spec 8.8 says every
// tag the chain rules read appears exactly once with a well-formed value.
// These builders write those tags from the rules and nothing else, so an
// agent can never hand-build one: every other module takes a template from
// here, and `kind: 3333` appears in this file and in no other source file of
// this server.
//
// The templates follow ONOSENDAI's src/lib/events.ts tag for tag, so an
// event this server signs is one ONOSENDAI would have signed: spawn, hop and
// sidestep from commit 8e4d0e3, enter-hyperspace and hyperjump from commit
// 18eded9 (branch v2). The sixteen rides of DECK-0001 5.8 all carry their
// tags in the order hyperjumpTemplate writes them, less the mn they predate
// (checked against the 2026-09-28 Level 2 audit corpus; four are fixtures).

import { coordToXyz, hexToCoord, type Plane } from 'cyberspace-core'
import { HEX_64, tagValue, type EventTemplate } from '../nostr/event.js'
import { positionHex, sectorTags, type Position } from '../space/coords.js'

/** A re-roll nonce as the mn tag carries it: an unsigned 64-bit number as exactly 16 lowercase hex characters (spec 6.10, DECK-0001 5.2). */
const MN_HEX = /^[0-9a-f]{16}$/

/** A block height as the ride tags carry it, base 10. The same test the chain reader applies (events.ts parseAction), so the builder refuses exactly what the reader would not read. */
const BLOCK_HEIGHT = /^\d+$/

/** Spec 8.1: every movement action, spawn included, is this one kind. */
export const ACTION_KIND = 3333

/**
 * Spec 8.3. The coordinate IS the pubkey, so there is nothing to choose: the
 * only input besides identity is when.
 */
export function spawnTemplate(pubkey: string, createdAt: number): EventTemplate {
  if (!HEX_64.test(pubkey)) throw new Error('a spawn needs the identity\'s 32-byte public key')
  const at = coordToXyz(hexToCoord(pubkey))
  return {
    kind: ACTION_KIND,
    created_at: createdAt,
    content: '',
    tags: [['A', 'spawn'], ['C', pubkey], ...sectorTags(at)],
  }
}

export interface HopInput {
  createdAt: number
  genesisId: string
  previousId: string
  /** Taken from the previous event's C tag, never recomputed, so the chain cannot disagree with itself about where it was. */
  prevCoordHex: string
  to: Position
  plane: Plane
  proofHash: string
}

/** Spec 8.4. */
export function hopTemplate(i: HopInput): EventTemplate {
  checkLinks(i)
  if (!HEX_64.test(i.proofHash)) throw new Error('a hop needs its 32-byte proof hash')
  return {
    kind: ACTION_KIND,
    created_at: i.createdAt,
    content: '',
    tags: [
      ['A', 'hop'],
      ['e', i.genesisId, '', 'genesis'],
      ['e', i.previousId, '', 'previous'],
      ['c', i.prevCoordHex],
      ['C', positionHex(i.to, i.plane)],
      ['proof', i.proofHash],
      ...sectorTags(i.to),
    ],
  }
}

export interface SidestepInput extends HopInput {
  /** Per-axis Merkle roots, 64 hex chars each. */
  merkleRoots: [string, string, string]
  /**
   * Per-axis openings (spec 6.10, 8.5): the destination path then the eight
   * sampled paths, every sibling leaf first, one hex string per axis; an axis
   * that did not move contributes an empty string.
   */
  openings: [string, string, string]
  /** The re-roll nonce the samples were drawn under (spec 6.10), 16 lowercase hex. */
  mnHex: string
  lcaHeights: [number, number, number]
}

/** Spec 8.5. */
export function sidestepTemplate(i: SidestepInput): EventTemplate {
  const hop = hopTemplate(i)
  if (!/^[0-9a-f]{16}$/.test(i.mnHex)) throw new Error('a sidestep needs its re-roll nonce as 16 lowercase hex characters')
  if (!i.merkleRoots.every((r) => HEX_64.test(r))) throw new Error('a sidestep needs three 32-byte Merkle roots')
  const [hx, hy, hz] = i.lcaHeights
  return {
    ...hop,
    tags: [
      ['A', 'sidestep'],
      ...hop.tags.slice(1, 6),
      ['mr', i.merkleRoots.join(':')],
      ['mp', i.openings.join(':')],
      ['mn', i.mnHex],
      ['hx', String(hx)],
      ['hy', String(hy)],
      ['hz', String(hz)],
      ...sectorTags(i.to),
    ],
  }
}

export interface EnterHyperspaceInput {
  createdAt: number
  genesisId: string
  previousId: string
  /**
   * Where the identity is standing, exactly as the chain says it: the C of
   * the last recognized action (buildChain). A boarding does not move
   * (DECK-0001 3.3), so this is both its c and its C. Taken as the hex itself,
   * never rebuilt from a position and a plane: ONOSENDAI once rebuilt it from
   * the plane lined up for the next move, which can differ from the plane the
   * identity stands in, and the boarding named a coordinate the chain never
   * reached (its boardPlane regression). The reader refuses a boarding whose
   * c and C differ, so that mistake would freeze the chain.
   */
  coordHex: string
  /** The DECK-0001 3.2 entry proof hash, computed over this same coordinate. */
  proofHash: string
}

/**
 * DECK-0001 3.1: board the line from wherever you stand. c equals C. Ported
 * from ONOSENDAI src/lib/events.ts enterHyperspaceTemplate at commit 18eded9,
 * tag for tag and in its order; the input checks are this server's.
 */
export function enterHyperspaceTemplate(i: EnterHyperspaceInput): EventTemplate {
  checkLinks({ genesisId: i.genesisId, previousId: i.previousId, prevCoordHex: i.coordHex })
  if (!HEX_64.test(i.proofHash)) throw new Error('a boarding needs its 32-byte entry proof hash')
  const here = i.coordHex
  const at = coordToXyz(hexToCoord(here))
  return {
    kind: ACTION_KIND,
    created_at: i.createdAt,
    content: '',
    tags: [
      ['A', 'enter-hyperspace'],
      ['e', i.genesisId, '', 'genesis'],
      ['e', i.previousId, '', 'previous'],
      ['c', here],
      ['C', here],
      ['proof', i.proofHash],
      ...sectorTags({ x: at.x, y: at.y, z: at.z }),
    ],
  }
}

export interface HyperjumpInput {
  createdAt: number
  genesisId: string
  previousId: string
  /** The identity's current coordinate: the boarding's coordinate on the first ride, the previous stop's after that (DECK-0001 5.2). As with a hop, taken from the chain and never recomputed. */
  prevCoordHex: string
  /** The destination stop's coordinate, already a 64-hex coord256 (DECK-0001 1). */
  toCoordHex: string
  fromHeight: number
  toHeight: number
  /**
   * The station set bound: the highest stop height considered when the
   * station was computed (DECK-0001 4.2). Required on the first ride after a
   * boarding and absent after that; the chain rules read it only there, so
   * whether to pass it is the ride runner's call, not this template's.
   */
  asOf?: number
  /** The ride's Merkle root (DECK-0001 5.4), 64 hex. */
  rootHex: string
  /** The sampled openings (DECK-0001 5.5), the SAMPLES inclusion paths joined by colons. */
  mp: string
  /** The re-roll nonce (DECK-0001 5.5), 16 lowercase hex. Every new ride carries one; only the sixteen rides of DECK-0001 5.8 were published without it. */
  mnHex: string
}

/**
 * DECK-0001 5.2: ride the line from the station (or current stop) to a
 * stop. Ported from ONOSENDAI src/lib/events.ts hyperjumpTemplate at commit
 * 18eded9, tag for tag and in its order; the input checks beyond the
 * zero-length refusal are this server's. Never a zero-length ride (arkinox,
 * 2026-10-07; DECK-0001 5.6): a destination that is the block the ride starts
 * from throws, so no path can sign one.
 */
export function hyperjumpTemplate(i: HyperjumpInput): EventTemplate {
  checkLinks(i)
  if (i.fromHeight === i.toHeight) throw new Error(`a zero-length ride (block ${i.toHeight} to itself) is never signed: a ride always goes to a different block`)
  if (!HEX_64.test(i.toCoordHex)) throw new Error('a ride needs the coordinate of the stop it goes to, as 64 lowercase hex characters')
  if (!HEX_64.test(i.rootHex)) throw new Error('a ride needs its 32-byte Merkle root')
  if (!MN_HEX.test(i.mnHex)) throw new Error('a ride needs its re-roll nonce as 16 lowercase hex characters')
  const at = coordToXyz(hexToCoord(i.toCoordHex))
  return {
    kind: ACTION_KIND,
    created_at: i.createdAt,
    content: '',
    tags: [
      ['A', 'hyperjump'],
      ['e', i.genesisId, '', 'genesis'],
      ['e', i.previousId, '', 'previous'],
      ['c', i.prevCoordHex],
      ['C', i.toCoordHex],
      ['from_height', String(i.fromHeight)],
      ['B', String(i.toHeight)],
      ...(i.asOf !== undefined ? [['as_of', String(i.asOf)]] : []),
      ['proof', i.rootHex],
      ['mp', i.mp],
      ['mn', i.mnHex],
      ...sectorTags({ x: at.x, y: at.y, z: at.z }),
    ],
  }
}

/** What every action after the spawn links to: its spawn, the event before it, and the coordinate that event left the identity at. */
interface Links {
  genesisId: string
  previousId: string
  prevCoordHex: string
}

function checkLinks(i: Links): void {
  if (!HEX_64.test(i.genesisId)) throw new Error('a chain action needs the id of its spawn as genesis')
  if (!HEX_64.test(i.previousId)) throw new Error('a chain action needs the id of the event before it as previous')
  if (!HEX_64.test(i.prevCoordHex)) throw new Error('a chain action needs the coordinate it starts from, as the previous event\'s C')
}

/** The actions this module builds. The reader (events.ts) recognizes two more, enter-virtual and exit-virtual, which no tool of this server signs. */
type BuiltAction = 'spawn' | 'hop' | 'sidestep' | 'enter-hyperspace' | 'hyperjump'

const BUILT_ACTIONS: readonly BuiltAction[] = ['spawn', 'hop', 'sidestep', 'enter-hyperspace', 'hyperjump']

/**
 * The tags the chain rules read on each action (spec 8.8, DECK-0001 8), as
 * this module writes them. A template is checked against this before it is
 * signed, so a bug in a builder is caught here and never reaches a relay.
 * A ride's as_of is not listed: the rules read it only on the first ride
 * after a boarding, which the template cannot tell from a later one, so
 * chainTemplateProblem checks it separately, at most once and well formed.
 */
const READ_TAGS: Record<BuiltAction, readonly string[]> = {
  spawn: ['A', 'C', 'X', 'Y', 'Z', 'S'],
  hop: ['A', 'e:genesis', 'e:previous', 'c', 'C', 'proof', 'X', 'Y', 'Z', 'S'],
  sidestep: ['A', 'e:genesis', 'e:previous', 'c', 'C', 'proof', 'mr', 'mp', 'mn', 'hx', 'hy', 'hz', 'X', 'Y', 'Z', 'S'],
  'enter-hyperspace': ['A', 'e:genesis', 'e:previous', 'c', 'C', 'proof', 'X', 'Y', 'Z', 'S'],
  hyperjump: ['A', 'e:genesis', 'e:previous', 'c', 'C', 'from_height', 'B', 'proof', 'mp', 'mn', 'X', 'Y', 'Z', 'S'],
}

function countTag(t: EventTemplate, key: string): number {
  if (!key.startsWith('e:')) return t.tags.filter((x) => x[0] === key).length
  const marker = key.slice(2)
  return t.tags.filter((x) => x[0] === 'e' && x[3] === marker).length
}

/**
 * Why a template is not a well-formed chain event, or null. Checked before
 * every signature: exactly one A tag naming an action this module builds;
 * every tag the rules read exactly once with a value; the sector tags equal
 * to the ones computed from C; a spawn's C equal to the pubkey it is signed
 * by; a boarding's C equal to its c; a ride's from_height, B and as_of block
 * heights in base 10, as_of at most once, B a different block from
 * from_height, and mn a 16-hex nonce. Each sentence names the one thing
 * wrong, so the log says what to fix and the relay never sees it.
 */
export function chainTemplateProblem(t: EventTemplate, pubkey: string): string | null {
  if (t.kind !== ACTION_KIND) return `kind ${t.kind} is not a chain event`
  const names = t.tags.filter((x) => x[0] === 'A').map((x) => x[1] ?? '')
  if (names.length !== 1) return `${names.length} A tags; a chain event carries exactly one`
  const name = names[0] as BuiltAction
  if (!BUILT_ACTIONS.includes(name)) return `action ${JSON.stringify(name)} is not one this server builds`
  for (const key of READ_TAGS[name]) {
    const n = countTag(t, key)
    if (n !== 1) return `${key} appears ${n} times; every tag the chain rules read appears exactly once`
  }
  for (const tag of t.tags) {
    if (READ_TAGS[name].includes(tag[0]) && (tag[1] === undefined || tag[1] === '')) return `${tag[0]} has no value`
  }
  const C = tagValue(t, 'C')!
  if (!HEX_64.test(C)) return 'C is not a 32-byte lowercase hex coordinate'
  if (name === 'spawn' && C !== pubkey) return 'a spawn\'s C must equal the pubkey'
  if (name === 'enter-hyperspace' && tagValue(t, 'c') !== C) return 'a boarding\'s C must equal its c; boarding the line does not move the identity'
  if (name === 'hyperjump') {
    const ride = rideTagsProblem(t)
    if (ride) return ride
  }
  const { x, y, z } = coordToXyz(hexToCoord(C))
  for (const [k, v] of sectorTags({ x, y, z })) {
    const got = tagValue(t, k)
    if (got !== v) return `${k} says ${got} where C is in ${v}`
  }
  return null
}

/**
 * Why a ride's own tags are malformed, or null (DECK-0001 5.2, 5.6, 8). The
 * count rules for from_height, B, mp and mn already held when this runs;
 * this reads their values, and as_of, which the count rules leave alone.
 */
function rideTagsProblem(t: EventTemplate): string | null {
  for (const key of ['from_height', 'B']) {
    if (!BLOCK_HEIGHT.test(tagValue(t, key)!)) return `${key} is not a block height in base 10`
  }
  const asOf = t.tags.filter((x) => x[0] === 'as_of')
  if (asOf.length > 1) return `as_of appears ${asOf.length} times; a first ride names its station bound exactly once`
  if (asOf.length === 1 && !BLOCK_HEIGHT.test(asOf[0][1] ?? '')) return 'as_of is not a block height in base 10'
  // Compared as integers, not strings: "0100" and "100" are the same block, and a rule about blocks holds however they are spelled.
  const from = BigInt(tagValue(t, 'from_height')!)
  const to = BigInt(tagValue(t, 'B')!)
  if (from === to) return `a zero-length ride: from_height and B are both block ${to}; a ride always goes to a different block`
  // The station is found among the blocks up to as_of, so the stop ridden to can never lie above it (DECK-0001 4.2, 5.2).
  if (asOf.length === 1 && BigInt(asOf[0][1]) < to) return `as_of (${asOf[0][1]}) is below the block the ride goes to (${to}); the station bound covers the destination`
  if (!MN_HEX.test(tagValue(t, 'mn')!)) return 'mn is not a re-roll nonce of 16 lowercase hex characters'
  return null
}
