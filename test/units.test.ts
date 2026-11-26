// units.test.ts: lengths in gibsons and in SI units (arkinox, 2026-11-26:
// XOR was asked about a distance in nanometres and could not convert it).
//
// formatDistance against figures sno-core v0.1.34's formatDistance gave for
// the same counts (the formatter ONOSENDAI shows every distance with);
// conversions both ways; unit strings, the µ, μ and u forms included, and the
// input refused; offsets with units in parseCoordinate; the conversion line
// and the distances in a real tool's answer through the MCP server.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { findLcaHeight } from 'cyberspace-core'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { afterAll, describe, expect, it } from 'vitest'
import { Agent } from '../src/agent.js'
import { bytesToHex } from '../src/nostr/event.js'
import { createServer } from '../src/server.js'
import type { Calibration } from '../src/space/calibration.js'
import { distanceBetween, distanceWords, parseCoordinate, placeFromHex, placeOf } from '../src/space/coords.js'
import { AU_METRES, GIBSONS_PER_METRE, UNITS_GUIDE, conversionWords, convertLength, distanceData, distanceText, formatDistance, unitConversions } from '../src/space/units.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork } from './fakeRelay.js'

/** sno-core v0.1.34 src/scale.ts formatDistance, run on each count (2026-11-26). */
const SNO_CORE_FIGURES: Array<[bigint, string]> = [
  [0n, '0'],
  [1n, '116 pm'],
  [2n, '233 pm'],
  [3n, '349 pm'],
  [8n, '931 pm'],
  [9n, '1.05 nm'],
  [86n, '10 nm'],
  [858n, '99.9 nm'],
  [859n, '100 nm'],
  [1718n, '200 nm'],
  [8589n, '1000 nm'],
  [8590n, '1 μm'],
  [85899n, '10 μm'],
  [858993n, '100 μm'],
  [8589934n, '1000 μm'],
  [42949673n, '5 mm'],
  [85899345n, '10 mm'],
  [858993459n, '10 cm'],
  [8589934592n, '1 m'],
  [17179869184n, '2 m'],
  [85899345920n, '10 m'],
  [8589934592000n, '1 km'],
  [8589934592000000n, '1 Mm'],
  [9007199254740992n, '1.05 Mm'],
  [9007199254740993n, '1.05 Mm'],
  [8589934592000000000n, '0.00668 AU'],
  [54726473285632000000n, '0.0426 AU'],
  [1285054214963199999999n, '1 AU'],
  [1285054214963200000000n, '1 AU'],
  [12850542149632000000000n, '10 AU'],
  [19342813113834066795298816n, '15100 AU'],
  [38685626227668133590597631n, '30100 AU'],
]

const M = GIBSONS_PER_METRE

describe('formatDistance, as ONOSENDAI shows a distance', () => {
  it('gives the figure sno-core v0.1.34 gives for every sample count, thresholds and AU included', () => {
    for (const [g, words] of SNO_CORE_FIGURES) expect(formatDistance(g), g.toString()).toBe(words)
  })

  it('uses the Greek mu, as ONOSENDAI writes micrometres', () => {
    expect(formatDistance(8590n)).toBe('1 μm')
  })

  it('says a negative count with a minus sign', () => {
    expect(formatDistance(-1718n)).toBe('-200 nm')
  })

  it('pairs gibsons with the words in data and text', () => {
    expect(distanceData(1718n)).toEqual({ gibsons: '1718', human: '200 nm' })
    expect(distanceText(1718n)).toBe('1718 gibsons (200 nm)')
    expect(distanceText(1n)).toBe('1 gibson (116 pm)')
  })
})

describe('convertLength, a length with a unit to gibsons', () => {
  const g = (s: string): bigint => convertLength(s)!.gibsons

  it('converts each unit exactly from 2^33 gibsons a metre', () => {
    expect(M).toBe(8_589_934_592n)
    expect(g('1 m')).toBe(M)
    expect(g('2 m')).toBe(1n << 34n)
    expect(g('1 km')).toBe(1000n * M)
    expect(g('1 Mm')).toBe(1_000_000n * M)
    expect(g('1 AU')).toBe(AU_METRES * M)
    expect(g('1 au')).toBe(AU_METRES * M)
    expect(g('1 cm')).toBe(85_899_346n) // 85,899,345.92
    expect(g('1 mm')).toBe(8_589_935n) // 8,589,934.592
    expect(g('1 nm')).toBe(9n) // 8.589934592
    expect(convertLength('1 m')!.exact).toBe(true)
    expect(convertLength('1 nm')!.exact).toBe(false)
  })

  it('200 nm is 1718 gibsons, and 1718 gibsons read as 200 nm', () => {
    const c = convertLength('200 nm')!
    expect(c.gibsons).toBe(1718n) // 1717.9869184
    expect(c.exact).toBe(false)
    expect(formatDistance(c.gibsons)).toBe('200 nm')
  })

  it('round-trips through what ONOSENDAI shows, for a length in each unit', () => {
    for (const s of ['349 pm', '1.05 nm', '200 nm', '1 μm', '10 μm', '5 mm', '10 cm', '1 m', '2 m', '1 km', '1 Mm', '1 AU', '10 AU']) {
      expect(formatDistance(g(s)), s).toBe(s)
    }
  })

  it('reads the micro sign, the Greek mu and a plain u alike, with or without a space', () => {
    const micro = g('1.5 µm')
    expect(micro).toBe(12_885n) // 1.5e-6 * 2^33 = 12,884.901888
    expect(g('1.5 μm')).toBe(micro)
    expect(g('1.5um')).toBe(micro)
    expect(g('1.5µm')).toBe(micro)
    expect(g('1.5 micrometres')).toBe(micro)
    expect(g('1.5 micrometers')).toBe(micro)
    expect(g('1.5 microns')).toBe(micro)
  })

  it('reads plus and minus, decimals, exponents and the names of units', () => {
    expect(g('200nm')).toBe(1718n)
    expect(g('  200   nm ')).toBe(1718n)
    expect(g('-3 m')).toBe(-3n * M)
    expect(g('+3 m')).toBe(3n * M)
    expect(g('.5 m')).toBe(M / 2n)
    expect(g('3e2 m')).toBe(300n * M)
    expect(g('2E-1 m')).toBe(g('20 cm'))
    expect(g('3 metres')).toBe(3n * M)
    expect(g('3 Meters')).toBe(3n * M)
    expect(g('1 kilometre')).toBe(1000n * M)
    expect(g('2 nanometers')).toBe(17n)
    expect(g('1 astronomical unit')).toBe(AU_METRES * M)
  })

  it('reads gibsons as a unit too, and rounds half a gibson to even', () => {
    expect(g('12 gibsons')).toBe(12n)
    expect(g('1 gibson')).toBe(1n)
    expect(g('7 G')).toBe(7n)
    expect(g('1.5 G')).toBe(2n)
    expect(g('2.5 G')).toBe(2n)
    expect(g('-2.5 G')).toBe(-2n)
    expect(g('2.6 G')).toBe(3n)
    expect(convertLength('2.5 G')!.exact).toBe(false)
  })

  it('keeps mm and Mm apart', () => {
    expect(g('1 mm')).not.toBe(g('1 Mm'))
    expect(() => convertLength('1 MM')).toThrow(/not a unit/)
  })

  it('leaves a plain whole number to the caller: a gibson count', () => {
    expect(convertLength('1718')).toBeNull()
    expect(convertLength('-12')).toBeNull()
  })

  it('refuses what is not a length, in a sentence that says how to give one', () => {
    for (const [bad, why] of [
      ['abc', /no number before the unit/],
      ['nm', /no number before the unit/],
      ['1.5', /fraction or an exponent needs a unit/],
      ['1e3', /fraction or an exponent needs a unit/],
      ['200 parsecs', /"parsecs" is not a unit/],
      ['1 2 nm', /"2 nm" is not a unit/],
      ['1 pm', /rounds to no gibson/],
      ['0.05 nm', /rounds to no gibson/],
      ['1e40 AU', /longer than an axis/],
      ['0.5 G', /half a gibson or less/],
      ['5 constructor', /"constructor" is not a unit/],
      ['5 __proto__', /"__proto__" is not a unit/],
      ['5 toString', /"toString" is not a unit/],
      ['1'.repeat(65), /too long/],
    ] as const) {
      expect(() => convertLength(bad, 'dx'), bad).toThrow(why)
      expect(() => convertLength(bad, 'dx'), bad).toThrow(/^dx: .*"200 nm", "1\.5 µm", "3 m"/)
    }
    // Zero is a length, and it is zero gibsons.
    expect(g('0 nm')).toBe(0n)
  })
})

describe('offsets with units in a coordinate', () => {
  const from = placeOf({ x: 1n << 84n, y: 1n << 84n, z: 1n << 84n }, 0)

  it('moves by the converted gibsons on each axis, a plain count as before', () => {
    const p = parseCoordinate({ dx: '200 nm', dy: '-1 μm', dz: 12 }, from)
    expect(p.position.x - from.position.x).toBe(1718n)
    expect(p.position.y - from.position.y).toBe(-8590n)
    expect(p.position.z - from.position.z).toBe(12n)
    expect(parseCoordinate({ dx: '25' }, from).position.x - from.position.x).toBe(25n)
  })

  it('refuses a fraction of a gibson with no unit, and a bad unit, in words', () => {
    expect(() => parseCoordinate({ dx: 1.5 }, from)).toThrow(/dx must be whole gibsons; for a fraction give a length with a unit/)
    expect(() => parseCoordinate({ dx: '1.5' }, from)).toThrow(/dx: a gibson count with no unit is a whole number/)
    expect(() => parseCoordinate({ dz: '3 furlongs' }, from)).toThrow(/dz: "furlongs" is not a unit/)
    expect(() => parseCoordinate({ dx: '' }, from)).toThrow(/dx must be an integer/)
  })

  it('keeps an absolute axis in whole gibsons', () => {
    expect(() => parseCoordinate({ x: '3 m', y: 0, z: 0 }, from)).toThrow(/x must be an integer/)
  })

  it('says a distance with the unit first, then the gibsons per axis', () => {
    const to = parseCoordinate({ dx: '200 nm', dy: 3 }, from)
    expect(distanceWords(distanceBetween(from, to))).toBe('200 nm (1718 gibsons east, 3 up; within the h11 cube)')
  })

  it('lists the conversions in a tool\'s arguments, and says them in a line', () => {
    const c = unitConversions({ target: { dx: '200 nm', dy: 5, dz: '3 m' }, by: { dz: '1 G' }, coordinate: '00'.repeat(32), to: { dx: 'nonsense nm' } })
    expect(c).toEqual([
      { field: 'target.dx', given: '200 nm', gibsons: '1718', exact: false, human: '200 nm' },
      { field: 'target.dz', given: '3 m', gibsons: (3n * M).toString(), exact: true, human: '3 m' },
      { field: 'by.dz', given: '1 G', gibsons: '1', exact: true, human: '116 pm' },
    ])
    expect(conversionWords(c.slice(0, 1))).toBe('Units: target.dx "200 nm" = 1718 gibsons (rounded to the nearest gibson). A gibson is 2^-33 m, about 116 pm.')
    expect(unitConversions({ target: { dx: 5 } })).toEqual([])
    expect(unitConversions({ hint: { coordinate: { dy: '2 m' }, heights: [1, 1, 1] } })).toEqual([{ field: 'hint.coordinate.dy', given: '2 m', gibsons: (2n * M).toString(), exact: true, human: '2 m' }])
  })
})

describe('the units in the MCP instructions', () => {
  it('give gibsons in each unit, figures that agree with 2^33 a metre', () => {
    const row = (unit: string): string => new RegExp(`^\\| ${unit.replace(/[()]/g, '\\$&')} \\| (.+) \\|$`, 'm').exec(UNITS_GUIDE)![1]
    const per = (metres: number): number => metres * 2 ** 33
    expect(row('pm')).toBe(per(1e-12).toFixed(7))
    expect(row('nm')).toBe(per(1e-9).toFixed(4))
    expect(row('μm')).toBe(per(1e-6).toLocaleString('en-US', { maximumFractionDigits: 1 }))
    expect(row('mm')).toBe(per(1e-3).toLocaleString('en-US', { maximumFractionDigits: 1 }))
    expect(row('m')).toBe(M.toLocaleString('en-US'))
    expect(row('km')).toBe((1000n * M).toLocaleString('en-US'))
    expect(row('AU (1.496e11 m)')).toBe((AU_METRES * M).toLocaleString('en-US'))
    expect(UNITS_GUIDE).toContain('200 nm = 200 x 8.5899 = 1,717.98, so 1,718 gibsons')
    expect(Number(convertLength('200 nm')!.gibsons)).toBe(1718)
  })
})

// ---- a real tool, through the MCP server ------------------------------------

const CANONICAL = 'wss://canonical.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }
const running: Agent[] = []
afterAll(async () => { for (const a of running) await a.stop() })

/** A key whose spawn has no tall wall within 1718 gibsons east, so the plan is one hop to the target. */
function roomyKey(): Uint8Array {
  for (;;) {
    const sk = generateSecretKey()
    const p = placeFromHex(getPublicKey(sk)).position
    if (findLcaHeight(p.x, p.x + 1718n) <= 12) return sk
  }
}

describe('plan_hop with a target 200 nm east', () => {
  it('lands on the converted gibsons, and says the conversion and the distances in gibsons and nm', async () => {
    const sk = roomyKey()
    const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-units-'))
    StateDir.open(dir)
    writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
    const network = new FakeNetwork()
    network.add(CANONICAL)
    const agent = await Agent.start({
      stateDir: dir, relays: [CANONICAL], capCallSeconds: 30, capSessionSeconds: 300, maxSidestepHeight: 24, allowRespawn: false,
      websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 500, lookupRelays: [],
    })
    running.push(agent)
    const home = placeFromHex(getPublicKey(sk))
    const server = createServer(agent)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    try {
      const r = await client.callTool({ name: 'plan_hop', arguments: { target: { dx: '200 nm' } } })
      const text = (r.content as Array<{ type: string; text: string }>).find((c) => c.type === 'text')!.text
      const data = r.structuredContent as { units: unknown[]; target: { x: string }; targetDistance: unknown; plan: { distance: unknown; targetDistance: unknown } }
      expect(text.split('\n')[0]).toBe('Units: target.dx "200 nm" = 1718 gibsons (rounded to the nearest gibson). A gibson is 2^-33 m, about 116 pm.')
      expect(data.units).toEqual([{ field: 'target.dx', given: '200 nm', gibsons: '1718', exact: false, human: '200 nm' }])
      expect(BigInt(data.target.x) - home.position.x).toBe(1718n)
      expect(data.targetDistance).toEqual({ gibsons: '1718', human: '200 nm' })
      expect(data.plan.distance).toEqual({ gibsons: '1718', human: '200 nm' })
      expect(text).toContain('covering 1718 gibsons (200 nm), landing on the target')

      const bad = await client.callTool({ name: 'plan_hop', arguments: { target: { dx: '200 parsecs' } } })
      expect(bad.isError).toBe(true)
      expect((bad.content as Array<{ text: string }>)[0].text).toMatch(/^REFUSED: dx: "parsecs" is not a unit this server knows/)
    } finally {
      await client.close()
    }
  }, 30_000)
})
