// snoUnknownFields.test.ts: with sno-core 0.1.17 carrying fields it does not
// know, this tool still publishes only what it can validate. An agent's
// payload with an invented field is accepted, the field is left out of what
// would be signed, and the agent is told which fields were left out. And the
// refusals sno-core 0.1.17 makes are named, not a generic "refused".

import { describe, expect, it } from 'vitest'
import { validateSnoPayload } from '../src/sno.js'

const tri = { v: 2, name: 'Tri', unit: 0, mode: 'solid', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], colors: [238, 238, 238], faces: [[0, 1, 2]] }

describe('placements (DECK-0003 1.9 rule 12) within the 4,096-unit position bound', () => {
  const address = `33331:${'ab'.repeat(32)}:water`
  const placed = (x: number, y: number, z: number) => validateSnoPayload({ ...tri, refs: [['a', address]], parts: [[0, x, y, z, 0, 0, 0, 0]] })

  it('accept an offset of 491520 ticks (4,096 units) on any axis, either way, and 7681 ticks, past the old 64-unit bound', () => {
    for (const at of [[491520, 0, 0], [0, -491520, 0], [0, 0, 491520], [-491520, 491520, -491520], [7681, -7681, 7681]] as Array<[number, number, number]>) {
      const v = placed(...at)
      expect(v.ok).toBe(true)
      expect(v.ok && v.payload.parts).toEqual([[0, ...at, 0, 0, 0, 0]])
    }
  })

  it('refuse an offset of 491521 ticks, one past the bound, naming the range', () => {
    for (const at of [[491521, 0, 0], [0, -491521, 0], [0, 0, 491521]] as Array<[number, number, number]>) {
      const v = placed(...at)
      expect(v.ok).toBe(false)
      expect(!v.ok && v.errors).toEqual(['part 0 must be eight integers: a refs index in range, three tick offsets in -491520..491520, three whole degrees 0..359, and a scale step (1.9 rule 12).'])
    }
  })
})

describe('fields this tool does not know', () => {
  it('are left out of the payload and named', () => {
    const v = validateSnoPayload({ ...tri, description: 'a note', blob: 'x'.repeat(40), type: 'shard' })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.ignored).toEqual(['description', 'blob'])
    expect(v.shard).not.toHaveProperty('extra')
    expect(v.payload).not.toHaveProperty('description')
    expect(v.payload).not.toHaveProperty('blob')
    expect(v.payload).not.toHaveProperty('type')
  })

  it('leave out `objects` too, which sno-core 0.1.20 knows: this tool writes no table until DECK-0003 1.10 is merged', () => {
    const address = `33331:${'ab'.repeat(32)}:water`
    const v = validateSnoPayload({ ...tri, refs: [['a', address]], parts: [[0, 0, 0, 0, 0, 0, 0, 0]], objects: { [address]: tri } })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.ignored).toEqual(['objects'])
    expect(v.shard).not.toHaveProperty('objects')
    expect(v.payload).not.toHaveProperty('objects')
  })

  it('keep a well formed `eye` (DECK-0003 1.17), and leave out a malformed one as repaired, never as unknown', () => {
    const v = validateSnoPayload({ ...tri, eye: [0, 159, -60] })
    expect(v.ok && v.ignored).toEqual([])
    expect(v.ok && v.repaired).toEqual([])
    expect(v.ok && (v.payload as unknown as Record<string, unknown>).eye).toEqual([0, 159, -60])
    // A version 1 payload's eye is read into the version 2 frame with its vertices.
    const v1 = validateSnoPayload({ ...tri, v: 1, colors: [[1, 1, 1], [1, 1, 1], [1, 1, 1]], eye: [0, 159, -60] })
    expect(v1.ok && (v1.payload as unknown as Record<string, unknown>).eye).toEqual([0, 159, 60])
    for (const eye of [[0, 159], [0, 1.5, 0], [0, 491521, 0], [-491521, 0, 0], 'up', null]) {
      const bad = validateSnoPayload({ ...tri, eye })
      expect(bad.ok && bad.repaired).toEqual(['eye'])
      expect(bad.ok && bad.ignored).toEqual([])
      expect(bad.ok && bad.payload).not.toHaveProperty('eye')
    }
  })

  it('keep an `eye` anywhere within the 4,096-unit bound (DECK-0003 1.8): 7681 ticks, once out of range, and 491520 ticks itself', () => {
    for (const eye of [[0, 7681, 0], [491520, -491520, 0]]) {
      const v = validateSnoPayload({ ...tri, eye })
      expect(v.ok && v.repaired).toEqual([])
      expect(v.ok && (v.payload as unknown as Record<string, unknown>).eye).toEqual(eye)
    }
  })

  it('keep `face` "upright" (DECK-0003 1.18), leave "path" out as the default, and a malformed one out as repaired, never as an unknown field', () => {
    const up = validateSnoPayload({ ...tri, face: 'upright' })
    expect(up.ok && up.ignored).toEqual([])
    expect(up.ok && up.repaired).toEqual([])
    expect(up.ok && (up.payload as unknown as Record<string, unknown>).face).toBe('upright')
    expect(up.ok && up.shard.extra?.face).toBe('upright')
    const path = validateSnoPayload({ ...tri, face: 'path' })
    expect(path.ok && path.repaired).toEqual([])
    expect(path.ok && path.ignored).toEqual([])
    expect(path.ok && path.payload).not.toHaveProperty('face')
    for (const face of ['Upright', 'PATH', '', '9up', 'a'.repeat(33), 'up_right', 1, true, null, ['upright']]) {
      const bad = validateSnoPayload({ ...tri, face })
      expect(bad.ok && bad.repaired).toEqual(['face'])
      expect(bad.ok && bad.ignored).toEqual([])
      expect(bad.ok && bad.unknownFace).toBeUndefined()
      expect(bad.ok && bad.payload).not.toHaveProperty('face')
    }
  })

  it('carry a `face` shaped like a mode\'s name that this version does not know, named as unknownFace, never as repaired', () => {
    for (const face of ['lean', 'sideways', 'a'.repeat(32), 'turn-2']) {
      const v = validateSnoPayload({ ...tri, face })
      expect(v.ok && v.unknownFace).toBe(face)
      expect(v.ok && v.repaired).toEqual([])
      expect(v.ok && v.ignored).toEqual([])
      expect(v.ok && (v.payload as unknown as Record<string, unknown>).face).toBe(face)
      expect(v.ok && v.shard.extra?.face).toBe(face)
    }
  })

  it('are an empty list when there are none', () => {
    const v = validateSnoPayload(tri)
    expect(v.ok && v.ignored).toEqual([])
  })
})

describe('refusals named in words', () => {
  it('a blank name', () => {
    const v = validateSnoPayload({ ...tri, name: '   ' })
    expect(v.ok).toBe(false)
    expect(!v.ok && v.errors.join(' ')).toContain('must not be blank')
  })

  it('an optional field written as null', () => {
    const v = validateSnoPayload({ ...tri, facecolors: null })
    expect(!v.ok && v.errors.join(' ')).toContain('facecolors, if present, must not be null')
  })

  it('facecolors that do not expand to one per face', () => {
    expect(validateSnoPayload({ ...tri, facecolors: [] }).ok).toBe(false)
    expect(!validateSnoPayload({ ...tri, facecolors: [] }).ok && (validateSnoPayload({ ...tri, facecolors: [] }) as { errors: string[] }).errors.join(' ')).toContain('expands to 0 entries for 1 faces')
    expect(validateSnoPayload({ ...tri, facecolors: [-1, 7] }).ok).toBe(false)
    expect(validateSnoPayload({ ...tri, facecolors: [7] }).ok).toBe(true)
  })
})
