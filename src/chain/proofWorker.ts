// proofWorker.ts: the proof of one step on a thread of its own (2026-11-09,
// after the stranger onboarding audit, B5). A hop's proof, a sidestep's and
// a boarding's entry proof are pure computation from the head and the
// target, and each can take up to the per-call cap; on the server's main
// thread nothing else was answered meanwhile, no progress notification left,
// and a client that gave up could not stop it. Here the proof runs on a
// worker_thread, as a ride's leaves (rideHost.ts) and an avatar's mining
// (avatarMine.ts) already do: the main thread keeps answering tool calls and
// sending progress, and a cancellation terminates the thread at once.
//
// Only the work moves. The thread is handed the head's coordinates and id
// and hands back the proof's values; the caller builds the template, confirms
// the head again and signs on the main thread, exactly as before. The thread
// holds no key and publishes nothing.

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { computeHopProofV2, computeSidestepProof, encodeNonce, encodeOpenings, hexToCoord } from 'cyberspace-core'
import { computeEnterProof } from '../hyperspace/enter.js'
import { bytesToHex } from '../nostr/event.js'

/** Axis values travel as decimal strings: a BigInt is cloned too, but strings say plainly what crosses. */
type Axes = [string, string, string]

/** One proof to compute. */
export type ProofJob =
  | { kind: 'hop'; from: Axes; to: Axes; plane: 0 | 1; previousId: string; maxComputeHeight: number }
  | { kind: 'sidestep'; from: Axes; to: Axes; plane: 0 | 1; previousId: string }
  | { kind: 'enter'; coordHex: string; previousId: string }

/** The proof's values, as the templates take them. */
export type ProofResult =
  | { kind: 'hop'; seal: string; mnHex: string; mpHex: string }
  | { kind: 'sidestep'; proofHash: string; merkleRoots: [string, string, string]; openings: [string, string, string]; mnHex: string; lcaHeights: [number, number, number] }
  | { kind: 'enter'; proofHash: string }

/** The proof, on the calling thread: what the worker runs, and the whole of the work. */
export function computeProof(job: ProofJob): ProofResult {
  if (job.kind === 'enter') return { kind: 'enter', proofHash: computeEnterProof(hexToCoord(job.coordHex), job.previousId) }
  const [fx, fy, fz] = job.from.map(BigInt) as [bigint, bigint, bigint]
  const [tx, ty, tz] = job.to.map(BigInt) as [bigint, bigint, bigint]
  if (job.kind === 'hop') {
    const proof = computeHopProofV2(fx, fy, fz, tx, ty, tz, job.plane, job.previousId, { maxComputeHeight: job.maxComputeHeight })
    return { kind: 'hop', seal: proof.tags.proof, mnHex: proof.tags.mn, mpHex: proof.tags.mp }
  }
  const proof = computeSidestepProof(fx, fy, fz, tx, ty, tz, job.plane, job.previousId)
  return {
    kind: 'sidestep',
    proofHash: proof.proofHash,
    merkleRoots: [bytesToHex(proof.merkleX), bytesToHex(proof.merkleY), bytesToHex(proof.merkleZ)],
    openings: [encodeOpenings(proof.openings.x), encodeOpenings(proof.openings.y), encodeOpenings(proof.openings.z)],
    mnHex: encodeNonce(proof.nonce),
    lcaHeights: proof.lcaHeights,
  }
}

// ---- the thread -----------------------------------------------------------

interface ProofData {
  cyberspaceProof: true
  job: ProofJob
}

type ProofMessage = { type: 'result'; result: ProofResult } | { type: 'error'; message: string }

if (!isMainThread && parentPort && (workerData as Partial<ProofData> | null)?.cyberspaceProof === true) {
  const port = parentPort
  try {
    port.postMessage({ type: 'result', result: computeProof((workerData as ProofData).job) } satisfies ProofMessage)
  } catch (err) {
    port.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) } satisfies ProofMessage)
  }
}

// ---- the host -------------------------------------------------------------

function threadSpec(): { url: URL; execArgv?: string[] } {
  const here = import.meta.url
  if (here.endsWith('.ts')) return { url: new URL('./proofWorker.ts', here), execArgv: ['--import', 'tsx'] }
  return { url: new URL('./proofWorker.js', here) }
}

/** What a proof cut short by its signal rejects with. */
export class ProofAborted extends Error {
  constructor() {
    super('the proof was stopped before it finished')
    this.name = 'AbortError'
  }
}

/**
 * The proof on a worker thread. Resolves with its values; rejects with
 * ProofAborted when the signal aborts (the thread is terminated at once:
 * the work is pure and leaves nothing behind) and with the error otherwise.
 */
export function proveInThread(job: ProofJob, signal?: AbortSignal): Promise<ProofResult> {
  return new Promise<ProofResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProofAborted())
      return
    }
    const spec = threadSpec()
    const data: ProofData = { cyberspaceProof: true, job }
    const worker = new Worker(spec.url, spec.execArgv ? { workerData: data, execArgv: spec.execArgv } : { workerData: data })
    let settled = false
    const settle = (outcome: ProofResult | Error): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (outcome instanceof Error) reject(outcome)
      else resolve(outcome)
    }
    const onAbort = (): void => {
      settle(new ProofAborted())
      void worker.terminate()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.on('message', (msg: ProofMessage) => {
      settle(msg.type === 'result' ? msg.result : new Error(msg.message))
      void worker.terminate()
    })
    worker.on('error', (err) => settle(err instanceof Error ? err : new Error(String(err))))
    worker.on('exit', (code) => settle(new Error(`the proof thread exited with code ${code} before it answered`)))
  })
}
