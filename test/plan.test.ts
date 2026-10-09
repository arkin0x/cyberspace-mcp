// plan.test.ts: the route as steps (after ONOSENDAI's movePlan), the price
// of a step from a synthetic calibration, and the budget's refusals.

import { describe, expect, it } from 'vitest'
import { AXIS_CENTER } from 'cyberspace-core'
import { Budget } from '../src/budget.js'
import { hopCeiling, projectCantorMs, sidestepCeiling, sidestepHashes, type Calibration } from '../src/space/calibration.js'
import { placeOf } from '../src/space/coords.js'
import { nextStep, planSummary, priceNextStep, wallSource } from '../src/space/plan.js'

const cal: Calibration = { version: 1, at: 0, fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }

describe('the route', () => {
  it('one hop reaches a target whose boundary fits the ceiling', () => {
    const from = { x: AXIS_CENTER, y: AXIS_CENTER, z: AXIS_CENTER }
    const to = { x: AXIS_CENTER + 100n, y: AXIS_CENTER, z: AXIS_CENTER }
    const step = nextStep(from, to, { hop: 17, sidestep: 24 })
    expect(step?.kind).toBe('hop')
    expect(step?.to).toEqual(to)
    expect(step?.heights.x).toBe(7)
  })

  it('a wall above the ceiling means hops to the wall leaf, then a sidestep of one gibson', () => {
    const from = { x: AXIS_CENTER + 5n, y: 1n, z: 1n }
    const to = { x: AXIS_CENTER + (1n << 20n) + 7n, y: 1n, z: 1n }
    const c = { hop: 17, sidestep: 24 }
    // Walk the route: hops (each one ending on a lower wall's leaf) until the h21 wall, then the sidestep.
    let cur = from
    let step = nextStep(cur, to, c)!
    let hops = 0
    while (step.kind === 'hop') {
      hops++
      cur = step.to
      step = nextStep(cur, to, c)!
    }
    expect(hops).toBeGreaterThan(0)
    // The first wall above the ceiling is h18: every boundary above the ceiling between here and the target is its own sidestep.
    expect(step.kind).toBe('sidestep')
    expect(step.from.x).toBe(wallSource(from.x, (AXIS_CENTER + (1n << 18n)) - 1n, 18))
    expect(step.to.x - step.from.x).toBe(1n)
    expect(step.maxHeight).toBe(18)
    const summary = planSummary(from, to, c)
    // Eight: h18, h19, h20 and h21 on the way up, and the sub-walls above the ceiling on the way to each wall leaf.
    expect(summary.sidesteps).toBe(8)
    expect(summary.tallestWall).toBe(21)
    expect(summary.infeasibleAt).toBeNull()
  })

  it('a wall above the sidestep cap is infeasible', () => {
    const from = { x: 1n, y: 1n, z: 1n }
    const to = { x: 1n << 30n, y: 1n, z: 1n }
    const summary = planSummary(from, to, { hop: 17, sidestep: 24 })
    expect(summary.infeasibleAt).not.toBeNull()
  })

  it('prices a hop from the calibration and marks a sidestep above the cap', () => {
    const from = placeOf({ x: AXIS_CENTER, y: AXIS_CENTER, z: AXIS_CENTER }, 1)
    const near = placeOf({ x: AXIS_CENTER + 100n, y: AXIS_CENTER, z: AXIS_CENTER }, 1)
    const hop = priceNextStep(from, near, { hop: 17, sidestep: 24 }, cal)!
    expect(hop.kind).toBe('hop')
    expect(hop.seconds).toBeGreaterThan(0)
    expect(hop.seconds).toBeLessThan(1)
    const far = placeOf({ x: AXIS_CENTER - 1n, y: AXIS_CENTER, z: AXIS_CENTER }, 1)
    // AXIS_CENTER is 2^84: one gibson below it is across the h85 wall, and the source is the leaf touching it.
    const side = priceNextStep(from, far, { hop: 17, sidestep: 24 }, cal)!
    expect(side.kind).toBe('sidestep')
    expect(side.maxHeight).toBe(85)
    expect(side.aboveSidestepCap).toBe(true)
    expect(side.feasible).toBe(false)
  })

  it('the same point in the other plane is a hop with trivial spatial trees', () => {
    const here = placeOf({ x: 5n, y: 5n, z: 5n }, 1)
    const other = placeOf({ x: 5n, y: 5n, z: 5n }, 0)
    const step = priceNextStep(here, other, { hop: 17, sidestep: 24 }, cal)!
    expect(step.kind).toBe('hop')
    expect(step.maxHeight).toBe(0)
    expect(step.to.plane).toBe(0)
    expect(priceNextStep(here, here, { hop: 17, sidestep: 24 }, cal)).toBeNull()
  })
})

describe('the calibration arithmetic', () => {
  it('projects, floors the growth, and derives the ceilings', () => {
    expect(projectCantorMs(cal.cantorMsByHeight, 14)).toBe(60)
    expect(projectCantorMs(cal.cantorMsByHeight, 17)).toBeGreaterThan(400 * 2.5 - 1)
    expect(hopCeiling(cal.cantorMsByHeight, 5000)).toBeGreaterThanOrEqual(16)
    expect(hopCeiling({}, 5000)).toBe(17)
    expect(sidestepCeiling(2_000_000)).toBeGreaterThanOrEqual(20)
    expect(sidestepHashes(20)).toBe(2 ** 21 + 2 * 2 ** 17)
  })
})

describe('the budget', () => {
  it('refuses above the call cap, the caller\'s cap, and the session cap', () => {
    const b = new Budget(10, 25)
    expect(b.refusal(5)).toBeNull()
    expect(b.refusal(11)).toMatch(/above the 10 s cap for one call/)
    expect(b.refusal(5, 3)).toMatch(/above the 3 s cap/)
    b.spendMove(9)
    b.spendWork(9)
    expect(b.refusal(8)).toMatch(/session has 7.0 s of its 25 s left/)
    expect(b.state().remainingSessionSeconds).toBe(7)
  })
})
