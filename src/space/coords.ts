// coords.ts: coordinates as the tools take and give them, on top of
// cyberspace-core's 256-bit interleaved form. Parsing the three input forms
// (hex, per-axis, offset), sector tags, distances, and the words for a place.
//
// sectorTags and positionHex are ported from ONOSENDAI src/lib/events.ts at
// commit 8e4d0e3 (branch feat/keys-and-chests). They live here rather than
// beside the chain resolver so that the one module that builds kind 3333
// events and the resolver that reads them do not import each other.

import {
  AXIS_BITS,
  coordToHex,
  coordToXyz,
  findLcaHeight,
  hexToCoord,
  sectorTag,
  xyzToCoord,
  xyzToSectorId,
  type Plane,
} from 'cyberspace-core'
import { HEX_64 } from '../nostr/event.js'

export interface Position {
  x: bigint
  y: bigint
  z: bigint
}

/** A place in the three forms the tools pass around. */
export interface Place {
  position: Position
  plane: Plane
  /** The 256-bit coordinate, 64 lowercase hex. */
  hex: string
}

/** The edge of an axis: 2^85 gibsons. */
export const AXIS_LIMIT = 1n << BigInt(AXIS_BITS)

/** Section 10: per-axis sector tags plus the combined one, all base-10, no padding. */
export function sectorTags(p: Position): string[][] {
  const sid = xyzToSectorId(p.x, p.y, p.z)
  return [
    ['X', sid.sx.toString()],
    ['Y', sid.sy.toString()],
    ['Z', sid.sz.toString()],
    ['S', sectorTag(sid)],
  ]
}

/** 64-char lowercase hex for a position in a plane. */
export function positionHex(p: Position, plane: Plane): string {
  return coordToHex(xyzToCoord(p.x, p.y, p.z, plane))
}

/** The S tag's value for a position. */
function sectorOf(p: Position): string {
  return sectorTag(xyzToSectorId(p.x, p.y, p.z))
}

/** A place from its 64-hex coordinate. Throws on anything else. */
export function placeFromHex(hex: string): Place {
  const h = hex.trim().toLowerCase()
  if (!HEX_64.test(h)) throw new Error(`not a coordinate: expected 64 lowercase hex characters, got ${JSON.stringify(hex)}`)
  const { x, y, z, plane } = coordToXyz(hexToCoord(h))
  return { position: { x, y, z }, plane, hex: h }
}

/** A place from axis values and a plane. Throws when an axis is outside cyberspace. */
export function placeOf(position: Position, plane: Plane): Place {
  for (const [name, v] of [['x', position.x], ['y', position.y], ['z', position.z]] as const) {
    if (v < 0n || v >= AXIS_LIMIT) throw new Error(`${name} is outside cyberspace: an axis runs from 0 to 2^85 - 1`)
  }
  return { position, plane, hex: positionHex(position, plane) }
}

/** The spawn coordinate of a public key (spec 3.1): the key itself, read as a coordinate. */
export function spawnPlace(pubkey: string): Place {
  return placeFromHex(pubkey)
}

/** What a tool may pass as a coordinate. */
export type CoordinateInput =
  | string
  | { x: string | number | bigint; y: string | number | bigint; z: string | number | bigint; plane?: number }
  | { dx?: string | number | bigint; dy?: string | number | bigint; dz?: string | number | bigint }

function toBig(v: string | number | bigint, name: string): bigint {
  try {
    if (typeof v === 'bigint') return v
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) throw new Error('not an integer')
      return BigInt(v)
    }
    const s = v.trim()
    if (!/^-?\d+$/.test(s)) throw new Error('not an integer')
    return BigInt(s)
  } catch {
    throw new Error(`${name} must be an integer, as a decimal string; got ${JSON.stringify(v)}`)
  }
}

/**
 * A coordinate from any of the three input forms: a 64-hex coordinate; an
 * object with x, y, z (decimal strings) and a plane (0 or 1); or an offset
 * dx, dy, dz from `from`, which is where the agent stands. Throws with a
 * sentence that says what was wrong.
 */
export function parseCoordinate(input: CoordinateInput, from?: Place): Place {
  if (typeof input === 'string') return placeFromHex(input)
  if (!input || typeof input !== 'object') throw new Error('a coordinate is a 64-hex string, an {x, y, z, plane} object, or a {dx, dy, dz} offset')
  const o = input as Record<string, unknown>
  if ('x' in o || 'y' in o || 'z' in o) {
    if (o.x === undefined || o.y === undefined || o.z === undefined) throw new Error('a per-axis coordinate needs x, y and z')
    const plane = o.plane === undefined ? (from?.plane ?? 1) : o.plane
    if (plane !== 0 && plane !== 1) throw new Error('plane must be 0 (dataspace) or 1 (ideaspace)')
    const axis = (v: unknown, name: string): bigint => {
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'bigint') throw new Error(`${name} must be an integer, as a decimal string`)
      return toBig(v, name)
    }
    return placeOf({ x: axis(o.x, 'x'), y: axis(o.y, 'y'), z: axis(o.z, 'z') }, plane as Plane)
  }
  if ('dx' in o || 'dy' in o || 'dz' in o) {
    if (!from) throw new Error('an offset needs a place to start from, and the agent has no position yet')
    const offset = (v: unknown, name: string): bigint => {
      if (v === undefined) return 0n
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'bigint') throw new Error(`${name} must be an integer, as a decimal string`)
      return toBig(v, name)
    }
    const dx = offset(o.dx, 'dx')
    const dy = offset(o.dy, 'dy')
    const dz = offset(o.dz, 'dz')
    return placeOf({ x: from.position.x + dx, y: from.position.y + dy, z: from.position.z + dz }, from.plane)
  }
  throw new Error('a coordinate is a 64-hex string, an {x, y, z, plane} object, or a {dx, dy, dz} offset')
}

/** The place as JSON a model can read: hex, per axis, plane and sector. */
export function describePlace(p: Place): { hex: string; x: string; y: string; z: string; plane: Plane; planeName: 'dataspace' | 'ideaspace'; sector: string } {
  return {
    hex: p.hex,
    x: p.position.x.toString(),
    y: p.position.y.toString(),
    z: p.position.z.toString(),
    plane: p.plane,
    planeName: p.plane === 0 ? 'dataspace' : 'ideaspace',
    sector: sectorOf(p.position),
  }
}

export interface Distance {
  dx: bigint
  dy: bigint
  dz: bigint
  /** The largest per-axis distance, in gibsons. */
  chebyshev: bigint
  /** The LCA height of the pair on each axis: what a move between them costs. */
  lca: { x: number; y: number; z: number }
  maxLca: number
  samePlane: boolean
}

export function distanceBetween(a: Place, b: Place): Distance {
  const dx = b.position.x - a.position.x
  const dy = b.position.y - a.position.y
  const dz = b.position.z - a.position.z
  const abs = (v: bigint): bigint => (v < 0n ? -v : v)
  const lca = {
    x: findLcaHeight(a.position.x, b.position.x),
    y: findLcaHeight(a.position.y, b.position.y),
    z: findLcaHeight(a.position.z, b.position.z),
  }
  const chebyshev = [abs(dx), abs(dy), abs(dz)].reduce((m, v) => (v > m ? v : m), 0n)
  return { dx, dy, dz, chebyshev, lca, maxLca: Math.max(lca.x, lca.y, lca.z), samePlane: a.plane === b.plane }
}

/** Whether two places share the aligned cube of height h (same plane, same base above h). */
export function sameCube(a: Place, b: Place, h: number): boolean {
  const s = BigInt(h)
  return a.plane === b.plane && a.position.x >> s === b.position.x >> s && a.position.y >> s === b.position.y >> s && a.position.z >> s === b.position.z >> s
}

/** A distance in words: "same h12 cube", "3 sectors east", "about 2^40 gibsons". */
export function distanceWords(d: Distance): string {
  if (d.chebyshev === 0n) return d.samePlane ? 'the same point' : 'the same point in the other plane'
  const dirs: string[] = []
  const axis = (v: bigint, pos: string, neg: string): void => {
    if (v === 0n) return
    const n = v < 0n ? -v : v
    dirs.push(`${n.toString()} ${v > 0n ? pos : neg}`)
  }
  axis(d.dx, 'east', 'west')
  axis(d.dy, 'up', 'down')
  axis(d.dz, 'forward', 'back')
  const h = d.maxLca
  const where = h <= 12 ? `within the h${h} cube` : h <= 30 ? `${h <= 30 ? 'the same sector' : ''}, h${h} apart` : `h${h} apart, across sectors`
  return `${dirs.join(', ')} (${where}${d.samePlane ? '' : ', other plane'})`
}
