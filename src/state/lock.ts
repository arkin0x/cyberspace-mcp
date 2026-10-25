// lock.ts: the state directory's lock, and the machine id that lets a
// server take back its own lock after a restart of the same machine
// (arkinox, 2026-10-25). One key has one mover, so a lock is only ever
// taken over when this process can show its owner is gone:
//
//   - a lock from another machine (another machine id) is never taken over;
//   - a lock from this machine, in the same pid namespace and boot, is taken
//     over when its pid is gone or now belongs to a younger process (the
//     kernel's start time of the pid differs from the one the lock records);
//   - a lock from this machine whose pid this process cannot see (a previous
//     boot of a container, or another container sharing the volume) is
//     taken over only after its heartbeat has been silent for a while: a
//     live owner touches the lock every few seconds from a worker thread;
//   - a lock written by an older version, with no machine id, keeps the old
//     rule: taken over on the same host when its pid is gone, never from
//     another host.
//
// A lock taken over is renamed aside (lock.stale-<when>-<reason>), never
// deleted, and the takeover is logged in one line.
//
// The machine id lives in a file beside the state directory, never inside
// it: <state>.machine-id. A state directory is the unit people copy, back up
// and sync, and a copy must never carry the identity of the machine it came
// from. The file records its own inode too, so a copy of it (a sync, cp, a
// restore) is recognized as not born here and replaced by a fresh id: the
// failure is a refusal, never a second mover.

import { randomBytes, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fstatSync, linkSync, openSync, readFileSync, readlinkSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

export class LockHeldError extends Error {}

/** The environment variable that names this machine's id, in place of the file. */
export const MACHINE_ID_ENV = 'CYBERSPACE_MCP_MACHINE_ID'

/** What an explicit machine id may look like. */
const MACHINE_ID_SHAPE = /^[A-Za-z0-9._:@-]{1,128}$/

/** How often a live owner touches its lock, by default. */
export const HEARTBEAT_MS = 10_000

/** The shortest silence that counts as an owner gone, whatever its heartbeat. */
const MIN_SILENCE_MS = 25_000

/** The machine id file this server writes: random, with the inode it was born with. */
interface MachineIdFile {
  generatedBy: 'cyberspace-mcp'
  id: string
  createdAt: string
  host: string
  inode: string
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
  /** How often the owner touches the lock, in ms. */
  heartbeatMs?: number
  /** Unique per lock taken, so a release never removes somebody else's. */
  nonce?: string
}

/** <state>.machine-id: beside the state directory, on the same volume, outside what a copy of the directory carries. */
export function machineIdPath(stateDir: string): string {
  const abs = resolve(stateDir)
  return join(dirname(abs), `${basename(abs)}.machine-id`)
}

const stamp = (d = new Date()): string => d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '')

/** A free name for a file moved aside: <path>.<what>-<when>-<reason>, never one already there. */
function asideName(path: string, what: string, reason: string): string {
  const base = `${path}.${what}-${stamp()}-${reason}`
  if (!existsSync(base)) return base
  for (let n = 2; ; n++) if (!existsSync(`${base}-${n}`)) return `${base}-${n}`
}

const inodeOf = (path: string): string => statSync(path, { bigint: true }).ino.toString()

/** Write a whole file and make it appear at path in one step, or throw EEXIST when path is there. Returns the inode. */
function publishOnce(path: string, content: (inode: string) => string): string {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const fd = openSync(tmp, 'wx', 0o600)
  let inode: string
  try {
    inode = fstatSync(fd, { bigint: true }).ino.toString()
    writeSync(fd, content(inode))
  } finally {
    closeSync(fd)
  }
  try {
    linkSync(tmp, path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') { unlinkSync(tmp); throw err }
    // A filesystem without hard links: an exclusive create, written at once.
    unlinkSync(tmp)
    const fd2 = openSync(path, 'wx', 0o600)
    try {
      inode = fstatSync(fd2, { bigint: true }).ino.toString()
      writeSync(fd2, content(inode))
    } finally {
      closeSync(fd2)
    }
    return inode
  }
  // The data stays under path; only the temporary name goes.
  unlinkSync(tmp)
  return inode
}

/**
 * This machine's id for a state directory: the --machine-id flag, else
 * $CYBERSPACE_MCP_MACHINE_ID, else the file <state>.machine-id, made once
 * with random bytes when it is missing (only when create is true; doctor
 * reads). A file whose recorded inode is not its own is a copy from
 * elsewhere: it is moved aside and a new id made, so a lock written under
 * the old id is refused rather than taken over.
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
  let note: string | undefined
  if (existsSync(path)) {
    let parsed: Partial<MachineIdFile> | null = null
    try { parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MachineIdFile> } catch { parsed = null }
    const valid = !!parsed && parsed.generatedBy === 'cyberspace-mcp' && typeof parsed.id === 'string' && MACHINE_ID_SHAPE.test(parsed.id) && typeof parsed.inode === 'string'
    if (valid && parsed!.inode === inodeOf(path)) return { id: parsed!.id!, source: 'file', path }
    const why = valid ? 'copied' : 'unreadable'
    if (!opts.create) return { id: null, source: 'none', path, note: valid ? `${path} is a copy from elsewhere (its inode is not the one it was made with); serve makes a new id` : `${path} is not a machine id file this server wrote; serve makes a new one` }
    const aside = asideName(path, why, 'replaced')
    renameSync(path, aside)
    note = valid
      ? `${path} was a copy from elsewhere (its inode is not the one it was made with), so it was kept as ${aside} and a new machine id made. A lock written under the old id is refused, never taken over. Never sync or copy this file.`
      : `${path} was not a machine id file this server wrote, so it was kept as ${aside} and a new one made.`
  } else if (!opts.create) {
    return { id: null, source: 'none', path }
  }
  const id = randomUUID()
  try {
    publishOnce(path, (inode) => JSON.stringify({ generatedBy: 'cyberspace-mcp', id, createdAt: new Date().toISOString(), host: hostname(), inode } satisfies MachineIdFile, null, 2) + '\n')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return resolveMachineId(stateDir, { ...opts, create: false })
    return { id: null, source: 'none', path, note: `${path} could not be written (${(err as Error).message}); the lock falls back to the host name, and a restart that changes it needs the lock removed by hand` }
  }
  return { id, source: 'new file', path, ...(note ? { note } : {}) }
}

const readOr = (path: string): string | null => { try { return readFileSync(path, 'utf8') } catch { return null } }

/** The kernel's boot id, or null where there is no /proc. */
const bootId = (): string | null => readOr('/proc/sys/kernel/random/boot_id')?.trim() || null

/** This process's pid namespace, or null where there is no /proc. */
const pidNs = (): string | null => { try { return readlinkSync('/proc/self/ns/pid') } catch { return null } }

/** A pid's start time in clock ticks since boot (field 22 of /proc/<pid>/stat), or null. */
export function procStart(pid: number | 'self'): string | null {
  const raw = readOr(`/proc/${pid}/stat`)
  if (!raw) return null
  // The command name, in parentheses, may itself hold spaces and parentheses: count from the last one.
  const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
  return fields[19] ?? null
}

/** Whether a process with this pid exists here. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
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
  const where = `pid ${held.pid}, started ${held.startedAt}`
  const sameNs = !!(held.bootId && held.pidNs && me.bootId && me.pidNs) && held.bootId === me.bootId && held.pidNs === me.pidNs
  // No /proc on either side (macOS): the host stands in for the namespace, as before.
  const noProc = !held.bootId && !held.pidNs && !me.bootId && !me.pidNs
  const pidMeansSomething = held.machineId && me.machineId ? sameNs || (noProc && held.host === me.host) : held.host === me.host
  // The same pid as this process is this process only when its start time agrees; otherwise the pid was reused.
  if (pidMeansSomething && held.pid === process.pid && (!held.procStart || held.procStart === procStart('self'))) return { kind: 'ours', detail: `held by this very process (pid ${held.pid})` }

  if (!held.machineId || !me.machineId) {
    // A lock from an older version (or a machine with no id): the host decides, as it always did.
    if (held.host !== me.host) {
      const older = held.machineId ? '' : ' This lock was written by an older cyberspace-mcp, which records no machine id; locks written by this version are recovered by themselves after a restart of the same machine, even when its host name changes.'
      return {
        kind: 'held',
        here: false,
        detail: `held by a cyberspace-mcp on another host (${held.host}, ${where})${held.machineId ? '' : ', older lock format'}`,
        message: `The state directory ${stateDir} is locked by a cyberspace-mcp on another host (${held.host}, ${where}), and this host cannot tell whether it still runs. ${ONE_MOVER} If that server is gone for certain, move ${path} aside by hand (rename it to lock.stale-<date>); otherwise stop it first, or give this server its own state directory.${older}`,
      }
    }
    if (pidAlive(held.pid)) return { kind: 'held', here: true, detail: `held by pid ${held.pid} on this host, running`, message: `Another cyberspace-mcp already holds ${stateDir} (${where} on this host). ${ONE_MOVER} Stop the other server, or give this one its own state directory.` }
    return { kind: 'stale', reason: 'pid-gone', detail: `left by pid ${held.pid} on this host, which is gone` }
  }

  if (held.machineId !== me.machineId) {
    return {
      kind: 'held',
      here: false,
      detail: `held by another machine (machine id ${held.machineId}, host ${held.host}, ${where})`,
      message: `The state directory ${stateDir} is locked by a cyberspace-mcp on another machine (machine id ${held.machineId}, host ${held.host}, ${where}); this machine's id is ${me.machineId}, and this machine cannot tell whether that server still runs. ${ONE_MOVER} If that server is gone for certain, move ${path} aside by hand (rename it to lock.stale-<date>); otherwise stop it first, or give this server its own state directory. A state directory and its machine id file are never synced or copied between machines while either runs.`,
    }
  }

  // This machine's lock.
  if (pidMeansSomething) {
    if (!pidAlive(held.pid)) return { kind: 'stale', reason: 'pid-gone', detail: `left by pid ${held.pid} on this machine, which is gone` }
    const now = held.procStart ? procStart(held.pid) : null
    if (held.procStart && now && now !== held.procStart) return { kind: 'stale', reason: 'pid-reused', detail: `left by pid ${held.pid} on this machine; that pid is now another process` }
    return { kind: 'held', here: true, detail: `held by pid ${held.pid} on this machine, running`, message: `Another cyberspace-mcp already holds ${stateDir} (${where} on this machine). ${ONE_MOVER} Stop the other server, or give this one its own state directory.` }
  }
  return { kind: 'watch', detail: `left by pid ${held.pid} on this machine (host ${held.host}) in a previous boot or another pid namespace` }
}

/** Whether the lock at path changes (content or modification time) within ms: a live owner's heartbeat. */
async function heartbeatSeen(path: string, raw: string, ms: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const mtime = (): bigint | null => { try { return statSync(path, { bigint: true }).mtimeNs } catch { return null } }
  const before = mtime()
  await sleep(ms)
  return readOr(path) !== raw || mtime() !== before
}

export interface LockOptions {
  /** The --machine-id flag. */
  machineId?: string
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
  /** How often this owner touches its lock (default 10 s); 0 for none (tests only). */
  heartbeatMs?: number
  /** Tests: how long another owner's heartbeat is watched for, in place of 2.5 of its beats (at least 25 s). */
  silenceMs?: number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Take the exclusive lock on a state directory. Throws LockHeldError, with a
 * plain message, when the owner may still run. Returns the release, which is
 * also run when this process exits.
 */
export async function takeLock(stateDir: string, opts: LockOptions = {}): Promise<() => void> {
  const path = join(stateDir, 'lock')
  const log = opts.log ?? (() => {})
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const machine = resolveMachineId(stateDir, { explicit: opts.machineId, env: opts.env, create: true })
  if (machine.note) log(`lock: ${machine.note}`)
  const me: Me = { host: hostname(), machineId: machine.id, bootId: bootId(), pidNs: pidNs() }
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS
  for (let attempt = 0; attempt < 3; attempt++) {
    const record: LockRecord = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      host: me.host,
      ...(me.machineId ? { machineId: me.machineId } : {}),
      ...(me.bootId ? { bootId: me.bootId } : {}),
      ...(me.pidNs ? { pidNs: me.pidNs } : {}),
      ...(procStart('self') ? { procStart: procStart('self')! } : {}),
      heartbeatMs,
      nonce: randomBytes(8).toString('hex'),
    }
    const mine = JSON.stringify(record)
    try {
      publishOnce(path, () => mine)
      return armRelease(path, mine, record.nonce!, heartbeatMs, log)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const raw = readOr(path)
    let verdict = judgeLock(path, stateDir, raw, me)
    if (verdict.kind === 'free') continue
    if (verdict.kind === 'ours') throw new LockHeldError(`Another cyberspace-mcp already holds ${stateDir} (this very process). ${ONE_MOVER} Stop the other server, or give this one its own state directory.`)
    if (verdict.kind === 'held') throw new LockHeldError(verdict.message)
    if (verdict.kind === 'watch') {
      const held = parseLock(raw)!
      const watchMs = opts.silenceMs ?? Math.max(MIN_SILENCE_MS, Math.ceil(2.5 * (held.heartbeatMs ?? HEARTBEAT_MS)))
      log(`lock: ${stateDir} is locked by this machine (${verdict.detail}); watching its heartbeat for ${Math.round(watchMs / 1000)} s before taking it over`)
      if (await heartbeatSeen(path, raw!, watchMs, sleep)) {
        const now = parseLock(readOr(path))
        if (now && now.nonce === held.nonce) {
          throw new LockHeldError(`The state directory ${stateDir} is locked by a cyberspace-mcp on this machine (host ${held.host}, pid ${held.pid}, started ${held.startedAt}) that this process cannot see (another container or pid namespace sharing the volume), and its heartbeat is live: it still runs. ${ONE_MOVER} Stop the other server, or give this one its own state directory.`)
        }
        continue // The lock changed hands meanwhile: judge the new one.
      }
      verdict = { kind: 'stale', reason: 'silent', detail: `${verdict.detail}, its heartbeat silent for ${Math.round(watchMs / 1000)} s` }
    }
    const kept = moveAside(path, raw!, verdict.reason)
    if (kept) log(`lock: took over the lock ${verdict.detail} (${verdict.reason}); the old lock is kept as ${kept}`)
  }
  throw new LockHeldError(`Could not take the lock on ${stateDir}: another server took it first.`)
}

/** Move the stale lock to lock.stale-<when>-<reason>, never deleting it, and return where; null when it was gone already. Throws when the file moved was not the one judged. */
function moveAside(path: string, judged: string, reason: string): string | null {
  const taking = `${path}.taking-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    renameSync(path, taking)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null // Gone meanwhile: the next attempt says who holds it.
    throw err
  }
  if (readOr(taking) !== judged) {
    // Somebody else's fresh lock, taken in a race: put it back, never over a newer one.
    try { linkSync(taking, path); unlinkSync(taking) } catch { /* left as lock.taking-*, named below */ }
    throw new LockHeldError(`Could not take the lock on ${dirname(path)}: another server took it first${existsSync(taking) ? ` (its lock is kept as ${taking})` : ''}.`)
  }
  const kept = asideName(path, 'stale', reason)
  renameSync(taking, kept)
  return kept
}

/** The heartbeat, in a worker so a busy main thread (a long hop) never silences it: it touches the lock while the lock is still ours. */
const HEARTBEAT_WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const { path, mine, everyMs } = workerData
const timer = setInterval(() => {
  try {
    if (fs.readFileSync(path, 'utf8') !== mine) { clearInterval(timer); parentPort.postMessage('lost'); return }
    const now = new Date()
    fs.utimesSync(path, now, now)
  } catch { clearInterval(timer); parentPort.postMessage('lost') }
}, everyMs)
`

function armRelease(path: string, mine: string, nonce: string, heartbeatMs: number, log: (line: string) => void): () => void {
  let worker: Worker | null = null
  if (heartbeatMs > 0) {
    worker = new Worker(HEARTBEAT_WORKER, { eval: true, workerData: { path, mine, everyMs: heartbeatMs } })
    worker.unref()
    worker.on('message', (m) => { if (m === 'lost') log(`lock: WARNING: ${path} is no longer this server's lock; its heartbeat stopped. Stop this server before anything else moves for this key.`) })
    worker.on('error', (err) => log(`lock: heartbeat stopped: ${err.message}`))
  }
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    if (worker) void worker.terminate()
    try {
      if (parseLock(readOr(path))?.nonce === nonce) unlinkSync(path)
    } catch { /* already gone */ }
    process.off('exit', release)
  }
  process.on('exit', release)
  return release
}

/** For doctor: this machine's id (read only) and what the lock means, one line each. */
export function describeLock(stateDir: string, opts: { machineId?: string; env?: NodeJS.ProcessEnv } = {}): { machine: MachineId; judgment: Judgment; held: LockRecord | null } {
  const machine = resolveMachineId(stateDir, { explicit: opts.machineId, env: opts.env, create: false })
  const raw = readOr(join(stateDir, 'lock'))
  const me: Me = { host: hostname(), machineId: machine.id, bootId: bootId(), pidNs: pidNs() }
  return { machine, judgment: judgeLock(join(stateDir, 'lock'), stateDir, raw, me), held: parseLock(raw) }
}
