// calibration.ts: what THIS machine can really compute, measured once.
//
// Ported from ONOSENDAI src/lib/calibration.ts at commit e793767 and
// src/workers/calibrate.worker.ts at commit 3ef4548 (branch
// feat/keys-and-chests), with the state directory in place of localStorage
// and the benchmark run inline instead of in a Web Worker.
//
// The protocol allows Cantor hops up to h20, but an h20 hop has never been
// observed to finish on real hardware. So a one-shot benchmark times real
// single-axis Cantor trees and the raw SHA-256 rate, and every price a tool
// quotes (plan_hop, hop) is projected from those timings. The ceilings
// recommended here only lower what the server voluntarily attempts; the
// hard cap stays cyberspace-core's DEFAULT_MAX_COMPUTE_HEIGHT.
//
// A hop is version 2 of the hop proof (spec 5.9, 5.10, 5.13): the same
// trees, then the residue extension, which derives m hop primes, reduces the
// roots through a product tree and a remainder tree, and grinds A re-roll
// attempts. Its price is part of every hop quote (hopSeconds). The ceiling
// rule stays as ruled (one axis tree within HOP_AXIS_BUDGET_MS; arkinox,
// 2026-10-29), so a hop at the ceiling simply costs more than it did.

import { cpus } from 'node:os'
import {
  AXIS_CENTER, computeAxisMerkleRoot, computeSubtreeCantor, deriveHopPrimes, hopAttempt, hopResidueCount, hopRerollAttempts, seedPrefix, wordAt,
  type HopCostEstimate, type SidestepCostEstimate,
} from 'cyberspace-core'
import type { StateDir } from '../state/dir.js'

/** Budget for one axis tree of a hop; a whole commit is up to three plus the temporal tree. */
const HOP_AXIS_BUDGET_MS = 5000
/** Budget for a whole sidestep. */
const SIDESTEP_BUDGET_MS = 60_000

/** Until measured: h17 finishes in seconds on modest hardware. */
const DEFAULT_HOP_HEIGHT = 17
const DEFAULT_SIDESTEP_HEIGHT = 24

/** Cantor cost per height never grows slower than this in practice. */
const GROWTH_RATIO_FLOOR = 2.5

const HOP_CEILING_MIN = 12
const HOP_CEILING_MAX = 20
const SIDESTEP_CEILING_MIN = 20
const SIDESTEP_CEILING_MAX = 40

/**
 * Projected wall-clock ms for one axis Cantor tree at height h: measured
 * heights as measured; gaps and heights above the data are log-linear
 * extrapolations at the growth ratio fitted to the top two measurements,
 * floored at GROWTH_RATIO_FLOOR. NaN with no measurements at all.
 */
export function projectCantorMs(cantorMsByHeight: Record<number, number>, h: number): number {
  const measured = cantorMsByHeight[h]
  if (measured !== undefined) return measured
  const heights = Object.keys(cantorMsByHeight).map(Number).sort((a, b) => a - b)
  if (heights.length === 0) return NaN
  const top = heights[heights.length - 1]
  let ratio = GROWTH_RATIO_FLOOR
  if (heights.length >= 2) {
    const topMs = Math.max(cantorMsByHeight[top], 0.5)
    const below = heights[heights.length - 2]
    const belowMs = Math.max(cantorMsByHeight[below], 0.5)
    const fitted = Math.pow(topMs / belowMs, 1 / (top - below))
    if (Number.isFinite(fitted)) ratio = Math.max(fitted, GROWTH_RATIO_FLOOR)
  }
  const baseH = heights.find((x) => x > h) ?? top
  const baseMs = Math.max(cantorMsByHeight[baseH], 0.5)
  return baseMs * Math.pow(ratio, h - baseH)
}

/** The largest hop height in [12, 20] whose projected single-axis time fits the budget. */
export function hopCeiling(cantorMsByHeight: Record<number, number>, budgetMs: number = HOP_AXIS_BUDGET_MS): number {
  if (Object.keys(cantorMsByHeight).length === 0) return DEFAULT_HOP_HEIGHT
  for (let h = HOP_CEILING_MAX; h > HOP_CEILING_MIN; h--) {
    if (projectCantorMs(cantorMsByHeight, h) <= budgetMs) return h
  }
  return HOP_CEILING_MIN
}

/** SHA-256 work of a single-axis sidestep at height h, in tree hashes, the re-roll price included (spec 6.10). */
export function sidestepHashes(height: number): number {
  return 2 ** (height + 1) + 2 * Math.max(1, Math.ceil(2 ** height / 8))
}

/** The largest sidestep height whose work fits the budget at the measured rate, clamped to [20, 40]. */
export function sidestepCeiling(sha256PerSec: number, budgetMs: number = SIDESTEP_BUDGET_MS): number {
  if (!Number.isFinite(sha256PerSec) || sha256PerSec <= 0) return DEFAULT_SIDESTEP_HEIGHT
  const affordable = sha256PerSec * (budgetMs / 1000)
  let h = Math.floor(Math.log2(affordable)) - 1
  if (sidestepHashes(h) > affordable) h -= 1
  return Math.min(SIDESTEP_CEILING_MAX, Math.max(SIDESTEP_CEILING_MIN, h))
}

/** The residue extension's costs on this machine (spec 5.9, 5.10), with the word kernel the prover uses (cyberspace-core's default: WASM in Node). */
export interface ResidueRates {
  /** Microseconds per hop prime (SHA-256, the small-prime sieve, the strong probable prime tests). */
  primeUs: number
  /** Microseconds per re-roll attempt (two SHA-256 blocks and a height-12 residue). */
  attemptUs: number
}

/**
 * Until measured (a calibration file from before version 2 of the hop
 * proof, or a test's): Node 22 with the WASM kernel, from the Phase 0 bench
 * (PHASE0-BROWSER-BENCH.md 3.3 and 4, cantor-verification research folder):
 * 15.3 us per attempt; a prime is about 3.7 us in Chromium's V8 and slower
 * in Node's, so 5.
 */
export const DEFAULT_RESIDUE_RATES: ResidueRates = Object.freeze({ primeUs: 5, attemptUs: 15 })

/**
 * The product tree and the remainder tree of the residue extension, as a
 * multiple of one axis Cantor tree of the hop's tallest height: the
 * remainder tree is about twice the axis tree in every engine measured
 * (Q spans a quarter of the root, as ruled), and the product tree about a
 * fifth of it (PHASE0 4, observation 1: 8.39 s and 0.99 s against a 4.62 s
 * h20 axis tree with the WASM kernel).
 */
export const RESIDUE_TREE_RATIO = 2

/**
 * Each further non-trivial tree of the hop (a second or third moving axis,
 * the temporal tree at K) is reduced modulo Q before the one descent, which
 * costs about half a tree of its height (PHASE0 3.5 and 4: reducing the root
 * modulo Q is about a quarter of the tree, and the pairing modulo Q beside it).
 */
export const RESIDUE_REDUCE_RATIO = 0.5

/** What the file stores: the raw measurements, not derived ceilings. */
export interface Calibration {
  version: 1
  /** Date.now() at measurement. */
  at: number
  fingerprint: string
  cantorMsByHeight: Record<number, number>
  sha256PerSec: number
  /** The residue extension's unit costs; DEFAULT_RESIDUE_RATES when absent. A saved file without them is measured again. */
  residue?: ResidueRates
}

/** A week keeps the numbers honest without re-running every start. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Whether a saved calibration is still good: this machine, under a week old, and every measurement present, the residue rates included. */
export function cacheValid(entry: unknown, now: number, fingerprint: string): entry is Calibration {
  if (typeof entry !== 'object' || entry === null) return false
  const e = entry as Partial<Calibration>
  if (e.version !== 1) return false
  if (e.fingerprint !== fingerprint) return false
  if (typeof e.at !== 'number' || now < e.at || now - e.at >= CACHE_TTL_MS) return false
  if (typeof e.sha256PerSec !== 'number' || !Number.isFinite(e.sha256PerSec) || e.sha256PerSec <= 0) return false
  if (typeof e.cantorMsByHeight !== 'object' || e.cantorMsByHeight === null) return false
  // A file measured before version 2 of the hop proof has no residue rates: measured again, so every quote prices the extension at this machine's speed.
  const r = e.residue
  if (typeof r !== 'object' || r === null || ![r.primeUs, r.attemptUs].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) return false
  const values = Object.values(e.cantorMsByHeight)
  if (values.length === 0) return false
  return values.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
}

/** What the cache is keyed by: cores, the CPU model, and the Node major version. */
export function fingerprint(): string {
  const list = cpus()
  return `${list.length}:${list[0]?.model ?? 'unknown'}:${process.version.split('.')[0]}`
}

/** Always measured: cheap everywhere, and enough points to fit the growth. */
const BASE_HEIGHTS = [12, 14]
/** Climbed one at a time, each step gated by the budgets below. */
const CLIMB_HEIGHTS = [15, 16, 17, 18]
const TOTAL_BUDGET_MS = 4_000
const NEXT_STEP_CAP_MS = 2_000
const GROWTH_FLOOR = 3
const BENCH_MAX_COMPUTE_HEIGHT = 22

/**
 * The benchmark: single-axis Cantor trees at increasing heights while the
 * budget allows, and the SHA-256 rate from one h17 Merkle tree. Blocks the
 * thread for a few seconds; run once, before any price is quoted.
 */
export function measure(now: number = Date.now()): Calibration {
  const cantorMsByHeight: Record<number, number> = {}
  let total = 0
  const measureOne = (h: number): void => {
    const t0 = performance.now()
    computeSubtreeCantor(AXIS_CENTER, h, BENCH_MAX_COMPUTE_HEIGHT)
    const elapsed = performance.now() - t0
    cantorMsByHeight[h] = elapsed
    total += elapsed
  }
  for (const h of BASE_HEIGHTS) measureOne(h)
  let prev = BASE_HEIGHTS[BASE_HEIGHTS.length - 2]
  let last = BASE_HEIGHTS[BASE_HEIGHTS.length - 1]
  for (const h of CLIMB_HEIGHTS) {
    if (total >= TOTAL_BUDGET_MS) break
    const msPrev = Math.max(cantorMsByHeight[prev], 0.5)
    const msLast = Math.max(cantorMsByHeight[last], 0.5)
    const perHeight = Math.max(GROWTH_FLOOR, Math.pow(msLast / msPrev, 1 / (last - prev)))
    if (msLast * Math.pow(perHeight, h - last) >= NEXT_STEP_CAP_MS) break
    measureOne(h)
    prev = last
    last = h
  }
  const SIDESTEP_HASHES = 2 ** 18 - 1
  const t0 = performance.now()
  computeAxisMerkleRoot(seedPrefix(new Uint8Array(32), 0), 0, AXIS_CENTER, AXIS_CENTER + (1n << 16n))
  const sidestepMs = Math.max(performance.now() - t0, 0.5)
  const sha256PerSec = SIDESTEP_HASHES / (sidestepMs / 1000)
  return { version: 1, at: now, fingerprint: fingerprint(), cantorMsByHeight, sha256PerSec, residue: measureResidueRates() }
}

/** Primes and attempts timed in bulk, a few tens of milliseconds in all; the same kernel the prover takes by default. */
const PRIMES_TIMED = 2048
const ATTEMPTS_TIMED = 512

/** The residue extension's unit costs here: PRIMES_TIMED hop primes and ATTEMPTS_TIMED re-roll attempts. */
export function measureResidueRates(): ResidueRates {
  const prev = new Uint8Array(32).fill(0x5a)
  let t0 = performance.now()
  const primes = deriveHopPrimes(prev, PRIMES_TIMED)
  const primeUs = Math.max(((performance.now() - t0) * 1000) / PRIMES_TIMED, 0.1)
  const p0 = wordAt(primes, 0)
  const seal = new Uint8Array(32).fill(0xa5)
  t0 = performance.now()
  for (let n = 0; n < ATTEMPTS_TIMED; n++) hopAttempt(prev, seal, BigInt(n), p0)
  const attemptUs = Math.max(((performance.now() - t0) * 1000) / ATTEMPTS_TIMED, 0.1)
  return { primeUs, attemptUs }
}

const FILE = 'calibration.json'

/** The calibration from the state directory when it is still valid, else a fresh measurement, saved. */
export function loadOrMeasure(dir: StateDir, now: number = Date.now()): { calibration: Calibration; measured: boolean } {
  const saved = dir.readJson<unknown>(FILE, null)
  if (cacheValid(saved, now, fingerprint())) return { calibration: saved, measured: false }
  const calibration = measure(now)
  dir.writeJson(FILE, calibration)
  return { calibration, measured: true }
}

/**
 * The seconds a version 2 hop is expected to take here: every non-trivial
 * axis tree and the temporal tree at K, as before, plus the residue
 * extension (hopResidueSeconds).
 */
export function hopSeconds(c: Calibration, est: HopCostEstimate): number {
  let ms = 0
  for (const h of [est.lcaX, est.lcaY, est.lcaZ]) if (h > 0) ms += projectCantorMs(c.cantorMsByHeight, h)
  if (est.terrainK > 0) ms += projectCantorMs(c.cantorMsByHeight, est.terrainK)
  return ms / 1000 + hopResidueSeconds(c, est)
}

/**
 * The residue extension's share of a hop (spec 5.9, 5.10), in seconds: m
 * primes and A attempts at the measured unit costs, where m follows from
 * h_max (the tallest of the three axis heights and K) and A from all four
 * heights exactly as the spec prices them; the product and remainder trees
 * as RESIDUE_TREE_RATIO of the tallest tree; and each further non-trivial
 * tree reduced modulo Q at RESIDUE_REDUCE_RATIO of its own.
 */
export function hopResidueSeconds(c: Calibration, est: HopCostEstimate): number {
  const rates = c.residue ?? DEFAULT_RESIDUE_RATES
  const heights = [est.lcaX, est.lcaY, est.lcaZ, est.terrainK]
  const hMax = Math.max(...heights)
  const m = Number(hopResidueCount(hMax))
  const A = Number(hopRerollAttempts(heights))
  const trees = heights.filter((h) => h > 0).sort((a, b) => b - a)
  let treeMs = 0
  if (trees.length > 0) {
    treeMs += RESIDUE_TREE_RATIO * projectCantorMs(c.cantorMsByHeight, trees[0])
    for (const h of trees.slice(1)) treeMs += RESIDUE_REDUCE_RATIO * projectCantorMs(c.cantorMsByHeight, h)
  }
  const unitMs = (m * rates.primeUs + A * rates.attemptUs) / 1000
  const ms = treeMs + unitMs
  return Number.isFinite(ms) ? ms / 1000 : NaN
}

/** The seconds a sidestep is expected to take here: the hashes of every moving axis at the measured rate, plus the temporal tree at K. */
export function sidestepSeconds(c: Calibration, est: SidestepCostEstimate, terrainK: number): number {
  let hashes = 0
  for (const h of [est.lcaX, est.lcaY, est.lcaZ]) if (h > 0) hashes += sidestepHashes(h)
  let seconds = hashes / c.sha256PerSec
  if (terrainK > 0) seconds += projectCantorMs(c.cantorMsByHeight, terrainK) / 1000
  return seconds
}
