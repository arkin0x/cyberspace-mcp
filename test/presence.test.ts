// presence.test.ts: the 27-sector neighborhood (after ONOSENDAI's
// usePresence): the filter names the three axis tags with the sector and
// its two neighbors and nothing more (strfry takes at most three tag
// filters), and a position is in the neighborhood when it is within one
// sector on every axis.

import { describe, expect, it } from 'vitest'
import { ACTION_KIND } from '../src/chain/builder.js'
import { inNeighborhood, neighborhoodFilter, sectorKey, sectorsApart } from '../src/presence.js'

const SECTOR = 1n << 30n

describe('the neighborhood', () => {
  const here = { x: 5n * SECTOR + 7n, y: 9n * SECTOR, z: 2n * SECTOR + 1n }

  it('is one filter on the three axis tags, the sector and its neighbors each', () => {
    const f = neighborhoodFilter(here)
    expect(f.kinds).toEqual([ACTION_KIND])
    expect(f['#X']).toEqual(['4', '5', '6'])
    expect(f['#Y']).toEqual(['8', '9', '10'])
    expect(f['#Z']).toEqual(['1', '2', '3'])
    expect(Object.keys(f).filter((k) => k.startsWith('#'))).toHaveLength(3)
    expect(sectorKey(here)).toBe('5-9-2')
  })

  it('clips a sector index below zero at the edge', () => {
    const f = neighborhoodFilter({ x: 1n, y: 1n, z: 1n })
    expect(f['#X']).toEqual(['0', '1'])
  })

  it('holds positions within one sector on every axis and no others', () => {
    expect(inNeighborhood({ x: here.x + SECTOR, y: here.y - SECTOR, z: here.z }, here)).toBe(true)
    expect(inNeighborhood({ x: here.x + 2n * SECTOR, y: here.y, z: here.z }, here)).toBe(false)
    expect(sectorsApart({ x: here.x + 2n * SECTOR, y: here.y, z: here.z }, here)).toBe(2n)
    expect(sectorsApart(here, here)).toBe(0n)
  })
})
