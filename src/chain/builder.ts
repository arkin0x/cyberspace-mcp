// builder.ts: the one module that writes a movement event (kind 3333).
//
// Spec 8.3 to 8.5 and 10 say exactly which tags a spawn, a hop and a
// sidestep carry, and spec 8.8 says every tag the chain rules read appears
// exactly once with a well-formed value. These builders write those tags
// from the rules and nothing else, so an agent can never hand-build one:
// every other module takes a template from here, and `kind: 3333` appears
// in this file and in no other source file of this server.
//
// The templates follow ONOSENDAI's src/lib/events.ts (commit 8e4d0e3) tag
// for tag, so an event this server signs is one ONOSENDAI would have signed.

import { coordToXyz, hexToCoord, type Plane } from 'cyberspace-core'
import { HEX_64, type EventTemplate } from '../nostr/event.js'
import { positionHex, sectorTags, type Position } from '../space/coords.js'

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

function checkLinks(i: HopInput): void {
  if (!HEX_64.test(i.genesisId)) throw new Error('a chain action needs the id of its spawn as genesis')
  if (!HEX_64.test(i.previousId)) throw new Error('a chain action needs the id of the event before it as previous')
  if (!HEX_64.test(i.prevCoordHex)) throw new Error('a chain action needs the coordinate it starts from, as the previous event\'s C')
}

/**
 * The tags the chain rules read on each action (spec 8.8), as this module
 * writes them. A template is checked against this before it is signed, so a
 * bug in a builder is caught here and never reaches a relay.
 */
const READ_TAGS: Record<'spawn' | 'hop' | 'sidestep', readonly string[]> = {
  spawn: ['A', 'C', 'X', 'Y', 'Z', 'S'],
  hop: ['A', 'e:genesis', 'e:previous', 'c', 'C', 'proof', 'X', 'Y', 'Z', 'S'],
  sidestep: ['A', 'e:genesis', 'e:previous', 'c', 'C', 'proof', 'mr', 'mp', 'mn', 'hx', 'hy', 'hz', 'X', 'Y', 'Z', 'S'],
}

function countTag(t: EventTemplate, key: string): number {
  if (!key.startsWith('e:')) return t.tags.filter((x) => x[0] === key).length
  const marker = key.slice(2)
  return t.tags.filter((x) => x[0] === 'e' && x[3] === marker).length
}

/**
 * Why a template is not a well-formed chain event, or null. Checked before
 * every signature: exactly one A tag naming a recognized action; every tag
 * the rules read exactly once with a value; the sector tags equal to the
 * ones computed from C; a spawn's C equal to the pubkey it is signed by.
 */
export function chainTemplateProblem(t: EventTemplate, pubkey: string): string | null {
  if (t.kind !== ACTION_KIND) return `kind ${t.kind} is not a chain event`
  const names = t.tags.filter((x) => x[0] === 'A').map((x) => x[1] ?? '')
  if (names.length !== 1) return `${names.length} A tags; a chain event carries exactly one`
  const name = names[0]
  if (name !== 'spawn' && name !== 'hop' && name !== 'sidestep') return `action ${JSON.stringify(name)} is not one this server builds`
  for (const key of READ_TAGS[name]) {
    const n = countTag(t, key)
    if (n !== 1) return `${key} appears ${n} times; every tag the chain rules read appears exactly once`
  }
  for (const tag of t.tags) {
    if (READ_TAGS[name].includes(tag[0]) && (tag[1] === undefined || tag[1] === '')) return `${tag[0]} has no value`
  }
  const C = t.tags.find((x) => x[0] === 'C')![1]
  if (!HEX_64.test(C)) return 'C is not a 32-byte lowercase hex coordinate'
  if (name === 'spawn' && C !== pubkey) return 'a spawn\'s C must equal the pubkey'
  const { x, y, z } = coordToXyz(hexToCoord(C))
  for (const [k, v] of sectorTags({ x, y, z })) {
    const got = t.tags.find((x) => x[0] === k)![1]
    if (got !== v) return `${k} says ${got} where C is in ${v}`
  }
  return null
}
