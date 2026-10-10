// realRide.test.ts: a ride arkinox published, recomputed from Bitcoin.
//
// The gate for this port is a real event, not a synthetic one: arkinox's
// hyperjump 9c5d55cd... (2026-09-09, block 36527 to block 29898, the
// reference ride named in docs/plans/2026-10-10-hyperspace-rides.md),
// verified here the way a verifier would, from its signature to its
// openings, against block hashes rebuilt from the NTH headers-v1 blob and
// chained by proof of work. What would fail silently without it: a domain,
// byte order or seed in the port that agrees with itself and with no one
// else.
//
// Fixtures (test/hyperspace/fixtures):
// - ride-9c5d55cd.json: the kind 3333 event as published on
//   cyberspace.nostr1.com, copied from the 2026-09-28 Level 2 audit corpus
//   (/data/Sync/agents/claude/projects/cantor-verification/audit/hyperjumps.json).
//   Its id and signature are checked below, so where the copy came from
//   does not matter: it is the event, or the test fails.
// - headers-29898-36527.bin: records 29898..36527 (6630 x 48 bytes) of
//   headers-000.bin at arkin0x/nth branch headers-v1, commit e889007 (blob
//   sha256 3b1f9c41..., as its manifest states). Verified below from block
//   29897's hash to block 36527's, so every block hash the ride needs is
//   proven by the chain's own work, not trusted from a file.
//
// The ride carries no mn tag: it was published before ride openings version
// 2 and is one of the sixteen rides exempt under DECK-0001 5.8, which
// grandfathered.ts lists. So Level 1 accepts it from the list, and its
// openings are checked here under the rule it was published with: sample
// indices drawn from the root under the version 1 domain. The boarding it
// chains from, edb4553a..., could not be found offline, so only what the
// ride itself says about that boarding is pinned here.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { coordToHex, hexToBytes, sha256 } from 'cyberspace-core'
import { parseAction } from '../../src/chain/events.js'
import { checkpointState, verifyAndDerive } from '../../src/hyperspace/headers.js'
import { landfallCoord } from '../../src/hyperspace/landfall.js'
import { SAMPLES, be32, computeRideLeaf, decodeOpenings, isGrandfatheredV1Hyperjump, merkleDepth, merkleRoot, rideBlocks, verifyInclusion, verifyRideLevel1 } from '../../src/hyperspace/ride.js'
import { planeOfMerkleRoot } from '../../src/hyperspace/stops.js'
import { bytesToHex, isAuthentic, type NostrEvent } from '../../src/nostr/event.js'

/** Block hashes from the audit corpus's list (rebuilt from the same blobs, chained from genesis); the slice below re-derives them. */
const HASH_29897 = '00000000e9274b89e3d6839bcef2314b30196d75cd985c2114299db2ff2cd928'
const HASH_29898 = '00000000ecdb66f90600cfb8ae07cdfaf510eef50c809ed83f9d49e4293c1063'
const HASH_36527 = '000000006321c6bb08c71243b0262c0ee36dfdc831299e744d9e657d392d6ddf'

/** The boarding the ride names as its previous event, and the coordinate it departs from (the ride's c tag). */
const BOARDING_ID = 'edb4553ab530d68fe54c4277f94c4c08f64200c82aefed2a3145520821bf3a39'
const BOARDING_COORD = '56db6db6db6db6db6db6dba9b01afec741623cab6e88e3820241120b0cb695ea'

const FROM_HEIGHT = 36527
const TO_HEIGHT = 29898
const SLICE_START = 29898
const SLICE_COUNT = 6630

const ride = JSON.parse(readFileSync(new URL('./fixtures/ride-9c5d55cd.json', import.meta.url), 'utf8')) as NostrEvent
const tag = (name: string): string => {
  const t = ride.tags.find((t) => t[0] === name)
  if (!t) throw new Error(`the ride has no ${name} tag`)
  return t[1]
}

/** The slice verified end to end; block hashes and merkle roots by height, display order. */
function verifiedSlice(): { hashes: Map<number, string>; merkles: Map<number, string> } {
  const bytes = new Uint8Array(readFileSync(new URL('./fixtures/headers-29898-36527.bin', import.meta.url)))
  const verdict = verifyAndDerive(bytes, SLICE_START, SLICE_COUNT, checkpointState(HASH_29897), {
    finalHashHex: HASH_36527,
    embedded: new Map([[SLICE_START, HASH_29898]]),
  })
  if (!verdict.ok) throw new Error(verdict.reason)
  const hashes = new Map<number, string>()
  const merkles = new Map<number, string>()
  for (let i = 0; i < SLICE_COUNT; i++) {
    hashes.set(SLICE_START + i, bytesToHex(verdict.columns.hashes.subarray(i * 32, i * 32 + 32)))
    merkles.set(SLICE_START + i, bytesToHex(verdict.columns.merkles.subarray(i * 32, i * 32 + 32)))
  }
  return { hashes, merkles }
}

/**
 * Ride openings version 1 (DECK-0001 v3 5.5 as written): the sample indices
 * come from the root itself. The rides on the 5.8 list were published under
 * this rule, so their openings are read with it; the port's own
 * `sampleIndices` is the version 2 rule and draws from G.
 */
const SAMPLE_V1 = new TextEncoder().encode('CYBERSPACE_HYPERSPACE_SAMPLE_V1')
function v1Indices(root: Uint8Array, n: number): number[] {
  return Array.from({ length: SAMPLES }, (_, i) => {
    const digest = sha256(new Uint8Array([...SAMPLE_V1, ...root, ...be32(i)]))
    return Number(BigInt('0x' + bytesToHex(digest)) % BigInt(n))
  })
}

describe('the headers-v1 slice behind the ride', () => {
  it('verifies from block 29897 to block 36527 by linkage, proof of work and checkpoints', () => {
    const { hashes } = verifiedSlice()
    expect(hashes.size).toBe(SLICE_COUNT)
    expect(hashes.get(29898)).toBe(HASH_29898)
    expect(hashes.get(36527)).toBe(HASH_36527)
    // Every hash the ride needs is in the slice: the blocks strictly after
    // the lower endpoint through the higher one.
    for (const b of rideBlocks(FROM_HEIGHT, TO_HEIGHT)) expect(hashes.has(b)).toBe(true)
  })

  it('refuses the slice with one byte changed', () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/headers-29898-36527.bin', import.meta.url)))
    bytes[3000 * 48 + 20] ^= 0x01
    const verdict = verifyAndDerive(bytes, SLICE_START, SLICE_COUNT, checkpointState(HASH_29897), { finalHashHex: HASH_36527, embedded: new Map() })
    expect(verdict.ok).toBe(false)
  })
})

describe('arkinox ride 9c5d55cd: 36527 to 29898 under as_of 966225', () => {
  it('is authentic and reads as that hyperjump, chained from boarding edb4553a, with no mn tag', () => {
    expect(ride.id).toBe('9c5d55cd2daae92b33ce60d1e7ddcb631324c141142a08cb1b12d7f0ff6903d5')
    expect(ride.pubkey).toBe('e8ed3798c6ffebffa08501ac39e271662bfd160f688f94c45d692d8767dd345a')
    expect(isAuthentic(ride)).toBe(true)
    expect(ride.tags.some((t) => t[0] === 'mn')).toBe(false)
    const action = parseAction(ride)
    expect(action?.type).toBe('hyperjump')
    expect(action?.fromHeight).toBe(FROM_HEIGHT)
    expect(action?.toHeight).toBe(TO_HEIGHT)
    expect(action?.asOf).toBe(966225)
    expect(action?.mn).toBeUndefined()
    expect(action?.previousId).toBe(BOARDING_ID)
    // The first ride after a boarding departs from the boarding's coordinate (5.2).
    expect(action?.prevCoordHex).toBe(BOARDING_COORD)
    expect(action?.coordHex).not.toBe(BOARDING_COORD)
  })

  it('arrives at the landfall of block 29898, derived exactly', () => {
    const { merkles } = verifiedSlice()
    expect(planeOfMerkleRoot(merkles.get(TO_HEIGHT)!)).toBe(0)
    expect(coordToHex(landfallCoord(HASH_29898))).toBe(tag('C'))
  })

  it('is on the 5.8 list, so Level 1 accepts it without re-checking the root', async () => {
    expect(isGrandfatheredV1Hyperjump(ride.id)).toBe(true)
    const result = await verifyRideLevel1({
      eventId: ride.id,
      previousEventIdHex: BOARDING_ID,
      fromHeight: FROM_HEIGHT,
      toHeight: TO_HEIGHT,
      rootHex: tag('proof'),
      mp: tag('mp'),
      mn: null,
      blockHashFor: () => { throw new Error('a listed ride is not recomputed') },
    })
    expect(result).toEqual({ ok: true, checked: 0, reason: null, grandfathered: true })
  })

  it('every one of its 32 published openings recomputes from the block hashes under the version 1 sample rule', () => {
    const { hashes } = verifiedSlice()
    const blocks = rideBlocks(FROM_HEIGHT, TO_HEIGHT)
    const n = blocks.length
    expect(n).toBe(6629)
    const root = hexToBytes(tag('proof'))
    const paths = decodeOpenings(tag('mp'), merkleDepth(n))
    expect(paths).not.toBeNull()
    expect(paths!.length).toBe(SAMPLES)
    const indices = v1Indices(root, n)
    expect(indices[0]).toBe(4522)
    for (let s = 0; s < SAMPLES; s++) {
      const height = blocks[indices[s]]
      const leaf = computeRideLeaf(BOARDING_ID, height, hashes.get(height)!)
      expect(verifyInclusion(leaf, indices[s], paths![s], root), `opening ${s}, block ${height}`).toBe(true)
    }
  }, 120_000)

  // Level 2 is every leaf: about 2.8e8 Cantor pairings, a quarter of an hour
  // of Node bigint on one thread, so it runs only when asked for.
  it.runIf(process.env.HYPERSPACE_LEVEL2 === '1')('Level 2: every leaf recomputed, the root is exact', () => {
    const { hashes } = verifiedSlice()
    const leaves = rideBlocks(FROM_HEIGHT, TO_HEIGHT).map((b) => computeRideLeaf(BOARDING_ID, b, hashes.get(b)!))
    expect(bytesToHex(merkleRoot(leaves))).toBe(tag('proof'))
  }, 3_600_000)
})
