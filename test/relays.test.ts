// relays.test.ts: the relay client against the in-memory relay: NIP-42 auth
// before reads, per-relay answers told apart, the publish policy (OK from
// any relay, refusals verbatim and never retried), and a live subscription
// that hears what is published after it opened.

import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Relays } from '../src/nostr/relays.js'
import { signEvent } from '../src/nostr/event.js'
import { FakeNetwork } from './fakeRelay.js'

function relaysOn(network: FakeNetwork, urls: string[], sk = generateSecretKey()): Relays {
  return new Relays({
    urls,
    signAuth: async (t) => finalizeEvent(t, sk),
    websocketImplementation: network.WebSocket,
    maxWaitMs: 1500,
  })
}

const note = (sk: Uint8Array, text: string, createdAt = 1_700_000_000) => signEvent({ kind: 1, created_at: createdAt, content: text, tags: [] }, sk)

describe('the relay client over the fake relay', () => {
  it('authenticates, publishes, and reads back what it published', async () => {
    const network = new FakeNetwork()
    const fake = network.add('wss://a.example')
    const sk = generateSecretKey()
    const relays = relaysOn(network, ['wss://a.example'], sk)
    const ev = note(sk, 'hello')
    const result = await relays.publish(ev)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.accepted).toEqual(['wss://a.example/'])
    expect(fake.published.map((e) => e.id)).toEqual([ev.id])
    const got = await relays.query({ kinds: [1], authors: [getPublicKey(sk)] })
    expect(got.map((e) => e.id)).toEqual([ev.id])
    // The read went out authenticated: the relay never had to close it.
    expect(fake.received.some((m) => m[0] === 'AUTH')).toBe(true)
    relays.close()
  })

  it('returns a refusal verbatim and does not try again', async () => {
    const network = new FakeNetwork()
    const fake = network.add('wss://a.example', { refuse: (ev) => (ev.kind === 0 ? 'blocked: not a member of this relay' : null) })
    const sk = generateSecretKey()
    const relays = relaysOn(network, ['wss://a.example'], sk)
    const profile = signEvent({ kind: 0, created_at: 1, content: '{}', tags: [] }, sk)
    const result = await relays.publish(profile)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('blocked: not a member of this relay')
    const sends = fake.received.filter((m) => m[0] === 'EVENT')
    expect(sends).toHaveLength(1)
    relays.close()
  })

  it('counts a publish as ok when any relay takes it, and names the ones that did not', async () => {
    const network = new FakeNetwork()
    network.add('wss://a.example', { refuse: () => 'restricted: closed' })
    network.add('wss://b.example')
    const sk = generateSecretKey()
    const relays = relaysOn(network, ['wss://a.example', 'wss://b.example'], sk)
    const result = await relays.publish(note(sk, 'x'))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.accepted).toEqual(['wss://b.example/'])
      expect(result.reasons['wss://a.example/']).toBe('restricted: closed')
    }
    relays.close()
  })

  it('tells answered, refused and unreachable apart', async () => {
    const network = new FakeNetwork()
    network.add('wss://answers.example')
    network.add('wss://silent.example', { silent: true })
    network.add('wss://down.example', { reachable: false })
    const relays = relaysOn(network, ['wss://answers.example', 'wss://silent.example', 'wss://down.example'])
    const answers = await relays.queryEach({ kinds: [1] }, 600)
    const byUrl = Object.fromEntries(answers.map((a) => [a.url, a.outcome]))
    expect(byUrl['wss://answers.example/']).toBe('answered')
    expect(byUrl['wss://silent.example/']).toBe('unreachable')
    expect(byUrl['wss://down.example/']).toBe('unreachable')
    relays.close()
  })

  it('a live subscription hears an event published after it opened', async () => {
    const network = new FakeNetwork()
    const fake = network.add('wss://a.example')
    const relays = relaysOn(network, ['wss://a.example'])
    const heard: string[] = []
    const stop = relays.subscribe({ kinds: [1] }, (ev) => heard.push(ev.content))
    await new Promise((r) => setTimeout(r, 150))
    fake.inject(note(generateSecretKey(), 'from another client'))
    await new Promise((r) => setTimeout(r, 50))
    expect(heard).toEqual(['from another client'])
    stop()
    relays.close()
  })

  it('queryEachSettled settles once the primary and the held relays have answered, without waiting for others', async () => {
    const network = new FakeNetwork()
    network.add('wss://canonical.example')
    network.add('wss://held.example')
    network.add('wss://slow.example', { silent: true })
    const relays = relaysOn(network, ['wss://canonical.example', 'wss://held.example', 'wss://slow.example'])
    const t0 = Date.now()
    const answers = await relays.queryEachSettled(relays.urls, { kinds: [1] }, 2000, 'wss://canonical.example', ['wss://held.example'])
    expect(Date.now() - t0).toBeLessThan(1500)
    const byUrl = Object.fromEntries(answers.map((a) => [a.url, a.outcome]))
    expect(byUrl['wss://canonical.example/']).toBe('answered')
    expect(byUrl['wss://held.example/']).toBe('answered')
    expect(byUrl['wss://slow.example/']).toBe('unreachable')
    relays.close()
  })
})
