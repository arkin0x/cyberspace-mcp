// rideWorker.ts: the worker_threads entry that computes ride leaves and
// price attempts for the ride runner (DECK-0001 v3 5.3 and 5.5).
//
// Ported from ONOSENDAI src/workers/ride.worker.ts at commit e793767 (branch
// v2): the chunk request (one leaf posted per block) and the grind request
// (one attempt posted per nonce, the range ended at the first that meets the
// price). Adapted: parentPort for self.postMessage; an explicit `done` per
// request, where the pool counted leaves; and a stop flag in shared memory,
// checked between leaves and attempts, so the runner can end a call at its
// budget without terminating a thread mid-leaf and losing the leaf. The
// calibrate request is not ported: this server measures in
// src/space/calibration.ts, on the main thread, once.
//
// A ride averages tens of thousands of Cantor pairings per block with a
// worst block of 2^22, and a full ride is 300k+ blocks, so this is hours of
// aggregate work spread over every spare core. A leaf lands every ~100 ms on
// average, so per-leaf posting is both the progress signal and the
// persistence trigger with no extra throttling needed.

import { parentPort, workerData, type MessagePort } from 'node:worker_threads'
import { bytesToHex, hexToBytes } from 'cyberspace-core'
import { computeRideLeaf, grindAttempt, meetsPrice } from './ride.js'

export interface RideChunkRequest {
  type: 'chunk'
  id: number
  previousEventIdHex: string
  chunk: Array<{ height: number; blockHash: string }>
}

/** Try the nonces start .. start + count - 1 against the price (5.5). */
export interface RideGrindRequest {
  type: 'grind'
  id: number
  previousEventIdHex: string
  rootHex: string
  /** A, the price in attempts. */
  attempts: number
  start: number
  count: number
}

export type RideWorkerRequest = RideChunkRequest | RideGrindRequest

export type RideWorkerResponse =
  | { type: 'leaf'; id: number; height: number; leafHex: string }
  /** One attempt; gHex is G when this nonce meets the price, else null. */
  | { type: 'attempt'; id: number; nonce: number; gHex: string | null }
  /** The request is over: finished, or stopped early at the flag with work left. */
  | { type: 'done'; id: number; stopped: boolean }
  | { type: 'error'; id: number; message: string }

/** What the runner hands each worker at start: the shared stop flag. */
export interface RideWorkerData {
  stop: SharedArrayBuffer
}

function serve(port: MessagePort, stop: Int32Array): void {
  const stopped = (): boolean => Atomics.load(stop, 0) !== 0
  port.on('message', (request: RideWorkerRequest) => {
    const post = (response: RideWorkerResponse): void => port.postMessage(response)
    const { id } = request
    try {
      if (request.type === 'grind') {
        const { previousEventIdHex, rootHex, attempts, start, count } = request
        const root = hexToBytes(rootHex)
        for (let nonce = start; nonce < start + count; nonce++) {
          if (stopped()) {
            post({ type: 'done', id, stopped: true })
            return
          }
          const G = grindAttempt(previousEventIdHex, root, BigInt(nonce))
          const hit = meetsPrice(G, attempts)
          post({ type: 'attempt', id, nonce, gHex: hit ? bytesToHex(G) : null })
          if (hit) break
        }
        post({ type: 'done', id, stopped: false })
        return
      }
      const { previousEventIdHex, chunk } = request
      for (const { height, blockHash } of chunk) {
        if (stopped()) {
          post({ type: 'done', id, stopped: true })
          return
        }
        post({ type: 'leaf', id, height, leafHex: bytesToHex(computeRideLeaf(previousEventIdHex, height, blockHash)) })
      }
      post({ type: 'done', id, stopped: false })
    } catch (err) {
      post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) })
    }
  })
}

// Only a thread started by the runner has a parent port; importing this
// module for its types from the main thread serves nothing.
if (parentPort) serve(parentPort, new Int32Array((workerData as RideWorkerData).stop))
