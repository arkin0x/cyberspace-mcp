// lock.test.ts: one key, one mover. A second lock on the same state
// directory is refused with a plain message while the first is held, and a
// released lock can be taken again. The lock records this machine's id
// (lock.ts), so a lock this machine left behind is taken back by itself
// after a restart: a dead pid, a zombie, a pid now held by another process,
// or (when the pid cannot be seen from here: a previous boot of a
// container) a silent heartbeat; the old lock is kept as lock.stale-*,
// never deleted, under a claim. A live owner, another machine's lock, and
// an older lock from another host are refused. The lock is a lease: an
// owner paused past its fence, or whose heartbeat cannot touch the lock,
// or whose lock was taken over, signs nothing more and exits. Real second
// processes (test/fixtures/lockOwner.ts) play the other servers, in a pid
// namespace of their own with unshare where the machine allows it. The
// machine id lives beside the state directory, persists, is replaced when
// the file is a copy, and yields to the flag and the environment. The key
// file is created once, mode 600, as JSON with the server's marker, loaded
// unchanged, and a key somebody else placed there (an nsec, a bare hex
// secret, JSON without the marker) is refused.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Agent } from '../src/agent.js'
import { bytesToHex } from '../src/nostr/event.js'
import { ForeignKeyError, KEY_GENERATED_BY, LockHeldError, LockLostError, StateDir } from '../src/state/dir.js'
import { checkLease, describeLock, machineIdPath, MACHINE_ID_ENV, moveAside, procStart, resolveMachineId, takeLock, takeOver } from '../src/state/lock.js'
import { RideCache } from '../src/hyperspace/rideCache.js'
import { FakeNetwork } from './fakeRelay.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(REPO, 'test', 'fixtures', 'lockOwner.ts')
const made: string[] = []
const fresh = (): string => { const d = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-test-')); made.push(d); return d }
// The machine id files these tests make beside their directories, and their copies, go with them.
afterAll(() => {
  for (const d of made) {
    try { chmodSync(dirname(d), 0o700) } catch { /* not ours */ }
    for (const f of readdirSync(dirname(d))) if (f.startsWith(`${basename(d)}.machine-id`)) rmSync(join(dirname(d), f), { force: true })
  }
})
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// A pid no process has: the largest pid Linux allows plus one is never live.
const DEAD_PID = 4194305
const hasProc = existsSync('/proc/self/stat')
const hasUnshare = hasProc && spawnSync('unshare', ['-Urpf', '--mount-proc', 'true']).status === 0
const env = {} as NodeJS.ProcessEnv
const quiet = { env, heartbeatMs: 0 }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** This process's boot and pid namespace, as a lock written here records them. */
const here = (): { bootId: string; pidNs: string } => ({
  bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
  pidNs: readlinkSync('/proc/self/ns/pid'),
})

const staleFiles = (path: string): string[] => readdirSync(path).filter((f) => f.startsWith('lock.stale-'))
const lockOf = (path: string): { pid: number; nonce?: string; machineId?: string } => JSON.parse(readFileSync(join(path, 'lock'), 'utf8'))

/** A real second server (test/fixtures/lockOwner.ts), in its own pid namespace with ns: true. Killed by its own pid. */
interface Owner {
  child: ChildProcess
  lines: string[]
  exit: Promise<number | null>
  waitFor: (re: RegExp, ms?: number) => Promise<string>
  count: (re: RegExp) => number
  kill: () => void
}
function owner(stateDir: string, opts: Record<string, unknown> = {}, ns = false): Owner {
  const args = ['--import', 'tsx', FIXTURE, stateDir, JSON.stringify(opts)]
  const child = ns
    ? spawn('unshare', ['-Urpf', '--mount-proc', '--kill-child', process.execPath, ...args], { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] })
    : spawn(process.execPath, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] })
  const lines: string[] = []
  let buf = ''
  child.stdout!.on('data', (b: Buffer) => {
    buf += b.toString('utf8')
    const parts = buf.split('\n')
    buf = parts.pop()!
    lines.push(...parts)
  })
  const exit = new Promise<number | null>((r) => child.on('exit', (c) => r(c)))
  return {
    child,
    lines,
    exit,
    count: (re) => lines.filter((l) => re.test(l)).length,
    waitFor: async (re, ms = 20_000) => {
      const until = Date.now() + ms
      for (;;) {
        const hit = lines.find((l) => re.test(l))
        if (hit) return hit
        if (Date.now() > until) throw new Error(`no line matching ${re} in ${ms} ms; got:\n${lines.join('\n')}`)
        await sleep(25)
      }
    },
    kill: () => { if (child.exitCode === null && child.pid) { try { process.kill(child.pid, 'SIGKILL') } catch { /* gone */ } } },
  }
}

describe('the state directory lock', () => {
  it('refuses a second mover while the first holds the lock, and records the machine id', async () => {
    const path = fresh()
    const dir = StateDir.open(path)
    const held = await dir.lock(quiet)
    expect(lockOf(path).pid).toBe(process.pid)
    expect(lockOf(path).machineId).toBe(resolveMachineId(path, { env }).id)
    await expect(dir.lock(quiet)).rejects.toThrow(LockHeldError)
    await expect(dir.lock(quiet)).rejects.toThrow(/One key has one mover/)
    held.release()
    expect(existsSync(join(path, 'lock'))).toBe(false)
    ;(await dir.lock(quiet)).release()
  })

  it('takes over an older lock (no machine id) left on this host by a process that no longer exists', async () => {
    const path = fresh()
    const dir = StateDir.open(path)
    const old = JSON.stringify({ pid: DEAD_PID, startedAt: 'long ago', host: hostname() })
    writeFileSync(join(path, 'lock'), old)
    const held = await dir.lock(quiet)
    expect(lockOf(path).pid).toBe(process.pid)
    const kept = staleFiles(path)
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatch(/^lock\.stale-\d{4}-\d\d-\d\dT\d{6}Z-pid-gone$/)
    expect(readFileSync(join(path, kept[0]), 'utf8')).toBe(old)
    held.release()
  })

  it('never takes over an older lock from another host, names the host and the file, and says newer versions recover by themselves', async () => {
    const path = fresh()
    const dir = StateDir.open(path)
    writeFileSync(join(path, 'lock'), JSON.stringify({ pid: DEAD_PID, startedAt: 'long ago', host: 'DCHA5U3M25QNOJMFT5GQQ3ZRWP2VOXIF' }))
    await expect(dir.lock(quiet)).rejects.toThrow(LockHeldError)
    await expect(dir.lock(quiet)).rejects.toThrow(/another host \(pid 4194305 on host DCHA5U3M25QNOJMFT5GQQ3ZRWP2VOXIF/)
    await expect(dir.lock(quiet)).rejects.toThrow(new RegExp(escape(join(path, 'lock'))))
    await expect(dir.lock(quiet)).rejects.toThrow(/older cyberspace-mcp, which records no machine id; locks written by this version are recovered by themselves/)
    expect(staleFiles(path)).toEqual([])
  })

  it('never takes over a lock from another machine, even with a dead pid on this host name', async () => {
    const path = fresh()
    const dir = StateDir.open(path)
    writeFileSync(join(path, 'lock'), JSON.stringify({ pid: DEAD_PID, startedAt: 'long ago', host: hostname(), machineId: 'another-machine', ...(hasProc ? here() : {}) }))
    await expect(dir.lock(quiet)).rejects.toThrow(LockHeldError)
    await expect(dir.lock(quiet)).rejects.toThrow(/on another machine \(pid 4194305 on host .*, machine id another-machine/)
    await expect(dir.lock(quiet)).rejects.toThrow(new RegExp(`this machine's id is ${escape(resolveMachineId(path, { env }).id!)}`))
    expect(staleFiles(path)).toEqual([])
  })

  it.skipIf(!hasProc)('takes over a lock this machine left with a dead pid: moved aside, never deleted, logged with the machine id and host', async () => {
    const path = fresh()
    const dir = StateDir.open(path)
    const id = resolveMachineId(path, { env, create: true }).id!
    const old = JSON.stringify({ pid: DEAD_PID, startedAt: 'long ago', host: 'DCHA5U3M25QNOJMFT5GQQ3ZRWP2VOXIF', machineId: id, ...here(), procStart: '1', heartbeatMs: 10_000, nonce: 'old' })
    writeFileSync(join(path, 'lock'), old)
    const lines: string[] = []
    const held = await dir.lock({ ...quiet, log: (l) => lines.push(l) })
    expect(lockOf(path).pid).toBe(process.pid)
    const kept = staleFiles(path)
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatch(/-pid-gone$/)
    expect(readFileSync(join(path, kept[0]), 'utf8')).toBe(old)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`pid ${DEAD_PID} on host DCHA5U3M25QNOJMFT5GQQ3ZRWP2VOXIF, machine id ${id}`)
    expect(lines[0]).toContain(`pid ${process.pid} on host ${hostname()}, machine id ${id} took over`)
    expect(lines[0]).toContain(kept[0])
    expect(existsSync(join(path, 'lock.claim'))).toBe(false)
    held.release()
  })

  it.skipIf(!hasProc)('refuses a lock this machine holds with a live serve, and takes over one whose pid is now another process', async () => {
    const path = fresh()
    const dir = StateDir.open(path)
    const id = resolveMachineId(path, { env, create: true }).id!
    const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      await sleep(100)
      // The pid and its start time agree: the owner runs.
      writeFileSync(join(path, 'lock'), JSON.stringify({ pid: live.pid, startedAt: 'now', host: hostname(), machineId: id, ...here(), procStart: procStart(live.pid!), nonce: 'live' }))
      await expect(dir.lock(quiet)).rejects.toThrow(new RegExp(`Another cyberspace-mcp already holds .*pid ${live.pid}.*on this machine`))
      expect(staleFiles(path)).toEqual([])
      // The same pid with another start time: the owner died and the pid was given to a younger process.
      writeFileSync(join(path, 'lock'), JSON.stringify({ pid: live.pid, startedAt: 'before the restart', host: hostname(), machineId: id, ...here(), procStart: '1', nonce: 'reused' }))
      ;(await dir.lock(quiet)).release()
      expect(staleFiles(path)[0]).toMatch(/-pid-reused$/)
    } finally {
      try { process.kill(live.pid!, 'SIGKILL') } catch { /* gone */ }
    }
  })

  it.skipIf(!hasProc)('takes over a lock whose owner is a zombie (exited, never reaped: pid 1 in a container may never reap)', async () => {
    const path = fresh()
    const dir = StateDir.open(path)
    const id = resolveMachineId(path, { env, create: true }).id!
    // The shell's background child is never reaped once the shell becomes sleep 30: a zombie.
    const parent = spawn('sh', ['-c', 'sleep 0.1 & echo $!; exec sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] })
    try {
      const zpid = Number(await new Promise<string>((r) => parent.stdout!.once('data', (b: Buffer) => r(b.toString().trim()))))
      let state = ''
      for (let i = 0; i < 100 && state !== 'Z'; i++) {
        await sleep(30)
        const raw = readFileSync(`/proc/${zpid}/stat`, 'utf8')
        state = raw.slice(raw.lastIndexOf(')') + 2).split(' ')[0]
      }
      expect(state).toBe('Z')
      writeFileSync(join(path, 'lock'), JSON.stringify({ pid: zpid, startedAt: 'now', host: hostname(), machineId: id, ...here(), procStart: procStart(zpid), nonce: 'zombie' }))
      ;(await dir.lock(quiet)).release()
      expect(staleFiles(path)[0]).toMatch(/-pid-zombie$/)
    } finally {
      try { process.kill(parent.pid!, 'SIGKILL') } catch { /* gone */ }
    }
  })

  it.skipIf(!hasProc)('in-process: takes over this machine\'s lock from another pid namespace once its heartbeat is silent, and refuses while it beats', async () => {
    const path = fresh()
    const dir = StateDir.open(path)
    const id = resolveMachineId(path, { env, create: true }).id!
    const before = { pid: process.pid, startedAt: 'before the restart', host: 'DCHA5U3M25QNOJMFT5GQQ3ZRWP2VOXIF', machineId: id, bootId: here().bootId, pidNs: 'pid:[1]', procStart: '1', heartbeatMs: 20, nonce: 'before' }
    writeFileSync(join(path, 'lock'), JSON.stringify(before))
    const beat = setInterval(() => { const t = new Date(); utimesSync(join(path, 'lock'), t, t) }, 10)
    try {
      await expect(dir.lock({ ...quiet, silenceMs: 150 })).rejects.toThrow(/cannot see .*its heartbeat is live/)
    } finally {
      clearInterval(beat)
    }
    expect(staleFiles(path)).toEqual([])
    const lines: string[] = []
    const held = await dir.lock({ ...quiet, silenceMs: 150, log: (l) => lines.push(l) })
    expect(lockOf(path).nonce).not.toBe('before')
    expect(staleFiles(path)[0]).toMatch(/-silent$/)
    expect(lines.some((l) => l.includes('watching its heartbeat'))).toBe(true)
    expect(lines.some((l) => l.includes('took over'))).toBe(true)
    held.release()
  })

  it('touches its own lock while held, and a release removes only its own lock', async () => {
    const path = fresh()
    const dir = StateDir.open(path)
    const held = await dir.lock({ env, heartbeatMs: 20 })
    const lock = join(path, 'lock')
    const past = new Date(Date.now() - 3_600_000)
    utimesSync(lock, past, past)
    await sleep(300)
    expect(statSync(lock).mtimeMs).toBeGreaterThan(past.getTime() + 1000)
    // Somebody else's lock in its place is never removed by this release.
    const other = JSON.stringify({ pid: DEAD_PID, startedAt: 'x', host: hostname(), nonce: 'other' })
    renameSync(lock, join(path, 'mine.aside'))
    writeFileSync(lock, other)
    const ino = statSync(lock).ino
    held.release()
    expect(readFileSync(lock, 'utf8')).toBe(other)
    // Not even moved for a moment: its owner would take a missing lock for a lost one.
    expect(statSync(lock).ino).toBe(ino)
    expect(readdirSync(path).filter((f) => f.startsWith('lock.releasing-'))).toEqual([])
  })
})

describe('the lock is a lease: an owner that cannot show it holds it signs nothing', () => {
  it('an owner paused past its fence fences itself on resume: no signature after, exit 1 (two real processes)', async () => {
    const path = fresh()
    const a = owner(path, { heartbeatMs: 200, fenceMs: 1000 })
    try {
      await a.waitFor(/^SIGNED 3$/)
      process.kill(a.child.pid!, 'SIGSTOP')
      const before = a.count(/^SIGNED/)
      await sleep(1600)
      process.kill(a.child.pid!, 'SIGCONT')
      expect(await a.exit).toBe(1)
      expect(a.count(/^SIGNED/)).toBe(before)
      expect(a.lines.some((l) => /^LOST .*past the 1 s fence|^LOST its heartbeat could not be confirmed/.test(l))).toBe(true)
    } finally {
      a.kill()
    }
  })

  it.skipIf(!hasUnshare)('a paused owner whose lock was taken over in another pid namespace never signs beside the new owner (two real processes)', async () => {
    const path = fresh()
    const a = owner(path, { heartbeatMs: 200, fenceMs: 1000 })
    let b: Owner | null = null
    try {
      await a.waitFor(/^SIGNED 2$/)
      process.kill(a.child.pid!, 'SIGSTOP')
      const before = a.count(/^SIGNED/)
      // Another container on the same volume: it cannot see A's pid, so it watches A's heartbeat, which is silent while A is paused.
      b = owner(path, { heartbeatMs: 200, fenceMs: 1000, silenceMs: 1500, holdMs: 6000 }, true)
      await b.waitFor(/^TAKEN/)
      expect(b.lines.some((l) => /took over .*\(silent\)/.test(l))).toBe(true)
      await b.waitFor(/^SIGNED 2$/)
      process.kill(a.child.pid!, 'SIGCONT')
      expect(await a.exit).toBe(1)
      expect(a.count(/^SIGNED/)).toBe(before)
      expect(a.lines.some((l) => /^LOST/.test(l))).toBe(true)
      // B goes on: it is the one mover.
      const bSigned = b.count(/^SIGNED/)
      await sleep(400)
      expect(b.count(/^SIGNED/)).toBeGreaterThan(bSigned)
      expect(b.count(/^REFUSED/)).toBe(0)
    } finally {
      a.kill()
      b?.kill()
    }
  })

  it('a heartbeat that fails for a moment retries and keeps the lease; one that cannot touch the lock fences the owner before a watcher could take it (two real processes)', async () => {
    const path = fresh()
    const a = owner(path, { heartbeatMs: 200, fenceMs: 1500 })
    const lock = join(path, 'lock')
    try {
      await a.waitFor(/^SIGNED 2$/)
      // Unreadable for 0.6 s: the beat fails, is retried every second at most, and mends.
      chmodSync(lock, 0o000)
      await sleep(600)
      chmodSync(lock, 0o600)
      await a.waitFor(/heartbeat touches .* again/, 5000)
      const mtime = statSync(lock).mtimeMs
      await sleep(600)
      expect(statSync(lock).mtimeMs).toBeGreaterThan(mtime)
      expect(a.count(/^LOST/)).toBe(0)
      const signed = a.count(/^SIGNED/)
      await sleep(300)
      expect(a.count(/^SIGNED/)).toBeGreaterThan(signed)
      // Unreadable for good: the owner fences itself within its 1.5 s fence (a watcher waits the fence plus 10 s at least).
      const t0 = Date.now()
      chmodSync(lock, 0o000)
      expect(await a.exit).toBe(1)
      expect(Date.now() - t0).toBeLessThan(4000)
      expect(a.lines.some((l) => /^LOST (its heartbeat could not be confirmed|its heartbeat was last confirmed .* past the \d+ s fence)/.test(l))).toBe(true)
      expect(a.lines.some((l) => /could not touch .* trying again every second/.test(l))).toBe(true)
    } finally {
      try { chmodSync(lock, 0o600) } catch { /* gone */ }
      a.kill()
    }
  })

  it('an owner whose lock was replaced finds out at its next signature and exits 1', async () => {
    const path = fresh()
    const a = owner(path, { heartbeatMs: 5000, fenceMs: 15000 })
    try {
      await a.waitFor(/^SIGNED 2$/)
      writeFileSync(join(path, 'lock'), JSON.stringify({ pid: DEAD_PID, startedAt: 'x', host: hostname(), nonce: 'somebody else' }))
      expect(await a.exit).toBe(1)
      // The next signature, or the heartbeat before it, finds the lock naming somebody else; nothing is signed after.
      expect(a.lines.some((l) => /^LOST the lock now names another owner/.test(l))).toBe(true)
      const lost = a.lines.findIndex((l) => l.startsWith('LOST'))
      expect(a.lines.slice(lost).some((l) => l.startsWith('SIGNED'))).toBe(false)
    } finally {
      a.kill()
    }
  })

  it('an owner whose lock file is gone (read twice in a row) stops signing and exits 1', async () => {
    const path = fresh()
    const a = owner(path, { heartbeatMs: 200, fenceMs: 5000 })
    try {
      await a.waitFor(/^SIGNED 2$/)
      renameSync(join(path, 'lock'), join(path, 'lock.moved-by-hand'))
      expect(await a.exit).toBe(1)
      expect(a.lines.some((l) => /^LOST the lock file is gone/.test(l))).toBe(true)
      const lost = a.lines.findIndex((l) => l.startsWith('LOST'))
      expect(a.lines.slice(lost).some((l) => l.startsWith('SIGNED'))).toBe(false)
    } finally {
      a.kill()
    }
  })

  it.skipIf(!hasProc)('many servers starting at once on a stale lock: exactly one takes it, and the lock names it (the S1 loop, real processes)', async () => {
    const path = fresh()
    StateDir.open(path)
    const id = resolveMachineId(path, { env, create: true }).id!
    const old = JSON.stringify({ pid: DEAD_PID, startedAt: 'long ago', host: hostname(), machineId: id, ...here(), procStart: '1', nonce: 'old' })
    writeFileSync(join(path, 'lock'), old)
    const startAt = Date.now() + 3000
    const all = Array.from({ length: 8 }, () => owner(path, { heartbeatMs: 200, fenceMs: 2000, holdMs: 6000, startAt }))
    try {
      for (const o of all) await o.waitFor(/^(TAKEN|HELD)/, 25_000)
      const winners = all.filter((o) => o.lines.some((l) => l.startsWith('TAKEN')))
      expect(winners).toHaveLength(1)
      expect(lockOf(path).pid).toBe(Number(winners[0].lines.find((l) => l.startsWith('TAKEN'))!.split(' ')[1]))
      expect(staleFiles(path)).toHaveLength(1)
      expect(readFileSync(join(path, staleFiles(path)[0]), 'utf8')).toBe(old)
      for (const o of all.filter((x) => x !== winners[0])) expect(await o.exit).toBe(3)
      expect(await winners[0].exit).toBe(0)
      expect(winners[0].count(/^REFUSED/)).toBe(0)
    } finally {
      for (const o of all) o.kill()
    }
  }, 60_000)

  it.skipIf(!hasUnshare)('with no machine id, a lock from another pid namespace is watched, never taken at once: refused while it beats, taken when silent (real processes)', async () => {
    // The machine id file cannot be written (its directory is read-only), so neither server has an id: the host decides.
    const parent = fresh()
    const path = join(parent, 'state')
    mkdirSync(path, { mode: 0o700 })
    chmodSync(parent, 0o500)
    const a = owner(path, { heartbeatMs: 200, fenceMs: 1000 })
    let b: Owner | null = null
    let c: Owner | null = null
    try {
      await a.waitFor(/^TAKEN/)
      expect(a.lines.some((l) => /could not be written/.test(l))).toBe(true)
      expect(lockOf(path).machineId).toBeUndefined()
      b = owner(path, { silenceMs: 1500 }, true)
      await b.waitFor(/^HELD .*its heartbeat is live/)
      expect(b.lines.some((l) => /watching its heartbeat/.test(l))).toBe(true)
      expect(await b.exit).toBe(3)
      // A dies without a word (the container stopped): its lock stays, and nothing touches it.
      process.kill(a.child.pid!, 'SIGKILL')
      await a.exit
      c = owner(path, { silenceMs: 1500, holdMs: 1000 }, true)
      await c.waitFor(/^TAKEN/)
      expect(c.lines.some((l) => /took over .*\(silent\)/.test(l))).toBe(true)
      expect(await c.exit).toBe(0)
    } finally {
      chmodSync(parent, 0o700)
      a.kill()
      b?.kill()
      c?.kill()
    }
  })

  it('an agent that lost its lock signs and publishes nothing, writes nothing, and says so once', async () => {
    const network = new FakeNetwork()
    const relay = network.add('wss://canonical.example')
    const path = fresh()
    const agent = await Agent.start({
      stateDir: path, relays: ['wss://canonical.example'], capCallSeconds: 30, capSessionSeconds: 120, maxSidestepHeight: 24, allowRespawn: false,
      websocketImplementation: network.WebSocket, relayMaxWaitMs: 1500, ordersPollMs: 0, machineId: 'agent-test',
      calibration: { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10 }, sha256PerSec: 2_000_000 },
    })
    const lost: string[] = []
    agent.onLockLost((r) => lost.push(r))
    try {
      writeFileSync(join(path, 'lock'), JSON.stringify({ pid: DEAD_PID, startedAt: 'x', host: hostname(), machineId: 'agent-test', nonce: 'somebody else' }))
      const published = relay.published.length
      await expect(agent.identity({ name: 'courier' })).rejects.toThrow(LockLostError)
      expect(lost).toHaveLength(1)
      expect(lost[0]).toMatch(/names another owner/)
      expect(relay.published.length).toBe(published)
      expect(() => StateDir.open(path).writeJson('probe.json', {})).not.toThrow()
      expect(() => (agent as unknown as { dir: StateDir }).dir.writeJson('profile.json', {})).toThrow(LockLostError)
      // The writes that do not go through writeJson: the waker's, flight.json, the line and the ride cache, all behind the same guard.
      expect(() => agent.guardWrite('write wake-work.json')).toThrow(LockLostError)
      const transit = (agent as unknown as { transit: { dir: StateDir; runner: { cache: RideCache }; store: { guard: (w: string) => void } } }).transit
      expect(transit.dir).toBe((agent as unknown as { dir: StateDir }).dir)
      expect(() => transit.store.guard('write the hyperspace line')).toThrow(LockLostError)
      expect(() => transit.runner.cache.appendLeaves('a'.repeat(64), [{ height: 1, leafHex: 'b'.repeat(64) }])).toThrow(LockLostError)
      expect(existsSync(join(path, 'rides', 'leaves', `${'a'.repeat(64)}.log`))).toBe(false)
    } finally {
      await agent.stop().catch(() => {})
      rmSync(join(path, 'lock'), { force: true })
    }
  })
})

describe('the guards on every other write', () => {
  it('a lease another thread checks: live while held, refused once released, and once its beat is older than the fence', async () => {
    const path = fresh()
    const held = await StateDir.open(path).lock({ env, heartbeatMs: 0, fenceMs: 150 })
    const view = held.view()
    expect(() => checkLease(view, 'write the ride cache')).not.toThrow()
    await sleep(250)
    expect(() => checkLease(view, 'write the ride cache')).toThrow(LockLostError)
    held.release()
    const again = await StateDir.open(path).lock({ env, heartbeatMs: 50 })
    const live = again.view()
    await sleep(200)
    expect(() => checkLease(live, 'write the ride cache')).not.toThrow()
    again.release()
    expect(() => checkLease(live, 'write the ride cache')).toThrow(/no longer holds/)
  })

  it('the ride cache, the waker\'s files and remove() all stop at the guard, leaving the files as they were', () => {
    const path = fresh()
    let lost = false
    const guard = (what: string): void => { if (lost) throw new LockLostError(`Refused to ${what}`) }
    const cache = RideCache.open(join(path, 'rides'), guard)
    cache.appendLeaves('c'.repeat(64), [{ height: 1, leafHex: 'd'.repeat(64) }])
    const dir = StateDir.open(path)
    dir.useGuard(guard)
    dir.writeJson('wake-work.json', { open: true })
    lost = true
    expect(() => cache.appendLeaves('c'.repeat(64), [{ height: 2, leafHex: 'd'.repeat(64) }])).toThrow(/Refused to write the ride cache/)
    expect(() => cache.forget('c'.repeat(64))).toThrow(LockLostError)
    expect(readFileSync(join(path, 'rides', 'leaves', `${'c'.repeat(64)}.log`), 'utf8').trim().split('\n')).toHaveLength(1)
    expect(() => dir.remove('wake-work.json')).toThrow(/Refused to remove wake-work.json/)
    expect(() => dir.writeJson('wake-work.json', {})).toThrow(LockLostError)
    expect(JSON.parse(readFileSync(join(path, 'wake-work.json'), 'utf8'))).toEqual({ open: true })
  })
})

describe('taking a lock over', () => {
  it.skipIf(!hasProc)('a fresh lock that lands between the check and the move is put back, never kept aside, and the taker judges again', () => {
    const path = fresh()
    StateDir.open(path)
    const lock = join(path, 'lock')
    const old = JSON.stringify({ pid: DEAD_PID, startedAt: 'long ago', host: hostname(), nonce: 'old' })
    writeFileSync(lock, old)
    const judged = { raw: old, mtime: statSync(lock, { bigint: true }).mtimeNs, inode: statSync(lock, { bigint: true }).ino }
    // A taker paused inside a claim another took from it as abandoned: the other's fresh lock is at `lock` when it moves.
    const fresh2 = JSON.stringify({ pid: process.pid, startedAt: 'now', host: hostname(), nonce: 'fresh' })
    let published = false
    const r = takeOver(lock, judged, 'pid-gone', () => { published = true; return true }, {
      beforeMove: () => { renameSync(lock, join(path, 'old.elsewhere')); writeFileSync(lock, fresh2) },
    })
    expect(r).toBe('changed')
    expect(published).toBe(false)
    expect(readFileSync(lock, 'utf8')).toBe(fresh2)
    expect(staleFiles(path)).toEqual([])
    expect(readdirSync(path).filter((f) => f.startsWith('lock.taking-'))).toEqual([])
    // Judged by inode too: the same bytes in another file are not the file judged.
    writeFileSync(join(path, 'copy'), old)
    renameSync(join(path, 'copy'), lock)
    expect(takeOver(lock, judged, 'pid-gone', () => true)).toBe('changed')
  })

  it.skipIf(!hasProc)('waits for a claim another taker holds, never moving the lock meanwhile, and moves aside a claim abandoned mid-takeover', async () => {
    const path = fresh()
    StateDir.open(path)
    const id = resolveMachineId(path, { env, create: true }).id!
    const old = JSON.stringify({ pid: DEAD_PID, startedAt: 'long ago', host: hostname(), machineId: id, ...here(), nonce: 'old' })
    writeFileSync(join(path, 'lock'), old)
    writeFileSync(join(path, 'lock.claim'), 'another taker')
    await expect(takeLock(path, { ...quiet, sleep: async () => {} })).rejects.toThrow(/other servers kept taking it first/)
    expect(readFileSync(join(path, 'lock'), 'utf8')).toBe(old)
    expect(readFileSync(join(path, 'lock.claim'), 'utf8')).toBe('another taker')
    // The same claim, left 20 s ago by a taker that died: kept aside, and the takeover goes on.
    const past = new Date(Date.now() - 20_000)
    utimesSync(join(path, 'lock.claim'), past, past)
    const held = await takeLock(path, { ...quiet, sleep: async () => {} })
    expect(lockOf(path).pid).toBe(process.pid)
    expect(readdirSync(path).filter((f) => f.startsWith('lock.claim.stale-'))).toHaveLength(1)
    expect(existsSync(join(path, 'lock.claim'))).toBe(false)
    held.release()
  })

  it('moves a file aside under a free name, never over one already there', () => {
    const path = fresh()
    const f = join(path, 'thing')
    writeFileSync(f, 'first')
    const one = moveAside(f, 'stale', 'test')
    writeFileSync(f, 'second')
    const two = moveAside(f, 'stale', 'test')
    expect(two).not.toBe(one)
    expect(readFileSync(one, 'utf8')).toBe('first')
    expect(readFileSync(two, 'utf8')).toBe('second')
    expect(existsSync(f)).toBe(false)
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
    const dir = StateDir.open(path)
    ;(await dir.lock(quiet)).release()
    const held = await dir.lock(quiet)
    expect(lockOf(path).machineId).toBe(first.id)
    held.release()
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
    expect(readdirSync(dirname(path)).some((f) => f.startsWith(`${basename(path)}.machine-id.copied-`))).toBe(true)
  })

  it('records its birth time where the filesystem has one, and a record whose birth time is not the file\'s is a copy', () => {
    const path = fresh()
    const made = resolveMachineId(path, { env, create: true })
    const file = `${path}.machine-id`
    const rec = JSON.parse(readFileSync(file, 'utf8')) as { birth?: string }
    if (statSync(file, { bigint: true }).birthtimeNs === 0n) return expect(rec.birth).toBeUndefined()
    expect(rec.birth).toBe(statSync(file, { bigint: true }).birthtimeNs.toString())
    // Same inode, another birth: the inode number was reused by a file made later.
    writeFileSync(file, JSON.stringify({ ...rec, birth: '1' }))
    const again = resolveMachineId(path, { env, create: true })
    expect(again.id).not.toBe(made.id)
    expect(again.note).toMatch(/was a copy from elsewhere/)
  })

  it('several starts at once on a copied file all end with the one new id, none failing (real processes)', async () => {
    const path = fresh()
    resolveMachineId(path, { env, create: true })
    const file = `${path}.machine-id`
    const content = readFileSync(file, 'utf8')
    renameSync(file, `${file}.orig`)
    writeFileSync(file, content, { mode: 0o600 })
    const startAt = Date.now() + 3000
    const all = Array.from({ length: 6 }, () => owner(path, { mode: 'machine-id', startAt }))
    try {
      const codes = await Promise.all(all.map((o) => o.exit))
      expect(codes).toEqual(all.map(() => 0))
      const ids = new Set(all.map((o) => o.lines.find((l) => l.startsWith('ID '))))
      expect(ids.size).toBe(1)
      expect([...ids][0]).toBe(`ID ${resolveMachineId(path, { env }).id}`)
    } finally {
      for (const o of all) o.kill()
    }
  }, 60_000)

  it('yields to the environment, and the flag to both, and refuses a malformed one', async () => {
    const path = fresh()
    expect(resolveMachineId(path, { env: { [MACHINE_ID_ENV]: 'xor-box' }, create: true })).toEqual({ id: 'xor-box', source: 'env' })
    expect(resolveMachineId(path, { explicit: 'from-flag', env: { [MACHINE_ID_ENV]: 'xor-box' }, create: true })).toEqual({ id: 'from-flag', source: 'flag' })
    expect(existsSync(`${path}.machine-id`)).toBe(false)
    expect(() => resolveMachineId(path, { explicit: 'has space' })).toThrow(/--machine-id must be/)
    expect(() => resolveMachineId(path, { env: { [MACHINE_ID_ENV]: 'a/b' } })).toThrow(new RegExp(`\\$${MACHINE_ID_ENV} must be`))
    const dir = StateDir.open(path)
    const held = await dir.lock({ ...quiet, machineId: 'from-flag' })
    expect(lockOf(path).machineId).toBe('from-flag')
    held.release()
    // A lock left under another id, by a process that is gone, is another machine's: refused.
    writeFileSync(join(path, 'lock'), JSON.stringify({ pid: DEAD_PID, startedAt: 'x', host: hostname(), machineId: 'from-flag', ...(hasProc ? here() : {}) }))
    await expect(dir.lock({ ...quiet, env: { [MACHINE_ID_ENV]: 'xor-box' } })).rejects.toThrow(/another machine \(pid 4194305 .*machine id from-flag/)
  })

  it('doctor reads it and the lock without writing anything, and judges the lock as serve would', async () => {
    const path = fresh()
    StateDir.open(path)
    expect(describeLock(path, { env })).toMatchObject({ machine: { id: null, source: 'none', path: `${path}.machine-id` }, judgment: { kind: 'free' }, ageMs: null })
    expect(existsSync(`${path}.machine-id`)).toBe(false)
    // A lock under a machine id while this machine has none yet: serve would make a new id and refuse it, and doctor says the same.
    writeFileSync(join(path, 'lock'), JSON.stringify({ pid: DEAD_PID, startedAt: 'x', host: hostname(), machineId: 'from-before', ...(hasProc ? here() : {}) }))
    const seen = describeLock(path, { env })
    expect(seen.judgment).toMatchObject({ kind: 'held', here: false })
    expect(seen.ageMs).toBeGreaterThanOrEqual(0)
    expect(existsSync(`${path}.machine-id`)).toBe(false)
    await expect(StateDir.open(path).lock(quiet)).rejects.toThrow(/another machine/)
    rmSync(join(path, 'lock'))
    const held = await StateDir.open(path).lock(quiet)
    expect(describeLock(path, { env })).toMatchObject({ machine: { source: 'file' }, judgment: { kind: 'ours' } })
    held.release()
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
