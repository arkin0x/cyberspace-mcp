// lock.test.ts: one key, one mover. A second lock on the same state
// directory is refused with a plain message while the first is held, and a
// released lock can be taken again. The lock records this machine's id
// (lock.ts), so a lock this machine left behind is taken back by itself
// after a restart: a dead pid, a pid now held by another process, or (when
// the pid cannot be seen from here: a previous boot of a container) a
// silent heartbeat; the old lock is kept as lock.stale-*, never deleted. A
// live owner, another machine's lock, and an older lock from another host
// are refused. The machine id lives beside the state directory, persists,
// is replaced when the file is a copy, and yields to the flag and the
// environment. The key file is created once, mode 600, as JSON with the
// server's marker, loaded unchanged, and a key somebody else placed there
// (an nsec, a bare hex secret, JSON without the marker) is refused.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from '../src/nostr/event.js'
import { ForeignKeyError, KEY_GENERATED_BY, LockHeldError, StateDir } from '../src/state/dir.js'
import { describeLock, machineIdPath, MACHINE_ID_ENV, procStart, resolveMachineId } from '../src/state/lock.js'

const fresh = (): string => mkdtempSync(join(tmpdir(), 'cyberspace-mcp-test-'))
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// A pid no process has: the largest pid Linux allows plus one is never live.
const DEAD_PID = 4194305
const hasProc = existsSync('/proc/self/stat')
const env = {} as NodeJS.ProcessEnv
const quiet = { env, heartbeatMs: 0 }

/** This process's boot and pid namespace, as a lock written here records them. */
const here = (): { bootId: string; pidNs: string } => ({
  bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
  pidNs: readlinkSync('/proc/self/ns/pid'),
})

const staleFiles = (path: string): string[] => readdirSync(path).filter((f) => f.startsWith('lock.stale-'))

/** A child that just sleeps, standing in for a live serve; killed by its own pid. */
async function sleeper(): Promise<{ pid: number; kill: () => void }> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 100))
  return { pid: child.pid!, kill: () => { try { process.kill(child.pid!, 'SIGKILL') } catch { /* gone */ } } }
}

describe('the state directory lock', () => {
  it('refuses a second mover while the first holds the lock, and records the machine id', async () => {
    const path = fresh()
    const dir = StateDir.open(path)
    const release = await dir.lock(quiet)
    const held = JSON.parse(readFileSync(join(path, 'lock'), 'utf8'))
    expect(held.pid).toBe(process.pid)
    expect(held.machineId).toBe(resolveMachineId(path, { env }).id)
    await expect(dir.lock(quiet)).rejects.toThrow(LockHeldError)
    await expect(dir.lock(quiet)).rejects.toThrow(/One key has one mover/)
    release()
    expect(existsSync(join(path, 'lock'))).toBe(false)
    const again = await dir.lock(quiet)
    again()
  })

  it('takes over an older lock (no machine id) left on this host by a process that no longer exists', async () => {
    const path = fresh()
    const dir = StateDir.open(path)
    const old = JSON.stringify({ pid: DEAD_PID, startedAt: 'long ago', host: hostname() })
    writeFileSync(join(path, 'lock'), old)
    const release = await dir.lock(quiet)
    expect(JSON.parse(readFileSync(join(path, 'lock'), 'utf8')).pid).toBe(process.pid)
    const kept = staleFiles(path)
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatch(/^lock\.stale-\d{4}-\d\d-\d\dT\d{6}Z-pid-gone$/)
    expect(readFileSync(join(path, kept[0]), 'utf8')).toBe(old)
    release()
  })

  it('never takes over an older lock from another host, names the host and the file, and says newer versions recover by themselves', async () => {
    const path = fresh()
    const dir = StateDir.open(path)
    writeFileSync(join(path, 'lock'), JSON.stringify({ pid: DEAD_PID, startedAt: 'long ago', host: 'DCHA5U3M25QNOJMFT5GQQ3ZRWP2VOXIF' }))
    await expect(dir.lock(quiet)).rejects.toThrow(LockHeldError)
    await expect(dir.lock(quiet)).rejects.toThrow(/another host \(DCHA5U3M25QNOJMFT5GQQ3ZRWP2VOXIF/)
    await expect(dir.lock(quiet)).rejects.toThrow(new RegExp(escape(join(path, 'lock'))))
    await expect(dir.lock(quiet)).rejects.toThrow(/older cyberspace-mcp, which records no machine id; locks written by this version are recovered by themselves/)
    expect(staleFiles(path)).toEqual([])
  })

  it('never takes over a lock from another machine, even with a dead pid on this host name', async () => {
    const path = fresh()
    const dir = StateDir.open(path)
    writeFileSync(join(path, 'lock'), JSON.stringify({ pid: DEAD_PID, startedAt: 'long ago', host: hostname(), machineId: 'another-machine', ...(hasProc ? here() : {}) }))
    await expect(dir.lock(quiet)).rejects.toThrow(LockHeldError)
    await expect(dir.lock(quiet)).rejects.toThrow(/on another machine \(machine id another-machine/)
    await expect(dir.lock(quiet)).rejects.toThrow(new RegExp(`this machine's id is ${escape(resolveMachineId(path, { env }).id!)}`))
    expect(staleFiles(path)).toEqual([])
  })

  it.skipIf(!hasProc)('takes over a lock this machine left with a dead pid: renamed aside, never deleted, logged in one line', async () => {
    const path = fresh()
    const dir = StateDir.open(path)
    const id = resolveMachineId(path, { env, create: true }).id!
    const old = JSON.stringify({ pid: DEAD_PID, startedAt: 'long ago', host: 'DCHA5U3M25QNOJMFT5GQQ3ZRWP2VOXIF', machineId: id, ...here(), procStart: '1', heartbeatMs: 10_000, nonce: 'old' })
    writeFileSync(join(path, 'lock'), old)
    const lines: string[] = []
    const release = await dir.lock({ ...quiet, log: (l) => lines.push(l) })
    expect(JSON.parse(readFileSync(join(path, 'lock'), 'utf8')).pid).toBe(process.pid)
    const kept = staleFiles(path)
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatch(/-pid-gone$/)
    expect(readFileSync(join(path, kept[0]), 'utf8')).toBe(old)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`pid ${DEAD_PID}`)
    expect(lines[0]).toContain(kept[0])
    release()
  })

  it.skipIf(!hasProc)('refuses a lock this machine holds with a live serve, and takes over one whose pid is now another process', async () => {
    const path = fresh()
    const dir = StateDir.open(path)
    const id = resolveMachineId(path, { env, create: true }).id!
    const live = await sleeper()
    try {
      // The pid and its start time agree: the owner runs.
      writeFileSync(join(path, 'lock'), JSON.stringify({ pid: live.pid, startedAt: 'now', host: hostname(), machineId: id, ...here(), procStart: procStart(live.pid), nonce: 'live' }))
      await expect(dir.lock(quiet)).rejects.toThrow(new RegExp(`Another cyberspace-mcp already holds .*pid ${live.pid}.*on this machine`))
      expect(staleFiles(path)).toEqual([])
      // The same pid with another start time: the owner died and the pid was given to a younger process.
      writeFileSync(join(path, 'lock'), JSON.stringify({ pid: live.pid, startedAt: 'before the restart', host: hostname(), machineId: id, ...here(), procStart: '1', nonce: 'reused' }))
      const release = await dir.lock(quiet)
      expect(staleFiles(path)[0]).toMatch(/-pid-reused$/)
      release()
    } finally {
      live.kill()
    }
  })

  it.skipIf(!hasProc)('takes over this machine\'s lock from a previous boot once its heartbeat is silent, and refuses while it beats', async () => {
    const path = fresh()
    const dir = StateDir.open(path)
    const id = resolveMachineId(path, { env, create: true }).id!
    // A previous boot of the container: another pid namespace, a new host name, and a pid that may well be live again here.
    const before = { pid: process.pid, startedAt: 'before the restart', host: 'DCHA5U3M25QNOJMFT5GQQ3ZRWP2VOXIF', machineId: id, bootId: here().bootId, pidNs: 'pid:[1]', procStart: '1', heartbeatMs: 20, nonce: 'before' }

    // Another container on the same volume, still running: it touches the lock, so this one refuses.
    writeFileSync(join(path, 'lock'), JSON.stringify(before))
    const beat = setInterval(() => { const t = new Date(); utimesSync(join(path, 'lock'), t, t) }, 10)
    try {
      await expect(dir.lock({ ...quiet, silenceMs: 150 })).rejects.toThrow(/cannot see .*its heartbeat is live/)
    } finally {
      clearInterval(beat)
    }
    expect(staleFiles(path)).toEqual([])

    // The previous boot: nothing touches it.
    const lines: string[] = []
    const release = await dir.lock({ ...quiet, silenceMs: 150, log: (l) => lines.push(l) })
    expect(JSON.parse(readFileSync(join(path, 'lock'), 'utf8')).nonce).not.toBe('before')
    expect(staleFiles(path)[0]).toMatch(/-silent$/)
    expect(lines.some((l) => l.includes('watching its heartbeat'))).toBe(true)
    expect(lines.some((l) => l.includes('took over'))).toBe(true)
    release()
  })

  it('touches its own lock while held, and a release removes only its own lock', async () => {
    const path = fresh()
    const dir = StateDir.open(path)
    const release = await dir.lock({ env, heartbeatMs: 20 })
    const lock = join(path, 'lock')
    const past = new Date(Date.now() - 3_600_000)
    utimesSync(lock, past, past)
    await new Promise((r) => setTimeout(r, 300))
    expect(statSync(lock).mtimeMs).toBeGreaterThan(past.getTime() + 1000)
    // Somebody else's lock in its place is never removed by this release.
    const other = JSON.stringify({ pid: DEAD_PID, startedAt: 'x', host: hostname(), nonce: 'other' })
    renameSync(lock, join(path, 'mine.aside'))
    writeFileSync(lock, other)
    release()
    expect(readFileSync(lock, 'utf8')).toBe(other)
  })
})

describe('the machine id', () => {
  it('is made once beside the state directory, never inside it, mode 600, and persists across runs', async () => {
    const path = fresh()
    const first = resolveMachineId(path, { env, create: true })
    expect(first.source).toBe('new file')
    expect(first.path).toBe(`${path}.machine-id`)
    expect(machineIdPath(`${path}/`)).toBe(`${path}.machine-id`)
    expect(statSync(`${path}.machine-id`).mode & 0o777).toBe(0o600)
    expect(existsSync(join(path, 'machine-id'))).toBe(false)
    const second = resolveMachineId(path, { env, create: true })
    expect(second).toEqual({ id: first.id, source: 'file', path: `${path}.machine-id` })
    // A lock taken and released, then taken again: the same id each time.
    const dir = StateDir.open(path)
    ;(await dir.lock(quiet))()
    const release = await dir.lock(quiet)
    expect(JSON.parse(readFileSync(join(path, 'lock'), 'utf8')).machineId).toBe(first.id)
    release()
  })

  it('is replaced, never reused, when the file is a copy from elsewhere (a sync, a cp, a restore)', () => {
    const path = fresh()
    const made = resolveMachineId(path, { env, create: true })
    const file = `${path}.machine-id`
    const content = readFileSync(file, 'utf8')
    // A copy has the same bytes and another inode.
    renameSync(file, `${file}.orig`)
    writeFileSync(file, content, { mode: 0o600 })
    expect(resolveMachineId(path, { env }).id).toBeNull()
    const again = resolveMachineId(path, { env, create: true })
    expect(again.id).not.toBe(made.id)
    expect(again.note).toMatch(/was a copy from elsewhere/)
    expect(readdirSync(join(path, '..')).some((f) => f.startsWith(`${path.split('/').pop()}.machine-id.copied-`))).toBe(true)
  })

  it('yields to the environment, and the flag to both, and refuses a malformed one', async () => {
    const path = fresh()
    expect(resolveMachineId(path, { env: { [MACHINE_ID_ENV]: 'xor-box' }, create: true })).toEqual({ id: 'xor-box', source: 'env' })
    expect(resolveMachineId(path, { explicit: 'from-flag', env: { [MACHINE_ID_ENV]: 'xor-box' }, create: true })).toEqual({ id: 'from-flag', source: 'flag' })
    expect(existsSync(`${path}.machine-id`)).toBe(false)
    expect(() => resolveMachineId(path, { explicit: 'has space' })).toThrow(/--machine-id must be/)
    expect(() => resolveMachineId(path, { env: { [MACHINE_ID_ENV]: 'a/b' } })).toThrow(new RegExp(`\\$${MACHINE_ID_ENV} must be`))
    const dir = StateDir.open(path)
    const release = await dir.lock({ ...quiet, machineId: 'from-flag' })
    expect(JSON.parse(readFileSync(join(path, 'lock'), 'utf8')).machineId).toBe('from-flag')
    release()
    // A lock left under another id, by a process that is gone, is another machine's: refused.
    writeFileSync(join(path, 'lock'), JSON.stringify({ pid: DEAD_PID, startedAt: 'x', host: hostname(), machineId: 'from-flag', ...(hasProc ? here() : {}) }))
    await expect(dir.lock({ ...quiet, env: { [MACHINE_ID_ENV]: 'xor-box' } })).rejects.toThrow(/another machine \(machine id from-flag/)
  })

  it('doctor reads it and the lock without writing anything', async () => {
    const path = fresh()
    StateDir.open(path)
    expect(describeLock(path, { env })).toMatchObject({ machine: { id: null, source: 'none', path: `${path}.machine-id` }, judgment: { kind: 'free' } })
    expect(existsSync(`${path}.machine-id`)).toBe(false)
    const release = await StateDir.open(path).lock(quiet)
    const seen = describeLock(path, { env })
    expect(seen.machine.source).toBe('file')
    expect(seen.judgment).toMatchObject({ kind: 'ours' })
    release()
    writeFileSync(join(path, 'lock'), JSON.stringify({ pid: DEAD_PID, startedAt: 'x', host: 'elsewhere' }))
    expect(describeLock(path, { env }).judgment).toMatchObject({ kind: 'held', here: false })
  })
})

describe('the key file', () => {
  it('is created once as JSON with the marker, mode 600, and loads the same key every time', () => {
    const path = fresh()
    const dir = StateDir.open(path)
    const first = dir.loadOrCreateKey()
    const mode = statSync(join(path, 'key')).mode & 0o777
    expect(mode).toBe(0o600)
    const file = JSON.parse(readFileSync(join(path, 'key'), 'utf8'))
    expect(file.generatedBy).toBe(KEY_GENERATED_BY)
    expect(file.secret).toBe(bytesToHex(first))
    const second = dir.loadOrCreateKey()
    expect(getPublicKey(second)).toBe(getPublicKey(first))
  })

  it('refuses an nsec, a bare hex secret, and JSON without the marker, citing the rule', () => {
    const sk = generateSecretKey()
    for (const content of [
      'nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      bytesToHex(sk),
      JSON.stringify({ secret: bytesToHex(sk) }),
      JSON.stringify({ generatedBy: 'someone-else', secret: bytesToHex(sk) }),
    ]) {
      const path = fresh()
      const dir = StateDir.open(path)
      writeFileSync(join(path, 'key'), content, { mode: 0o600 })
      expect(() => dir.loadOrCreateKey()).toThrow(ForeignKeyError)
      expect(() => dir.loadOrCreateKey()).toThrow(/never takes a human's key/)
    }
  })

  it('writes JSON atomically and reads it back', () => {
    const dir = StateDir.open(fresh())
    dir.writeJson('thing.json', { a: 1 })
    expect(dir.readJson('thing.json', null)).toEqual({ a: 1 })
    expect(dir.readJson('missing.json', 'fallback')).toBe('fallback')
  })
})
