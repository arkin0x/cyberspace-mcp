// rideHostWorker.ts: the worker_threads entry that runs a whole ride off the
// server's main thread (arkinox, 2026-10-11: "agents being responsive is top
// priority or else the feature feels broken").
//
// The leaves and the price attempts already ran on rideWorker.ts threads,
// but the runner itself did its bookkeeping on the thread that answers tool
// calls, and at the scale of a real ride that bookkeeping is long: for
// 661,038 leaves, reading the cache back took about 3.5 s, decoding it 2.6 s
// and building the Merkle tree 5.5 s on this machine, and the Level 1
// self-verification recomputes 32 sampled leaves, each up to 2^22 pairings.
// Every tool call (inbox, orders_waiting, message_operator) would wait behind
// those. So the runner runs here, on a thread of its own, and starts its leaf
// threads from here; the main thread only hears progress.
//
// One run per thread: the thread starts with its job in workerData, posts
// progress as the runner reports it, then posts the result (or the error)
// and ends. A stop flag in shared memory asks for a cut (the session cap, or
// a pause), which the runner honors as a spent budget: everything computed
// is on disk. An 'abort' message ends the run at once (cancel, shutdown);
// finished leaves are flushed to disk on that path too.

import { parentPort, workerData, type MessagePort } from 'node:worker_threads'
import { bytesToHex } from 'cyberspace-core'
import { RideRunner, type RideProgress, type RideRunResult } from './rideRunner.js'

export interface RideHostData {
  /** Marks a thread started as a ride host, so importing this file anywhere else serves nothing. */
  rideHost: true
  cachePath: string
  threads: number
  chunkSize?: number
  grindChunk?: number
  previousEventIdHex: string
  fromHeight: number
  toHeight: number
  /** The block hash of every height the ride passes, 32 bytes each, (lo, hi] ascending (Line.rideHashes). */
  hashes: Uint8Array
  budgetSeconds: number
  /** Nonzero asks the run to stop as if its budget ran out. */
  stop: SharedArrayBuffer
}

export type RideHostMessage =
  | { type: 'progress'; progress: RideProgress }
  | { type: 'result'; result: RideRunResult }
  | { type: 'error'; message: string; aborted: boolean }

function serve(port: MessagePort, data: RideHostData): void {
  const stop = new Int32Array(data.stop)
  const controller = new AbortController()
  port.on('message', (msg: unknown) => {
    if ((msg as { type?: string } | null)?.type === 'abort') controller.abort()
  })
  const lo = Math.min(data.fromHeight, data.toHeight)
  const hi = Math.max(data.fromHeight, data.toHeight)
  const blockHashFor = (height: number): string => {
    if (height <= lo || height > hi) throw new Error(`block ${height} is not on this ride`)
    const at = (height - lo - 1) * 32
    return bytesToHex(data.hashes.subarray(at, at + 32))
  }
  const runner = RideRunner.open(data.cachePath, { threads: data.threads, chunkSize: data.chunkSize, grindChunk: data.grindChunk })
  runner.run(
    { previousEventIdHex: data.previousEventIdHex, fromHeight: data.fromHeight, toHeight: data.toHeight, blockHashFor },
    {
      budgetSeconds: data.budgetSeconds,
      signal: controller.signal,
      stop: () => Atomics.load(stop, 0) !== 0,
      onProgress: (progress) => port.postMessage({ type: 'progress', progress } satisfies RideHostMessage),
    },
  ).then(
    (result) => port.postMessage({ type: 'result', result } satisfies RideHostMessage),
    (err: unknown) => port.postMessage({
      type: 'error', message: err instanceof Error ? err.message : String(err), aborted: err instanceof Error && err.name === 'AbortError',
    } satisfies RideHostMessage),
  ).finally(() => port.close())
}

const data = workerData as RideHostData | undefined
if (parentPort && data?.rideHost === true) serve(parentPort, data)
