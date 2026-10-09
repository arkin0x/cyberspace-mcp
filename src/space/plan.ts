// plan.ts: the route from where the agent stands to a target, as steps, and
// the price of the next one.
//
// Ported from ONOSENDAI src/lib/movePlan.ts at commit 59552ed (branch
// feat/keys-and-chests): wallSource, nextAxisMove, nextStep, planSummary,
// with the HOSAKA (cloud) ceilings left out, since paid moves are not in
// v0. The pricing on top is this server's, from the calibration.
//
// One commit is one event. A sidestep is the smallest move across a wall
// (spec 6.3), so the agent has to be standing on the leaf touching the wall
// before it sidesteps, and everything between here and there is ordinary
// hops. So "go to the target" becomes: hops within the ceiling up to the
// wall, one sidestep of exactly 1 gibson across it, hops onward, repeated
// for every wall on the way. Each step is its own signed event, and `hop`
// executes the next one.

import { estimateHopCost, estimateSidestepCost, findLcaHeight, terrainK, type Plane } from 'cyberspace-core'
import { placeOf, type Place, type Position } from './coords.js'
import { hopSeconds, sidestepSeconds, type Calibration } from './calibration.js'

export type PlanStepKind = 'hop' | 'sidestep'

export interface PlanStep {
  kind: PlanStepKind
  from: Position
  to: Position
  /** Tallest per-axis LCA height of this step. */
  maxHeight: number
  heights: { x: number; y: number; z: number }
  /** Whether this machine, under its ceilings, can take it. */
  feasible: boolean
}

export interface Ceilings {
  hop: number
  sidestep: number
}

/** The leaf touching the wall on the source side, for the wall at height h between current and target (spec 6.3). */
export function wallSource(current: bigint, target: bigint, h: number): bigint {
  const hb = BigInt(h)
  const base = (current >> hb) << hb
  const half = 1n << BigInt(h - 1)
  return target > current ? base + half - 1n : base + half
}

export type AxisMove =
  | { kind: 'none' }
  | { kind: 'hop'; to: bigint; height: number }
  | { kind: 'sidestep'; to: bigint; height: number }

/**
 * The next move on one axis toward target with hops capped at ceiling: one
 * hop when the tallest boundary fits; else that boundary is a wall: the
 * sidestep across when standing on the leaf touching it, else whatever
 * brings us toward that leaf.
 */
function nextAxisMove(current: bigint, target: bigint, ceiling: number): AxisMove {
  if (current === target) return { kind: 'none' }
  const h = findLcaHeight(current, target)
  if (h <= ceiling) return { kind: 'hop', to: target, height: h }
  const wall = wallSource(current, target, h)
  if (current === wall) {
    return { kind: 'sidestep', to: target > current ? current + 1n : current - 1n, height: h }
  }
  return nextAxisMove(current, wall, ceiling)
}

/**
 * The next step of the route from cur to to. Hops move every axis that can
 * move at once; a sidestep moves exactly the axes that are standing at
 * their walls (spec 6.9) and holds the others until it is done. Null when
 * cur is to.
 */
export function nextStep(cur: Position, to: Position, c: Ceilings): PlanStep | null {
  if (c.hop < 1) throw new Error('ceiling must be at least 1')
  if (cur.x === to.x && cur.y === to.y && cur.z === to.z) return null
  const mx = nextAxisMove(cur.x, to.x, c.hop)
  const my = nextAxisMove(cur.y, to.y, c.hop)
  const mz = nextAxisMove(cur.z, to.z, c.hop)
  const crossing = mx.kind === 'sidestep' || my.kind === 'sidestep' || mz.kind === 'sidestep'
  const pick = (m: AxisMove, v: bigint): { to: bigint; h: number } => {
    if (crossing) return m.kind === 'sidestep' ? { to: m.to, h: m.height } : { to: v, h: 0 }
    return m.kind === 'hop' ? { to: m.to, h: m.height } : { to: v, h: 0 }
  }
  const px = pick(mx, cur.x)
  const py = pick(my, cur.y)
  const pz = pick(mz, cur.z)
  const kind: PlanStepKind = crossing ? 'sidestep' : 'hop'
  const maxHeight = Math.max(px.h, py.h, pz.h)
  return {
    kind,
    from: cur,
    to: { x: px.to, y: py.to, z: pz.to },
    maxHeight,
    heights: { x: px.h, y: py.h, z: pz.h },
    feasible: kind === 'hop' ? maxHeight <= c.hop : maxHeight <= c.sidestep,
  }
}

export interface PlanSummary {
  steps: number
  hops: number
  sidesteps: number
  tallestWall: number
  /** True when counting stopped at cap; steps is then a floor. */
  capped: boolean
  /** The first step nobody can take, or null when the whole route is feasible. */
  infeasibleAt: number | null
}

/** How long the route is, without keeping it. */
export function planSummary(from: Position, to: Position, c: Ceilings, cap: number = 100_000): PlanSummary {
  let hops = 0
  let sidesteps = 0
  let tallestWall = 0
  let infeasibleAt: number | null = null
  let cur: Position = { ...from }
  for (let n = 0; n < cap; n++) {
    const step = nextStep(cur, to, c)
    if (!step) return { steps: hops + sidesteps, hops, sidesteps, tallestWall, capped: false, infeasibleAt }
    if (step.kind === 'hop') hops++
    else {
      sidesteps++
      if (step.maxHeight > tallestWall) tallestWall = step.maxHeight
    }
    if (!step.feasible && infeasibleAt === null) infeasibleAt = n
    cur = step.to
  }
  return { steps: hops + sidesteps, hops, sidesteps, tallestWall, capped: true, infeasibleAt }
}

/** A step with its price on this machine. */
export interface PricedStep {
  kind: PlanStepKind
  from: Place
  to: Place
  heights: { x: number; y: number; z: number }
  maxHeight: number
  terrainK: number
  /** Expected seconds here. */
  seconds: number
  /** Cantor pairings for a hop, or SHA-256 hashes (plus re-roll attempts) for a sidestep. */
  work: number
  feasible: boolean
  /** Whether a sidestep is above the configured height cap. */
  aboveSidestepCap: boolean
}

/**
 * The next step toward `target` from `from`, priced. The step is signed in
 * the target's plane: a hop may change plane (spec 8.7.1), and the plane
 * bit is part of the terrain K at the destination.
 */
export function priceNextStep(from: Place, target: Place, c: Ceilings, cal: Calibration): PricedStep | null {
  const step = nextStep(from.position, target.position, c)
  const plane: Plane = target.plane
  if (!step) {
    if (from.plane === target.plane) return null
    // The same point in the other plane: a hop with three trivial trees and the temporal tree.
    const est = estimateHopCost(from.position.x, from.position.y, from.position.z, from.position.x, from.position.y, from.position.z, plane, c.hop)
    return {
      kind: 'hop', from, to: placeOf(from.position, plane), heights: { x: 0, y: 0, z: 0 }, maxHeight: 0, terrainK: est.terrainK,
      seconds: hopSeconds(cal, est), work: est.totalOps, feasible: true, aboveSidestepCap: false,
    }
  }
  const to = placeOf(step.to, plane)
  if (step.kind === 'hop') {
    const est = estimateHopCost(step.from.x, step.from.y, step.from.z, step.to.x, step.to.y, step.to.z, plane, c.hop)
    return {
      kind: 'hop', from, to, heights: step.heights, maxHeight: step.maxHeight, terrainK: est.terrainK,
      seconds: hopSeconds(cal, est), work: est.totalOps, feasible: step.feasible && !est.exceedsLimit, aboveSidestepCap: false,
    }
  }
  const est = estimateSidestepCost(step.from.x, step.from.y, step.from.z, step.to.x, step.to.y, step.to.z)
  const K = terrainK(step.to.x, step.to.y, step.to.z, plane)
  return {
    kind: 'sidestep', from, to, heights: step.heights, maxHeight: step.maxHeight, terrainK: K,
    seconds: sidestepSeconds(cal, est, K), work: est.totalHashes + 2 * est.attempts, feasible: step.feasible, aboveSidestepCap: step.maxHeight > c.sidestep,
  }
}
