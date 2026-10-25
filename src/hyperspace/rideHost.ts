// rideHost.ts: run a ride on a thread of its own (rideHostWorker.ts), with
// the same contract as RideRunner.run, so the server's main thread stays
// free to answer tool calls while a ride computes in the background
// (arkinox, 2026-10-11). The caller's `stop` predicate is looked at on a
// timer and on every progress report, and handed to the ride thread through
// shared memory; the caller's signal aborts the ride thread.

import { Worker } from 'node:worker_threads'
import type { RideHostData, RideHostMessage } from './rideHostWorker.js'
import type { RideRunOptions, RideRunResult } from './rideRunner.js'
import type { LeaseView } from '../state/lock.js'

export interface RideHostJob {
  cachePath: string
  threads: number
  chunkSize?: number
  grindChunk?: number
  previousEventIdHex: string
  fromHeight: number
  toHeight: number
  hashes: Uint8Array
  /** The state directory's lease, checked by the thread before every write to the ride cache (lock.ts). */
  lease?: LeaseView
}

/** How often the caller's stop predicate is looked at. */
const STOP_POLL_MS = 250
/** How long an aborted ride thread may take to flush and end before it is terminated. */
const ABORT_GRACE_MS = 3000

function hostSpec(): { url: URL; execArgv?: string[] } {
  const here = import.meta.url
  if (here.endsWith('.ts')) return { url: new URL('./rideHostWorker.ts', here), execArgv: ['--import', 'tsx'] }
  return { url: new URL('./rideHostWorker.js', here) }
}

function abortError(): Error {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

/**
 * One ride run on its own thread: resolves as RideRunner.run does (`done:
 * false` with progress when the budget or `stop` cut it, `done: true` with a
 * proof verified at Level 1), rejects with AbortError on the signal and with
 * the runner's error otherwise.
 */
export function runRideInThread(job: RideHostJob, options: RideRunOptions): Promise<RideRunResult> {
  return new Promise<RideRunResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError())
      return
    }
    const stopBuffer = new SharedArrayBuffer(4)
    const stop = new Int32Array(stopBuffer)
    const data: RideHostData = { rideHost: true, ...job, budgetSeconds: options.budgetSeconds, stop: stopBuffer }
    const spec = hostSpec()
    const worker = new Worker(spec.url, spec.execArgv ? { workerData: data, execArgv: spec.execArgv } : { workerData: data })
    let settled = false
    let killer: ReturnType<typeof setTimeout> | null = null
    const lookAtStop = (): void => {
      if (options.stop?.() === true) Atomics.store(stop, 0, 1)
    }
    const watch = setInterval(lookAtStop, STOP_POLL_MS)
    const settle = (outcome: RideRunResult | Error): void => {
      if (settled) return
      settled = true
      clearInterval(watch)
      if (killer !== null) clearTimeout(killer)
      options.signal?.removeEventListener('abort', onAbort)
      if (outcome instanceof Error) reject(outcome)
      else resolve(outcome)
    }
    const onAbort = (): void => {
      worker.postMessage({ type: 'abort' })
      // The thread flushes its finished leaves and ends; one that does not is ended for it.
      killer = setTimeout(() => {
        void worker.terminate()
        settle(abortError())
      }, ABORT_GRACE_MS)
    }
    options.signal?.addEventListener('abort', onAbort)
    worker.on('message', (msg: RideHostMessage) => {
      if (msg.type === 'progress') {
        options.onProgress?.(msg.progress)
        lookAtStop()
      } else if (msg.type === 'result') {
        settle(msg.result)
      } else {
        settle(msg.aborted ? abortError() : new Error(msg.message))
      }
    })
    worker.on('error', (err) => settle(err instanceof Error ? err : new Error(String(err))))
    worker.on('exit', (code) => {
      if (!settled) settle(options.signal?.aborted ? abortError() : new Error(`the ride thread exited with code ${code} before it answered`))
    })
  })
}
