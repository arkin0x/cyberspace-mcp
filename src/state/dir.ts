// dir.ts: the state directory, the one place the agent's key, chain, outbox
// and keys live. Files are JSON, written atomically (a temporary file then a
// rename) so a crash mid-write never leaves half a chain behind. The secret
// key is one file, mode 600, created on first run and never printed. The
// lock is one file holding the pid of the process that owns the directory:
// a second server on the same directory refuses to start, because one key
// has one mover (brief, ruling 6).

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes, HEX_64 } from '../nostr/event.js'

export class LockHeldError extends Error {}

interface LockRecord {
  pid: number
  startedAt: string
  host: string
}

/** Whether a process with this pid exists on this machine. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class StateDir {
  private constructor(readonly path: string) {}

  /** Open or create the directory (mode 700). */
  static open(path: string): StateDir {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    mkdirSync(join(path, 'keys'), { recursive: true, mode: 0o700 })
    return new StateDir(path)
  }

  file(name: string): string {
    return join(this.path, name)
  }

  exists(name: string): boolean {
    return existsSync(this.file(name))
  }

  readJson<T>(name: string, fallback: T): T {
    try {
      const raw = readFileSync(this.file(name), 'utf8')
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  /** Write a JSON file atomically: a temporary file in the same directory, then a rename. */
  writeJson(name: string, value: unknown): void {
    const target = this.file(name)
    const tmp = `${target}.${process.pid}.tmp`
    const fd = openSync(tmp, 'w', 0o600)
    try {
      writeSync(fd, JSON.stringify(value, null, 2))
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, target)
  }

  /**
   * The agent's secret key: loaded from `key`, or created there (mode 600)
   * on the first run. Returned as bytes to the one caller that signs; never
   * logged, never returned by any tool.
   */
  loadOrCreateKey(): Uint8Array {
    const path = this.file('key')
    if (existsSync(path)) {
      const hex = readFileSync(path, 'utf8').trim().toLowerCase()
      if (!HEX_64.test(hex)) throw new Error(`the key file ${path} is not a 32-byte hex secret; the server will not guess`)
      return hexToBytes(hex)
    }
    const sk = generateSecretKey()
    const fd = openSync(path, 'wx', 0o600)
    try {
      writeSync(fd, bytesToHex(sk) + '\n')
    } finally {
      closeSync(fd)
    }
    return sk
  }

  /**
   * Take the exclusive lock on this directory. Throws LockHeldError, with a
   * plain message, when a process that is still running holds it. A lock
   * left by a process that no longer exists is taken over. Returns the
   * release, which is also run when this process exits.
   */
  lock(): () => void {
    const path = this.file('lock')
    const record: LockRecord = { pid: process.pid, startedAt: new Date().toISOString(), host: hostname() }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, 'wx', 0o600)
        try { writeSync(fd, JSON.stringify(record)) } finally { closeSync(fd) }
        return this.armRelease(path)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
      let held: LockRecord | null = null
      try { held = JSON.parse(readFileSync(path, 'utf8')) as LockRecord } catch { held = null }
      if (held && typeof held.pid === 'number' && pidAlive(held.pid)) {
        const who = held.pid === process.pid ? 'this very process' : `pid ${held.pid} on ${held.host ?? 'this machine'}, started ${held.startedAt}`
        throw new LockHeldError(`Another cyberspace-mcp already holds ${this.path} (${who}). One key has one mover: a second server on the same state directory would fork the chain and kill it. Stop the other server, or give this one its own state directory.`)
      }
      // Stale: the process is gone. Take it over.
      try { unlinkSync(path) } catch { /* raced; the retry says who won */ }
    }
    throw new LockHeldError(`Could not take the lock on ${this.path}: another server took it first.`)
  }

  private armRelease(path: string): () => void {
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      try {
        const held = JSON.parse(readFileSync(path, 'utf8')) as LockRecord
        if (held.pid === process.pid) unlinkSync(path)
      } catch { /* already gone */ }
      process.off('exit', release)
    }
    process.on('exit', release)
    return release
  }
}
