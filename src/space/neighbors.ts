// neighbors.ts: the gibsons beside a point, for the rule that the agent
// never lands on the exact gibson a human stands on (arkinox, 2026-10-11:
// "don't ever let the agent land on the exact same gibson as the user,
// because that is uncomfortable"). A neighbor is in the same plane, one
// gibson off on one axis; when all six are taken, the ring two and then
// three gibsons off on one axis is tried.

import { AXIS_LIMIT, distanceBetween, placeOf, type Place } from './coords.js'

/** The farthest ring of single-axis offsets tried before giving up. */
const MAX_RING = 3

/** The candidates beside `of`, one axis at a time, nearest ring first; off the edge of an axis is skipped. */
function ring(of: Place, d: bigint): Place[] {
  const out: Place[] = []
  const { x, y, z } = of.position
  for (const [dx, dy, dz] of [[d, 0n, 0n], [-d, 0n, 0n], [0n, d, 0n], [0n, -d, 0n], [0n, 0n, d], [0n, 0n, -d]] as const) {
    const p = { x: x + dx, y: y + dy, z: z + dz }
    if (p.x < 0n || p.y < 0n || p.z < 0n || p.x >= AXIS_LIMIT || p.y >= AXIS_LIMIT || p.z >= AXIS_LIMIT) continue
    out.push(placeOf(p, of.plane))
  }
  return out
}

/**
 * The free gibson beside `of` that is cheapest to reach from `from`: the
 * lowest wall between them (the LCA height, which prices a move), then the
 * fewest gibsons. `taken` holds the hex coordinates someone stands on.
 * Null only when every candidate is taken.
 */
export function freeNeighbor(of: Place, from: Place, taken: Set<string>): Place | null {
  for (let d = 1n; d <= BigInt(MAX_RING); d++) {
    const free = ring(of, d).filter((p) => !taken.has(p.hex) && p.hex !== from.hex)
    // Standing beside it already is the best neighbor of all: no move.
    if (d === 1n && ring(of, d).some((p) => p.hex === from.hex)) return from
    if (free.length === 0) continue
    const cost = (p: Place): [number, bigint] => { const dist = distanceBetween(from, p); return [dist.maxLca + (dist.samePlane ? 0 : 1000), dist.chebyshev] }
    return free.sort((a, b) => { const [ha, ga] = cost(a); const [hb, gb] = cost(b); return ha - hb || (ga < gb ? -1 : ga > gb ? 1 : 0) })[0]
  }
  return null
}
