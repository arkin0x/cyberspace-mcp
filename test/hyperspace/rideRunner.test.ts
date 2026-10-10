// rideRunner.test.ts: the ride runner over real block hashes and over the
// reference deck's synthetic line.
//
// What would fail silently without these tests: a runner that assembled
// leaves in completion order, trusted a cache from another chain position or
// a cache line someone edited, resumed the price search from the wrong
// nonce, or handed back a proof it had not checked would each produce a
// hyperjump that is internally consistent and verifies against nothing. The
// end-to-end tests close the loop through verifyRideLevel1 and through the
// one-thread buildRideProof, so the runner's bookkeeping is checked by the
// real verifier and by the reference path, never by itself.
//
// Block hashes come from two places: the verified slice
// headers-29898-36527.bin (real mainnet blocks, chosen where terrain K is
// low so a leaf costs milliseconds), and the synthetic line of DECK-0001
// decks/hyperjump-reference.py, whose 40-block ride under 'ab' x 32 has a
// known root and nonce (ONOSENDAI pins the same two values), which exercises
// a price search that has to pass nonces 0 and 1.
//
// Most tests run with threads: 0 (everything on this thread) so the budget
// cut is deterministic under a fake clock; one test runs the real
// worker_threads pool and must reach the same root.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bytesToHex, sha256 } from 'cyberspace-core'
import type { Calibration } from '../../src/space/calibration.js'
import { checkpointState, verifyAndDerive } from '../../src/hyperspace/headers.js'
import { K_LINE, be32, be64, buildRideProof, computeRideLeaf, lineTerrainK, rideBlocks, verifyRideLevel1 } from '../../src/hyperspace/ride.js'
import { leafKey, leafLineCheck } from '../../src/hyperspace/rideCache.js'
import { RideRunner, estimateRideSeconds, grindCheckpoint, planChunks, type RideProgress } from '../../src/hyperspace/rideRunner.js'

const PREV = 'ab'.repeat(32)
const OTHER_PREV = 'cd'.repeat(32)

/** Block hashes of the slice, verified by the chain's own work (as realRide.test.ts does). */
const HASHES = ((): Map<number, string> => {
  const bytes = new Uint8Array(readFileSync(new URL('./fixtures/headers-29898-36527.bin', import.meta.url)))
  const verdict = verifyAndDerive(bytes, 29898, 6630, checkpointState('00000000e9274b89e3d6839bcef2314b30196d75cd985c2114299db2ff2cd928'), {
    finalHashHex: '000000006321c6bb08c71243b0262c0ee36dfdc831299e744d9e657d392d6ddf',
    embedded: new Map(),
  })
  if (!verdict.ok) throw new Error(verdict.reason)
  const out = new Map<number, string>()
  for (let i = 0; i < 6630; i++) out.set(29898 + i, bytesToHex(verdict.columns.hashes.subarray(i * 32, i * 32 + 32)))
  return out
})()
const realHash = (height: number): string => {
  const h = HASHES.get(height)
  if (h === undefined) throw new Error(`no hash for block ${height}`)
  return h
}

/**
 * DECK-0001 decks/hyperjump-reference.py: for each height the first of
 * sha256("CYBERSPACE_TEST_BLOCK" || be64(b) || be32(j)), j = 0, 1, ..., whose
 * ride height K + 6 is at most 10, so every leaf is cheap.
 */
function syntheticHash(b: number): string {
  const domain = new TextEncoder().encode('CYBERSPACE_TEST_BLOCK')
  for (let j = 0; ; j++) {
    const hex = bytesToHex(sha256(new Uint8Array([...domain, ...be64(b), ...be32(j)])))
    if (lineTerrainK(hex) + K_LINE <= 10) return hex
  }
}

/** A clock the test drives: `stepPerRead` milliseconds pass on every read. */
function fakeClock(): { now: () => number; stepPerRead: number } {
  let t = 1000
  const clock = {
    stepPerRead: 0,
    now: () => {
      const v = t
      t += clock.stepPerRead
      return v
    },
  }
  return clock
}

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-rides-'))
  dirs.push(dir)
  return join(dir, 'rides')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Blocks 29924..29928: terrain K 6, 7, 5, 5, 6, a few milliseconds each. */
const CHEAP_FROM = 29923
const CHEAP_TO = 29928

function referenceProof(from: number, to: number, hashFor: (h: number) => string) {
  return buildRideProof(PREV, rideBlocks(from, to).map((b) => computeRideLeaf(PREV, b, hashFor(b))))
}

describe('the pieces ported from the pool', () => {
  it('splits into chunks ascending and in order, the flattened plan being the input verbatim', () => {
    const blocks = Array.from({ length: 150 }, (_, i) => ({ height: 1000 + i, blockHash: '00'.repeat(32) }))
    const chunks = planChunks(blocks)
    expect(chunks.map((c) => c.length)).toEqual([64, 64, 22])
    expect(chunks.flat()).toEqual(blocks)
    expect(planChunks([])).toEqual([])
  })

  it('the price search checkpoint is the lowest range still in flight, else the next range to hand out', () => {
    expect(grindCheckpoint([], 24)).toBe(24)
    expect(grindCheckpoint([16, 8, 32], 40)).toBe(8)
    expect(grindCheckpoint([40], 48)).toBe(40)
  })

  it('prices a ride from the calibration: more blocks cost more, more threads cost less, no calibration is NaN', () => {
    const c: Calibration = { version: 1, at: 0, fingerprint: 'test', sha256PerSec: 600_000, cantorMsByHeight: { 12: 8, 14: 32, 16: 130 } }
    const one = estimateRideSeconds(c, 1, 1)
    expect(one).toBeGreaterThan(0)
    expect(estimateRideSeconds(c, 1000, 1)).toBeGreaterThan(estimateRideSeconds(c, 100, 1))
    expect(estimateRideSeconds(c, 1000, 8)).toBeLessThan(estimateRideSeconds(c, 1000, 1))
    expect(estimateRideSeconds(c, 0, 4)).toBe(0)
    expect(Number.isNaN(estimateRideSeconds({ ...c, cantorMsByHeight: {} }, 10, 1))).toBe(true)
  })
})

describe('a ride over real blocks, on this thread', () => {
  it('computes a proof that Level 1 accepts and that equals the one-thread reference, reporting progress through every phase', async () => {
    const runner = RideRunner.open(tempDir(), { threads: 0 })
    const seen: RideProgress[] = []
    const result = await runner.run({ previousEventIdHex: PREV, fromHeight: CHEAP_FROM, toHeight: CHEAP_TO, blockHashFor: realHash }, { budgetSeconds: 60, onProgress: (p) => seen.push(p) })
    expect(result.done).toBe(true)
    if (!result.done) return
    expect(result.proof).toEqual(referenceProof(CHEAP_FROM, CHEAP_TO, realHash))
    expect(result.verification).toMatchObject({ ok: true, checked: 32, grandfathered: false })
    expect(result.workSeconds).toBeGreaterThan(0)
    const check = await verifyRideLevel1({ previousEventIdHex: PREV, fromHeight: CHEAP_FROM, toHeight: CHEAP_TO, rootHex: result.proof.rootHex, mp: result.proof.mp, mn: result.proof.mnHex, blockHashFor: realHash })
    expect(check.ok).toBe(true)
    // Posts within a phase are throttled, so a phase may report more than once; the order is what matters.
    expect(seen.map((p) => p.phase).filter((phase, i, all) => i === 0 || phase !== all[i - 1])).toEqual(['leaves', 'price', 'verify', 'done'])
    expect(seen[seen.length - 1]).toMatchObject({ leavesDone: 5, leavesTotal: 5, leavesResumed: 0, attempts: 1, attemptsExpected: 1, etaMs: 0 })
    expect(result.progress.notes).toEqual([])
  })

  it('refuses a zero-length ride, a malformed previous event id, and a block without a hash', async () => {
    const runner = RideRunner.open(tempDir(), { threads: 0 })
    await expect(runner.run({ previousEventIdHex: PREV, fromHeight: 5, toHeight: 5, blockHashFor: realHash }, { budgetSeconds: 1 })).rejects.toThrow(/zero-length/)
    await expect(runner.run({ previousEventIdHex: 'ab', fromHeight: CHEAP_FROM, toHeight: CHEAP_TO, blockHashFor: realHash }, { budgetSeconds: 1 })).rejects.toThrow(/64 lowercase hex/)
    await expect(runner.run({ previousEventIdHex: PREV, fromHeight: 1, toHeight: 2, blockHashFor: () => 'nope' }, { budgetSeconds: 1 })).rejects.toThrow(/block 2 has no 64-hex block hash/)
  })

  it('rejects with AbortError when the signal is already aborted, and refuses a second ride while one runs', async () => {
    const runner = RideRunner.open(tempDir(), { threads: 0 })
    const controller = new AbortController()
    controller.abort()
    await expect(runner.run({ previousEventIdHex: PREV, fromHeight: CHEAP_FROM, toHeight: CHEAP_TO, blockHashFor: realHash }, { budgetSeconds: 60, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    const first = runner.run({ previousEventIdHex: PREV, fromHeight: CHEAP_FROM, toHeight: CHEAP_TO, blockHashFor: realHash }, { budgetSeconds: 60 })
    await expect(runner.run({ previousEventIdHex: PREV, fromHeight: CHEAP_FROM, toHeight: CHEAP_TO, blockHashFor: realHash }, { budgetSeconds: 60 })).rejects.toThrow(/one ride at a time/)
    expect((await first).done).toBe(true)
  })
})

describe('the budget and the resume', () => {
  it('stops after the leaves the budget allows, keeps them on disk, and a later call resumes to the identical root', async () => {
    const path = tempDir()
    const clock = fakeClock()
    // Every clock read is a second; the reporter and the persister read it
    // too, so the deadline arrives after about two leaves, not exactly two.
    clock.stepPerRead = 1000
    const runner = RideRunner.open(path, { threads: 0, now: clock.now })
    const job = { previousEventIdHex: PREV, fromHeight: CHEAP_FROM, toHeight: CHEAP_TO, blockHashFor: realHash }
    const cut = await runner.run(job, { budgetSeconds: 8 })
    expect(cut.done).toBe(false)
    expect(cut.progress.phase).toBe('leaves')
    expect(cut.progress.leavesDone).toBeGreaterThan(0)
    expect(cut.progress.leavesDone).toBeLessThan(5)
    const done = cut.progress.leavesDone
    const log = readFileSync(join(path, 'leaves', `${PREV}.log`), 'utf8').trim().split('\n')
    expect(log.length).toBe(done)
    for (const line of log) expect(line).toMatch(/^\d+ [0-9a-f]{64} [0-9a-f]{8}$/)

    // A new runner, as after a restart: the cached leaves are resumed, not recomputed.
    clock.stepPerRead = 0
    const again = RideRunner.open(path, { threads: 0, now: clock.now })
    const result = await again.run(job, { budgetSeconds: 60 })
    expect(result.done).toBe(true)
    if (!result.done) return
    expect(result.progress.leavesResumed).toBe(done)
    expect(result.progress.leavesDone).toBe(5)
    expect(result.proof).toEqual(referenceProof(CHEAP_FROM, CHEAP_TO, realHash))
  })

  it('a cache from another chain position is not used: its file is another file', async () => {
    const path = tempDir()
    const runner = RideRunner.open(path, { threads: 0 })
    const first = await runner.run({ previousEventIdHex: OTHER_PREV, fromHeight: CHEAP_FROM, toHeight: CHEAP_TO, blockHashFor: realHash }, { budgetSeconds: 60 })
    expect(first.done).toBe(true)
    const result = await runner.run({ previousEventIdHex: PREV, fromHeight: CHEAP_FROM, toHeight: CHEAP_TO, blockHashFor: realHash }, { budgetSeconds: 60 })
    expect(result.done).toBe(true)
    expect(result.progress.leavesResumed).toBe(0)
    if (result.done && first.done) expect(result.proof.rootHex).not.toBe(first.proof.rootHex)
  })

  it('a tampered cache line fails its check and is recomputed, never trusted', async () => {
    const path = tempDir()
    const runner = RideRunner.open(path, { threads: 0 })
    const job = { previousEventIdHex: PREV, fromHeight: CHEAP_FROM, toHeight: CHEAP_TO, blockHashFor: realHash }
    const honest = await runner.run(job, { budgetSeconds: 60 })
    expect(honest.done).toBe(true)
    const file = join(path, 'leaves', `${PREV}.log`)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines.length).toBe(5)
    // Flip one hex digit of the third leaf; the line's check no longer holds.
    const parts = lines[2].split(' ')
    parts[1] = (parts[1][0] === '0' ? '1' : '0') + parts[1].slice(1)
    lines[2] = parts.join(' ')
    writeFileSync(file, lines.join('\n') + '\n')

    const result = await runner.run(job, { budgetSeconds: 60 })
    expect(result.done).toBe(true)
    if (!result.done) return
    expect(result.progress.leavesResumed).toBe(4)
    expect(result.progress.notes).toEqual(['1 cached leaf line(s) failed their check and were dropped; those leaves are recomputed'])
    expect(result.proof).toEqual(honest.done ? honest.proof : null)
    // The file was rewritten without the bad line and then the recomputed leaf appended.
    const after = readFileSync(file, 'utf8').trim().split('\n')
    expect(after.length).toBe(5)
    expect(new Set(after.map((l) => l.split(' ')[0])).size).toBe(5)
  })

  it('a well-formed lie in the cache (a wrong leaf with a matching check) fails the self-verification; the cache is discarded and the ride recomputed', async () => {
    // A one-block ride: every one of the 32 samples opens leaf 0, so a wrong
    // leaf 0 is caught with certainty, not with probability.
    const path = tempDir()
    const from = 29926
    const to = 29927
    const runner = RideRunner.open(path, { threads: 0 })
    const job = { previousEventIdHex: PREV, fromHeight: from, toHeight: to, blockHashFor: realHash }
    const lie = 'ee'.repeat(32)
    writeFileSync(join(path, 'leaves', `${PREV}.log`), `${to} ${lie} ${leafLineCheck(leafKey(PREV, to), lie)}\n`)

    const seen: RideProgress[] = []
    const result = await runner.run(job, { budgetSeconds: 60, onProgress: (p) => seen.push(p) })
    expect(result.done).toBe(true)
    if (!result.done) return
    expect(result.proof).toEqual(referenceProof(from, to, realHash))
    expect(result.verification.ok).toBe(true)
    expect(result.progress.notes.length).toBe(1)
    expect(result.progress.notes[0]).toMatch(/^the finished proof did not verify \(opening 0 \(block 29927\) does not verify\); the cached leaves and price search for this ride were discarded, and the ride is recomputed from scratch$/)
    // First pass resumed the lie (1 of 1), second pass computed afresh (0 resumed).
    expect(seen[0]).toMatchObject({ leavesResumed: 1, leavesDone: 1 })
    expect(result.progress).toMatchObject({ leavesResumed: 0, leavesDone: 1, phase: 'done' })
    // What is on disk now is the honest leaf.
    const cached = readFileSync(join(path, 'leaves', `${PREV}.log`), 'utf8').trim().split('\n')
    expect(cached.length).toBe(1)
    expect(cached[0].split(' ')[1]).toBe(bytesToHex(computeRideLeaf(PREV, to, realHash(to))))
  })

  it('forget drops a ride\'s leaves and price search, so the next run starts from nothing', async () => {
    const path = tempDir()
    const runner = RideRunner.open(path, { threads: 0 })
    const job = { previousEventIdHex: PREV, fromHeight: CHEAP_FROM, toHeight: CHEAP_TO, blockHashFor: realHash }
    await runner.run(job, { budgetSeconds: 60 })
    expect(JSON.stringify(JSON.parse(readFileSync(join(path, 'grind.json'), 'utf8')))).toContain(`${PREV}:`)
    runner.forget(PREV)
    expect(readFileSync(join(path, 'grind.json'), 'utf8')).not.toContain(PREV)
    const result = await runner.run(job, { budgetSeconds: 60 })
    expect(result.progress.leavesResumed).toBe(0)
  })
})

describe('the reference deck\'s 40-block ride, where the price takes more than one attempt', () => {
  const FROM = 900000
  const TO = 900040
  const ROOT = 'd3a1d8de00558e8c31018c80b24e8cbf588941829f217fd1f01c9419c5dd2930'
  const MN = '0000000000000002'

  it('lands on the known root and nonce, on this thread', async () => {
    const runner = RideRunner.open(tempDir(), { threads: 0 })
    const result = await runner.run({ previousEventIdHex: PREV, fromHeight: FROM, toHeight: TO, blockHashFor: syntheticHash }, { budgetSeconds: 60 })
    expect(result.done).toBe(true)
    if (!result.done) return
    expect(result.proof.rootHex).toBe(ROOT)
    expect(result.proof.mnHex).toBe(MN)
    expect(result.progress).toMatchObject({ attempts: 3, attemptsExpected: 2 })
    expect(result.proof).toEqual(referenceProof(FROM, TO, syntheticHash))
  })

  it('cut during the price search, the checkpoint resumes it to the same nonce', async () => {
    const path = tempDir()
    const clock = fakeClock()
    const runner = RideRunner.open(path, { threads: 0, now: clock.now })
    const job = { previousEventIdHex: PREV, fromHeight: FROM, toHeight: TO, blockHashFor: syntheticHash }
    // Leaves first, with time to spare.
    const leaves = await runner.run(job, { budgetSeconds: 60 })
    expect(leaves.done).toBe(true)
    runner.forget(PREV)
    // Now the leaves again (cheap), then a clock that runs out after the
    // first attempt or two of the price search.
    const warm = RideRunner.open(path, { threads: 0, now: clock.now })
    const seen: RideProgress[] = []
    clock.stepPerRead = 0
    const again = await warm.run(job, { budgetSeconds: 1, onProgress: (p) => { seen.push(p); if (p.phase === 'price') clock.stepPerRead = 400 } })
    expect(again.done).toBe(false)
    expect(again.progress.phase).toBe('price')
    expect(again.progress.attempts).toBeGreaterThanOrEqual(1)
    expect(again.progress.attempts).toBeLessThan(3)
    const grind = JSON.parse(readFileSync(join(path, 'grind.json'), 'utf8')) as Record<string, number>
    expect(grind[`${PREV}:${ROOT}`]).toBeGreaterThanOrEqual(1)

    clock.stepPerRead = 0
    const result = await warm.run(job, { budgetSeconds: 60 })
    expect(result.done).toBe(true)
    if (!result.done) return
    expect(result.proof.rootHex).toBe(ROOT)
    expect(result.proof.mnHex).toBe(MN)
    expect(result.progress.leavesResumed).toBe(40)
  })
})

describe('the worker pool', () => {
  it('two threads reach the same proof as the one-thread reference, over real and synthetic blocks', async () => {
    const runner = RideRunner.open(tempDir(), { threads: 2, chunkSize: 2, grindChunk: 2 })
    const real = await runner.run({ previousEventIdHex: PREV, fromHeight: CHEAP_FROM, toHeight: CHEAP_TO, blockHashFor: realHash }, { budgetSeconds: 60 })
    expect(real.done).toBe(true)
    if (real.done) expect(real.proof).toEqual(referenceProof(CHEAP_FROM, CHEAP_TO, realHash))

    const synthetic = await runner.run({ previousEventIdHex: PREV, fromHeight: 900000, toHeight: 900040, blockHashFor: syntheticHash }, { budgetSeconds: 60 })
    expect(synthetic.done).toBe(true)
    if (synthetic.done) {
      expect(synthetic.proof.rootHex).toBe('d3a1d8de00558e8c31018c80b24e8cbf588941829f217fd1f01c9419c5dd2930')
      expect(synthetic.proof.mnHex).toBe('0000000000000002')
    }
  }, 60_000)

  it('a budget that is already spent returns at once with nothing computed, and an abort mid-ride rejects while keeping what landed', async () => {
    const path = tempDir()
    const runner = RideRunner.open(path, { threads: 2, chunkSize: 1 })
    const job = { previousEventIdHex: PREV, fromHeight: 900000, toHeight: 900040, blockHashFor: syntheticHash }
    const nothing = await runner.run(job, { budgetSeconds: 0 })
    expect(nothing).toMatchObject({ done: false, progress: { phase: 'leaves', leavesDone: 0, leavesTotal: 40 } })

    const controller = new AbortController()
    const run = runner.run(job, { budgetSeconds: 60, signal: controller.signal, onProgress: (p) => { if (p.leavesDone >= 4) controller.abort() } })
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    const cached = readFileSync(join(path, 'leaves', `${PREV}.log`), 'utf8').trim().split('\n').filter(Boolean)
    expect(cached.length).toBeGreaterThanOrEqual(4)
    const result = await runner.run(job, { budgetSeconds: 60 })
    expect(result.done).toBe(true)
    expect(result.progress.leavesResumed).toBe(cached.length)
  }, 60_000)
})
