// snoUnknownFields.test.ts: with sno-core 0.1.17 carrying fields it does not
// know, this tool still publishes only what it can validate. An agent's
// payload with an invented field is accepted, the field is left out of what
// would be signed, and the agent is told which fields were left out. And the
// refusals sno-core 0.1.17 makes are named, not a generic "refused".

import { describe, expect, it } from 'vitest'
import { validateSnoPayload } from '../src/sno.js'

const tri = { v: 2, name: 'Tri', unit: 0, mode: 'solid', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], colors: [238, 238, 238], faces: [[0, 1, 2]] }

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
