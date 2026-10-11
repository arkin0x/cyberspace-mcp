// avatarMine.ts: the work an avatar owes, done off the main thread.
//
// ONOSENDAI's loop (src/lib/avatarMine.ts mineChunk, src/workers/
// avatar.worker.ts), on node's worker_threads (arkinox, 2026-10-11:
// responsiveness first, nothing blocks tool calls). The NIP-01 serialization
// is built once around a marker, so only the nonce's digits change per try.
// Each thread takes its own residue of the nonce (thread i of n tries i,
// i+n, i+2n...), the first find wins, and every thread stops on a shared
// flag: the deadline, the caller's signal, or the find. While the threads
// hash, the main thread answers every other tool.

import { createHash } from 'node:crypto'
import { availableParallelism } from 'node:os'
import { Worker, parentPort, workerData, type MessagePort } from 'node:worker_threads'
import { nonceTagged } from './avatar.js'

export interface MineTemplate {
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
}

export interface MineFound { nonce: string; id: string }

const MARKER = 'CYBERSPACE-MCP-NONCE-MARKER-7f3a9c'
/** Tries between looks at the stop flag. */
const CHUNK = 4096

/** Leading zero bits of a hash. */
export function leadingZeros(hash: Uint8Array): number {
  let n = 0
  for (const b of hash) {
    if (b === 0) { n += 8; continue }
    n += Math.clz32(b) - 24
    break
  }
  return n
}

/**
 * Try `count` nonces from `from`, `stride` apart; the first whose id carries
 * `target` leading zero bits, or null. Deterministic, so a thread and a test
 * find the same nonce for the same template.
 */
export function mineChunk(t: MineTemplate, target: number, from: number, count: number, stride: number = 1): MineFound | null {
  const marked = nonceTagged(t, MARKER, target)
  const split = JSON.stringify([0, t.pubkey, t.created_at, t.kind, marked.tags, t.content]).split(MARKER)
  // The marker cannot be in the content of a template this server builds, but a
  // second copy would make the split ambiguous: refuse rather than mine the wrong bytes.
  if (split.length !== 2) throw new Error('the nonce marker appears in the event itself')
  const head = Buffer.from(split[0], 'utf8')
  const tail = Buffer.from(split[1], 'utf8')
  const last = from + count * stride
  for (let n = from; n < last; n += stride) {
    const digits = String(n)
    const hash = createHash('sha256').update(head).update(digits).update(tail).digest()
    if (leadingZeros(hash) >= target) return { nonce: digits, id: hash.toString('hex') }
  }
  return null
}

// ---- the thread ------------------------------------------------------------

interface MineData {
  avatarMine: true
  template: MineTemplate
  target: number
  start: number
  stride: number
  stop: SharedArrayBuffer
}

type MineMessage = { type: 'found'; found: MineFound; tries: number } | { type: 'stopped'; tries: number } | { type: 'error'; message: string }

function threadMain(data: MineData, port: MessagePort): void {
  const stop = new Int32Array(data.stop)
  let tries = 0
  try {
    for (;;) {
      if (Atomics.load(stop, 0) !== 0) { port.postMessage({ type: 'stopped', tries } satisfies MineMessage); return }
      const found = mineChunk(data.template, data.target, data.start + tries * data.stride, CHUNK, data.stride)
      if (found) {
        tries = (Number(found.nonce) - data.start) / data.stride + 1
        port.postMessage({ type: 'found', found, tries } satisfies MineMessage)
        return
      }
      tries += CHUNK
    }
  } catch (err) {
    port.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) } satisfies MineMessage)
  }
}

if (parentPort && (workerData as Partial<MineData> | null)?.avatarMine === true) threadMain(workerData as MineData, parentPort)

// ---- the host --------------------------------------------------------------

/** Threads per job: every core but one, at most four, so the server and a ride keep theirs. */
export function avatarThreads(): number {
  return Math.max(1, Math.min(4, availableParallelism() - 1))
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
 * `deadlineMs` of wall time or on the signal. Resolves with the nonce, or
 * with how far it got; rejects only when a thread fails.
 */
export function mineAvatar(template: MineTemplate, target: number, options: { threads: number; deadlineMs: number; signal?: AbortSignal }): Promise<MineOutcome> {
  const started = Date.now()
  const stopBuffer = new SharedArrayBuffer(4)
  const stop = new Int32Array(stopBuffer)
  const spec = threadSpec()
  const n = Math.max(1, options.threads)
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
      const data: MineData = { avatarMine: true, template, target, start: i, stride: n, stop: stopBuffer }
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
