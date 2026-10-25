// lock.ts: the state directory's lock, and the machine id that lets a
// server take back its own lock after a restart of the same machine
// (arkinox, 2026-10-25). One key has one mover, so a lock is only ever
// taken over when this process can show its owner is gone:
//
//   - a lock from another machine (another machine id) is never taken over;
//   - a lock from this machine, in the same pid namespace and boot, is taken
//     over when its pid is gone, a zombie, or now belongs to a younger
//     process (the kernel's start time of the pid differs from the lock's);
//   - a lock from this machine whose pid this process cannot see (a previous
//     boot of a container, or another container sharing the volume) is
//     taken over only after its heartbeat has been silent for 25 s;
//   - a lock written by an older version, with no machine id, keeps the old
//     rule: taken over on the same host when its pid is gone, never from
//     another host.
//
// The lock is a lease. Its owner touches it every 5 s from a worker thread
// and may sign, publish or write state only while its last confirmed touch
// is under 15 s old (by the wall clock and the monotonic clock both) and
// the lock still names it: HeldLock.assert, called before every signature,
// every publish and every state write. An owner that cannot confirm a touch
// in time, or finds the lock naming somebody else, fences itself: every
// assert refuses from then on, and the server stops and exits (its
// supervisor restarts it through this same lock). A watcher takes over only
// after 25 s of silence, so a paused owner (SIGSTOP, a paused container or
// VM, a laptop asleep beside a machine sharing the volume) is fenced at
// least 10 s before anybody else may move for the key.
//
// A lock taken over is moved aside (lock.stale-<when>-<reason>), never
// deleted, under an exclusive claim file, and the takeover is logged.
//
// The machine id lives in a file beside the state directory, never inside
// it: <state>.machine-id. A state directory is the unit people copy, back up
// and sync, and a copy must never carry the identity of the machine it came
// from. The file records its own inode and birth time, so a copy of it (a
// sync, cp, a restore) is recognized as not born here and replaced by a
// fresh id: the failure is a refusal, never a second mover. A block-level
// clone (a filesystem snapshot, a disk or VM image) keeps both and is not
// recognized: such a clone must never run while the original runs.

import { randomBytes, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fstatSync, linkSync, openSync, readFileSync, readlinkSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

export class LockHeldError extends Error {}

/** This server no longer holds its lock (or cannot show that it does): nothing may be signed, published or written. */
export class LockLostError extends Error {
  override name = 'LockLostError'
}

/**
 * The lease as another thread of this process sees it (a ride's thread, which
 * writes the ride cache): the heartbeat's shared buffer and the fence. It can
 * be handed to a worker in its workerData.
 */
export interface LeaseView {
  shared: SharedArrayBuffer
  fenceMs: number
}

/**
 * Throws LockLostError unless the lease is live: never fenced, never
 * released, and its last confirmed heartbeat within the fence by both
 * clocks. For a thread that holds no HeldLock (the main thread's own checks
 * also fence; this one only refuses).
 */
export function checkLease(view: LeaseView, what: string): void {
  const beat = new BigInt64Array(view.shared)
  const wall = BigInt(Date.now()) - Atomics.load(beat, 0)
  const steady = process.hrtime.bigint() / 1_000_000n - Atomics.load(beat, 1)
  const age = Number(wall > steady ? wall : steady)
  if (Atomics.load(beat, 2) !== 0n || age > view.fenceMs) throw new LockLostError(`Refused to ${what}: this server no longer holds its state directory's lock (or cannot show that it does). One key has one mover.`)
}

/** The environment variable that names this machine's id, in place of the file. */
export const MACHINE_ID_ENV = 'CYBERSPACE_MCP_MACHINE_ID'

/** What an explicit machine id may look like. */
const MACHINE_ID_SHAPE = /^[A-Za-z0-9._:@-]{1,128}$/

/** How often a live owner touches its lock, by default. */
export const HEARTBEAT_MS = 5_000

/** How old the owner's last confirmed touch may be before it fences itself. */
export const FENCE_MS = 15_000

/** How soon a touch that failed is tried again. */
const RETRY_MS = 1_000

/** The shortest silence that counts as an owner gone: its fence plus 10 s, at least. */
const MIN_SILENCE_MS = 25_000

/** A claim older than this was left by a taker that died mid-takeover (a takeover takes milliseconds). */
const CLAIM_STALE_MS = 10_000

/** The machine id file this server writes: random, with the inode (and birth time) it was born with. */
interface MachineIdFile {
  generatedBy: 'cyberspace-mcp'
  id: string
  createdAt: string
  host: string
  inode: string
  birth?: string
}

export interface MachineId {
  /** The id, or null when none could be had (the lock then falls back to the host, as older versions did). */
  id: string | null
  /** Where it came from. */
  source: 'flag' | 'env' | 'file' | 'new file' | 'none'
  /** The file, for 'file', 'new file' and 'none'. */
  path?: string
  /** One sentence when something was unusual: a copied file replaced, a file that could not be written. */
  note?: string
}

/** The lock file as this version writes it. Older versions wrote pid, startedAt and host only. */
export interface LockRecord {
  pid: number
  startedAt: string
  host: string
  machineId?: string
  /** The kernel's boot id, and the pid namespace, where /proc has them: a pid means something only inside both. */
  bootId?: string
  pidNs?: string
  /** The pid's start time in clock ticks since boot (/proc/<pid>/stat field 22): tells a reused pid from the owner. */
  procStart?: string
  /** How often the owner touches the lock, and how old its last touch may be before it fences itself, in ms. */
  heartbeatMs?: number
  fenceMs?: number
  /** Unique per lock taken, so a release never removes somebody else's. */
  nonce?: string
}

/** <state>.machine-id: beside the state directory, on the same volume, outside what a copy of the directory carries. */
export function machineIdPath(stateDir: string): string {
  const abs = resolve(stateDir)
  return join(dirname(abs), `${basename(abs)}.machine-id`)
}

const stamp = (d = new Date()): string => d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '')

const code = (err: unknown): string | undefined => (err as NodeJS.ErrnoException)?.code

/**
 * Move a file aside to <path>.<what>-<when>-<reason> (or -2, -3...),
 * never over a file already there, and return the new name: a hard link
 * then the old name dropped, or a rename where links are not supported.
 */
export function moveAside(path: string, what: string, reason: string, as = path): string {
  const base = `${as}.${what}-${stamp()}-${reason}`
  for (let n = 1; n < 1000; n++) {
    const dest = n === 1 ? base : `${base}-${n}`
    try {
      linkSync(path, dest)
    } catch (err) {
      if (code(err) === 'EEXIST') continue
      if (code(err) === 'ENOENT') throw err
      if (existsSync(dest)) continue
      renameSync(path, dest)
      return dest
    }
    unlinkSync(path)
    return dest
  }
  throw new Error(`no free name beside ${path}`)
}

/** A file's inode and birth time (where the filesystem records one), as strings. */
function identityOf(path: string): { inode: string; birth?: string } {
  const s = statSync(path, { bigint: true })
  return { inode: s.ino.toString(), ...(s.birthtimeNs > 0n ? { birth: s.birthtimeNs.toString() } : {}) }
}

/** Write a whole file and make it appear at path in one step, or throw EEXIST when path is there. */
function publishOnce(path: string, content: (id: { inode: string; birth?: string }) => string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const write = (target: string, flags: string): void => {
    const fd = openSync(target, flags, 0o600)
    try {
      const s = fstatSync(fd, { bigint: true })
      writeSync(fd, content({ inode: s.ino.toString(), ...(s.birthtimeNs > 0n ? { birth: s.birthtimeNs.toString() } : {}) }))
    } finally {
      closeSync(fd)
    }
  }
  write(tmp, 'wx')
  try {
    linkSync(tmp, path)
  } catch (err) {
    unlinkSync(tmp)
    if (code(err) === 'EEXIST') throw err
    // A filesystem without hard links: an exclusive create, written at once.
    write(path, 'wx')
    return
  }
  // The data stays under path; only the temporary name goes.
  unlinkSync(tmp)
}

/**
 * Run fn holding <path>.claim, made exclusively: only one process at a
 * time moves a file aside to replace it. 'busy' when another holds the
 * claim; a claim left by a process that died holding it (older than 10 s:
 * a replacement takes milliseconds) is moved aside, never deleted.
 */
function withClaim<T>(path: string, fn: () => T): T | 'busy' {
  const claim = `${path}.claim`
  const token = `${process.pid} ${randomBytes(8).toString('hex')}`
  try {
    publishOnce(claim, () => token)
  } catch (err) {
    if (code(err) !== 'EEXIST') throw err
    const raw = readOr(claim)
    const m = mtimeOf(claim)
    if (raw !== null && m !== null && Date.now() - Number(m / 1_000_000n) > CLAIM_STALE_MS && readOr(claim) === raw) {
      try { moveAside(claim, 'stale', 'abandoned') } catch { /* another process moved it */ }
    }
    return 'busy'
  }
  try {
    return fn()
  } finally {
    if (readOr(claim) === token) { try { unlinkSync(claim) } catch { /* gone */ } }
  }
}

/** Block this thread for ms (a synchronous caller waiting for a claim). */
const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/**
 * This machine's id for a state directory: the --machine-id flag, else
 * $CYBERSPACE_MCP_MACHINE_ID, else the file <state>.machine-id, made once
 * with random bytes when it is missing (only when create is true; doctor
 * reads). A file whose recorded inode or birth time is not its own is a
 * copy from elsewhere: it is moved aside and a new id made, so a lock
 * written under the old id is refused rather than taken over.
 */
export function resolveMachineId(stateDir: string, opts: { explicit?: string; env?: NodeJS.ProcessEnv; create?: boolean } = {}): MachineId {
  if (opts.explicit !== undefined) {
    if (!MACHINE_ID_SHAPE.test(opts.explicit)) throw new Error(`--machine-id must be 1 to 128 letters, digits or . _ : @ -; got ${JSON.stringify(opts.explicit)}`)
    return { id: opts.explicit, source: 'flag' }
  }
  const fromEnv = (opts.env ?? process.env)[MACHINE_ID_ENV]?.trim()
  if (fromEnv) {
    if (!MACHINE_ID_SHAPE.test(fromEnv)) throw new Error(`$${MACHINE_ID_ENV} must be 1 to 128 letters, digits or . _ : @ -; got ${JSON.stringify(fromEnv)}`)
    return { id: fromEnv, source: 'env' }
  }
  const path = machineIdPath(stateDir)
  // Another process may replace or make the file meanwhile (a copy replaced by two starts at once): it is read again.
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const r = machineIdFromFile(path, opts.create === true)
      if (r === 'busy') { sleepSync(25); continue }
      if (r !== 'changed') return r
    } catch (err) {
      if (code(err) !== 'ENOENT') throw err
    }
  }
  return { id: null, source: 'none', path, note: `${path} kept changing under this process; the lock falls back to the host name` }
}

/** The id from the file, made when missing; 'busy' or 'changed' when another process is replacing it (read again). */
function machineIdFromFile(path: string, create: boolean): MachineId | 'busy' | 'changed' {
  let raw: string | null = null
  try { raw = readFileSync(path, 'utf8') } catch (err) { if (code(err) !== 'ENOENT') throw err }
  if (raw !== null) {
    let parsed: Partial<MachineIdFile> | null = null
    try { parsed = JSON.parse(raw) as Partial<MachineIdFile> } catch { parsed = null }
    const valid = !!parsed && parsed.generatedBy === 'cyberspace-mcp' && typeof parsed.id === 'string' && MACHINE_ID_SHAPE.test(parsed.id) && typeof parsed.inode === 'string'
    const now = identityOf(path)
    const born = valid && parsed!.inode === now.inode && (parsed!.birth === undefined || now.birth === undefined || parsed!.birth === now.birth)
    if (born) return { id: parsed!.id!, source: 'file', path }
    if (!create) return { id: null, source: 'none', path, note: valid ? `${path} is a copy from elsewhere (its inode or birth time is not the one it was made with); serve makes a new id` : `${path} is not a machine id file this server wrote; serve makes a new one` }
    // Replaced under the claim, and only when it is still the file judged: never a fresh one another start just made.
    return withClaim(path, () => {
      if (readOr(path) !== raw || identityOf(path).inode !== now.inode) return 'changed' as const
      const aside = moveAside(path, valid ? 'copied' : 'unreadable', 'replaced')
      const note = valid
        ? `${path} was a copy from elsewhere (its inode or birth time is not the one it was made with), so it was kept as ${aside} and a new machine id made. A lock written under the old id is refused, never taken over. Never sync or copy this file.`
        : `${path} was not a machine id file this server wrote, so it was kept as ${aside} and a new one made.`
      return makeMachineId(path, note)
    })
  }
  return create ? makeMachineId(path) : { id: null, source: 'none', path }
}

/** A new id in a new file; 'changed' when another start made one first (that one is read). */
function makeMachineId(path: string, note?: string): MachineId | 'changed' {
  const id = randomUUID()
  try {
    publishOnce(path, (made) => JSON.stringify({ generatedBy: 'cyberspace-mcp', id, createdAt: new Date().toISOString(), host: hostname(), ...made } satisfies MachineIdFile, null, 2) + '\n')
  } catch (err) {
    if (code(err) === 'EEXIST') return 'changed'
    return { id: null, source: 'none', path, note: `${path} could not be written (${(err as Error).message}); the lock falls back to the host name, and a restart that changes it needs the lock moved aside by hand` }
  }
  return { id, source: 'new file', path, ...(note ? { note } : {}) }
}

const readOr = (path: string): string | null => { try { return readFileSync(path, 'utf8') } catch { return null } }
const mtimeOf = (path: string): bigint | null => { try { return statSync(path, { bigint: true }).mtimeNs } catch { return null } }
const inodeOr = (path: string): bigint | null => { try { return statSync(path, { bigint: true }).ino } catch { return null } }

/** The kernel's boot id, or null where there is no /proc. */
const bootId = (): string | null => readOr('/proc/sys/kernel/random/boot_id')?.trim() || null

/** This process's pid namespace, or null where there is no /proc. */
const pidNs = (): string | null => { try { return readlinkSync('/proc/self/ns/pid') } catch { return null } }

/** The fields of /proc/<pid>/stat after the command name (state first), or null. */
function statFields(pid: number | 'self'): string[] | null {
  const raw = readOr(`/proc/${pid}/stat`)
  // The command name, in parentheses, may itself hold spaces and parentheses: count from the last one.
  return raw ? raw.slice(raw.lastIndexOf(')') + 2).split(' ') : null
}

/** A pid's start time in clock ticks since boot (field 22 of /proc/<pid>/stat), or null. */
export function procStart(pid: number | 'self'): string | null {
  return statFields(pid)?.[19] ?? null
}

/** Whether a pid is running here, gone, or a zombie (exited and not reaped: pid 1 in a container may never reap it). */
export function pidState(pid: number): 'running' | 'gone' | 'zombie' {
  try {
    process.kill(pid, 0)
  } catch (err) {
    if (code(err) !== 'EPERM') return 'gone'
  }
  const state = statFields(pid)?.[0]
  return state === 'Z' || state === 'X' ? 'zombie' : 'running'
}

/** Who this process is, for writing a lock and judging one. */
interface Me {
  host: string
  machineId: string | null
  bootId: string | null
  pidNs: string | null
}

export type Judgment =
  | { kind: 'free' }
  | { kind: 'ours'; detail: string }
  | { kind: 'held'; message: string; detail: string; here: boolean }
  | { kind: 'stale'; reason: string; detail: string }
  | { kind: 'watch'; detail: string }

/** A lock record read from disk, or null when it is not one. */
export function parseLock(raw: string | null): LockRecord | null {
  if (raw === null) return null
  try {
    const v = JSON.parse(raw) as LockRecord
    return v && typeof v === 'object' && typeof v.pid === 'number' ? v : null
  } catch {
    return null
  }
}

const ONE_MOVER = 'One key has one mover: a second server on the same key would fork the chain and kill it.'

/** Who wrote a lock, for messages and the log: pid, host and machine id. */
const owner = (held: LockRecord): string => `pid ${held.pid} on host ${held.host}${held.machineId ? `, machine id ${held.machineId}` : ''}, started ${held.startedAt}`

/**
 * What the lock at path means for a process that is `me`, without waiting:
 * held (refuse, with the sentence), stale (take it over, for this reason),
 * watch (this machine's, but its pid cannot be seen from here: take it over
 * only after its heartbeat is silent), or ours (this very process).
 */
export function judgeLock(path: string, stateDir: string, raw: string | null, me: Me): Judgment {
  if (raw === null) return { kind: 'free' }
  const held = parseLock(raw)
  if (!held) return { kind: 'stale', reason: 'unreadable', detail: 'not a lock this server wrote' }
  const who = owner(held)
  // A pid means something only in the pid namespace and boot it was written in.
  const bothProc = !!(held.bootId && held.pidNs && me.bootId && me.pidNs)
  const sameNs = bothProc && held.bootId === me.bootId && held.pidNs === me.pidNs
  // No /proc on either side (macOS, older locks): the host stands in for the namespace, as before.
  const pidVisible = bothProc ? sameNs : held.host === me.host
  // The same pid as this process is this process only when its start time agrees; otherwise the pid was reused.
  if (pidVisible && held.pid === process.pid && (!held.procStart || held.procStart === procStart('self'))) return { kind: 'ours', detail: `held by this very process (pid ${held.pid})` }

  const live = (where: string): Judgment => ({ kind: 'held', here: true, detail: `held by ${who}, running`, message: `Another cyberspace-mcp already holds ${stateDir} (${who}, on this ${where}). ${ONE_MOVER} Stop the other server, or give this one its own state directory.` })
  /** This machine's (or this host's) lock: judged by its pid where the pid can be seen, by its heartbeat where it cannot. */
  const local = (where: string): Judgment => {
    if (!pidVisible) return { kind: 'watch', detail: `left by ${who} in a previous boot or another pid namespace` }
    const state = pidState(held.pid)
    if (state !== 'running') return { kind: 'stale', reason: `pid-${state}`, detail: `left by ${who}, which is ${state === 'gone' ? 'gone' : 'a zombie (exited, never reaped)'}` }
    const now = held.procStart ? procStart(held.pid) : null
    if (held.procStart && now && now !== held.procStart) return { kind: 'stale', reason: 'pid-reused', detail: `left by ${who}; that pid is now another process` }
    return live(where)
  }

  if (!held.machineId || !me.machineId) {
    // A lock from an older version (or a machine with no id): the host decides, as it always did.
    if (held.host !== me.host) {
      const older = held.machineId ? '' : ' This lock was written by an older cyberspace-mcp, which records no machine id; locks written by this version are recovered by themselves after a restart of the same machine, even when its host name changes.'
      return {
        kind: 'held',
        here: false,
        detail: `held by a cyberspace-mcp on another host (${who})${held.machineId ? '' : ', older lock format'}`,
        message: `The state directory ${stateDir} is locked by a cyberspace-mcp on another host (${who}), and this host cannot tell whether it still runs. ${ONE_MOVER} If that server is gone for certain, move ${path} aside by hand (rename it to lock.stale-<date>); otherwise stop it first, or give this server its own state directory.${older}`,
      }
    }
    return local('host')
  }

  if (held.machineId !== me.machineId) {
    return {
      kind: 'held',
      here: false,
      detail: `held by another machine (${who})`,
      message: `The state directory ${stateDir} is locked by a cyberspace-mcp on another machine (${who}); this machine's id is ${me.machineId}, and this machine cannot tell whether that server still runs. ${ONE_MOVER} If that server is gone for certain, move ${path} aside by hand (rename it to lock.stale-<date>); otherwise stop it first, or give this server its own state directory. A state directory and its machine id file are never synced or copied between machines while either runs.`,
    }
  }
  return local('machine')
}

/** A lock this process holds: its release, and the check that it still holds it. */
export interface HeldLock {
  /** Give the lock up (only while it is still ours); also run when this process exits. */
  release(): void
  /**
   * Throws LockLostError unless the lock still names this process and its
   * heartbeat was confirmed within the fence (15 s). Synchronous: call it
   * immediately before a signature or a publish. Fences this process when it
   * fails for a reason that will not mend (a lock naming another owner, a
   * lock gone, a heartbeat too old).
   */
  assert(what: string): void
  /** The same without reading the lock file: the heartbeat's age and the fence only (before a state write). */
  assertFresh(what: string): void
  /** Why this process was fenced, or null. */
  fenced(): string | null
  /** The lease for another thread of this process to check (checkLease). */
  view(): LeaseView
  /** Called once when this process is fenced (at once when it already is). */
  onLost(cb: (reason: string) => void): void
}

export interface LockOptions {
  /** The --machine-id flag. */
  machineId?: string
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
  /** How often this owner touches its lock (default 5 s); 0 for none (tests only: nothing then keeps the lease, so asserts fail after the fence). */
  heartbeatMs?: number
  /** How old this owner's last touch may be before it fences itself (default 15 s). */
  fenceMs?: number
  /** Tests: how long another owner's heartbeat is watched for, in place of its fence plus 10 s (at least 25 s). */
  silenceMs?: number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Take the exclusive lock on a state directory. Throws LockHeldError, with a
 * plain message, when the owner may still run.
 */
export async function takeLock(stateDir: string, opts: LockOptions = {}): Promise<HeldLock> {
  const path = join(stateDir, 'lock')
  const log = opts.log ?? (() => {})
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const machine = resolveMachineId(stateDir, { explicit: opts.machineId, env: opts.env, create: true })
  if (machine.note) log(`lock: ${machine.note}`)
  const me: Me = { host: hostname(), machineId: machine.id, bootId: bootId(), pidNs: pidNs() }
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS
  const fenceMs = opts.fenceMs ?? FENCE_MS
  const self = `pid ${process.pid} on host ${me.host}${me.machineId ? `, machine id ${me.machineId}` : ''}`
  let record: LockRecord | null = null
  let mine = ''
  const publish = (): boolean => {
    record = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      host: me.host,
      ...(me.machineId ? { machineId: me.machineId } : {}),
      ...(me.bootId ? { bootId: me.bootId } : {}),
      ...(me.pidNs ? { pidNs: me.pidNs } : {}),
      ...(procStart('self') ? { procStart: procStart('self')! } : {}),
      heartbeatMs,
      fenceMs,
      nonce: randomBytes(8).toString('hex'),
    }
    mine = JSON.stringify(record)
    try {
      publishOnce(path, () => mine)
      return true
    } catch (err) {
      if (code(err) === 'EEXIST') return false
      throw err
    }
  }
  const held = (): HeldLock => armLease(path, mine, record!.nonce!, heartbeatMs, fenceMs, log, self)

  for (let attempt = 0; attempt < 8; attempt++) {
    if (publish()) return held()
    const raw = readOr(path)
    const verdict = judgeLock(path, stateDir, raw, me)
    if (verdict.kind === 'free') continue
    if (verdict.kind === 'ours') throw new LockHeldError(`Another cyberspace-mcp already holds ${stateDir} (this very process). ${ONE_MOVER} Stop the other server, or give this one its own state directory.`)
    if (verdict.kind === 'held') throw new LockHeldError(verdict.message)
    let reason = verdict.kind === 'stale' ? verdict.reason : 'silent'
    let detail = verdict.detail
    let mtime = mtimeOf(path)
    const inode = inodeOr(path)
    if (verdict.kind === 'watch') {
      const old = parseLock(raw)!
      const watchMs = opts.silenceMs ?? Math.max(MIN_SILENCE_MS, Math.ceil(2.5 * (old.heartbeatMs ?? HEARTBEAT_MS)), (old.fenceMs ?? FENCE_MS) + 10_000)
      log(`lock: ${stateDir} is locked by this machine (${verdict.detail}); this is ${self}; watching its heartbeat for ${Math.round(watchMs / 1000)} s before taking it over`)
      await sleep(watchMs)
      if (readOr(path) !== raw || mtimeOf(path) !== mtime) {
        const now = parseLock(readOr(path))
        if (now && now.nonce === old.nonce) {
          throw new LockHeldError(`The state directory ${stateDir} is locked by a cyberspace-mcp on this machine (${owner(old)}) that this process cannot see (another container or pid namespace sharing the volume), and its heartbeat is live: it still runs. ${ONE_MOVER} Stop the other server, or give this one its own state directory.`)
        }
        continue // The lock changed hands meanwhile: judge the new one.
      }
      reason = 'silent'
      detail = `${verdict.detail}, its heartbeat silent for ${Math.round(watchMs / 1000)} s`
      mtime = mtimeOf(path)
    }
    const taken = takeOver(path, { raw: raw!, mtime, inode }, reason, publish)
    if (taken === 'busy') { await sleep(200); continue }
    if (taken === 'changed') continue
    log(`lock: ${self} took over the lock ${detail} (${reason}); the old lock is kept as ${taken}`)
    return held()
  }
  throw new LockHeldError(`Could not take the lock on ${stateDir}: other servers kept taking it first.`)
}

/**
 * Take a stale lock over under an exclusive claim (lock.claim): re-read the
 * lock under it, and only when it is still exactly what was judged (bytes
 * and modification time), move it aside and publish this process's own,
 * in that order, before the claim is let go. Returns the name the old lock
 * is kept under, 'busy' when another taker holds the claim, 'changed' when
 * the lock is no longer the one judged. hooks.beforeMove: tests only (a
 * fresh lock swapped in at the worst moment).
 */
export function takeOver(path: string, judged: { raw: string; mtime: bigint | null; inode: bigint | null }, reason: string, publish: () => boolean, hooks: { beforeMove?: () => void } = {}): string | 'busy' | 'changed' {
  return withClaim(path, () => {
    // The very file judged: its bytes (the nonce among them), its modification time and its inode.
    if (judged.inode === null || readOr(path) !== judged.raw || mtimeOf(path) !== judged.mtime || inodeOr(path) !== judged.inode) return 'changed'
    hooks.beforeMove?.()
    // Moved to a name of this process's own first, then checked: what was moved must be the very file judged (bytes,
    // nonce included, and inode). A claim taken from a taker that was paused inside it may let that taker move
    // a fresh lock at this moment; a fresh lock moved here by mistake is put back, and if it cannot be, its owner
    // finds its lock gone and fences itself.
    const taking = `${path}.taking-${process.pid}-${randomBytes(4).toString('hex')}`
    try {
      renameSync(path, taking)
    } catch (err) {
      if (code(err) === 'ENOENT') return 'changed'
      throw err
    }
    if (readOr(taking) !== judged.raw || inodeOr(taking) !== judged.inode) {
      try { linkSync(taking, path); unlinkSync(taking) } catch { /* left as lock.taking-*: its owner fences itself on the missing lock */ }
      return 'changed'
    }
    const kept = moveAside(taking, 'stale', reason, path)
    // A server starting just now may publish into the gap (it needs no claim to take a free lock): then it is the owner, and this one judges its lock.
    if (!publish()) return 'changed'
    return kept
  })
}

/**
 * The heartbeat, in a worker so a busy main thread (a long hop) never
 * silences it. Each beat reads the lock, touches it, and reads it again;
 * only a beat whose lock was ours both times is confirmed (the wall and
 * monotonic times go into the shared buffer the main thread checks), and
 * only while the last one is within the fence: a lease that expired (the
 * process was paused) is never renewed, only fenced. A
 * failed beat is tried again every second, never given up: an owner that
 * cannot confirm a beat within the fence, or finds the lock naming another
 * owner (or gone, twice), fences itself (state 1 or 2) and stops touching.
 */
const HEARTBEAT_WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const { path, mine, everyMs, retryMs, fenceMs, shared } = workerData
const beat = new BigInt64Array(shared)
const mono = () => process.hrtime.bigint() / 1000000n
let missing = 0
let failing = null
const stop = (state, reason) => {
  if (Atomics.compareExchange(beat, 2, 0n, state) === 0n) parentPort.postMessage({ fence: reason })
}
const age = () => {
  const wall = BigInt(Date.now()) - Atomics.load(beat, 0)
  const steady = mono() - Atomics.load(beat, 1)
  return Number(wall > steady ? wall : steady)
}
const tick = () => {
  if (Atomics.load(beat, 2) !== 0n) return
  // A lease past its fence is never renewed: this process was paused (or could not beat), and a watcher may have taken the lock meanwhile.
  if (age() > fenceMs) return stop(1n, 'its heartbeat could not be confirmed for ' + Math.round(age() / 1000) + ' s')
  let ok = false
  try {
    if (fs.readFileSync(path, 'utf8') !== mine) return stop(2n, 'the lock now names another owner')
    const now = new Date()
    fs.utimesSync(path, now, now)
    if (fs.readFileSync(path, 'utf8') !== mine) return stop(2n, 'the lock now names another owner')
    Atomics.store(beat, 0, BigInt(Date.now()))
    Atomics.store(beat, 1, mono())
    missing = 0
    if (failing) { parentPort.postMessage({ mended: failing }); failing = null }
    ok = true
  } catch (err) {
    if (err && err.code === 'ENOENT') { if (++missing >= 2) return stop(2n, 'the lock file is gone') }
    else if (!failing) { failing = err && err.code ? err.code : String(err); parentPort.postMessage({ failing }) }
  }
  if (age() > fenceMs) return stop(1n, 'its heartbeat could not be confirmed for ' + Math.round(age() / 1000) + ' s')
  setTimeout(tick, ok ? everyMs : retryMs)
}
setTimeout(tick, everyMs)
`

function armLease(path: string, mine: string, nonce: string, heartbeatMs: number, fenceMs: number, log: (line: string) => void, self: string): HeldLock {
  const shared = new SharedArrayBuffer(3 * 8)
  const beat = new BigInt64Array(shared)
  const mono = (): bigint => process.hrtime.bigint() / 1_000_000n
  Atomics.store(beat, 0, BigInt(Date.now()))
  Atomics.store(beat, 1, mono())
  let fence: string | null = null
  const callbacks: Array<(reason: string) => void> = []
  let worker: Worker | null = null

  const doFence = (reason: string): void => {
    if (fence) return
    fence = reason
    Atomics.compareExchange(beat, 2, 0n, 3n)
    if (worker) void worker.terminate()
    log(`lock: FENCED: ${self} no longer holds ${path} (${reason}). It signs, publishes and writes nothing more, and stops.`)
    for (const cb of callbacks.splice(0)) cb(reason)
  }
  /** The age of the last confirmed beat by both clocks, whichever is older. */
  const age = (): number => {
    const wall = Date.now() - Number(Atomics.load(beat, 0))
    const steady = Number(mono() - Atomics.load(beat, 1))
    return Math.max(wall, steady)
  }
  const refuse = (what: string, why: string): LockLostError => new LockLostError(`Refused to ${what}: this server (${self}) ${why}. ${ONE_MOVER} It stops now; restarted, it takes the lock again only when nobody else holds it.`)
  const fresh = (what: string): void => {
    if (fence) throw refuse(what, `no longer holds ${path}: ${fence}`)
    const state = Atomics.load(beat, 2)
    if (state === 1n || state === 2n) {
      doFence(state === 2n ? 'the lock now names another owner, or is gone' : 'its heartbeat could not be confirmed in time')
      throw refuse(what, `no longer holds ${path}: ${fence}`)
    }
    const a = age()
    if (a > fenceMs) {
      doFence(`its heartbeat was last confirmed ${Math.round(a / 1000)} s ago, past the ${Math.round(fenceMs / 1000)} s fence: this process was paused or could not touch the lock, and another server may hold it now`)
      throw refuse(what, `no longer holds ${path}: ${fence}`)
    }
  }

  if (heartbeatMs > 0) {
    worker = new Worker(HEARTBEAT_WORKER, { eval: true, workerData: { path, mine, everyMs: heartbeatMs, retryMs: Math.min(RETRY_MS, heartbeatMs), fenceMs, shared } })
    worker.unref()
    worker.on('message', (m: { fence?: string; failing?: string; mended?: string }) => {
      if (m.fence) doFence(m.fence)
      else if (m.failing) log(`lock: the heartbeat could not touch ${path} (${m.failing}); trying again every second, and fencing this server if it cannot within ${Math.round(fenceMs / 1000)} s`)
      else if (m.mended) log(`lock: the heartbeat touches ${path} again`)
    })
    worker.on('error', (err) => doFence(`its heartbeat thread failed: ${err.message}`))
  }

  let released = false
  const release = (): void => {
    if (released) return
    released = true
    Atomics.compareExchange(beat, 2, 0n, 3n)
    if (worker) void worker.terminate()
    // Moved out of the way first, then judged: a lock that is no longer ours is put back, never removed.
    // Somebody else's lock is never touched, not even for a moment: its owner would take a missing lock for a lost one.
    if (parseLock(readOr(path))?.nonce !== nonce) { process.off('exit', release); return }
    const out = `${path}.releasing-${nonce}`
    try {
      renameSync(path, out)
      if (parseLock(readOr(out))?.nonce === nonce) unlinkSync(out)
      else { try { linkSync(out, path); unlinkSync(out) } catch { log(`lock: another server's lock was kept as ${out} while releasing`) } }
    } catch { /* already gone */ }
    process.off('exit', release)
  }
  process.on('exit', release)

  return {
    release,
    assertFresh: fresh,
    assert(what: string): void {
      fresh(what)
      let raw: string
      try {
        raw = readFileSync(path, 'utf8')
      } catch (err) {
        // Refused, not fenced: the heartbeat fences on a lock missing twice in a row, or on a lease past its fence.
        throw refuse(what, `could not read ${path} to confirm it still holds it (${code(err) ?? String(err)})`)
      }
      if (parseLock(raw)?.nonce !== nonce) { doFence('the lock now names another owner'); throw refuse(what, `no longer holds ${path}: ${fence}`) }
    },
    fenced: () => fence,
    view: () => ({ shared, fenceMs }),
    onLost(cb: (reason: string) => void): void {
      if (fence) cb(fence)
      else callbacks.push(cb)
    },
  }
}

/** For doctor: this machine's id (read only) and what the lock means, judged as serve would judge it. */
export function describeLock(stateDir: string, opts: { machineId?: string; env?: NodeJS.ProcessEnv } = {}): { machine: MachineId; judgment: Judgment; held: LockRecord | null; ageMs: number | null } {
  const machine = resolveMachineId(stateDir, { explicit: opts.machineId, env: opts.env, create: false })
  const path = join(stateDir, 'lock')
  const raw = readOr(path)
  // With no id yet, serve makes a fresh one, which no lock on disk can carry: judged with that.
  const id = machine.id ?? (machine.path ? `(new: ${randomUUID()})` : null)
  const me: Me = { host: hostname(), machineId: id, bootId: bootId(), pidNs: pidNs() }
  const m = mtimeOf(path)
  return { machine, judgment: judgeLock(path, stateDir, raw, me), held: parseLock(raw), ageMs: m === null ? null : Date.now() - Number(m / 1_000_000n) }
}
