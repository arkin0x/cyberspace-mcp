// dir.ts: the state directory, the one place the agent's key, chain, outbox
// and keys live. Files are JSON, written atomically (a temporary file then a
// rename) so a crash mid-write never leaves half a chain behind. The secret
// key is one file, mode 600, created on first run and never printed, and it
// is only ever a key this server generated: a human's nsec placed there is
// refused, because an agent never takes a human's key (agents note 6, rule
// 1). The lock is one file naming the process that owns the directory (its
// machine id, host and pid; lock.ts): a second server on the same directory
// refuses to start, because one key has one mover (brief, ruling 6).

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { generateSecretKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes, HEX_64 } from '../nostr/event.js'
import { LockHeldError, takeLock, type LockOptions } from './lock.js'

export { LockHeldError }

/** A key file that is not one this server wrote. */
export class ForeignKeyError extends Error {}

/** The marker every key file this server writes carries, and loadOrCreateKey requires. */
export const KEY_GENERATED_BY = 'cyberspace-mcp'

interface KeyFile {
  generatedBy: string
  secret: string
  createdAt: string
}

const NEVER_A_HUMANS_KEY = 'An agent never takes a human\'s key: never share a key between two running agents, or between an agent and a human (agents note 6, rule 1). Delete the file and let this server create its own key, or give it an empty state directory.'

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
   * on the first run, as JSON with the generatedBy marker. A file without
   * the marker is refused: an nsec, or a bare hex secret, is a key somebody
   * placed there, and an agent never takes a human's key. Returned as bytes
   * to the one caller that signs; never logged, never returned by any tool.
   */
  loadOrCreateKey(): Uint8Array {
    const path = this.file('key')
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8').trim()
      if (/^nsec1[a-z0-9]+$/i.test(raw)) throw new ForeignKeyError(`The key file ${path} holds an nsec, which this server did not write. ${NEVER_A_HUMANS_KEY}`)
      if (HEX_64.test(raw.toLowerCase())) throw new ForeignKeyError(`The key file ${path} holds a bare hex secret, which this server did not write. ${NEVER_A_HUMANS_KEY}`)
      let parsed: Partial<KeyFile> | null = null
      try { parsed = JSON.parse(raw) as Partial<KeyFile> } catch { parsed = null }
      if (!parsed || parsed.generatedBy !== KEY_GENERATED_BY || typeof parsed.secret !== 'string' || !HEX_64.test(parsed.secret)) {
        throw new ForeignKeyError(`The key file ${path} is not a key this server wrote (it lacks the "generatedBy": "${KEY_GENERATED_BY}" marker or a 32-byte secret). ${NEVER_A_HUMANS_KEY}`)
      }
      return hexToBytes(parsed.secret)
    }
    const sk = generateSecretKey()
    const record: KeyFile = { generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: new Date().toISOString() }
    const fd = openSync(path, 'wx', 0o600)
    try {
      writeSync(fd, JSON.stringify(record, null, 2) + '\n')
    } finally {
      closeSync(fd)
    }
    return sk
  }

  /**
   * Take the exclusive lock on this directory (lock.ts): throws
   * LockHeldError, with a plain message, while its owner may still run. A
   * lock this machine left behind (a dead pid, a reused pid, or a previous
   * boot whose heartbeat is silent) is taken over and kept aside as
   * lock.stale-*. Returns the release, also run when this process exits.
   */
  lock(opts: LockOptions = {}): Promise<() => void> {
    return takeLock(this.path, opts)
  }
}
