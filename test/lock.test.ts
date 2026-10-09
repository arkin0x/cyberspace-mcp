// lock.test.ts: one key, one mover. A second lock on the same state
// directory is refused with a plain message while the first is held, a
// released lock can be taken again, a lock left by a dead process on this
// host is taken over, and a lock from another host never is. The key file
// is created once, mode 600, as JSON with the server's marker, loaded
// unchanged, and a key somebody else placed there (an nsec, a bare hex
// secret, JSON without the marker) is refused with the rule.

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from '../src/nostr/event.js'
import { ForeignKeyError, KEY_GENERATED_BY, LockHeldError, StateDir } from '../src/state/dir.js'

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

  it('takes over a lock left on this host by a process that no longer exists', () => {
    const path = fresh()
    const dir = StateDir.open(path)
    // A pid no process has: the largest pid Linux allows plus one is never live.
    writeFileSync(join(path, 'lock'), JSON.stringify({ pid: 4194305, startedAt: 'long ago', host: hostname() }))
    const release = dir.lock()
    expect(JSON.parse(readFileSync(join(path, 'lock'), 'utf8')).pid).toBe(process.pid)
    release()
  })

  it('never takes over a lock from another host, and names the host and the file', () => {
    const path = fresh()
    const dir = StateDir.open(path)
    writeFileSync(join(path, 'lock'), JSON.stringify({ pid: 4194305, startedAt: 'long ago', host: 'another-machine' }))
    expect(() => dir.lock()).toThrow(LockHeldError)
    expect(() => dir.lock()).toThrow(/another host \(another-machine/)
    expect(() => dir.lock()).toThrow(new RegExp(join(path, 'lock').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
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
