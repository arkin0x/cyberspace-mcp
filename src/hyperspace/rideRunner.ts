// rideRunner.ts: the ride computation layer over ride.ts for the server
// (DECK-0001 v3 5.7): leaves across worker threads, the Merkle root, the
// price search, the sample openings, and a Level 1 self-verification before
// a proof is handed back, all resumable from <state>/rides/ and chunked by a
// time budget per call so the server's per-call cap holds.
//
// Ported from ONOSENDAI src/lib/hyperspace/ridePool.ts at commit 8cf3354
// (branch v2): the pull queue (RIDE_CHUNK_SIZE blocks per request, a worker
// asks for the next chunk when it finishes one, because leaf cost spans 2^10
// to 2^22 pairings and a pre-partitioned pool idles behind the heavy
// stretch), planChunks, pendingBlocks, assembleLeaves, grindCheckpoint, the
// GRIND_CHUNK nonce ranges with the first hit anywhere winning, the batched
// leaf persister and the grind checkpoint written on the same cadence, the
// progress reporter with its ETA from the mean wall-clock per fresh leaf,
// the one-ride-at-a-time latch, and the pool's own semantics (a worker error
// or crash rejects, the signal rejects with AbortError). Adapted: Web Workers
// become worker_threads (rideWorker.ts) with a shared stop flag; IndexedDB
// becomes rideCache.ts; and the pool is given a deadline, at which it stops
// handing out work and returns what it has, where the original ran to the
// end or to an abort. Added: `verifyRideLevel1` over the finished proof
// before it is returned, with the ride's cache discarded and the ride
// recomputed when it fails, so a proof that does not verify is never handed
// to the builder; and `estimateRideSeconds`, the price a tool quotes before
// starting, from this server's calibration. The browser's proven-ride
// cleanup (deleteRideRows) is not automatic here: the tool calls `forget`
// once the hyperjump is signed and recorded, because a server that crashed
// between the proof and the signature would otherwise repay hours.

import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import { bytesToHex, hexToBytes } from 'cyberspace-core'
import { HEX_64 } from '../nostr/event.js'
import type { Calibration } from '../space/calibration.js'
import {
  SAMPLES,
  attemptsRequired,
  computeRideLeaf,
  expectedPricePairs,
  expectedRidePairs,
  grindAttempt,
  meetsPrice,
  rideBlocks,
  rideProofFor,
  rideTree,
  verifyRideLevel1,
  type RideProof,
  type RideVerifyResult,
} from './ride.js'
import { RideCache } from './rideCache.js'
import type { RideWorkerData, RideWorkerRequest, RideWorkerResponse } from './rideWorker.js'

export { grindKey, leafKey } from './rideCache.js'

export interface RideJob {
  /** 64 hex; the chain head the ride departs from. Every leaf is seeded by it (5.3). */
  previousEventIdHex: string
  fromHeight: number
  toHeight: number
  /** The block hash for a height the ride passes, 64 lowercase hex: the line's `blockHash`. */
  blockHashFor: (height: number) => string
}

export type RidePhase = 'leaves' | 'price' | 'verify' | 'done'

export interface RideProgress {
  phase: RidePhase
  /** Leaves in hand, of the ride's total; `leavesResumed` of them came from the cache, not this call. */
  leavesDone: number
  leavesTotal: number
  leavesResumed: number
  /** Price attempts tried so far and A, the expected count (5.5). Each attempt succeeds with probability 1/A, so a run can pass A. */
  attempts: number
  attemptsExpected: number
  /** Wall-clock of this call so far. */
  elapsedMs: number
  /** Estimated remaining wall-clock for the whole ride, or null until enough fresh work was timed. */
  etaMs: number | null
  /** What happened that the caller should relay: refused cache lines, a failed self-verification. */
  notes: string[]
}

export type RideRunResult =
  /** The budget ran out (or nothing is left to do but the next call); progress is on disk. */
  | { done: false; progress: RideProgress; workSeconds: number }
  /** The proof, already verified at Level 1 by this server. */
  | { done: true; proof: RideProof; verification: RideVerifyResult; progress: RideProgress; workSeconds: number }

export interface RideRunOptions {
  /** Seconds this call may spend; checked between leaves and attempts, so the overrun is at most one leaf per thread (plus the self-verification, 32 leaves, once the proof is built). */
  budgetSeconds: number
  signal?: AbortSignal
  onProgress?: (progress: RideProgress) => void
}

export interface RideRunnerOptions {
  /** Worker threads for leaves and attempts; 0 runs everything on the calling thread. Default: the cores available less one, at least one. */
  threads?: number
  chunkSize?: number
  grindChunk?: number
  /** A milliseconds clock for the budget and the ETA; tests inject one. */
  now?: () => number
}

/**
 * Blocks per worker request. Small enough that a pulled chunk represents a
 * few seconds of average work (so the pull queue can rebalance around a
 * heavy block), large enough that message overhead is noise.
 */
export const RIDE_CHUNK_SIZE = 64

/** Nonces per worker request in the price search: an attempt costs about one
 * average block, so this is a second or two of work per pull. */
export const GRIND_CHUNK = 8

/** How long the pool waits, after the deadline, for threads to finish the leaf in hand before terminating them. */
const GRACE_MS = 1500
const FLUSH_INTERVAL_MS = 250
const FLUSH_BATCH = 500
const PROGRESS_INTERVAL_MS = 100
/** Below this many fresh leaves (or attempts) the rate estimate is noise; report no ETA. */
const ETA_MIN_FRESH = 20

type Block = { height: number; blockHash: string }

/** Split pending blocks into chunks; workers pull them in index order. */
export function planChunks(blocks: Block[], size: number = RIDE_CHUNK_SIZE): Block[][] {
  const chunks: Block[][] = []
  for (let i = 0; i < blocks.length; i += size) chunks.push(blocks.slice(i, i + size))
  return chunks
}

/**
 * Where a resumed price search starts: the lowest nonce not known to miss.
 * Ranges finish out of order, so it is the start of the lowest range still
 * in flight, or the next range to hand out when none is.
 */
export function grindCheckpoint(inFlightStarts: Iterable<number>, nextStart: number): number {
  let low = nextStart
  for (const start of inFlightStarts) if (start < low) low = start
  return low
}

/**
 * The seconds a ride of n blocks is expected to take on this machine with
 * `threads` workers: the leaves and the price attempts (5.7 expected
 * pairings) at the pairing rate of the tallest Cantor tree the calibration
 * timed, spread over the threads, plus the self-verification's sampled
 * leaves on one thread. NaN without a calibration.
 */
export function estimateRideSeconds(c: Calibration, n: number, threads: number): number {
  const heights = Object.keys(c.cantorMsByHeight).map(Number).sort((a, b) => a - b)
  if (heights.length === 0 || n <= 0) return heights.length === 0 ? NaN : 0
  const top = heights[heights.length - 1]
  const msPerPair = Math.max(c.cantorMsByHeight[top], 0.5) / 2 ** top
  const pooled = ((expectedRidePairs(n) + expectedPricePairs(n)) * msPerPair) / Math.max(1, threads)
  const check = Math.min(n, SAMPLES) * expectedRidePairs(1) * msPerPair
  return (pooled + check) / 1000
}

function abortError(): Error {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError()
}

/** The worker file beside this one: compiled, or the TypeScript source through tsx when running from source (vitest). */
function workerSpec(): { url: URL; execArgv?: string[] } {
  const here = import.meta.url
  if (here.endsWith('.ts')) return { url: new URL('./rideWorker.ts', here), execArgv: ['--import', 'tsx'] }
  return { url: new URL('./rideWorker.js', here) }
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

class ProgressReporter {
  private phase: RidePhase = 'leaves'
  private done: number
  private fresh = 0
  private attempts = 0
  private phaseStarted: number
  private lastPost = -Infinity

  constructor(
    private readonly now: () => number,
    private readonly onProgress: ((p: RideProgress) => void) | undefined,
    private readonly started: number,
    private readonly total: number,
    private readonly resumed: number,
    private readonly attemptsExpected: number,
    readonly notes: string[],
  ) {
    this.done = resumed
    this.phaseStarted = started
  }

  snapshot(): RideProgress {
    const now = this.now()
    // Mean wall-clock per fresh leaf (or attempt) since the phase started.
    // Resumed work costs nothing and would fake a rate; parallelism is
    // absorbed because the mean is over wall-clock, not thread time. An
    // attempt costs about one average block (5.5), so the leaf phase's ETA
    // counts the price as that many more blocks.
    let etaMs: number | null = null
    if (this.fresh >= ETA_MIN_FRESH) {
      const each = (now - this.phaseStarted) / this.fresh
      if (this.phase === 'leaves') etaMs = (this.total - this.done + this.attemptsExpected) * each
      else if (this.phase === 'price' && this.attempts < this.attemptsExpected) etaMs = (this.attemptsExpected - this.attempts) * each
    }
    if (this.phase === 'done') etaMs = 0
    return {
      phase: this.phase,
      leavesDone: this.done,
      leavesTotal: this.total,
      leavesResumed: this.resumed,
      attempts: this.attempts,
      attemptsExpected: this.attemptsExpected,
      elapsedMs: now - this.started,
      etaMs,
      notes: this.notes.slice(),
    }
  }

  private post(force: boolean): void {
    if (!this.onProgress) return
    const now = this.now()
    if (!force && now - this.lastPost < PROGRESS_INTERVAL_MS) return
    this.lastPost = now
    this.onProgress(this.snapshot())
  }

  start(): void {
    this.post(true)
  }

  leafDone(): void {
    this.done++
    this.fresh++
    this.post(false)
  }

  /** Every leaf is in; the price search begins, `attempts` of it already tried. */
  priceStart(attempts: number): void {
    this.phase = 'price'
    this.attempts = attempts
    this.phaseStarted = this.now()
    this.fresh = 0
    this.post(true)
  }

  attemptDone(): void {
    this.attempts++
    this.fresh++
    this.post(false)
  }

  verifyStart(): void {
    this.phase = 'verify'
    this.post(true)
  }

  finish(): void {
    this.phase = 'done'
    this.post(true)
  }
}

// ---------------------------------------------------------------------------
// Persisters: leaves in batches, the checkpoint on the same cadence
// ---------------------------------------------------------------------------

class LeafPersister {
  private buffer: Array<{ height: number; leafHex: string }> = []
  private lastFlush: number

  constructor(private readonly cache: RideCache, private readonly prev: string, private readonly now: () => number) {
    this.lastFlush = now()
  }

  add(height: number, leafHex: string): void {
    this.buffer.push({ height, leafHex })
    if (this.buffer.length >= FLUSH_BATCH || this.now() - this.lastFlush >= FLUSH_INTERVAL_MS) this.flush()
  }

  /** Runs on every settle path, so a retry resumes from here instead of repaying the work. */
  flush(): void {
    if (this.buffer.length === 0) return
    const rows = this.buffer
    this.buffer = []
    this.cache.appendLeaves(this.prev, rows)
    this.lastFlush = this.now()
  }
}

class GrindPersister {
  private latest: number | null = null
  private lastFlush: number

  constructor(private readonly cache: RideCache, private readonly prev: string, private readonly rootHex: string, private readonly now: () => number) {
    this.lastFlush = now()
  }

  set(next: number): void {
    this.latest = next
    if (this.now() - this.lastFlush >= FLUSH_INTERVAL_MS) this.flush()
  }

  flush(): void {
    if (this.latest === null) return
    this.cache.writeGrind(this.prev, this.rootHex, this.latest)
    this.latest = null
    this.lastFlush = this.now()
  }
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

interface PoolHandlers {
  /** The next request for a free thread, or null when nothing remains. */
  next(id: number): RideWorkerRequest | null
  /** A leaf or an attempt; 'finish' settles the whole pool early (a nonce was found). */
  onMessage(msg: RideWorkerResponse): 'continue' | 'finish'
  /** A request ended; `stopped` when the thread stopped at the flag with work left in it. */
  onDone?(id: number, stopped: boolean): void
}

type PoolOutcome = 'finished' | 'cut'

interface Found {
  nonce: number
  G: Uint8Array
}

export class RideRunner {
  private running = false
  private readonly threads: number
  private readonly chunkSize: number
  private readonly grindChunk: number
  private readonly now: () => number

  private constructor(readonly cache: RideCache, options: RideRunnerOptions) {
    this.threads = options.threads ?? Math.max(1, availableParallelism() - 1)
    this.chunkSize = options.chunkSize ?? RIDE_CHUNK_SIZE
    this.grindChunk = options.grindChunk ?? GRIND_CHUNK
    this.now = options.now ?? (() => performance.now())
  }

  /** Open or create `<state>/rides` and the runner over it. */
  static open(path: string, options: RideRunnerOptions = {}): RideRunner {
    return new RideRunner(RideCache.open(path), options)
  }

  /** Drop a ride's cached leaves and price search: the tool calls this once the hyperjump is signed and recorded. */
  forget(previousEventIdHex: string): void {
    this.cache.forget(previousEventIdHex)
  }

  /**
   * Do as much of the ride as the budget allows, then return where it stands:
   * `done: false` with progress (everything computed is on disk; call again),
   * or `done: true` with a proof this server has verified at Level 1. Rejects
   * on abort (name AbortError, progress kept), on a malformed job, on a
   * thread failure, and if a ride recomputed from scratch still does not
   * verify, which would be a bug. One ride at a time: the pool sizes itself
   * to the machine, and a second would only slow both.
   */
  async run(job: RideJob, options: RideRunOptions): Promise<RideRunResult> {
    if (this.running) throw new Error('a ride is already computing; one ride at a time')
    this.running = true
    try {
      return await this.runRide(job, options)
    } finally {
      this.running = false
    }
  }

  private async runRide(job: RideJob, options: RideRunOptions): Promise<RideRunResult> {
    const prev = job.previousEventIdHex
    if (typeof prev !== 'string' || !HEX_64.test(prev)) throw new Error('previousEventIdHex must be 64 lowercase hex characters')
    for (const h of [job.fromHeight, job.toHeight]) {
      if (!Number.isSafeInteger(h) || h < 0) throw new Error('fromHeight and toHeight must be block heights')
    }
    // There is no zero-length ride (arkinox, 2026-10-07): a ride passes at
    // least one block, and a job with none is a bug upstream, never a proof.
    if (job.fromHeight === job.toHeight) throw new Error('a ride passes at least one block: there is no zero-length ride')
    const blocks: Block[] = rideBlocks(job.fromHeight, job.toHeight).map((height) => {
      const blockHash = job.blockHashFor(height)
      if (typeof blockHash !== 'string' || !HEX_64.test(blockHash)) throw new Error(`block ${height} has no 64-hex block hash`)
      return { height, blockHash }
    })

    const started = this.now()
    const deadline = started + Math.max(0, options.budgetSeconds) * 1000
    const signal = options.signal
    throwIfAborted(signal)
    const notes: string[] = []
    const attemptsExpected = attemptsRequired(blocks.length)
    const workSeconds = (): number => (this.now() - started) / 1000

    // Two passes at most: the second only after a failed self-verification
    // emptied the cache, and then it computes everything afresh.
    for (let pass = 0; pass < 2; pass++) {
      const { leaves: cached, refused } = this.cache.readLeaves(prev)
      if (refused > 0) notes.push(`${refused} cached leaf line(s) failed their check and were dropped; those leaves are recomputed`)
      const leafHexByHeight = new Map<number, string>()
      for (const b of blocks) {
        const hex = cached.get(b.height)
        if (hex !== undefined) leafHexByHeight.set(b.height, hex)
      }
      // Keys carry the previous event id (the file is named by it), so a
      // cache from another chain position skips nothing: its leaves are
      // worthless here (5.3 seeds differ).
      const pending = blocks.filter((b) => !leafHexByHeight.has(b.height))
      const progress = new ProgressReporter(this.now, options.onProgress, started, blocks.length, blocks.length - pending.length, attemptsExpected, notes)
      progress.start()
      const cut = (): RideRunResult => ({ done: false, progress: progress.snapshot(), workSeconds: workSeconds() })

      if (pending.length > 0) {
        const outcome = await this.computeLeaves(prev, pending, leafHexByHeight, progress, deadline, signal)
        if (outcome === 'cut') return cut()
      }

      // Leaves arrive in completion order (a pool property, not a protocol
      // one); 5.4 requires ascending height, so assembly follows the blocks.
      const tree = rideTree(blocks.map((b) => {
        const hex = leafHexByHeight.get(b.height)
        if (hex === undefined) throw new Error(`missing ride leaf for block ${b.height}`)
        return hexToBytes(hex)
      }))
      const rootHex = bytesToHex(tree.root)
      const from = this.cache.readGrind(prev, rootHex)
      progress.priceStart(from)
      const found = await this.searchNonce(prev, rootHex, attemptsExpected, from, progress, deadline, signal)
      if (found === null) return cut()
      const proof = rideProofFor(tree, BigInt(found.nonce), found.G)

      // The gate: the proof is checked the way a verifier will check it,
      // the sampled leaves recomputed from the block hashes, before anyone
      // signs it. Bounded work (SAMPLES leaves), run whatever the budget says.
      progress.verifyStart()
      const verification = await verifyRideLevel1({
        previousEventIdHex: prev, fromHeight: job.fromHeight, toHeight: job.toHeight,
        rootHex: proof.rootHex, mp: proof.mp, mn: proof.mnHex, blockHashFor: job.blockHashFor,
      })
      if (verification.ok) {
        progress.finish()
        return { done: true, proof, verification, progress: progress.snapshot(), workSeconds: workSeconds() }
      }
      notes.push(`the finished proof did not verify (${verification.reason}); the cached leaves and price search for this ride were discarded, and the ride is recomputed from scratch`)
      this.cache.forget(prev)
      if (this.now() >= deadline) return cut()
    }
    throw new Error('the ride was recomputed from scratch and its proof still does not verify: a bug in the ride code, not in the cache')
  }

  /** Phase 1: the pending leaves, into `out` and the cache, until done or the deadline. */
  private async computeLeaves(
    prev: string,
    pending: Block[],
    out: Map<number, string>,
    progress: ProgressReporter,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<PoolOutcome> {
    const persister = new LeafPersister(this.cache, prev, this.now)
    const landed = (height: number, leafHex: string): void => {
      out.set(height, leafHex)
      persister.add(height, leafHex)
      progress.leafDone()
    }
    try {
      if (this.threads === 0) {
        // Same semantics, sequential, with a microtask yield per leaf so an
        // abort flagged between leaves is honored promptly.
        for (const { height, blockHash } of pending) {
          throwIfAborted(signal)
          if (this.now() >= deadline) return 'cut'
          landed(height, bytesToHex(computeRideLeaf(prev, height, blockHash)))
          await Promise.resolve()
        }
        return 'finished'
      }
      const chunks = planChunks(pending, this.chunkSize)
      let nextChunk = 0
      return await this.runPool(Math.min(this.threads, chunks.length), {
        next: (id) => (nextChunk < chunks.length ? { type: 'chunk', id, previousEventIdHex: prev, chunk: chunks[nextChunk++] } : null),
        onMessage: (msg) => {
          if (msg.type === 'leaf') landed(msg.height, msg.leafHex)
          return 'continue'
        },
      }, deadline, signal)
    } finally {
      persister.flush()
    }
  }

  /** Phase 2: the price search upward from the checkpoint, until a nonce meets the price or the deadline. */
  private async searchNonce(
    prev: string,
    rootHex: string,
    attempts: number,
    from: number,
    progress: ProgressReporter,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<Found | null> {
    const checkpoint = new GrindPersister(this.cache, prev, rootHex, this.now)
    try {
      if (this.threads === 0) {
        const root = hexToBytes(rootHex)
        for (let nonce = from; ; nonce++) {
          throwIfAborted(signal)
          if (this.now() >= deadline) {
            checkpoint.set(nonce)
            return null
          }
          const G = grindAttempt(prev, root, BigInt(nonce))
          progress.attemptDone()
          if (meetsPrice(G, attempts)) {
            checkpoint.set(nonce)
            return { nonce, G }
          }
          checkpoint.set(nonce + 1)
          await Promise.resolve()
        }
      }
      // Disjoint nonce ranges pulled in order, the first nonce meeting the
      // price wins. The checkpoint trails the lowest range still in flight
      // (a range stopped at the flag stays in flight for this purpose: its
      // remaining nonces are not known to miss), so a resumed search repeats
      // at most one range per thread; once a nonce is found the checkpoint
      // is that nonce, so a resume finds it again on its first attempt.
      let nextStart = from
      const ranges = new Map<number, number>()
      let found: Found | null = null
      const outcome = await this.runPool(Math.min(this.threads, attempts), {
        next: (id) => {
          const start = nextStart
          nextStart += this.grindChunk
          ranges.set(id, start)
          return { type: 'grind', id, previousEventIdHex: prev, rootHex, attempts, start, count: this.grindChunk }
        },
        onMessage: (msg) => {
          if (msg.type !== 'attempt') return 'continue'
          progress.attemptDone()
          if (msg.gHex === null) return 'continue'
          found = { nonce: msg.nonce, G: hexToBytes(msg.gHex) }
          checkpoint.set(msg.nonce)
          return 'finish'
        },
        onDone: (id, stopped) => {
          if (stopped || found !== null) return
          ranges.delete(id)
          checkpoint.set(grindCheckpoint(ranges.values(), nextStart))
        },
      }, deadline, signal)
      if (found !== null) return found
      if (outcome === 'finished') throw new Error('the price search ended without a nonce')
      return null
    } finally {
      checkpoint.flush()
    }
  }

  /**
   * The pull queue both phases run on: `size` threads, each handed the next
   * request when it finishes one. Resolves 'finished' when nothing is left
   * and nothing is in flight (or a handler said 'finish'), 'cut' once the
   * deadline passed and every thread stopped at the flag or the grace ran
   * out. A thread error or crash rejects; the signal rejects with AbortError.
   */
  private runPool(size: number, handlers: PoolHandlers, deadline: number, signal: AbortSignal | undefined): Promise<PoolOutcome> {
    return new Promise<PoolOutcome>((resolve, reject) => {
      const stopBuffer = new SharedArrayBuffer(4)
      const stop = new Int32Array(stopBuffer)
      const workers: Worker[] = []
      let settled = false
      let cutting = false
      let inFlight = 0
      let nextId = 0
      let grace: ReturnType<typeof setTimeout> | null = null

      const settle = (outcome: PoolOutcome | Error): void => {
        if (settled) return
        settled = true
        Atomics.store(stop, 0, 1)
        if (grace !== null) clearTimeout(grace)
        signal?.removeEventListener('abort', onAbort)
        for (const w of workers) void w.terminate()
        if (outcome instanceof Error) reject(outcome)
        else resolve(outcome)
      }
      const onAbort = (): void => settle(abortError())
      const cut = (): void => {
        if (cutting) return
        cutting = true
        // Threads see the flag between leaves and post their done; the
        // leaf in hand is kept. Past the grace, they are terminated.
        Atomics.store(stop, 0, 1)
        if (inFlight === 0) settle('cut')
        else grace = setTimeout(() => settle('cut'), GRACE_MS)
      }
      const assign = (worker: Worker): void => {
        if (settled) return
        if (!cutting && this.now() >= deadline) cut()
        if (cutting) {
          if (inFlight === 0) settle('cut')
          return
        }
        const request = handlers.next(++nextId)
        if (request === null) {
          if (inFlight === 0) settle('finished')
          return
        }
        inFlight++
        worker.postMessage(request)
      }

      signal?.addEventListener('abort', onAbort)
      if (signal?.aborted) {
        onAbort()
        return
      }
      // A budget already spent starts no thread: starting one costs more than the nothing it would be allowed to do.
      if (this.now() >= deadline) {
        settle('cut')
        return
      }

      const spec = workerSpec()
      const workerData: RideWorkerData = { stop: stopBuffer }
      for (let i = 0; i < size; i++) {
        const worker = new Worker(spec.url, spec.execArgv ? { workerData, execArgv: spec.execArgv } : { workerData })
        workers.push(worker)
        worker.on('message', (msg: RideWorkerResponse) => {
          if (settled) return
          if (msg.type === 'error') {
            settle(new Error(msg.message))
            return
          }
          if (msg.type === 'done') {
            inFlight--
            handlers.onDone?.(msg.id, msg.stopped)
            // Pull, not pre-partition: a 2^22 block stalls only its own thread.
            assign(worker)
            return
          }
          if (handlers.onMessage(msg) === 'finish') settle('finished')
          else if (!cutting && this.now() >= deadline) cut()
        })
        // A crashed thread never posts again; without this the ride would
        // hang silently one chunk short of done.
        worker.on('error', (err) => settle(err instanceof Error ? err : new Error(String(err))))
        worker.on('exit', (code) => {
          if (!settled && code !== 0) settle(new Error(`a ride worker exited with code ${code}`))
        })
        assign(worker)
      }
    })
  }
}
