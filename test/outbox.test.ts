// outbox.test.ts: a signed event is written before it is sent, so a crash
// between signing and confirmation leaves an entry the next start replays
// through the guard: clear sends it, a fork drops it, and relays that cannot
// say leave it pending until a retry can; an event some relay already took
// skips the guard. The canonical relay is retried in the background and the
// retry survives a restart; a refusal is kept verbatim and never retried.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { Outbox, type GuardVerdict } from '../src/nostr/outbox.js'
import { signEvent } from '../src/nostr/event.js'
import { Relays } from '../src/nostr/relays.js'
import { StateDir } from '../src/state/dir.js'
import { FakeNetwork } from './fakeRelay.js'

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const clear = async (): Promise<GuardVerdict> => ({ verdict: 'clear' })

function setup(network: FakeNetwork, urls: string[]) {
  const sk = generateSecretKey()
  const dir = StateDir.open(mkdtempSync(join(tmpdir(), 'cyberspace-mcp-outbox-')))
  const relays = new Relays({ urls, signAuth: async (t) => finalizeEvent(t, sk), websocketImplementation: network.WebSocket, maxWaitMs: 800 })
  const note = (text: string) => signEvent({ kind: 1, created_at: 1_700_000_000, content: text, tags: [] }, sk)
  return { sk, dir, relays, note }
}

describe('the outbox', () => {
  it('replays what a crash left unsent when the guard says clear', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL)
    const { dir, relays, note } = setup(network, [CANONICAL])
    const crashed = new Outbox(dir, relays, { guard: clear })
    const ev = note('signed, then the process died')
    crashed.add(ev)
    const restarted = new Outbox(dir, relays, { guard: clear })
    expect(restarted.pending().map((e) => e.event.id)).toEqual([ev.id])
    const { sent, dropped, waiting } = await restarted.replay()
    expect(sent).toHaveLength(1)
    expect(dropped).toHaveLength(0)
    expect(waiting).toHaveLength(0)
    expect(canonical.published.map((e) => e.id)).toEqual([ev.id])
    expect(restarted.pending()).toHaveLength(0)
    restarted.stop()
    relays.close()
  })

  it('leaves an unsent event pending while the guard cannot tell, and sends it once it can', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL)
    const { dir, relays, note } = setup(network, [CANONICAL])
    let verdict: GuardVerdict = { verdict: 'unknown', reason: 'the relays did not answer' }
    const guard = vi.fn(async () => verdict)
    const outbox = new Outbox(dir, relays, { guard, retryMs: 50 })
    const ev = note('unsure')
    outbox.add(ev)
    const first = await outbox.replay()
    expect(first.waiting.map((e) => e.event.id)).toEqual([ev.id])
    expect(first.sent).toHaveLength(0)
    expect(canonical.published).toHaveLength(0)
    expect(outbox.pending()[0].lastError).toBe('the relays did not answer')
    // The scheduled retry asks the guard again and still waits.
    await sleep(120)
    expect(canonical.published).toHaveLength(0)
    expect(guard.mock.calls.length).toBeGreaterThan(1)
    // Now the relays can say: the retry sends it.
    verdict = { verdict: 'clear' }
    await outbox.retry()
    expect(canonical.published.map((e) => e.id)).toEqual([ev.id])
    expect(outbox.pending()).toHaveLength(0)
    outbox.stop()
    relays.close()
  })

  it('drops an unsent event when the guard says fork, at replay and at retry', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL)
    const { dir, relays, note } = setup(network, [CANONICAL])
    const outbox = new Outbox(dir, relays, { guard: async () => ({ verdict: 'fork', reason: 'another device moved from the same point' }) })
    const ev = note('would fork')
    outbox.add(ev)
    const { sent, dropped } = await outbox.replay()
    expect(sent).toHaveLength(0)
    expect(dropped[0].dropped).toBe('another device moved from the same point')
    expect(canonical.published).toHaveLength(0)
    expect(outbox.state().dropped).toHaveLength(1)
    const another = note('would fork too')
    outbox.add(another)
    await outbox.retry()
    expect(outbox.state().dropped).toHaveLength(2)
    expect(canonical.published).toHaveLength(0)
    outbox.stop()
    relays.close()
  })

  it('skips the guard for an event some relay already took, and keeps asking the canonical relay across a restart', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL, { reachable: false })
    network.add(MINE)
    const { dir, relays, note } = setup(network, [CANONICAL, MINE])
    const guard = vi.fn(async (): Promise<GuardVerdict> => ({ verdict: 'unknown', reason: 'never asked' }))
    const outbox = new Outbox(dir, relays, { guard, retryMs: 100 })
    const ev = note('hello')
    const entry = outbox.add(ev)
    const result = await outbox.send(entry)
    expect(result.ok).toBe(true)
    expect(entry.accepted).toEqual(['wss://mine.example/'])
    expect(outbox.pending()).toHaveLength(1)
    outbox.stop()
    canonical.policy.reachable = true
    const again = new Outbox(dir, relays, { guard, retryMs: 100 })
    expect(again.pending().map((e) => e.event.id)).toEqual([ev.id])
    await again.retry()
    expect(guard).not.toHaveBeenCalled()
    expect(canonical.published.map((e) => e.id)).toEqual([ev.id])
    expect(again.pending()).toHaveLength(0)
    again.stop()
    relays.close()
  }, 20_000)

  it('keeps a refusal verbatim and never retries it; a rate limit is not a refusal', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL, { refuse: (ev) => (ev.kind === 0 ? 'blocked: profile publishing is closed to new keys' : ev.kind === 1 ? 'rate-limited: slow down' : null) })
    const { dir, relays, sk, note } = setup(network, [CANONICAL])
    const outbox = new Outbox(dir, relays, { guard: clear, retryMs: 50 })
    const profile = signEvent({ kind: 0, created_at: 1, content: '{"bot":true}', tags: [] }, sk)
    const entry = outbox.add(profile)
    const result = await outbox.send(entry)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('blocked: profile publishing is closed to new keys')
    expect(entry.refused?.['wss://canonical.example/']).toBe('blocked: profile publishing is closed to new keys')
    expect(outbox.pending()).toHaveLength(0)
    await sleep(200)
    expect(canonical.received.filter((m) => m[0] === 'EVENT')).toHaveLength(1)
    expect(outbox.state().refused).toHaveLength(1)
    // Rate-limited: not refused, left pending with the reason, retried later.
    const limited = outbox.add(note('too fast'))
    const r2 = await outbox.send(limited)
    expect(r2.ok).toBe(false)
    expect(limited.refused).toBeUndefined()
    expect(limited.lastError).toMatch(/rate-limited: slow down/)
    expect(outbox.pending().map((e) => e.event.id)).toEqual([limited.event.id])
    outbox.stop()
    relays.close()
  })
})
