// lock.test.ts: one key, one mover. A second lock on the same state
// directory is refused with a plain message while the first is held, a
// released lock can be taken again, and a lock left by a dead process is
// taken over. The key file is created once, mode 600, and loaded unchanged.

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import { LockHeldError, StateDir } from '../src/state/dir.js'

const fresh = (): string => mkdtempSync(join(tmpdir(), 'cyberspace-mcp-test-'))

describe('the state directory lock', () => {
  it('refuses a second mover while the first holds the lock', () => {
    const dir = StateDir.open(fresh())
    const release = dir.lock()
    expect(() => dir.lock()).toThrow(LockHeldError)
    expect(() => dir.lock()).toThrow(/One key has one mover/)
    release()
    const again = dir.lock()
    again()
  })

  it('takes over a lock left by a process that no longer exists', () => {
    const path = fresh()
    const dir = StateDir.open(path)
    // A pid no process has: the largest pid Linux allows plus one is never live.
    writeFileSync(join(path, 'lock'), JSON.stringify({ pid: 4194305, startedAt: 'long ago', host: 'elsewhere' }))
    const release = dir.lock()
    expect(JSON.parse(readFileSync(join(path, 'lock'), 'utf8')).pid).toBe(process.pid)
    release()
  })
})

describe('the key file', () => {
  it('is created once, mode 600, and loads the same key every time', () => {
    const path = fresh()
    const dir = StateDir.open(path)
    const first = dir.loadOrCreateKey()
    const mode = statSync(join(path, 'key')).mode & 0o777
    expect(mode).toBe(0o600)
    const second = dir.loadOrCreateKey()
    expect(getPublicKey(second)).toBe(getPublicKey(first))
  })

  it('writes JSON atomically and reads it back', () => {
    const dir = StateDir.open(fresh())
    dir.writeJson('thing.json', { a: 1 })
    expect(dir.readJson('thing.json', null)).toEqual({ a: 1 })
    expect(dir.readJson('missing.json', 'fallback')).toBe('fallback')
  })
})
