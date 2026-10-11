// avatar.test.ts: set_avatar publishes the kind 11333 ONOSENDAI publishes
// and draws (arkinox, 2026-10-11). The fixture in fixtures/onosendai.json was
// made with ONOSENDAI's own code (26a8f31, origin/v2 17fa254 plus PR #305's
// chat mentions, which leave the avatar code as it was: src/lib/avatar.ts,
// avatarMine.ts, client.ts) and test keys; the reading rules are ONOSENDAI's
// paidShard, ported in avatar.ts over the same pinned cyberspace-core
// verifyAvatarWork ONOSENDAI draws with. Fake relays only.

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { nip19 } from 'nostr-tools'
import { generateSecretKey } from 'nostr-tools/pure'
import { Agent } from '../src/agent.js'
import { AVATAR_KIND, avatarFromEvent, avatarTemplate, nonceTagged, paidShard, verifyAvatarWork } from '../src/avatar.js'
import { mineAvatar, mineChunk } from '../src/avatarMine.js'
import { signEvent, type NostrEvent } from '../src/nostr/event.js'
import { validateSnoPayload } from '../src/sno.js'
import type { Calibration } from '../src/space/calibration.js'
import { FakeNetwork } from './fakeRelay.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/onosendai.json', import.meta.url), 'utf8')) as { avatar: { event: NostrEvent; required: number } }

const CANONICAL = 'wss://canonical.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }
const network = new FakeNetwork()
const canonical = network.add(CANONICAL)
const agents: Agent[] = []
afterAll(async () => { for (const a of agents) await a.stop() })

async function start(extra: Partial<Parameters<typeof Agent.start>[0]> = {}): Promise<Agent> {
  const a = await Agent.start({
    stateDir: mkdtempSync(join(tmpdir(), 'cyberspace-mcp-avatar-')), relays: [CANONICAL], capCallSeconds: 30, capSessionSeconds: 120, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1500, avatarThreads: 2, ...extra,
  })
  agents.push(a)
  return a
}

/** ONOSENDAI's test wedge (src/lib/__tests__/avatarMine.test.ts) as an SNO payload: one gibson of reach, 8 of detail, 16 bits. */
const wedge = { v: 1, name: 'Wedge', unit: 0, mode: 'solid', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], colors: [[1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0]], faces: [[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 3, 2]] }

const avatarsOf = (pubkey: string): NostrEvent[] => canonical.published.filter((e) => e.kind === AVATAR_KIND && e.pubkey === pubkey)

describe('ONOSENDAI\'s avatar, read here', () => {
  it('the fixture ONOSENDAI mined is paid and reads as its shape', () => {
    const ev = fixture.avatar.event
    expect(verifyAvatarWork(ev)).toMatchObject({ ok: true, required: 16, committed: 16 })
    expect(paidShard(ev)?.name).toBe('Wedge')
    expect(ev.tags.map((t) => t[0])).toEqual(['name', 'client', 'nonce'])
  })

  it('the template is ONOSENDAI\'s: same tag order, same content, no d', () => {
    const v = validateSnoPayload(wedge)
    if (!v.ok) throw new Error(v.errors.join(' '))
    const mine = avatarTemplate(v.shard, fixture.avatar.event.created_at)
    const theirs = fixture.avatar.event
    expect(mine.kind).toBe(theirs.kind)
    expect(mine.content).toBe(theirs.content)
    expect(mine.tags).toEqual([['name', 'Wedge'], ['client', 'cyberspace-mcp']])
    expect(theirs.tags.slice(0, 2).map((t) => t[0])).toEqual(mine.tags.map((t) => t[0]))
    expect(avatarTemplate(null, 1)).toMatchObject({ content: '', tags: [['client', 'cyberspace-mcp']] })
  })

  it('a shape that has not paid is the dodecahedron, as ONOSENDAI draws it', () => {
    const ev = fixture.avatar.event
    expect(paidShard({ ...ev, tags: ev.tags.filter((t) => t[0] !== 'nonce') })).toBeNull()
    expect(paidShard({ ...ev, id: 'f' + ev.id.slice(1) })).toBeNull()
    expect(avatarFromEvent({ ...ev, kind: 33331 })).toBeNull()
  })
})

describe('mining', () => {
  it('the chunk loop and the threads find nonces the reader accepts', async () => {
    const sk = generateSecretKey()
    const v = validateSnoPayload(wedge)
    if (!v.ok) throw new Error('invalid')
    const t = avatarTemplate(v.shard, 1_800_000_000)
    const pubkey = signEvent(t, sk).pubkey
    let found = null
    for (let from = 0; !found; from += 4096) found = mineChunk({ ...t, pubkey }, 16, from, 4096)
    const ev = signEvent(nonceTagged(t, found.nonce, 16), sk)
    expect(ev.id).toBe(found.id)
    expect(verifyAvatarWork(ev).ok).toBe(true)
    const threaded = await mineAvatar({ ...t, pubkey }, 16, { threads: 2, deadlineMs: 20_000 })
    expect(threaded.found).toBe(true)
    if (threaded.found) expect(verifyAvatarWork(signEvent(nonceTagged(t, threaded.nonce, 16), sk)).ok).toBe(true)
  }, 30_000)

  it('stops at the deadline and on the signal, with nothing found', async () => {
    const t = { pubkey: 'ab'.repeat(32), created_at: 1, kind: AVATAR_KIND, tags: [['client', 'cyberspace-mcp']], content: '{}' }
    const late = await mineAvatar(t, 60, { threads: 1, deadlineMs: 200 })
    expect(late).toMatchObject({ found: false, why: 'deadline' })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    expect(await mineAvatar(t, 60, { threads: 2, deadlineMs: 20_000, signal: ac.signal })).toMatchObject({ found: false, why: 'aborted' })
  }, 30_000)
})

describe('set_avatar', () => {
  it('publishes a paid kind 11333 ONOSENDAI draws, returns its id and a picture, and charges the work', async () => {
    const a = await start()
    // Other tools answer while the avatar is mined on its threads.
    const pending = a.setAvatar({ object: wedge })
    const quick = a.budgetState()
    expect(quick.text).toContain('Work:')
    const r = await pending
    const ev = avatarsOf(a.pubkey).at(-1)!
    expect(ev.id).toBe(r.data.eventId)
    expect(ev.tags.map((t) => t[0])).toEqual(['name', 'client', 'nonce'])
    expect(ev.tags.some((t) => t[0] === 'd')).toBe(false)
    expect(ev.tags.find((t) => t[0] === 'nonce')?.[2]).toBe('16')
    // ONOSENDAI's reading rules: paid, and the shape back.
    expect(verifyAvatarWork(ev).ok).toBe(true)
    const shard = paidShard(ev)!
    expect(shard.name).toBe('Wedge')
    expect(shard.vertices).toHaveLength(4)
    expect(shard.faces).toHaveLength(4)
    expect(ev.content).toBe(fixture.avatar.event.content)
    expect(r.images?.[0].mimeType).toBe('image/png')
    expect(r.data.bits).toBe(16)
    expect(a.budget.spentSeconds).toBeGreaterThan(0)
  }, 60_000)

  it('copies a public object\'s payload by address, and clear puts the dodecahedron back', async () => {
    const a = await start()
    const author = generateSecretKey()
    const object = signEvent({ kind: 33331, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'wedge']], content: JSON.stringify(wedge) }, author)
    canonical.seed(object)
    const naddr = nip19.naddrEncode({ kind: 33331, pubkey: object.pubkey, identifier: 'wedge' })
    const r = await a.setAvatar({ address: naddr })
    expect(String(r.data.source)).toContain(`33331:${object.pubkey}:wedge`)
    const ev = avatarsOf(a.pubkey).at(-1)!
    expect(paidShard(ev)?.name).toBe('Wedge')
    const cleared = await a.setAvatar({ clear: true })
    const last = avatarsOf(a.pubkey).at(-1)!
    expect(last.id).toBe(cleared.data.eventId)
    expect(last.content).toBe('')
    // Signed after the avatar it replaces, never in the same second: a tie would go to the mined id.
    expect(last.created_at).toBeGreaterThan(ev.created_at)
    expect(last.tags).toEqual([['client', 'cyberspace-mcp']])
    expect(paidShard(last)).toBeNull()
  }, 60_000)

  it('refuses before any work: over the caps, invalid, too big, or not exactly one source', async () => {
    const a = await start({ capCallSeconds: 1 })
    const huge = { ...wedge, unit: 30 }
    await expect(a.setAvatar({ object: huge })).rejects.toThrow(/owes \d+ bits of work/)
    expect(a.budget.spentSeconds).toBe(0)
    await expect(a.setAvatar({ object: { v: 1 } })).rejects.toThrow(/not valid SNO/)
    await expect(a.setAvatar({})).rejects.toThrow(/exactly one of/)
    await expect(a.setAvatar({ object: wedge, clear: true })).rejects.toThrow(/exactly one of/)
    const many = 2000
    const big = { ...wedge, vertices: Array.from({ length: many }, (_, i) => [i % 2, 0, 0]), colors: Array.from({ length: many }, () => [1, 1, 1]), faces: [] }
    await expect(a.setAvatar({ object: big })).rejects.toThrow(/at most 16384/)
    expect(avatarsOf(a.pubkey)).toHaveLength(0)
  }, 30_000)
})
