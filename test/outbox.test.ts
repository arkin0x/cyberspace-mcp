// outbox.test.ts: a signed event is written before it is sent, so a crash
// between signing and confirmation leaves an entry the next start replays;
// the canonical relay is retried in the background and the retry survives a
// restart; a refusal is kept verbatim and never retried; a replay that
// would fork the chain is dropped.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { Outbox } from '../src/nostr/outbox.js'
import { signEvent } from '../src/nostr/event.js'
import { Relays } from '../src/nostr/relays.js'
import { StateDir } from '../src/state/dir.js'
import { FakeNetwork } from './fakeRelay.js'

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function setup(network: FakeNetwork, urls: string[]) {
  const sk = generateSecretKey()
  const dir = StateDir.open(mkdtempSync(join(tmpdir(), 'cyberspace-mcp-outbox-')))
  const relays = new Relays({ urls, signAuth: async (t) => finalizeEvent(t, sk), websocketImplementation: network.WebSocket, maxWaitMs: 800 })
  const note = (text: string) => signEvent({ kind: 1, created_at: 1_700_000_000, content: text, tags: [] }, sk)
  return { sk, dir, relays, note }
}

describe('the outbox', () => {
  it('replays what a crash left unsent', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL)
    const { dir, relays, note } = setup(network, [CANONICAL])
    const crashed = new Outbox(dir, relays)
    const ev = note('signed, then the process died')
    crashed.add(ev)
    // No send: the process is gone. The next start sees the entry.
    const restarted = new Outbox(dir, relays)
    expect(restarted.pending().map((e) => e.event.id)).toEqual([ev.id])
    const { sent, dropped } = await restarted.replay(async () => null)
    expect(sent).toHaveLength(1)
    expect(dropped).toHaveLength(0)
    expect(canonical.published.map((e) => e.id)).toEqual([ev.id])
    expect(restarted.pending()).toHaveLength(0)
    restarted.stop()
    relays.close()
  })

  it('counts a publish on any OK and keeps asking the canonical relay in the background, across a restart', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL, { reachable: false })
    network.add(MINE)
    const { dir, relays, note } = setup(network, [CANONICAL, MINE])
    const outbox = new Outbox(dir, relays, { retryMs: 100 })
    const ev = note('hello')
    const entry = outbox.add(ev)
    const result = await outbox.send(entry)
    expect(result.ok).toBe(true)
    expect(entry.accepted).toEqual(['wss://mine.example/'])
    expect(outbox.pending()).toHaveLength(1)
    outbox.stop()
    // A restart: the entry is still owed to the canonical relay, which is back.
    canonical.policy.reachable = true
    const again = new Outbox(dir, relays, { retryMs: 100 })
    expect(again.pending().map((e) => e.event.id)).toEqual([ev.id])
    await again.retry()
    expect(canonical.published.map((e) => e.id)).toEqual([ev.id])
    expect(again.pending()).toHaveLength(0)
    again.stop()
    relays.close()
  }, 20_000)

  it('keeps a refusal verbatim and never retries it', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL, { refuse: (ev) => (ev.kind === 0 ? 'blocked: profile publishing is closed to new keys' : null) })
    const { dir, relays, sk } = setup(network, [CANONICAL])
    const outbox = new Outbox(dir, relays, { retryMs: 50 })
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
    outbox.stop()
    relays.close()
  })

  it('drops an entry at replay when the check says it would fork the chain', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL)
    const { dir, relays, note } = setup(network, [CANONICAL])
    const outbox = new Outbox(dir, relays)
    const ev = note('would fork')
    outbox.add(ev)
    const { sent, dropped } = await outbox.replay(async () => 'another device moved from the same point')
    expect(sent).toHaveLength(0)
    expect(dropped[0].dropped).toBe('another device moved from the same point')
    expect(canonical.published).toHaveLength(0)
    expect(outbox.state().dropped).toHaveLength(1)
    outbox.stop()
    relays.close()
  })
})
