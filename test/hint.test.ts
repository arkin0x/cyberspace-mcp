// hint.test.ts: hint tags against the spec's golden vectors (section 7.7,
// produced by hint-reference.py), and the malformed-hint rules.

import { describe, expect, it } from 'vitest'
import { hintTags, parseHint, hintCandidatesExponent } from '../src/hidden/hint.js'
import { placeFromHex } from '../src/space/coords.js'

describe('hint golden vectors', () => {
  it('london_h5_box11: a cube of height 11 on plane 0 fixes all three sectors', () => {
    // The box's base is inside the box, so it stands in for the london point.
    const base = placeFromHex('c492492492492492492492edf5bee7267451c787d95ba4d7840c76d000000000')
    const tags = hintTags(base.position, base.plane, [11, 11, 11])
    expect(tags).toEqual([
      ['hint', 'c492492492492492492492edf5bee7267451c787d95ba4d7840c76d000000000', '11', '11', '11'],
      ['X', '18014398541305938'],
      ['Y', '18014398549232983'],
      ['Z', '18014398509410999'],
      ['S', '18014398541305938-18014398549232983-18014398509410999'],
    ])
    expect(hintCandidatesExponent([11, 11, 11], 5)).toBe(18)
  })

  it('london_h5_x_exact: an exact axis with two coarse ones', () => {
    const base = placeFromHex('c492492492492492492492edf5bee7267451c787d95ba4d7840c749041240000')
    const tags = hintTags(base.position, base.plane, [5, 14, 14])
    expect(tags[0]).toEqual(['hint', 'c492492492492492492492edf5bee7267451c787d95ba4d7840c749041240000', '5', '14', '14'])
    expect(tags.slice(1)).toEqual([
      ['X', '18014398541305938'],
      ['Y', '18014398549232983'],
      ['Z', '18014398509410999'],
      ['S', '18014398541305938-18014398549232983-18014398509410999'],
    ])
    expect(hintCandidatesExponent([5, 14, 14], 5)).toBe(18)
  })

  it('ideaspace_h8_y_open: an open axis gets no sector tag and no S', () => {
    const point = { x: (1n << 84n) + 12345n, y: 3n * (1n << 80n) + 777n, z: (1n << 85n) - 1n - 4242n }
    const tags = hintTags(point, 1, [12, 40, 12])
    expect(tags).toEqual([
      ['hint', 'a4b64924924924924924924924924924924924924924924924924d8000000001', '12', '40', '12'],
      ['X', '18014398509481984'],
      ['Z', '36028797018963967'],
    ])
    expect(hintCandidatesExponent([12, 40, 12], 8)).toBe(40)
    const read = parseHint(tags, 8)
    expect(read?.heights).toEqual([12, 40, 12])
    expect(read?.plane).toBe(1)
  })

  it('reads a malformed hint as absent', () => {
    expect(parseHint([['hint', 'zz', '1', '1', '1']], 1)).toBeNull()
    expect(parseHint([['hint', 'a4b64924924924924924924924924924924924924924924924924d8000000001', '12', '040', '12']], 8)).toBeNull()
    expect(parseHint([['hint', 'a4b64924924924924924924924924924924924924924924924924d8000000001', '7', '40', '12']], 8)).toBeNull()
    expect(parseHint([['hint', 'a4b64924924924924924924924924924924924924924924924924d8000000001', '12', '40', '12'], ['hint', 'a4b64924924924924924924924924924924924924924924924924d8000000001', '12', '40', '12']], 8)).toBeNull()
  })
})
