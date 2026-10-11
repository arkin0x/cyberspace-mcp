// roam.ts: the roam companion behavior (agents plan A4; arkinox, 2026-10-11).
// While roaming is on, the agent takes a short walk every so often: the
// waker sees `roamDue` in orders_waiting once the interval has passed since
// the last roam step, starts a turn, and the model calls `roam` for a
// suggested destination, hops there, looks, and may tell its operator what
// it saw. Moving stays the model's decision; this only suggests.
//
//   - The switch, the interval and the last step are kept in the state
//     directory (roam.json), so a restart keeps roaming on the same clock.
//   - Whether a step is due is answered from memory: orders_waiting asks it
//     every poll and it never touches a relay.
//   - A suggestion is one hop from where the agent stands, in a random
//     direction, priced by the planner and within the caps. It never lands
//     on a gibson a person stands on, and it prefers h12 cubes the agent has
//     not stood in or been sent to lately (a small visited set, kept here).
//   - The search is a few dozen candidates, each priced by arithmetic, so a
//     step never makes another tool wait.

import { randomInt } from 'node:crypto'
import { AXIS_LIMIT, placeOf, type Place } from './space/coords.js'
import type { PricedStep } from './space/plan.js'
import type { StateDir } from './state/dir.js'

const FILE = 'roam.json'
/** The interval when none is given, in minutes. */
export const ROAM_DEFAULT_MINUTES = 30
/** The shortest interval, in minutes: roaming is a stroll, not a patrol. */
export const ROAM_MIN_MINUTES = 5
/** The longest interval, in minutes: a day. */
export const ROAM_MAX_MINUTES = 24 * 60
/** The cubes kept as visited, newest last. */
const VISITED_KEPT = 64
/** The height of the cube a place counts as visited by: the cube look and chat see. */
const VISIT_CUBE_HEIGHT = 12n
/** The lowest height a roam aims for first: far enough to leave the h12 cube the agent stands in. */
const ROAM_LOW_HEIGHT = 13
/** Candidates tried per height. */
const TRIES_PER_HEIGHT = 3

interface RoamFile {
  version: 1
  on: boolean
  everyMinutes: number
  /** The clock a step is due by, unix seconds: when roaming was turned on, or the last step, whichever is later. */
  since: number | null
  /** The last roam step, unix seconds. */
  lastStepAt: number | null
  /** h12 cubes stood in or suggested lately (cubeOf), newest last. */
  visited: string[]
}

const EMPTY: RoamFile = { version: 1, on: false, everyMinutes: ROAM_DEFAULT_MINUTES, since: null, lastStepAt: null, visited: [] }

/** The h12 cube a place is in, as a short key: plane and the three axis prefixes. */
export function cubeOf(p: Place): string {
  const s = VISIT_CUBE_HEIGHT
  return `${p.plane}:${(p.position.x >> s).toString(36)}:${(p.position.y >> s).toString(36)}:${(p.position.z >> s).toString(36)}`
}

export class Roam {
  private state: RoamFile

  constructor(private readonly dir: StateDir, private readonly now: () => number) {
    const saved = dir.readJson<RoamFile | null>(FILE, null)
    this.state = saved?.version === 1 ? { ...EMPTY, ...saved, visited: Array.isArray(saved.visited) ? saved.visited.slice(-VISITED_KEPT) : [] } : { ...EMPTY }
  }

  private save(): void {
    this.dir.writeJson(FILE, this.state)
  }

  get on(): boolean {
    return this.state.on
  }

  get everyMinutes(): number {
    return this.state.everyMinutes
  }

  get lastStepAt(): number | null {
    return this.state.lastStepAt
  }

  /** Turn roaming on or off and set the interval. Turning it on starts the clock now; a step is due one interval later. */
  configure(on: boolean | undefined, everyMinutes: number | undefined): void {
    if (everyMinutes !== undefined) this.state.everyMinutes = everyMinutes
    if (on !== undefined) {
      if (on && !this.state.on) this.state.since = this.now()
      this.state.on = on
    }
    this.save()
  }

  /** When the next step is due, unix seconds, or null while roaming is off. */
  dueAt(): number | null {
    if (!this.state.on) return null
    return (this.state.since ?? this.now()) + this.state.everyMinutes * 60
  }

  /** Whether a step is due now, from memory. */
  due(): boolean {
    const at = this.dueAt()
    return at !== null && this.now() >= at
  }

  /** A step was taken (or tried and found nothing that fits): the clock restarts, and these cubes count as visited. */
  markStep(places: Place[]): void {
    const at = this.now()
    this.state.lastStepAt = at
    this.state.since = at
    const keys = places.map(cubeOf)
    this.state.visited = [...this.state.visited.filter((k) => !keys.includes(k)), ...keys].slice(-VISITED_KEPT)
    this.save()
  }

  visited(): Set<string> {
    return new Set(this.state.visited)
  }
}

/** A number in [0, 1), from the system's cryptographic source. */
export function cryptoRandom(): number {
  return randomInt(2 ** 47) / 2 ** 47
}

/** A point one roam step from `from`: on one axis between 2^(h-1) and 2^h gibsons, on the others less than 2^(h-1), each way at random. Null off the edge of cyberspace. */
function randomTarget(from: Place, h: number, rng: () => number): Place | null {
  const primary = Math.min(2, Math.floor(rng() * 3))
  const half = 2 ** (h - 1)
  const move = (v: bigint, i: number): bigint | null => {
    const mag = BigInt(i === primary ? Math.max(1, half + Math.floor(rng() * half)) : Math.floor(rng() * half))
    const up = rng() < 0.5
    const there = up ? v + mag : v - mag
    if (there >= 0n && there < AXIS_LIMIT) return there
    const back = up ? v - mag : v + mag
    return back >= 0n && back < AXIS_LIMIT ? back : null
  }
  const x = move(from.position.x, 0)
  const y = move(from.position.y, 1)
  const z = move(from.position.z, 2)
  if (x === null || y === null || z === null) return null
  if (x === from.position.x && y === from.position.y && z === from.position.z) return null
  return placeOf({ x, y, z }, from.plane)
}

/**
 * Candidate destinations for one roam step, nearest the agent's reach
 * first: the heights from h13 (out of the h12 cube it stands in) up to the
 * hop ceiling, in random order, then the lower ones, highest first, a few
 * candidates each.
 */
export function* roamCandidates(from: Place, hopCeiling: number, rng: () => number = cryptoRandom): Generator<Place> {
  const top = Math.max(1, hopCeiling)
  const low = Math.min(ROAM_LOW_HEIGHT, top)
  const preferred = Array.from({ length: top - low + 1 }, (_, i) => low + i)
  for (let i = preferred.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[preferred[i], preferred[j]] = [preferred[j], preferred[i]]
  }
  const heights = [...preferred, ...Array.from({ length: low - 1 }, (_, i) => low - 1 - i)]
  for (const h of heights) {
    for (let t = 0; t < TRIES_PER_HEIGHT; t++) {
      const p = randomTarget(from, h, rng)
      if (p) yield p
    }
  }
}

export interface RoamPick {
  target: Place
  step: PricedStep
  /** Whether the target's h12 cube is one the agent has not been to lately. */
  fresh: boolean
}

export interface RoamSearch {
  pick: RoamPick | null
  /** Candidates passed over, by reason. */
  skipped: { people: number; notOneHop: number; refused: number; visited: number }
  /** The last refusal a candidate met, in the planner's words, for a search that found nothing. */
  lastRefusal: string | null
}

/**
 * The first candidate a roam step may suggest: reached by one hop that
 * lands on it, within the caps (`refusal` is the planner's and the
 * budget's), not where `blocked` says the agent's avatar would overlap a
 * person's (space/personalSpace.ts). A candidate in a visited cube is
 * kept only as a fallback, so a fresh cube wins whenever one fits.
 */
export function searchRoam(opts: {
  candidates: Iterable<Place>
  price: (target: Place) => PricedStep | null
  refusal: (step: PricedStep | null, target: Place) => string | null
  blocked: (target: Place) => boolean
  visited: Set<string>
}): RoamSearch {
  const skipped = { people: 0, notOneHop: 0, refused: 0, visited: 0 }
  let fallback: RoamPick | null = null
  let lastRefusal: string | null = null
  for (const target of opts.candidates) {
    if (opts.blocked(target)) { skipped.people++; continue }
    const step = opts.price(target)
    if (!step || step.kind !== 'hop' || step.to.hex !== target.hex) { skipped.notOneHop++; continue }
    const refused = opts.refusal(step, target)
    if (refused) { skipped.refused++; lastRefusal = refused; continue }
    if (opts.visited.has(cubeOf(target))) {
      skipped.visited++
      fallback ??= { target, step, fresh: false }
      continue
    }
    return { pick: { target, step, fresh: true }, skipped, lastRefusal }
  }
  return { pick: fallback, skipped, lastRefusal }
}
