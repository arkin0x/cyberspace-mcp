// duplicateOk.test.ts: grain (relay.onosendai.tech, the canonical relay since
// 2026-11-05) answers an event it already holds with OK false "duplicate:",
// where strfry says OK true. The relay holds that exact id, so it took it: the
// publish is ok, the outbox settles the entry as accepted (not refused), and a
// second relay that was down when the canonical relay took an event is asked
// again once it is back, for a day.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { normalizeURL } from 'nostr-tools/utils'
import { Outbox, OTHERS_RETRY_S } from '../src/nostr/outbox.js'
import { signEvent } from '../src/nostr/event.js'
import { Relays } from '../src/nostr/relays.js'
import { StateDir } from '../src/state/dir.js'
import { FakeNetwork } from './fakeRelay.js'

const CANONICAL = 'wss://canonical.example'
const SECOND = 'wss://second.example'
const C = normalizeURL(CANONICAL)
const S = normalizeURL(SECOND)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function setup(network: FakeNetwork) {
  const sk = generateSecretKey()
  const dir = StateDir.open(mkdtempSync(join(tmpdir(), 'cyberspace-mcp-dup-')))
  const relays = new Relays({ urls: [CANONICAL, SECOND], signAuth: async (t) => finalizeEvent(t, sk), websocketImplementation: network.WebSocket, maxWaitMs: 400 })
  const note = (text: string) => signEvent({ kind: 1, created_at: 1_700_000_000, content: text, tags: [] }, sk)
  return { dir, relays, note }
}

describe('a canonical relay that answers a duplicate with OK false', () => {
  it('took it: publishMany is ok and names it as accepting', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL, { duplicateOkFalse: true })
    network.add(SECOND, { reachable: false })
    const { relays, note } = setup(network)
    const ev = note('already there')
    canonical.seed(ev)
    const result = await relays.publishMany([CANONICAL, SECOND], ev)
    expect(result.ok).toBe(true)
    expect(result.ok && result.accepted).toEqual([C])
    relays.close()
  })

  it('settles an outbox entry as accepted, not refused, and the second relay gets it once it is back', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL, { duplicateOkFalse: true })
    const second = network.add(SECOND, { reachable: false })
    const { dir, relays, note } = setup(network)
    const outbox = new Outbox(dir, relays, { retryMs: 50 })
    const ev = note('copied there by the history catch-up')
    canonical.seed(ev)
    const entry = outbox.add(ev)
    const result = await outbox.send(entry)
    expect(result.ok).toBe(true)
    expect(entry.accepted).toEqual([C])
    expect(entry.refused?.[C]).toBeUndefined()
    expect(outbox.pending()).toHaveLength(0)
    second.policy.reachable = true
    await sleep(400)
    expect(second.published.map((e) => e.id)).toEqual([ev.id])
    expect(entry.accepted.sort()).toEqual([C, S].sort())
    outbox.stop()
    relays.close()
  })
})

describe('a second relay down when the canonical relay took an event', () => {
  it('is asked again on the retry once it is back', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(CANONICAL)
    const second = network.add(SECOND, { reachable: false })
    const { dir, relays, note } = setup(network)
    const outbox = new Outbox(dir, relays, { retryMs: 50 })
    const ev = note('a new move')
    const entry = outbox.add(ev)
    await outbox.send(entry)
    expect(canonical.published.map((e) => e.id)).toEqual([ev.id])
    expect(second.published).toHaveLength(0)
    second.policy.reachable = true
    await sleep(400)
    expect(second.published.map((e) => e.id)).toEqual([ev.id])
    // Taken by both: nothing more is sent.
    const sends = canonical.published.length + second.published.length
    await sleep(300)
    expect(canonical.published.length + second.published.length).toBe(sends)
    outbox.stop()
    relays.close()
  })

  it('is not asked for an event signed more than a day ago', async () => {
    const network = new FakeNetwork()
    network.add(CANONICAL)
    const second = network.add(SECOND, { reachable: false })
    const { dir, relays, note } = setup(network)
    const outbox = new Outbox(dir, relays, { retryMs: 50 })
    const ev = note('an old move')
    const entry = outbox.add(ev, Math.floor(Date.now() / 1000) - OTHERS_RETRY_S - 60)
    await outbox.send(entry)
    second.policy.reachable = true
    await sleep(400)
    expect(second.published).toHaveLength(0)
    outbox.stop()
    relays.close()
  })
})
