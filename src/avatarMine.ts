// avatarMine.ts: the work an avatar owes, done off the main thread.
//
// ONOSENDAI's worker pattern (src/workers/avatar.worker.ts) on node's
// worker_threads (arkinox, 2026-10-11: responsiveness first, nothing blocks
// tool calls), with cyberspace-core's midstate miner (AvatarTailMiner,
// spec 8.10 since 2026-11): the nonce is the last field of the content, the
// serialization before it is hashed once, and each try hashes one SHA-256
// block, whatever the avatar's size. Each thread runs its own miner from its
// own start (thread i at i * THREAD_SPAN), the first find wins, and every
// thread stops on a shared flag: the deadline, the caller's signal, or the
// find. While the threads hash, the main thread answers every other tool.
// The event to sign is cyberspace-core's avatarTailEvent(template, nonce,
// target), whose id is the find's.

import { availableParallelism } from 'node:os'
import { AVATAR_MINE_MAX_TARGET, AvatarTailMiner, avatarTailSplit, type AvatarMineFound, type AvatarMineTemplate } from 'cyberspace-core'
import { defaultThreads } from './budget.js'
import { Worker, parentPort, workerData, type MessagePort } from 'node:worker_threads'

export type MineTemplate = AvatarMineTemplate
/** A find: the whole nonce field (any leading zeros included) and the id it gives. */
export type MineFound = AvatarMineFound

/** Tries between looks at the stop flag: a few milliseconds at the midstate rate. */
const CHUNK = 8192
/**
 * Nonces between one thread's start and the next's. The miner has room for
 * 16 digits (10^16 nonces), so up to 10,000 threads never meet, and no
 * thread exhausts its 10^12 before any deadline a call may set.
 */
export const THREAD_SPAN = 1e12
/** The most threads whose ranges fit the miner's 16 digits. */
const MAX_THREADS = 10_000

// ---- the thread ------------------------------------------------------------

interface MineData {
  avatarMine: true
  template: MineTemplate
  target: number
  start: number
  stop: SharedArrayBuffer
}

type MineMessage = { type: 'found'; found: MineFound; tries: number } | { type: 'stopped'; tries: number } | { type: 'error'; message: string }

function threadMain(data: MineData, port: MessagePort): void {
  const stop = new Int32Array(data.stop)
  let miner: AvatarTailMiner | null = null
  try {
    miner = new AvatarTailMiner(avatarTailSplit(data.template, data.target), data.start)
    for (;;) {
      if (Atomics.load(stop, 0) !== 0) { port.postMessage({ type: 'stopped', tries: miner.tries } satisfies MineMessage); return }
      const found = miner.run(CHUNK, data.target)
      if (found) { port.postMessage({ type: 'found', found, tries: miner.tries } satisfies MineMessage); return }
    }
  } catch (err) {
    port.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) } satisfies MineMessage)
  }
}

if (parentPort && (workerData as Partial<MineData> | null)?.avatarMine === true) threadMain(workerData as MineData, parentPort)

// ---- the host --------------------------------------------------------------

/** Threads per job: the human's --threads, else min(2, cores - 1) (D3, 2026-11-09), so the machine keeps its cores. */
export function avatarThreads(threads?: number): number {
  return threads ?? defaultThreads(availableParallelism())
}

function threadSpec(): { url: URL; execArgv?: string[] } {
  const here = import.meta.url
  if (here.endsWith('.ts')) return { url: new URL('./avatarMine.ts', here), execArgv: ['--import', 'tsx'] }
  return { url: new URL('./avatarMine.js', here) }
}

export type MineOutcome =
  | { found: true; nonce: string; id: string; tries: number; elapsedMs: number }
  | { found: false; why: 'deadline' | 'aborted'; tries: number; elapsedMs: number }

/**
 * Mine `template` to `target` bits on `threads` threads, stopping at
 * `deadlineMs` of wall time or on the signal. Resolves with the nonce (the
 * whole trailing field's value; sign avatarTailEvent(template, nonce,
 * target)), or with how far it got; rejects only when a thread fails or the
 * template cannot be mined (content not a JSON object, target over
 * AVATAR_MINE_MAX_TARGET).
 */
export function mineAvatar(template: MineTemplate, target: number, options: { threads: number; deadlineMs: number; signal?: AbortSignal }): Promise<MineOutcome> {
  // What a thread would fail on, refused here before any thread starts.
  if (!Number.isInteger(target) || target < 0 || target > AVATAR_MINE_MAX_TARGET) return Promise.reject(new Error(`the target must be 0 to ${AVATAR_MINE_MAX_TARGET} bits; got ${target}`))
  try { avatarTailSplit(template, target) } catch (err) { return Promise.reject(err instanceof Error ? err : new Error(String(err))) }
  const started = Date.now()
  const stopBuffer = new SharedArrayBuffer(4)
  const stop = new Int32Array(stopBuffer)
  const spec = threadSpec()
  const n = Math.min(MAX_THREADS, Math.max(1, Math.floor(options.threads)))
  return new Promise<MineOutcome>((resolve, reject) => {
    const workers: Worker[] = []
    const tries = new Array<number>(n).fill(0)
    let settled = false
    const ended = new Set<number>()
    let why: 'deadline' | 'aborted' = 'deadline'
    const halt = (): void => { Atomics.store(stop, 0, 1) }
    const timer = setTimeout(() => { why = 'deadline'; halt() }, options.deadlineMs)
    const onAbort = (): void => { why = 'aborted'; halt() }
    options.signal?.addEventListener('abort', onAbort)
    const finish = (outcome: MineOutcome | Error): void => {
      if (settled) return
      settled = true
      halt()
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      // A thread that has not seen the flag within a moment is ended for it.
      setTimeout(() => { for (const w of workers) void w.terminate() }, 1000).unref()
      if (outcome instanceof Error) reject(outcome)
      else resolve(outcome)
    }
    if (options.signal?.aborted) { finish({ found: false, why: 'aborted', tries: 0, elapsedMs: 0 }); return }
    for (let i = 0; i < n; i++) {
      const data: MineData = { avatarMine: true, template, target, start: i * THREAD_SPAN, stop: stopBuffer }
      const worker = new Worker(spec.url, spec.execArgv ? { workerData: data, execArgv: spec.execArgv } : { workerData: data })
      workers.push(worker)
      worker.on('message', (msg: MineMessage) => {
        if (msg.type === 'error') { finish(new Error(msg.message)); return }
        tries[i] = msg.tries
        const total = tries.reduce((a, b) => a + b, 0)
        if (msg.type === 'found') finish({ found: true, nonce: msg.found.nonce, id: msg.found.id, tries: total, elapsedMs: Date.now() - started })
        else if (ended.add(i).size === n) finish({ found: false, why, tries: total, elapsedMs: Date.now() - started })
      })
      worker.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))))
      worker.on('exit', () => { if (!settled && ended.add(i).size === n) finish({ found: false, why, tries: tries.reduce((a, b) => a + b, 0), elapsedMs: Date.now() - started }) })
    }
  })
}
