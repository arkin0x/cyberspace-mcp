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
import { toPayload } from 'sno-core/shards'
import { Agent } from '../src/agent.js'
import { AVATAR_CONTENT_MAX, avatarTailEvent, mineAvatarTail } from 'cyberspace-core'
import { AVATAR_KIND, MAX_AVATAR_BYTES, MAX_AVATAR_PAYLOAD_BYTES, avatarFits, avatarFromEvent, avatarPrice, avatarSeconds, avatarTemplate, avatarTriesPerSec, paidShard, verifyAvatarWork } from '../src/avatar.js'
import { THREAD_SPAN, mineAvatar } from '../src/avatarMine.js'
import { signEvent, type NostrEvent } from '../src/nostr/event.js'
import { validateSnoPayload } from '../src/sno.js'
import { measureAvatarTriesPerSec, type Calibration } from '../src/space/calibration.js'
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

/** ONOSENDAI's test wedge (src/lib/__tests__/avatarMine.test.ts) as an SNO payload: one gibson of reach, 8 of detail, 10 bits (16 before 2026-11). */
const wedge = { v: 1, name: 'Wedge', unit: 0, mode: 'solid', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], colors: [[1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0]], faces: [[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 3, 2]] }

/** A points cloud within one gibson whose payload grows about 25 bytes a vertex: 4,000 is about 101 KB and 21 bits, 5,300 is over the limit. */
const padded = (n: number) => ({
  v: 1, name: 'Padded', unit: 0, mode: 'points', faces: [],
  vertices: Array.from({ length: n }, () => [0, 0, 0]),
  ticks: Array.from({ length: n }, (_, i) => [100 + (i % 19), 101 + (i % 17), 102 + (i % 13)]),
  colors: Array.from({ length: n }, (_, i) => [((i * 37) % 255) / 255, ((i * 91) % 255) / 255, ((i * 13) % 255) / 255]),
})

const avatarsOf = (pubkey: string): NostrEvent[] => canonical.published.filter((e) => e.kind === AVATAR_KIND && e.pubkey === pubkey)

describe('ONOSENDAI\'s avatar, read here', () => {
  it('the fixture ONOSENDAI mined is paid and reads as its shape', () => {
    const ev = fixture.avatar.event
    // Mined at 16 bits under the rule before 2026-11; the shape owes 10 now, and what it committed still covers that.
    expect(verifyAvatarWork(ev)).toMatchObject({ ok: true, required: 10, committed: 16 })
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

/** The event a find gives, signed with a throwaway key: cyberspace-core's avatarTailEvent without the pubkey (signEvent sets it). */
function signTail(t: ReturnType<typeof avatarTemplate>, pubkey: string, nonce: string, target: number, sk: Uint8Array): NostrEvent {
  const tail = avatarTailEvent({ ...t, pubkey }, nonce, target)
  return signEvent({ kind: tail.kind, created_at: tail.created_at, tags: tail.tags, content: tail.content }, sk)
}

describe('mining', () => {
  it('the threads find a nonce at the end of the content whose signed id is the find, and the reader accepts it', async () => {
    const sk = generateSecretKey()
    const v = validateSnoPayload(wedge)
    if (!v.ok) throw new Error('invalid')
    const t = avatarTemplate(v.shard, 1_800_000_000)
    const pubkey = signEvent(t, sk).pubkey
    // cyberspace-core's single-thread miner, for comparison: the same split, the same event shape.
    const single = mineAvatarTail({ ...t, pubkey }, 16)
    if (!single) throw new Error('not mined')
    expect(signTail(t, pubkey, single.found.nonce, 16, sk).id).toBe(single.found.id)
    const threaded = await mineAvatar({ ...t, pubkey }, 16, { threads: 2, deadlineMs: 20_000 })
    expect(threaded.found).toBe(true)
    if (!threaded.found) return
    const ev = signTail(t, pubkey, threaded.nonce, 16, sk)
    expect(ev.id).toBe(threaded.id)
    expect(verifyAvatarWork(ev)).toMatchObject({ ok: true, required: 10, committed: 16 })
    expect(ev.tags).toEqual([['name', 'Wedge'], ['client', 'cyberspace-mcp'], ['nonce', '0', '16']])
    // The nonce is the content's last field, decimal digits; the shape before it is the template's, byte for byte.
    expect(ev.content).toBe(`${t.content.slice(0, -1)},"nonce":"${threaded.nonce}"}`)
    expect(threaded.nonce).toMatch(/^\d+$/)
    // The reader ignores the trailing field: the shape is the wedge, nothing added.
    const shard = paidShard(ev)!
    expect(shard.name).toBe('Wedge')
    expect(shard.vertices).toHaveLength(4)
    expect(shard.faces).toHaveLength(4)
    expect(JSON.stringify(toPayload(shard))).toBe(t.content)
    expect(shard.extra?.nonce).toBeUndefined()
  }, 30_000)

  it('each thread starts its own range: the second thread\'s find is a 13-digit nonce', async () => {
    // One thread, from the second thread's start, finds what thread 1 of 2 would: proof the starts are disjoint.
    const t = { pubkey: 'ab'.repeat(32), created_at: 1, kind: AVATAR_KIND, tags: [['client', 'cyberspace-mcp']], content: '{"vertices":[]}' }
    const second = mineAvatarTail(t, 8, THREAD_SPAN)
    expect(second?.found.nonce.replace(/^0+/, '')).toMatch(/^1\d{12}$/)
  })

  it('stops at the deadline and on the signal, with nothing found', async () => {
    const t = { pubkey: 'ab'.repeat(32), created_at: 1, kind: AVATAR_KIND, tags: [['client', 'cyberspace-mcp']], content: '{}' }
    const late = await mineAvatar(t, 60, { threads: 1, deadlineMs: 200 })
    expect(late).toMatchObject({ found: false, why: 'deadline' })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    expect(await mineAvatar(t, 60, { threads: 2, deadlineMs: 20_000, signal: ac.signal })).toMatchObject({ found: false, why: 'aborted' })
    const gone = new AbortController()
    gone.abort()
    expect(await mineAvatar(t, 60, { threads: 2, deadlineMs: 20_000, signal: gone.signal })).toMatchObject({ found: false, why: 'aborted', tries: 0 })
  }, 30_000)

  it('refuses before any thread starts: content that is not a JSON object, a target the miner cannot aim for', async () => {
    const t = { pubkey: 'ab'.repeat(32), created_at: 1, kind: AVATAR_KIND, tags: [], content: '[1,2]' }
    await expect(mineAvatar(t, 8, { threads: 1, deadlineMs: 1000 })).rejects.toThrow(/not a JSON object/)
    await expect(mineAvatar({ ...t, content: '{}' }, 65, { threads: 1, deadlineMs: 1000 })).rejects.toThrow(/0 to 64 bits/)
  })
})

describe('the price', () => {
  it('a try costs the same at any size: the estimate depends on the bits, the rate and the threads only', () => {
    expect(avatarSeconds(20, 2_000_000, 1)).toBeCloseTo(2 ** 20 / 2_000_000)
    expect(avatarSeconds(21, 2_000_000, 1)).toBeCloseTo(2 * avatarSeconds(20, 2_000_000, 1))
    expect(avatarSeconds(20, 2_000_000, 2)).toBeLessThan(avatarSeconds(20, 2_000_000, 1))
    expect(avatarSeconds(20, 2_000_000, 2)).toBeGreaterThan(avatarSeconds(20, 2_000_000, 1) / 2)
  })

  it('the rate is the calibration\'s measured miner rate, else derived from its SHA-256 rate', () => {
    expect(avatarTriesPerSec({ sha256PerSec: 500_000, avatarTriesPerSec: 2_100_000 })).toBe(2_100_000)
    expect(avatarTriesPerSec({ sha256PerSec: 500_000 })).toBe(1_500_000)
    expect(avatarTriesPerSec({ sha256PerSec: 500_000, avatarTriesPerSec: 0 })).toBe(1_500_000)
  })

  it('the calibration measures the miner on this thread, cheaply', () => {
    const t0 = performance.now()
    const rate = measureAvatarTriesPerSec()
    expect(Number.isFinite(rate) && rate > 0).toBe(true)
    expect(performance.now() - t0).toBeLessThan(5000)
  })

  it('set_avatar quotes from the calibration\'s miner rate and the threads, before any work', async () => {
    // 1,024 tries at 100 a second on 2 threads (1.7 of one): about 6 s, over a 1 s cap.
    const a = await start({ capCallSeconds: 1, calibration: { ...cal, avatarTriesPerSec: 100 } })
    await expect(a.setAvatar({ object: wedge })).rejects.toThrow(/owes 10 bits of work \(spec 8\.10: reach and detail\), about 6\.0 s expected on 2 thread\(s\)/)
    expect(a.budget.spentSeconds).toBe(0)
  })

  it('the wedge owes 10 bits; the limit is the spec\'s, less the nonce field\'s room before mining', () => {
    const v = validateSnoPayload(wedge)
    if (!v.ok) throw new Error('invalid')
    expect(avatarPrice(avatarTemplate(v.shard, 1).content).bits).toBe(10)
    expect(MAX_AVATAR_BYTES).toBe(AVATAR_CONTENT_MAX)
    expect(MAX_AVATAR_BYTES).toBe(131_072)
    expect(avatarFits(MAX_AVATAR_PAYLOAD_BYTES)).toBe(true)
    expect(avatarFits(MAX_AVATAR_PAYLOAD_BYTES + 1)).toBe(false)
    expect(avatarFits(100_000)).toBe(true)
  })
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
    expect(ev.tags.find((t) => t[0] === 'nonce')).toEqual(['nonce', '0', '10'])
    // ONOSENDAI's reading rules: paid, and the shape back.
    expect(verifyAvatarWork(ev).ok).toBe(true)
    const shard = paidShard(ev)!
    expect(shard.name).toBe('Wedge')
    expect(shard.vertices).toHaveLength(4)
    expect(shard.faces).toHaveLength(4)
    // ONOSENDAI's content with the nonce as its last field.
    expect(ev.content.startsWith(fixture.avatar.event.content.slice(0, -1) + ',"nonce":"')).toBe(true)
    expect(r.images?.[0].mimeType).toBe('image/png')
    expect(r.data.bits).toBe(10)
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
    // Over the limit once the nonce field's room is counted: refused, nothing mined, nothing charged.
    await expect(a.setAvatar({ object: padded(5300) })).rejects.toThrow(/is 13\d{4} bytes, and an avatar's content is at most 131072 bytes/)
    expect(a.budget.spentSeconds).toBe(0)
    expect(avatarsOf(a.pubkey)).toHaveLength(0)
  }, 30_000)

  it('a payload of about 100 KB is mined and published, within the limit, and reads back', async () => {
    const a = await start()
    const r = await a.setAvatar({ object: padded(4000) })
    const ev = avatarsOf(a.pubkey).at(-1)!
    expect(ev.id).toBe(r.data.eventId)
    const bytes = new TextEncoder().encode(ev.content).length
    expect(bytes).toBeGreaterThan(100_000)
    expect(bytes).toBeLessThanOrEqual(AVATAR_CONTENT_MAX)
    expect(verifyAvatarWork(ev)).toMatchObject({ ok: true, required: 21, committed: 21 })
    expect(r.data.bits).toBe(21)
    expect(paidShard(ev)?.vertices).toHaveLength(4000)
  }, 60_000)
})
