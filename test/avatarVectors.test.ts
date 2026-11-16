// avatarVectors.test.ts: the price set_avatar quotes is the spec's (spec
// 8.10 since 2026-11). fixtures/avatar-vectors.json is the spec's golden
// file, copied unchanged from arkin0x/cyberspace at 9caa0c4 (written by
// avatar-reference.py; sha256 8ba48522...0b955). Every `price` row is a
// payload this server prices through avatarPrice, as set_avatar does; every
// `bits` and `corpus` row is a reach and a detail through avatarBits, the
// function avatarWork rounds with; a corpus row's `refused` is this server's
// size check on its bytes. No network.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AVATAR_CONTENT_MAX, avatarBits } from 'cyberspace-core'
import { MAX_AVATAR_BYTES, avatarFits, avatarPrice } from '../src/avatar.js'

interface Row { reach: number; detail: number; required: number; required_before_2026_11: number }
interface Vectors {
  constants: { kind: number; floor_bits: number; size_bits: number; detail_bits: number; detail_free: number; content_max: number }
  price: Array<Row & { name: string; payload: unknown }>
  bits: Row[]
  corpus: Array<{ name: string; bytes: number; vertices: number; faces: number; reach: number; required: number; required_before_2026_11: number; refused: boolean }>
  content_limit: Array<{ bytes: number; refused: boolean }>
}

const vectors = JSON.parse(readFileSync(new URL('./fixtures/avatar-vectors.json', import.meta.url), 'utf8')) as Vectors

describe('the spec\'s avatar vectors', () => {
  it('the limit is the spec\'s', () => {
    expect(vectors.constants.content_max).toBe(AVATAR_CONTENT_MAX)
    expect(MAX_AVATAR_BYTES).toBe(vectors.constants.content_max)
  })

  it('every price row: the payload, priced as set_avatar prices it', () => {
    expect(vectors.price.length).toBeGreaterThan(0)
    for (const row of vectors.price) {
      expect({ name: row.name, bits: avatarPrice(JSON.stringify(row.payload)).bits }).toEqual({ name: row.name, bits: row.required })
      expect(row.required).toBeLessThanOrEqual(row.required_before_2026_11)
    }
  })

  it('every bits row: the reach and detail, priced', () => {
    expect(vectors.bits.length).toBeGreaterThan(0)
    for (const row of vectors.bits) expect({ ...row, got: avatarBits(row.reach, row.detail) }).toEqual({ ...row, got: row.required })
  })

  it('every corpus row: the reach and vertices plus faces priced, and refused exactly when over the limit', () => {
    expect(vectors.corpus.length).toBeGreaterThan(0)
    for (const row of vectors.corpus) {
      expect({ name: row.name, bits: avatarBits(row.reach, row.vertices + row.faces) }).toEqual({ name: row.name, bits: row.required })
      // This server refuses before mining when the payload and the nonce field's room exceed the limit; every corpus avatar the spec accepts still fits.
      expect({ name: row.name, refused: !avatarFits(row.bytes) }).toEqual({ name: row.name, refused: row.refused })
    }
  })

  it('every content_limit row: over the limit is over it here too', () => {
    for (const row of vectors.content_limit) expect(row.bytes > MAX_AVATAR_BYTES).toBe(row.refused)
  })
})
