// enter.test.ts: the entry proof against the base protocol's own arithmetic.
//
// ONOSENDAI ships enter.ts without a test, and arkinox's real boarding
// (edb4553a...) could not be found offline to serve as a vector, so the
// check here is the one DECK-0001 3.2 states in words: the entry proof is
// the temporal axis of a hop at the current coordinate with no spatial
// component. cyberspace-core computes that temporal axis for every hop
// (`computeHopProof` exposes its `cantorT`), from the same two inputs, the
// previous event id and the terrain K at the destination. A zero-length hop
// at C therefore hands us cantor_t from an implementation enter.ts does not
// share a line with, and pi(0, cantor_t) hashed twice must be the proof.
// What would fail silently without this: a seed masked to the wrong width,
// K taken at the wrong place, or the spatial term left in, each of which
// still yields a well-formed 64-hex proof.

import { describe, expect, it } from 'vitest'
import { bytesToHex, cantorPair, computeHopProof, coordToXyz, hexToCoord, intToBytesBE, sha256, terrainK } from 'cyberspace-core'
import { computeEnterProof, verifyEnterProof } from '../../src/hyperspace/enter.js'

/** Coordinates to board from: arkinox's real boarding coordinate (the c tag of ride 9c5d55cd, dataspace, on Earth), an ideaspace point, and a corner. */
const COORDS = [
  '56db6db6db6db6db6db6dba9b01afec741623cab6e88e3820241120b0cb695ea',
  'c492492492492492492492c7807ba8ecefd0a48a7b41dfbb50da5947b489ed8d',
  '0000000000000000000000000000000000000000000000000000000000000001',
]
const PREVS = ['ab'.repeat(32), '00'.repeat(32), 'edb4553ab530d68fe54c4277f94c4c08f64200c82aefed2a3145520821bf3a39']

describe('computeEnterProof (DECK-0001 3.2)', () => {
  it('is the double SHA-256 of pi(0, cantor_t), with cantor_t as cyberspace-core computes it for a hop standing still at C', () => {
    for (const hex of COORDS) {
      const coord = hexToCoord(hex)
      const { x, y, z, plane } = coordToXyz(coord)
      for (const prev of PREVS) {
        const hop = computeHopProof(x, y, z, x, y, z, plane, prev)
        expect(hop.terrainK).toBe(terrainK(x, y, z, plane))
        const want = bytesToHex(sha256(sha256(intToBytesBE(cantorPair(0n, hop.cantorT)))))
        expect(computeEnterProof(coord, prev)).toBe(want)
        // No spatial component: the hop's own proof pairs region_n in, so the
        // two coincide exactly when region_n is 0, which a hop standing still
        // reaches only at the origin (pi(pi(0, 0), 0) = 0), and nowhere else.
        expect(computeEnterProof(coord, prev) === hop.proofHash).toBe(hop.regionN === 0n)
      }
    }
  })

  it('is 64 lowercase hex, deterministic, and bound to both the coordinate and the chain position', () => {
    const a = computeEnterProof(hexToCoord(COORDS[0]), PREVS[0])
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(computeEnterProof(hexToCoord(COORDS[0]), PREVS[0])).toBe(a)
    expect(computeEnterProof(hexToCoord(COORDS[1]), PREVS[0])).not.toBe(a)
    expect(computeEnterProof(hexToCoord(COORDS[0]), PREVS[1])).not.toBe(a)
  })

  it('refuses a previous event id that is not 64 hex characters', () => {
    expect(() => computeEnterProof(hexToCoord(COORDS[0]), 'ab'.repeat(31))).toThrow(/64 hex/)
  })
})

describe('verifyEnterProof', () => {
  it('accepts the proof it computes, in either case, and nothing else', () => {
    const coord = hexToCoord(COORDS[0])
    const proof = computeEnterProof(coord, PREVS[0])
    expect(verifyEnterProof(coord, PREVS[0], proof)).toBe(true)
    expect(verifyEnterProof(coord, PREVS[0], proof.toUpperCase())).toBe(true)
    expect(verifyEnterProof(coord, PREVS[1], proof)).toBe(false)
    expect(verifyEnterProof(hexToCoord(COORDS[1]), PREVS[0], proof)).toBe(false)
    expect(verifyEnterProof(coord, PREVS[0], proof.replace(/^./, proof.startsWith('0') ? '1' : '0'))).toBe(false)
  })
})
