// chat.test.ts: the pure parts of the chat room (after ONOSENDAI's
// useChatFeed and useChat): the 26 neighbor cubes and their clipping at the
// edge of cyberspace, merging lines by id in time order, and whether a line
// addresses the agent.

import { describe, expect, it } from 'vitest'
import { addressesMe, mergeLines, neighborPositions, type ChatLine } from '../src/chat.js'

const line = (id: string, at: number): ChatLine => ({ id, from: 'f'.repeat(64), text: id, at, region: 'r', height: 12, mine: false, addressed: false, heardAt: at })

describe('neighbor cubes', () => {
  it('are the 26 around an interior point, one cube of side 2^h apart', () => {
    const at = { x: 1n << 40n, y: 1n << 40n, z: 1n << 40n }
    const around = neighborPositions(at, 12)
    expect(around).toHaveLength(26)
    const side = 1n << 12n
    for (const p of around) {
      for (const [a, b] of [[p.x, at.x], [p.y, at.y], [p.z, at.z]] as const) expect([a - b].map(String)).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^(-?${side}|0)$`))]))
    }
  })

  it('are clipped at the edge of cyberspace', () => {
    expect(neighborPositions({ x: 0n, y: 0n, z: 0n }, 12)).toHaveLength(7)
    const top = (1n << 85n) - 1n
    expect(neighborPositions({ x: top, y: top, z: top }, 12)).toHaveLength(7)
  })
})

describe('merging lines', () => {
  it('keeps one line per id, newest last', () => {
    const have = [line('a', 10), line('b', 20)]
    const merged = mergeLines(have, [line('b', 20), line('c', 15)])
    expect(merged.map((l) => l.id)).toEqual(['a', 'c', 'b'])
    expect(mergeLines(have, [line('a', 10)])).toBe(have)
  })
})

describe('addressing', () => {
  const me = { pubkey: 'ab'.repeat(32), npub: 'npub1testing', name: 'ferryman' }
  it('matches the name as a whole word, the npub, and the hex pubkey', () => {
    expect(addressesMe('hello Ferryman, are you there?', me)).toBe(true)
    expect(addressesMe('hey npub1testing', me)).toBe(true)
    expect(addressesMe(`for ${'ab'.repeat(32)} only`, me)).toBe(true)
  })
  it('does not match a longer word, or anything without a name', () => {
    expect(addressesMe('the ferrymanic tide', me)).toBe(false)
    expect(addressesMe('hello everyone', me)).toBe(false)
    expect(addressesMe('hello', { ...me, name: null })).toBe(false)
  })
})
