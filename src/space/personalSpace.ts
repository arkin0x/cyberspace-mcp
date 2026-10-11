// personalSpace.ts: where the agent may stand near a person, so that its
// avatar never overlaps theirs (arkinox, 2026-10-11: "the avatar is larger
// than 1 gibson, so I don't want him to be adjacent to me. avatar overlap
// feels wrong."). It replaces the rule that only kept the agent off a
// person's exact gibson (arkinox, 2026-10-11: "don't ever let the agent land
// on the exact same gibson as the user, because that is uncomfortable").
//
// How big ONOSENDAI draws an avatar, at origin/v2 1a3d87b:
//
// - The default avatar is a wireframe icosahedron of radius 0.5 render units
//   (src/scene/AvatarShape.tsx, IcosahedronGeometry(0.5, 1)), and a render
//   unit is one cell; at the 2^0 zoom a cell is one gibson, so the default
//   avatar reaches half a gibson from its center.
// - A kind 11333 shard is drawn at true scale (spec 8.10: "one model unit as
//   2^unit gibsons"), scaled by src/lib/avatar.ts avatarScale: render units
//   per model unit are 2^unit, unless the shape reaches farther than
//   MAX_AVATAR_RADIUS (4) cells on any axis, when it is shrunk to reach 4.
//   An empty shard, or one with no vertices, is drawn as the default.
// - So an avatar's half-extent on each axis, in gibsons at true scale, is
//   its reach (the largest absolute vertex coordinate on any axis, from the
//   build origin it is drawn about) times 2^unit, at most 4; the default's
//   is half a gibson. An avatar's box is the cube of that half-side around
//   its gibson's center.
//
// Two avatars do not overlap when their boxes are apart on at least one
// axis, with a gap of one gibson between them: on some axis the two centers
// are at least (the agent's half-extent + the person's half-extent + 1)
// gibsons apart,
// rounded up to whole gibsons because positions are whole gibsons. Avatars in
// different planes are never drawn together (ONOSENDAI's PresenceAvatars
// shows only the plane you are in), so they never conflict.
//
// This is true scale (the 2^0 zoom, one cell to a gibson). ONOSENDAI sizes
// an avatar in cells, so at every coarser zoom it is 2^zoom times larger in
// gibsons and every avatar nearby overlaps on screen by design; the rule
// honors true scale, where people stand beside each other. So the farthest
// apart two avatars must stand is 4 + 4 + 1 = 9 gibsons.

import { TICKS_PER_UNIT, ticksOf, type ShardModel } from 'sno-core/shards'
import { AXIS_LIMIT, distanceBetween, placeOf, type Place, type Position } from './coords.js'

/** The default avatar's radius in gibsons: ONOSENDAI's icosahedron of radius 0.5 in a one-gibson cell. */
export const DEFAULT_AVATAR_RADIUS = 0.5

/** The farthest ONOSENDAI lets a shard reach on any axis, in cells (gibsons at true scale): src/lib/avatar.ts MAX_AVATAR_RADIUS. */
export const MAX_AVATAR_REACH = 4

/** Gibsons of clear space kept between two avatars' boxes. */
export const AVATAR_GAP = 1

/**
 * How far an avatar reaches from its center on each axis, in gibsons at
 * true scale: the default's half gibson for none (or a shard with no
 * vertices, which ONOSENDAI draws as the default), else the shard's reach
 * times 2^unit, at most MAX_AVATAR_REACH, as avatarScale draws it. A shard
 * that places other objects (DECK-0003 1.10) is taken as the cap, since its
 * parts are not fetched here.
 */
export function avatarRadius(shard: ShardModel | null): number {
  if (!shard || shard.vertices.length === 0) return DEFAULT_AVATAR_RADIUS
  let reach = 0
  for (const v of shard.vertices) {
    const t = ticksOf(v)
    reach = Math.max(reach, Math.abs(t[0]), Math.abs(t[1]), Math.abs(t[2]))
  }
  const radius = Math.min((reach / TICKS_PER_UNIT) * 2 ** shard.unit, MAX_AVATAR_REACH)
  return shard.parts?.length ? MAX_AVATAR_REACH : radius
}

/** Whole gibsons two avatars' centers must be apart on some axis so their boxes, and the gap, do not overlap. */
export function spacingFor(mine: number, theirs: number): number {
  // The epsilon keeps a sum that is a whole number in exact arithmetic from rounding up past it.
  return Math.max(1, Math.ceil(mine + theirs + AVATAR_GAP - 1e-9))
}

/** A person as this rule sees them: where they stand and how far their avatar reaches. */
export interface Body {
  place: Place
  radius: number
}

const abs = (n: bigint): bigint => (n < 0n ? -n : n)
const AXES = ['x', 'y', 'z'] as const

/** Whether an agent whose avatar reaches `mine` may stand at `at` without overlapping `body`. */
export function clearOf(at: Place, body: Body, mine: number): boolean {
  if (at.plane !== body.place.plane) return true
  const need = BigInt(spacingFor(mine, body.radius))
  return AXES.some((a) => abs(at.position[a] - body.place.position[a]) >= need)
}

/** The bodies an agent standing at `at` would overlap, nearest first. */
export function overlapping<T extends Body>(at: Place, bodies: T[], mine: number): T[] {
  const cheb = (b: Body): bigint => AXES.reduce((m, a) => { const d = abs(at.position[a] - b.place.position[a]); return d > m ? d : m }, 0n)
  return bodies.filter((b) => !clearOf(at, b, mine)).sort((a, b) => { const da = cheb(a); const db = cheb(b); return da < db ? -1 : da > db ? 1 : 0 })
}

/** Rounds of pushing a candidate out of the boxes it lands in before giving up. */
const MAX_ROUNDS = 4

/**
 * The coordinate nearest `of` (same plane) that clears every body, cheapest
 * to reach from `from`: candidates are `of` pushed just outside each box it
 * falls in, one axis at a time, and pushed again when that lands in another
 * box; among the clear ones of the fewest pushes, the lowest wall from
 * `from` (the LCA height, which prices a move), then the fewest gibsons from
 * `from`, then the nearest `of`. `from` itself is the answer when it is
 * clear and no farther from `of` than the spacing: the agent already stands
 * just outside. Null when nothing within the rounds clears.
 */
export function nearestClear(of: Place, from: Place, bodies: Body[], mine: number): Place | null {
  const clear = (p: Place): boolean => bodies.every((b) => clearOf(p, b, mine))
  if (clear(of)) return of
  const blockers = overlapping(of, bodies, mine)
  const reach = BigInt(Math.max(...blockers.map((b) => spacingFor(mine, b.radius))))
  if (from.plane === of.plane && clear(from) && AXES.every((a) => abs(from.position[a] - of.position[a]) <= reach)) return from

  const seen = new Set<string>([of.hex])
  let frontier: Place[] = [of]
  for (let round = 0; round < MAX_ROUNDS && frontier.length > 0; round++) {
    const next: Place[] = []
    for (const p of frontier) {
      for (const b of overlapping(p, bodies, mine)) {
        const need = BigInt(spacingFor(mine, b.radius))
        for (const a of AXES) {
          for (const v of [b.place.position[a] + need, b.place.position[a] - need]) {
            if (v < 0n || v >= AXIS_LIMIT) continue
            const pos: Position = { ...p.position, [a]: v }
            const q = placeOf(pos, of.plane)
            if (seen.has(q.hex)) continue
            seen.add(q.hex)
            next.push(q)
          }
        }
      }
    }
    const free = next.filter(clear)
    if (free.length > 0) return free.sort(byCost(from, of))[0]
    frontier = next
  }
  return null
}

function byCost(from: Place, of: Place): (a: Place, b: Place) => number {
  const cost = (p: Place): [number, bigint, bigint] => {
    const d = distanceBetween(from, p)
    const off = AXES.reduce((s, a) => s + abs(p.position[a] - of.position[a]), 0n)
    return [d.maxLca + (d.samePlane ? 0 : 1000), d.chebyshev, off]
  }
  const cmp = (x: bigint, y: bigint): number => (x < y ? -1 : x > y ? 1 : 0)
  return (a, b) => {
    const [ha, ga, oa] = cost(a)
    const [hb, gb, ob] = cost(b)
    return ha - hb || cmp(ga, gb) || cmp(oa, ob) || (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0)
  }
}

/** The fewest gibsons on the axis that separates `at` from `body` best: how far apart they stand, for the words. */
export function apartOnBestAxis(at: Place, body: Body): bigint {
  return AXES.reduce((m, a) => { const d = abs(at.position[a] - body.place.position[a]); return d > m ? d : m }, 0n)
}
