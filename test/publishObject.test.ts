// publishObject.test.ts: publish_object publishes the public kind 33331
// ONOSENDAI's PUBLISH publishes (DECK-0003 3.1; arkinox, 2026-10-13,
// amending D11: agents may publish objects, and placing public shards waits
// for a price). Fake relays only.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { nip19 } from 'nostr-tools'
import { objectFromEvent } from 'sno-core/feed'
import { Agent } from '../src/agent.js'
import { publicObjectTemplate } from '../src/publicObject.js'
import { validateSnoPayload } from '../src/sno.js'
import type { NostrEvent } from '../src/nostr/event.js'
import type { Calibration } from '../src/space/calibration.js'
import { FakeNetwork } from './fakeRelay.js'

const CANONICAL = 'wss://canonical.example'
const REFUSING = 'wss://refusing.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }
const network = new FakeNetwork()
const canonical = network.add(CANONICAL)
network.add(REFUSING, { refuse: (ev) => (ev.kind === 33331 ? 'blocked: no objects here' : null) })
const agents: Agent[] = []
afterAll(async () => { for (const a of agents) await a.stop() })

async function start(extra: Partial<Parameters<typeof Agent.start>[0]> = {}): Promise<Agent> {
  const a = await Agent.start({
    stateDir: mkdtempSync(join(tmpdir(), 'cyberspace-mcp-publish-')), relays: [CANONICAL], capCallSeconds: 30, capSessionSeconds: 120, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1500, ...extra,
  })
  agents.push(a)
  return a
}

const wedge = { v: 1, name: 'Wedge', unit: 0, mode: 'solid', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], colors: [[1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0]], faces: [[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 3, 2]] }

const objectsOf = (pubkey: string): NostrEvent[] => canonical.published.filter((e) => e.kind === 33331 && e.pubkey === pubkey)

describe('the public object', () => {
  it('is ONOSENDAI\'s publicObjectTemplate: d, name, alt, then the client tag from the signer; the payload as content, no encrypted tag', () => {
    const v = validateSnoPayload(wedge)
    if (!v.ok) throw new Error(v.errors.join(' '))
    const t = publicObjectTemplate(v.shard, 'abc', 1)
    expect(t.kind).toBe(33331)
    expect(t.tags).toEqual([['d', 'abc'], ['name', 'Wedge'], ['alt', 'a 3D object: Wedge, 4 vertices']])
    expect(JSON.parse(t.content)).toMatchObject({ name: 'Wedge', mode: 'solid' })
    expect(validateSnoPayload(JSON.parse(t.content)).ok).toBe(true)
    expect(publicObjectTemplate(v.shard, 'abc', 1, 'A red wedge.').tags[2]).toEqual(['alt', 'A red wedge.'])
  })
})

describe('publish_object', () => {
  it('publishes a public kind 33331 the feed reads, and returns an address and naddr that decode to it', async () => {
    const a = await start()
    const r = await a.publishObject({ object: wedge, description: 'A small red wedge.' })
    const ev = objectsOf(a.pubkey).at(-1)!
    expect(ev.id).toBe(r.data.eventId)
    expect(ev.tags.map((t) => t[0])).toEqual(['d', 'name', 'alt', 'client'])
    expect(ev.tags.find((t) => t[0] === 'client')?.[1]).toBe('cyberspace-mcp')
    expect(ev.tags.some((t) => t[0] === 'encrypted')).toBe(false)
    const d = String(r.data.d)
    expect(ev.tags[0]).toEqual(['d', d])
    expect(ev.tags[2]).toEqual(['alt', 'A small red wedge.'])
    // The feed's own reader (sno-core, as the Shard Feed reads) takes it as an object.
    const o = objectFromEvent(ev)
    expect(o?.address).toBe(`33331:${a.pubkey}:${d}`)
    expect(r.data.address).toBe(`33331:${a.pubkey}:${d}`)
    const decoded = nip19.decode(String(r.data.naddr))
    expect(decoded.type).toBe('naddr')
    if (decoded.type !== 'naddr') throw new Error('not an naddr')
    expect(decoded.data).toMatchObject({ kind: 33331, pubkey: a.pubkey, identifier: d })
    expect(decoded.data.relays).toContain(`${CANONICAL}/`)
    expect(r.text).toContain('does not place it in the world')
    // What it returns is what render and place take: the address resolves on the relays.
    const seen = await a.render({ address: String(r.data.naddr) })
    expect(seen.text).toContain('4 vertices')
  })

  it('the same d replaces it in place, newer created_at even within one second; a name replaces the payload\'s', async () => {
    const a = await start()
    const first = await a.publishObject({ object: wedge })
    const d = String(first.data.d)
    const second = await a.publishObject({ object: wedge, d, name: 'Wedge II' })
    expect(second.data.d).toBe(d)
    expect(second.data.replaced).toBe(true)
    const [one, two] = objectsOf(a.pubkey).filter((e) => e.tags[0][1] === d)
    expect(two.created_at).toBeGreaterThan(one.created_at)
    expect(two.tags[1]).toEqual(['name', 'Wedge II'])
    expect(JSON.parse(two.content).name).toBe('Wedge II')
    // Without a d, every publish is a new object.
    const third = await a.publishObject({ object: wedge })
    expect(third.data.d).not.toBe(d)
  })

  it('refuses a payload that is not valid SNO, a bad d and an overlong description, and publishes nothing', async () => {
    const a = await start()
    await expect(a.publishObject({ object: { v: 1 } })).rejects.toThrow(/not valid SNO/)
    await expect(a.publishObject({})).rejects.toThrow(/Give object/)
    await expect(a.publishObject({ object: 'not json' })).rejects.toThrow(/not JSON/)
    await expect(a.publishObject({ object: wedge, d: '' })).rejects.toThrow(/d must not be empty/)
    await expect(a.publishObject({ object: wedge, d: 'x'.repeat(129) })).rejects.toThrow(/at most 128/)
    await expect(a.publishObject({ object: wedge, d: 'a\nb' })).rejects.toThrow(/control characters/)
    await expect(a.publishObject({ object: wedge, d: 'ab'.repeat(16) })).rejects.toThrow(/object this server hid/)
    await expect(a.publishObject({ object: wedge, description: 'x'.repeat(281) })).rejects.toThrow(/at most 280/)
    expect(objectsOf(a.pubkey)).toHaveLength(0)
  })

  it('stops at the daily limit, and the count survives a restart', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-publish-cap-'))
    const a = await start({ stateDir, publishMaxPerDay: 2 })
    await a.publishObject({ object: wedge })
    const r = await a.publishObject({ object: wedge })
    expect(r.data.publishedToday).toBe(2)
    await expect(a.publishObject({ object: wedge })).rejects.toThrow(/2 objects in the last 24 hours/)
    await a.stop()
    const b = await start({ stateDir, publishMaxPerDay: 2 })
    await expect(b.publishObject({ object: wedge })).rejects.toThrow(/Nothing was published/)
    expect(objectsOf(a.pubkey)).toHaveLength(2)
  })

  it('a publish no relay accepts is kept for the outbox and does not count against the day', async () => {
    const a = await start({ relays: [REFUSING], publishMaxPerDay: 1 })
    const r = await a.publishObject({ object: wedge })
    expect(r.data.accepted).toEqual([])
    expect(r.text).toContain('blocked: no objects here')
    expect(r.data.publishedToday).toBe(0)
  })
})
