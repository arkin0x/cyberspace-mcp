// relays.test.ts: the relay client against the in-memory relay: NIP-42 auth
// before reads, per-relay answers told apart, the publish policy (OK from
// any relay, refusals verbatim and never retried), and a live subscription
// that hears what is published after it opened.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { parseArgs, settingsFrom } from '../src/config.js'
import { DEFAULT_RELAY, RETIRED_RELAYS, Relays, isDefaultRelay, isRetiredRelay } from '../src/nostr/relays.js'
import { Holders } from '../src/chain/holders.js'
import { StateDir } from '../src/state/dir.js'
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

describe('a retired relay', () => {
  const RETIRED = RETIRED_RELAYS[0]

  it('is wss://onosendai.feeds.relay.tools (owner\'s ruling, 2026-10-31), however the URL is written', () => {
    expect(RETIRED).toBe('wss://onosendai.feeds.relay.tools')
    expect(isRetiredRelay('wss://onosendai.feeds.relay.tools/')).toBe(true)
    expect(isRetiredRelay('WSS://Onosendai.Feeds.Relay.Tools')).toBe(true)
    expect(isRetiredRelay(DEFAULT_RELAY)).toBe(false)
    expect(isRetiredRelay('not a url at all')).toBe(false)
  })

  it('is dropped from config.json and from --relay, and an emptied list falls back to the default', () => {
    const state = ['--state', '/x']
    expect(settingsFrom(parseArgs(state), { relays: [DEFAULT_RELAY, `${RETIRED}/`] }).relays).toEqual([DEFAULT_RELAY])
    expect(settingsFrom(parseArgs(state), { relays: [RETIRED] }).relays).toEqual([DEFAULT_RELAY])
    expect(settingsFrom(parseArgs([...state, '--relay', DEFAULT_RELAY, '--relay', RETIRED]), {}).relays).toEqual([DEFAULT_RELAY])
    expect(settingsFrom(parseArgs([...state, '--relay', RETIRED]), { relays: ['wss://mine.example'] }).relays).toEqual(['wss://mine.example'])
  })

  it('is never dialed, whichever list names it: a publish and a read cost it nothing and the others still count', async () => {
    const network = new FakeNetwork()
    const canonical = network.add(DEFAULT_RELAY)
    const retired = network.add(RETIRED)
    const sk = generateSecretKey()
    const relays = relaysOn(network, [DEFAULT_RELAY, RETIRED], sk)
    const event = note(sk, 'hello')
    const published = await relays.publish(event)
    expect(published.ok).toBe(true)
    expect(canonical.published.map((e) => e.id)).toEqual([event.id])
    const answers = await relays.queryEach({ kinds: [1], authors: [getPublicKey(sk)] })
    expect(answers.find((a) => a.url === `${DEFAULT_RELAY}/`)?.outcome).toBe('answered')
    expect(answers.find((a) => a.url === `${RETIRED}/`)?.outcome).toBe('unreachable')
    expect(retired.received).toHaveLength(0)
    relays.close()
  })

  it('is forgotten by a saved holders.json, on disk too, and the other holders stay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-holders-'))
    writeFileSync(join(dir, 'holders.json'), JSON.stringify([`${RETIRED}/`, 'wss://mine.example/', `${DEFAULT_RELAY}/`]))
    const holders = new Holders(StateDir.open(dir), `${DEFAULT_RELAY}/`).holders()
    expect([...holders].sort()).toEqual([`${DEFAULT_RELAY}/`, 'wss://mine.example/'])
    expect(JSON.parse(readFileSync(join(dir, 'holders.json'), 'utf8'))).toEqual(['wss://mine.example/', `${DEFAULT_RELAY}/`])
  })
})

describe('the default canonical relay', () => {
  it('is ONOSENDAI\'s DEFAULT_RELAY, wss://cyberspace.nostr1.com (owner\'s ruling, 2026-10-22)', () => {
    expect(DEFAULT_RELAY).toBe('wss://cyberspace.nostr1.com')
  })

  it('is what a server started without --relay or config.json relays uses', () => {
    expect(settingsFrom(parseArgs(['--state', '/x']), {}).relays).toEqual(['wss://cyberspace.nostr1.com'])
  })

  it('is recognized however the URL is written, and no other relay is', () => {
    expect(isDefaultRelay('wss://cyberspace.nostr1.com')).toBe(true)
    expect(isDefaultRelay('wss://cyberspace.nostr1.com/')).toBe(true)
    expect(isDefaultRelay('WSS://Cyberspace.Nostr1.com')).toBe(true)
    expect(isDefaultRelay('wss://onosendai.feeds.relay.tools')).toBe(false)
    expect(isDefaultRelay('wss://canonical.example')).toBe(false)
  })
})

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

// The state directory's lock is checked the moment before an event leaves for
// each relay, after every wait (a slow connect, an AUTH round trip), so a
// pause between the last check and the send cannot let a server that lost
// its lock publish (lock.ts; review of #48, L1).
describe('beforePublish, the lock\'s check before every send', () => {
  class LockLostError extends Error { override name = 'LockLostError' }
  const URL_A = 'wss://slow-connect.example'
  const URL_B = 'wss://auth-on-publish.example'

  it('runs after a slow connect, before the event goes out, and a refusal there stops the publish', async () => {
    const network = new FakeNetwork()
    // The first connection (the auth pass) is refused at once; the publish's own connect then takes 300 ms.
    const relay = network.add(URL_A, { requireAuth: false, connectDelayMs: 300, refuseConnects: 1 })
    const t0 = Date.now()
    const calls: number[] = []
    // The second check is the one after the connect: the lock is lost by then (a pause landed in the wait).
    const relays = new Relays({
      urls: [URL_A], signAuth: async (t) => finalizeEvent(t, generateSecretKey()), websocketImplementation: network.WebSocket, maxWaitMs: 1500,
      beforePublish: () => { calls.push(Date.now() - t0); if (calls.length >= 2) throw new LockLostError('Refused to publish an event: this server no longer holds its lock') },
    })
    try {
      await expect(relays.publish(note(generateSecretKey(), 'never sent'))).rejects.toThrow(LockLostError)
      expect(calls).toHaveLength(2)
      expect(calls[1]).toBeGreaterThanOrEqual(290)
      expect(relay.published).toHaveLength(0)
    } finally {
      relays.close()
    }
  })

  it('runs again before the send that follows an AUTH the relay asked for, and a refusal there stops it', async () => {
    const network = new FakeNetwork()
    const relay = network.add(URL_B, { requireAuth: false, challengeOnReq: true, requireAuthToPublish: true })
    let calls = 0
    const relays = new Relays({
      urls: [URL_B], signAuth: async (t) => finalizeEvent(t, generateSecretKey()), websocketImplementation: network.WebSocket, maxWaitMs: 1500,
      // The top check, the one before the first send (refused: auth-required), then the one after the AUTH: lost by then.
      beforePublish: () => { if (++calls >= 3) throw new LockLostError('Refused to publish an event: this server no longer holds its lock') },
    })
    try {
      await expect(relays.publish(note(generateSecretKey(), 'never sent'))).rejects.toThrow(LockLostError)
      expect(calls).toBe(3)
      expect(relay.published).toHaveLength(0)
    } finally {
      relays.close()
    }
  })

  it('lets the event go when every check passes', async () => {
    const network = new FakeNetwork()
    const relay = network.add(URL_B, { requireAuth: false, challengeOnReq: true, requireAuthToPublish: true })
    let calls = 0
    const relays = new Relays({ urls: [URL_B], signAuth: async (t) => finalizeEvent(t, generateSecretKey()), websocketImplementation: network.WebSocket, maxWaitMs: 1500, beforePublish: () => { calls++ } })
    try {
      expect((await relays.publish(note(generateSecretKey(), 'sent'))).ok).toBe(true)
      expect(calls).toBe(3)
      expect(relay.published).toHaveLength(1)
    } finally {
      relays.close()
    }
  })
})
