// hopLevel1Refusal.test.ts: a hop whose proof fails Level 1 after it is
// signed is never recorded, queued or sent, and the next hop works (review
// of #51). cyberspace-core's verifyHopLevel1 is wrapped for the whole file
// so the test can force a failure; everything else is the real core, and
// the relays are the fake ones (test/fakeRelay.ts).

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'

const flags = vi.hoisted(() => ({ fail: false, calls: 0 }))
vi.mock('cyberspace-core', async (orig) => {
  const real = await orig<typeof import('cyberspace-core')>()
  return {
    ...real,
    verifyHopLevel1: (...args: Parameters<typeof real.verifyHopLevel1>) => {
      flags.calls++
      return flags.fail ? ['price'] : real.verifyHopLevel1(...args)
    },
  }
})

import { Agent } from '../src/agent.js'
import { bytesToHex } from '../src/nostr/event.js'
import type { Calibration } from '../src/space/calibration.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork } from './fakeRelay.js'

const CANONICAL = 'wss://canonical.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }
const running: Agent[] = []
afterAll(async () => { for (const a of running) await a.stop() })

describe('a hop that fails Level 1 after signing', () => {
  it('is not recorded, not queued and not sent; the move is released and the next hop works', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL)
    const sk = generateSecretKey()
    const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-level1-'))
    StateDir.open(dir)
    writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
    const a = await Agent.start({ stateDir: dir, relays: [CANONICAL], capCallSeconds: 30, capSessionSeconds: 600, maxSidestepHeight: 24, allowRespawn: false, websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1000 })
    running.push(a)
    await a.hop({ target: { dx: 2 } })
    const head = a.keeper.head()!.id
    const events = a.keeper.events.length
    const outbox = a.outbox.entries.length
    const moves = (): number => canonical.published.filter((e) => e.kind === 3333).length
    expect(moves()).toBe(2) // the spawn and the first hop

    flags.fail = true
    const before = flags.calls
    await expect(a.hop({ target: { dx: 1 } })).rejects.toThrow(/refusing to publish a hop whose proof fails Level 1 \(price\); it was signed and discarded, never sent/)
    expect(flags.calls).toBeGreaterThan(before)
    expect(a.keeper.head()!.id).toBe(head)
    expect(a.keeper.events.length).toBe(events)
    expect(a.outbox.entries.length).toBe(outbox)
    expect(moves()).toBe(2)

    flags.fail = false
    await a.hop({ target: { dx: 1 } })
    expect(moves()).toBe(3)
    expect(a.keeper.head()!.id).not.toBe(head)
  }, 60_000)
})
