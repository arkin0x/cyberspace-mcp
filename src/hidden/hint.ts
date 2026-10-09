// hint.ts: the hider's clue to where a bag is (spec 7.7).
//
// Ported from ONOSENDAI src/lib/hint.ts at commit 3d38de3 (branch
// feat/keys-and-chests), unchanged but for the imports.
//
// A bag says nothing about where it is. A hint is the hider's optional,
// public statement of an aligned box the bag's region lies in, one height
// per axis on one plane: ["hint", "<coord_hex of the box's base>", "<Hx>",
// "<Hy>", "<Hz>"]. A hint also fixes the sector (spec 10) of every axis
// whose height is 30 or less, so the bag then carries those X, Y, Z sector
// tags, and S when all three are fixed. A bag without a hint carries none.
// Checked against the spec's hint-reference.py golden vectors in the tests.
//
// Pure: positions in, tags out.

import { coordToXyz, hexToCoord, type Plane } from 'cyberspace-core'
import { positionHex, type Position } from '../space/coords.js'

/** Bits per axis (spec 2.1); a hint height of 85 leaves that axis open. */
export const AXIS_BITS = 85
/** A sector is 2^30 gibsons on a side (spec 10). */
export const SECTOR_HEIGHT = 30
/** One height per axis, X, Y, Z. */
export type HintHeights = [number, number, number]
/** The sector hint: heights of 30 on all three axes name exactly one sector (spec 7.7). */
export const SECTOR_HINT: HintHeights = [SECTOR_HEIGHT, SECTOR_HEIGHT, SECTOR_HEIGHT]

/** The base of the aligned run of 2^height values that contains v (spec 4.5, 7.7). */
export function alignedBase(v: bigint, height: number): bigint {
  const h = BigInt(height)
  return (v >> h) << h
}

/** Whether these heights are a legal hint for a bag at `bagHeight`: each in [bagHeight, 85] (spec 7.7). */
export function hintFits(heights: HintHeights, bagHeight: number): boolean {
  return heights.every((h) => Number.isInteger(h) && h >= bagHeight && h <= AXIS_BITS)
}

/** Whether these heights are the sector hint. */
export function isSectorHint(heights: HintHeights | null): boolean {
  return !!heights && heights.every((h) => h === SECTOR_HEIGHT)
}

/**
 * The tags a hint adds to a bag (spec 7.7, 10): the hint itself, then the
 * sector tag of every axis whose height is at most 30, then S when all three
 * are fixed. Any point inside the box may be passed; the hint always carries
 * the box's aligned base. The order matches hint-reference.py's hint_tags.
 */
export function hintTags(at: Position, plane: Plane, heights: HintHeights): string[][] {
  const [hx, hy, hz] = heights
  const base = { x: alignedBase(at.x, hx), y: alignedBase(at.y, hy), z: alignedBase(at.z, hz) }
  const tags: string[][] = [['hint', positionHex(base, plane), String(hx), String(hy), String(hz)]]
  const known: Record<string, string> = {}
  for (const [name, v, h] of [['X', base.x, hx], ['Y', base.y, hy], ['Z', base.z, hz]] as const) {
    if (h > SECTOR_HEIGHT) continue
    known[name] = (v >> BigInt(SECTOR_HEIGHT)).toString()
    tags.push([name, known[name]])
  }
  if (Object.keys(known).length === 3) tags.push(['S', `${known.X}-${known.Y}-${known.Z}`])
  return tags
}

/** A hint box read off a bag: its aligned base, its plane and its heights. */
export interface HintBox {
  base: Position
  plane: Plane
  heights: HintHeights
}

const CANONICAL_INT = /^(0|[1-9][0-9]*)$/
const HEX64 = /^[0-9a-f]{64}$/

/**
 * The hint a bag carries, or null when it carries no well-formed one (spec
 * 7.7 "Malformed hints"). A bad hint is absent, never a reason to reject the
 * bag. More than one hint tag is itself malformed.
 */
export function parseHint(tags: string[][], bagHeight: number): HintBox | null {
  const hints = tags.filter((t) => t[0] === 'hint')
  if (hints.length !== 1) return null
  const t = hints[0]
  if (t.length !== 5 || typeof t[1] !== 'string' || !HEX64.test(t[1])) return null
  if (!t.slice(2).every((s) => typeof s === 'string' && CANONICAL_INT.test(s))) return null
  const heights = t.slice(2).map(Number) as HintHeights
  if (!hintFits(heights, bagHeight)) return null
  const { x, y, z, plane } = coordToXyz(hexToCoord(t[1]))
  const base = { x, y, z }
  for (const [v, h] of [[x, heights[0]], [y, heights[1]], [z, heights[2]]] as const) {
    if (h === AXIS_BITS ? v !== 0n : alignedBase(v, h) !== v) return null
  }
  return { base, plane, heights }
}

/** Whether a tag is one a hint writes: the hint itself or a sector tag. */
export function isHintTag(t: string[]): boolean {
  return t[0] === 'hint' || t[0] === 'X' || t[0] === 'Y' || t[0] === 'Z' || t[0] === 'S'
}

/** How many regions of height h a box of height boxHeight on every axis holds, as a power of two. */
export function searchExponent(h: number, boxHeight: number): number {
  return 3 * Math.max(0, boxHeight - h)
}

/** The candidates a hinted box holds for a bag at height h: 2^(sum over axes of H - h) (spec 7.7). */
export function hintCandidatesExponent(heights: HintHeights, h: number): number {
  return heights.reduce((sum, H) => sum + Math.max(0, H - h), 0)
}
