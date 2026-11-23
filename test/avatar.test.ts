// avatar.test.ts: set_avatar publishes the kind 11333 ONOSENDAI publishes
// and draws (arkinox, 2026-10-11), with no proof of work (spec 8.10, ruled
// 2026-11). The fixture in fixtures/onosendai.json was made with ONOSENDAI's
// own code (26a8f31, origin/v2 17fa254 plus PR #305's chat mentions:
// src/lib/avatar.ts, avatarMine.ts, client.ts) and test keys while avatars
// still owed work: it carries a nonce tag and must still read. The reading
// rules are ONOSENDAI's paidShard, ported in avatar.ts over cyberspace-core's
// verifyAvatar. Fake relays only.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { nip19 } from 'nostr-tools'
import { generateSecretKey } from 'nostr-tools/pure'
import { Agent } from '../src/agent.js'
import { toPayload } from 'sno-core/shards'
import { AVATAR_CONTENT_MAX, AVATAR_CONTENT_WARN, AVATAR_KIND, DEFAULT_AVATAR_PER_DAY, avatarFromEvent, avatarTemplate, paidShard, verifyAvatar } from '../src/avatar.js'
import { signEvent, type NostrEvent } from '../src/nostr/event.js'
import { validateSnoPayload } from '../src/sno.js'
import type { Calibration } from '../src/space/calibration.js'
import { parseArgs, settingsFrom } from '../src/config.js'
import { FakeNetwork } from './fakeRelay.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createServer } from '../src/server.js'
import { renderShard } from '../src/render.js'
import { centroid, magentaRing } from './pngDecode.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/onosendai.json', import.meta.url), 'utf8')) as { avatar: { event: NostrEvent; required: number } }

const CANONICAL = 'wss://canonical.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }
const REFUSING = 'wss://refusing.example'
const network = new FakeNetwork()
const canonical = network.add(CANONICAL)
network.add(REFUSING, { refuse: (ev) => (ev.kind === AVATAR_KIND ? 'rate-limited: slow down' : null) })
const agents: Agent[] = []
afterAll(async () => { for (const a of agents) await a.stop() })

async function start(extra: Partial<Parameters<typeof Agent.start>[0]> = {}): Promise<Agent> {
  const a = await Agent.start({
    stateDir: mkdtempSync(join(tmpdir(), 'cyberspace-mcp-avatar-')), relays: [CANONICAL], capCallSeconds: 30, capSessionSeconds: 120, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1500, ...extra,
  })
  agents.push(a)
  return a
}

/** ONOSENDAI's test wedge (src/lib/__tests__/avatarMine.test.ts) as an SNO payload: one gibson of reach, 8 of detail. */
const wedge = { v: 1, name: 'Wedge', unit: 0, mode: 'solid', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], colors: [[1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0]], faces: [[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 3, 2]] }

/** A points cloud within one gibson whose payload grows about 25 bytes a vertex: 3,000 is about 76 KB, 5,300 is over the limit. */
const padded = (n: number) => ({
  v: 1, name: 'Padded', unit: 0, mode: 'points', faces: [],
  vertices: Array.from({ length: n }, () => [0, 0, 0]),
  ticks: Array.from({ length: n }, (_, i) => [100 + (i % 19), 101 + (i % 17), 102 + (i % 13)]),
  colors: Array.from({ length: n }, (_, i) => [((i * 37) % 255) / 255, ((i * 91) % 255) / 255, ((i * 13) % 255) / 255]),
})

/** A padded payload whose content as signed is exactly `bytes` long: the vertex count gets within 63, the name (up to 64 characters) the rest. */
function exactly(bytes: number) {
  const sizeOf = (n: number): number => { const v = validateSnoPayload({ ...padded(n), name: 'P' }); if (!v.ok) throw new Error(v.errors.join(' ')); return v.bytes }
  // About 25.3 bytes a vertex: aim a little short with each step, a handful of validations in all.
  let n = Math.floor(bytes / 26)
  for (let step = 0; step < 20; step++) {
    const base = sizeOf(n)
    if (base > bytes) { n -= 3; continue }
    if (bytes - base <= 63) return { ...padded(n), name: 'P'.repeat(1 + bytes - base) }
    n += Math.max(1, Math.floor((bytes - base - 30) / 26))
  }
  throw new Error(`no payload of exactly ${bytes} bytes found`)
}

const avatarsOf = (pubkey: string): NostrEvent[] => canonical.published.filter((e) => e.kind === AVATAR_KIND && e.pubkey === pubkey)

describe('ONOSENDAI\'s avatar, read here', () => {
  it('the fixture ONOSENDAI mined while avatars owed work still reads as its shape, nonce tag and all', () => {
    const ev = fixture.avatar.event
    expect(verifyAvatar(ev)).toMatchObject({ ok: true, reason: 'ok' })
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

  it('work is not read: without its nonce tag, or with an id of no zeros, the shape is the same', () => {
    const ev = fixture.avatar.event
    expect(paidShard({ ...ev, tags: ev.tags.filter((t) => t[0] !== 'nonce') })?.name).toBe('Wedge')
    expect(paidShard({ ...ev, id: 'f' + ev.id.slice(1) })?.name).toBe('Wedge')
    expect(avatarFromEvent({ ...ev, kind: 33331 })).toBeNull()
  })

  it('an avatar mined with the nonce as the last field of its content reads without it', () => {
    const ev = fixture.avatar.event
    const content = `${ev.content.slice(0, -1)},"nonce":"000000000000004211"}`
    const shard = paidShard({ ...ev, content, tags: [['name', 'Wedge'], ['client', 'ONOSENDAI'], ['nonce', '0', '16']] })!
    expect(shard.name).toBe('Wedge')
    expect(shard.extra?.nonce).toBeUndefined()
    expect(JSON.stringify(toPayload(shard))).toBe(ev.content)
  })

  it('over the limit, or not a shape, is the dodecahedron, as ONOSENDAI draws it', () => {
    const ev = fixture.avatar.event
    const oversize = { ...ev, content: `${ev.content.slice(0, -1)},"pad":"${'x'.repeat(AVATAR_CONTENT_MAX)}"}` }
    expect(verifyAvatar(oversize)).toMatchObject({ ok: false, reason: 'too-large' })
    expect(paidShard(oversize)).toBeNull()
    expect(verifyAvatar({ ...ev, content: '{"vertices":"none"}' })).toMatchObject({ ok: false, reason: 'not-an-avatar' })
    expect(paidShard({ ...ev, content: 'not json' })).toBeNull()
  })
})

describe('set_avatar', () => {
  it('publishes a kind 11333 ONOSENDAI draws at once, with no work and no charge, and returns its id and a picture', async () => {
    const a = await start()
    const r = await a.setAvatar({ object: wedge })
    const ev = avatarsOf(a.pubkey).at(-1)!
    expect(ev.id).toBe(r.data.eventId)
    expect(ev.tags).toEqual([['name', 'Wedge'], ['client', 'cyberspace-mcp']])
    expect(ev.tags.some((t) => t[0] === 'd')).toBe(false)
    // ONOSENDAI's reading rules: accepted, and the shape back.
    expect(verifyAvatar(ev).ok).toBe(true)
    const shard = paidShard(ev)!
    expect(shard.name).toBe('Wedge')
    expect(shard.vertices).toHaveLength(4)
    expect(shard.faces).toHaveLength(4)
    expect(ev.content).toBe(fixture.avatar.event.content)
    expect(r.images?.[0].mimeType).toBe('image/png')
    expect(r.data.bits).toBeUndefined()
    expect(r.data.bytes).toBe(new TextEncoder().encode(ev.content).length)
    expect(r.text).not.toMatch(/bits|tries|remote signer/)
    expect(a.budget.spentSeconds).toBe(0)
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
    // Signed after the avatar it replaces, never in the same second: a tie would go to the lower id, by chance.
    expect(last.created_at).toBeGreaterThan(ev.created_at)
    expect(last.tags).toEqual([['client', 'cyberspace-mcp']])
    expect(paidShard(last)).toBeNull()
  }, 60_000)

  it('refuses invalid, too big, or not exactly one source; a far-reaching shape owes nothing, even under a 1 s cap', async () => {
    const a = await start({ capCallSeconds: 1 })
    const huge = { ...wedge, unit: 30 }
    const far = await a.setAvatar({ object: huge })
    expect(avatarsOf(a.pubkey).at(-1)?.id).toBe(far.data.eventId)
    expect(a.budget.spentSeconds).toBe(0)
    await expect(a.setAvatar({ object: { v: 1 } })).rejects.toThrow(/not valid SNO/)
    await expect(a.setAvatar({})).rejects.toThrow(/exactly one of/)
    await expect(a.setAvatar({ object: wedge, clear: true })).rejects.toThrow(/exactly one of/)
    const before = avatarsOf(a.pubkey).length
    await expect(a.setAvatar({ object: padded(5300) })).rejects.toThrow(/the payload is 13\d{4} bytes, and an avatar is at most 131072 bytes/)
    expect(avatarsOf(a.pubkey)).toHaveLength(before)
  }, 30_000)

  it('the limit is exact: 131072 bytes of content are published, 131073 are refused', async () => {
    const a = await start()
    const at = exactly(AVATAR_CONTENT_MAX)
    const r = await a.setAvatar({ object: at })
    expect(r.data.bytes).toBe(AVATAR_CONTENT_MAX)
    expect(new TextEncoder().encode(avatarsOf(a.pubkey).at(-1)!.content).length).toBe(AVATAR_CONTENT_MAX)
    const before = avatarsOf(a.pubkey).length
    await expect(a.setAvatar({ object: exactly(AVATAR_CONTENT_MAX + 1) })).rejects.toThrow(/the payload is 131073 bytes, and an avatar is at most 131072 bytes/)
    expect(avatarsOf(a.pubkey)).toHaveLength(before)
  }, 120_000)

  it('a burst of calls signs each in a later second, never dated ahead of the clock', async () => {
    const a = await start()
    const results = await Promise.all([a.setAvatar({ object: wedge }), a.setAvatar({ object: { ...wedge, name: 'Second' } }), a.setAvatar({ clear: true })])
    const events = results.map((r) => avatarsOf(a.pubkey).find((e) => e.id === r.data.eventId)!)
    const times = events.map((e) => e.created_at)
    expect(new Set(times).size).toBe(3)
    expect(Math.max(...times)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
  }, 30_000)

  it('a payload of about 76 KB is published as it is, with a short note that remote signers may refuse one that large', async () => {
    const a = await start()
    const r = await a.setAvatar({ object: padded(3000) })
    const ev = avatarsOf(a.pubkey).at(-1)!
    expect(ev.id).toBe(r.data.eventId)
    const bytes = new TextEncoder().encode(ev.content).length
    expect(bytes).toBeGreaterThan(AVATAR_CONTENT_WARN)
    expect(bytes).toBeLessThanOrEqual(AVATAR_CONTENT_MAX)
    expect(r.data.bytes).toBe(bytes)
    expect(r.text).toContain('remote signer')
    expect(verifyAvatar(ev).ok).toBe(true)
    expect(paidShard(ev)?.vertices).toHaveLength(3000)
  }, 60_000)

  it('stops at the daily limit, clearing included; the refusal says when the next may go, and the count survives a restart', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-avatar-cap-'))
    const a = await start({ stateDir, avatarMaxPerDay: 2 })
    const first = await a.setAvatar({ object: wedge })
    expect(first.data).toMatchObject({ leftToday: 1, maxPerDay: 2 })
    expect(first.text).toContain('1 more avatar change in the next 24 hours')
    const second = await a.setAvatar({ clear: true })
    expect(second.data).toMatchObject({ leftToday: 0, maxPerDay: 2 })
    const before = avatarsOf(a.pubkey).length
    const at = Math.floor(Date.now() / 1000)
    const refusal = await a.setAvatar({ object: wedge }).then(() => '', (e: Error) => e.message)
    expect(refusal).toMatch(/^You have set your avatar 2 times in the last 24 hours, the most your human allows \(2 a day, avatarMaxPerDay\)\. The next one can go after (\S+), in about 2[34]\.\d h\. Nothing was published\.$/)
    // The next may go 24 hours after the oldest of the two: within a few seconds of now plus a day.
    const next = Date.parse(refusal.match(/after (\S+),/)![1]) / 1000
    expect(next).toBeGreaterThanOrEqual(at - 5 + 86_400)
    expect(next).toBeLessThanOrEqual(at + 5 + 86_400)
    expect(avatarsOf(a.pubkey)).toHaveLength(before)
    await a.stop()
    const b = await start({ stateDir, avatarMaxPerDay: 2 })
    await expect(b.setAvatar({ clear: true })).rejects.toThrow(/Nothing was published/)
    expect(avatarsOf(a.pubkey)).toHaveLength(before)
    await b.stop()
    // The human raises it: the same state directory, a higher limit, and the next goes.
    const c = await start({ stateDir, avatarMaxPerDay: 3 })
    const third = await c.setAvatar({ object: wedge })
    expect(third.data).toMatchObject({ leftToday: 0, maxPerDay: 3 })
  }, 60_000)

  it('counts only the last 24 hours: avatars set more than a day ago do not count', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-avatar-old-'))
    const now = Math.floor(Date.now() / 1000)
    writeFileSync(join(stateDir, 'avatars-set.json'), JSON.stringify({ posts: [now - 86_400 - 60, now - 86_400 - 30, now - 3600] }))
    const a = await start({ stateDir, avatarMaxPerDay: 2 })
    const r = await a.setAvatar({ object: wedge })
    expect(r.data).toMatchObject({ leftToday: 0, maxPerDay: 2 })
    await expect(a.setAvatar({ clear: true })).rejects.toThrow(/2 times in the last 24 hours/)
  }, 30_000)

  it('a burst cannot slip past the limit: calls in flight count', async () => {
    const a = await start({ avatarMaxPerDay: 2 })
    const results = await Promise.allSettled([a.setAvatar({ object: wedge }), a.setAvatar({ object: { ...wedge, name: 'Second' } }), a.setAvatar({ clear: true })])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(String(refused.reason.message)).toMatch(/Nothing was published/)
    expect(avatarsOf(a.pubkey)).toHaveLength(2)
  }, 30_000)

  it('an avatar no relay accepts does not count against the day', async () => {
    const a = await start({ relays: [REFUSING], avatarMaxPerDay: 1 })
    const r = await a.setAvatar({ object: wedge })
    expect(r.data.accepted).toEqual([])
    expect(r.text).toContain('rate-limited: slow down')
    expect(r.data.leftToday).toBeNull()
    const again = await a.setAvatar({ clear: true })
    expect(again.data.accepted).toEqual([])
  }, 30_000)

  it('defaults to 12 a day, and the human sets another with --avatar-max-per-day or avatarMaxPerDay in config.json', async () => {
    expect(DEFAULT_AVATAR_PER_DAY).toBe(12)
    expect(settingsFrom(parseArgs(['--state', '/tmp/x']), {}).avatarMaxPerDay).toBe(12)
    expect(settingsFrom(parseArgs(['--state', '/tmp/x']), { avatarMaxPerDay: 4 }).avatarMaxPerDay).toBe(4)
    expect(settingsFrom(parseArgs(['--state', '/tmp/x', '--avatar-max-per-day', '30']), { avatarMaxPerDay: 4 }).avatarMaxPerDay).toBe(30)
    expect(settingsFrom(parseArgs(['--state', '/tmp/x']), { avatarMaxPerDay: 'many' }).avatarMaxPerDay).toBe(12)
    expect(settingsFrom(parseArgs(['--state', '/tmp/x']), { avatarMaxPerDay: 2.7 }).avatarMaxPerDay).toBe(2)
    const a = await start()
    const r = await a.setAvatar({ object: wedge })
    expect(r.data).toMatchObject({ leftToday: 11, maxPerDay: 12 })
  }, 30_000)
})

// The avatar's eye (DECK-0003 1.17, ruled 2026-11-16): where its own
// first-person viewer looks from. set_avatar names it in its description,
// refuses a malformed one (a publisher never writes one; null is no choice),
// says which eye goes out and what ONOSENDAI does to one past 4 gibsons, and
// marks it on the picture; render, publish_object and validate_object see it too.
describe('set_avatar and the eye', () => {
  const sent = () => canonical.published.length
  const wedge2 = { ...wedge, v: 2, colors: [1, 1, 1, 1] }

  it('the tool description says what the eye is, which side is behind, AUTO when absent, [0, 0, 0] the origin, ticks on the object\'s grid, the 4-gibson reach', async () => {
    const server = createServer({} as unknown as Agent)
    const [x, y] = InMemoryTransport.createLinkedPair()
    await server.connect(x)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(y)
    const tools = (await client.listTools()).tools
    const tool = tools.find((t) => t.name === 'set_avatar')!
    expect(tool.description).toContain('"eye": [x, y, z]')
    expect(tool.description).toMatch(/first person/)
    expect(tool.description).toContain('In ONOSENDAI you face -Z, so [0, 150, 400] is behind you and a little up')
    expect(tool.description).toMatch(/Left out or null, the eye is AUTO: one eighth of the avatar's height below its top/)
    expect(tool.description).toContain('[0, 0, 0] is the origin')
    expect(tool.description).toMatch(/whole ticks \(120 a unit\) on the object's own grid/)
    expect(tool.description).toMatch(/not held to the shape/)
    expect(tool.description).toMatch(/within 4 gibsons of its origin on each axis: it shrinks a larger avatar and its eye together/)
    const render = tools.find((t) => t.name === 'render')!
    expect(render.description).toMatch(/chosen "eye".*magenta ring; eye: true marks the AUTO eye/)
    expect(render.inputSchema.properties).toHaveProperty('eye')
    await client.close()
  })

  it('refuses a malformed eye with nothing signed or published: two or four elements, a fraction, out of range, a string, a boolean', async () => {
    const a = await start()
    const sign = vi.spyOn(a as unknown as { sign: (t: unknown) => unknown }, 'sign')
    const before = sent()
    const pending = a.outbox.state().pending.length
    for (const eye of [[0, 159], [0, 159, 0, 0], [0, 1.5, 0], [0, 491521, 0], [-491521, 0, 0], '0, 159, 0', true]) {
      await expect(a.setAvatar({ object: { ...wedge, eye } })).rejects.toThrow(/Not set: "eye" must be three whole numbers of ticks \(120 a unit\), each from -491520 to 491520 \(DECK-0003 1\.17\); got .*Leave eye out \(or null\) for the automatic eye\. Nothing was signed or published\./)
      // As a JSON string, too.
      await expect(a.setAvatar({ object: JSON.stringify({ ...wedge, eye }) })).rejects.toThrow(/Not set: "eye" must be/)
    }
    expect(sign).not.toHaveBeenCalled()
    expect(sent()).toBe(before)
    expect(a.outbox.state().pending).toHaveLength(pending)
  }, 30_000)

  it('reads eye: null as no eye chosen: AUTO, nothing written, and the caller\'s object left as it was', async () => {
    const a = await start()
    const object = { ...wedge, eye: null }
    const r = await a.setAvatar({ object })
    expect(r.text).toContain('eye AUTO 0, 105, 0 ticks (0, 0.875, 0 units)')
    expect(JSON.parse(avatarsOf(a.pubkey).at(-1)!.content)).not.toHaveProperty('eye')
    expect(object).toHaveProperty('eye', null)
  }, 30_000)

  it('reports AUTO when the payload chose none, writes none, and marks it on the picture', async () => {
    const a = await start()
    const r = await a.setAvatar({ object: wedge })
    // The wedge reaches from 0 to 120 ticks up: 120 - floor(120 / 8) = 105.
    expect(r.text).toContain('eye AUTO 0, 105, 0 ticks (0, 0.875, 0 units)')
    expect(r.data.eye).toEqual({ ticks: [0, 105, 0], chosen: false })
    expect(r.text).toContain('the magenta ring is the eye, AUTO, at 0, 0.875, 0 units')
    expect(r.text).not.toMatch(/nearer/)
    expect(JSON.parse(avatarsOf(a.pubkey).at(-1)!.content)).not.toHaveProperty('eye')
    expect(magentaRing(Buffer.from(r.images![0].data, 'base64')).n).toBeGreaterThan(30)
  }, 30_000)

  it('puts the ring on its picture where a vertex at the eye\'s wire point is drawn: drawnEye / 120, end to end', async () => {
    const a = await start()
    // One point 1 unit right, 2 up and 3 toward the viewer, and the eye written at the same place.
    const point = { v: 2, name: 'Point', unit: 0, mode: 'points', vertices: [[1, 2, 3]], colors: [7], faces: [] }
    const r = await a.setAvatar({ object: { ...point, eye: [120, 240, 360] } })
    expect(r.text).toContain('eye CHOSEN 120, 240, 360 ticks (1, 2, 3 units)')
    const ring = magentaRing(Buffer.from(r.images![0].data, 'base64'))
    // The same shape drawn with no eye: the frame is the same, since the eye is at the vertex.
    const v = validateSnoPayload(point)
    if (!v.ok) throw new Error(v.errors.join(' '))
    const dot = centroid(renderShard(v.shard, {}).png, (c) => c[2] > 150 && c[1] > 150 && c[0] < 100)
    expect(dot.n).toBeGreaterThan(5)
    expect(ring.n).toBeGreaterThan(30)
    expect(Math.abs(ring.x - dot.x)).toBeLessThan(3)
    expect(Math.abs(ring.y - dot.y)).toBeLessThan(3)
  }, 30_000)

  it('reports CHOSEN and publishes it in the version 2 frame; [0, 0, 0] is a choice, and -0 is written as 0', async () => {
    const a = await start()
    // A version 1 payload's Z points the other way (DECK-0003 2): sno-core writes its eye out negated with the vertices.
    const r = await a.setAvatar({ object: { ...wedge, eye: [0, 159, 30] } })
    expect(r.text).toContain('eye CHOSEN 0, 159, -30 ticks (0, 1.325, -0.25 units)')
    expect(r.data.eye).toEqual({ ticks: [0, 159, -30], chosen: true })
    expect(r.text).toContain('the magenta ring is the eye, CHOSEN, at 0, 1.325, -0.25 units')
    const ev = avatarsOf(a.pubkey).at(-1)!
    expect(JSON.parse(ev.content).eye).toEqual([0, 159, -30])
    expect(paidShard(ev)?.extra?.eye).toEqual([0, 159, -30])
    const origin = await a.setAvatar({ object: { ...wedge2, eye: [0, 0, 0] } })
    expect(origin.text).toContain('eye CHOSEN 0, 0, 0 ticks (0, 0, 0 units)')
    expect(JSON.parse(avatarsOf(a.pubkey).at(-1)!.content).eye).toEqual([0, 0, 0])
    // JSON.parse keeps a -0; the content never carries one (DECK-0003 1.17: never -0).
    await a.setAvatar({ object: JSON.stringify(wedge2).replace(/}$/, ',"eye":[-0,159,-0]}') })
    const content = avatarsOf(a.pubkey).at(-1)!.content
    expect(content).toContain('"eye":[0,159,0]')
    expect(content).not.toContain('-0')
  }, 30_000)

  it('says when ONOSENDAI will draw the eye nearer: an eye past 4 gibsons, and a shape past 4 that shrinks with its eye', async () => {
    const a = await start()
    const behind = await a.setAvatar({ object: { ...wedge2, eye: [0, 7680, 7680] } })
    expect(behind.text).toContain('eye CHOSEN 0, 7680, 7680 ticks (0, 64, 64 units)')
    expect(behind.text).toContain('ONOSENDAI will draw it nearer: it draws an avatar within 4 gibsons of its origin on each axis, so the eye reaches past 4 gibsons, so it is brought straight in toward your origin, to 0, 4, 4 gibsons from your origin.')
    // Unit 3: the wedge reaches 8 gibsons, drawn at half scale, and the AUTO eye 7 gibsons up comes down to 3.5.
    const big = await a.setAvatar({ object: { ...wedge2, unit: 3 } })
    expect(big.text).toContain('ONOSENDAI will draw it nearer: it draws an avatar within 4 gibsons of its origin on each axis, so the shape reaches 8 gibsons, so it is drawn at 0.5 of true scale and the eye with it, to 0, 3.5, 0 gibsons from your origin.')
    // Both: shrunk with the shape, and still past 4, then brought in.
    const both = await a.setAvatar({ object: { ...wedge2, unit: 3, eye: [0, 0, 7680] } })
    expect(both.text).toContain('the shape reaches 8 gibsons, so it is drawn at 0.5 of true scale and the eye with it, and the eye is then brought straight in toward your origin, to 0, 0, 4 gibsons from your origin.')
  }, 30_000)

  it('takes an eye out to the 4,096-unit bound (DECK-0003 1.8): 7681 ticks, once past the 64-unit bound, and 491520 itself', async () => {
    const a = await start()
    const past64 = await a.setAvatar({ object: { ...wedge2, eye: [0, 7681, 0] } })
    expect(past64.text).toContain('eye CHOSEN 0, 7681, 0 ticks')
    expect(JSON.parse(avatarsOf(a.pubkey).at(-1)!.content).eye).toEqual([0, 7681, 0])
    const edge = await a.setAvatar({ object: { ...wedge2, eye: [-491520, 0, 491520] } })
    expect(edge.text).toContain('eye CHOSEN -491520, 0, 491520 ticks')
    expect(JSON.parse(avatarsOf(a.pubkey).at(-1)!.content).eye).toEqual([-491520, 0, 491520])
  }, 30_000)

  it('leaves out a malformed eye in an object copied by address, so the eye is AUTO', async () => {
    const a = await start()
    const author = generateSecretKey()
    const object = signEvent({ kind: 33331, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'wedge-eye']], content: JSON.stringify({ ...wedge, eye: [0, 0.5, 0] }) }, author)
    canonical.seed(object)
    const r = await a.setAvatar({ address: `33331:${object.pubkey}:wedge-eye` })
    expect(String(r.data.source)).toContain('its malformed eye is left out, so the eye is AUTO')
    expect(r.text).toContain('eye AUTO 0, 105, 0 ticks')
    expect(JSON.parse(avatarsOf(a.pubkey).at(-1)!.content)).not.toHaveProperty('eye')
  }, 30_000)

  it('render marks a chosen eye always, and the AUTO eye only when asked; an object with no vertices has its AUTO eye at the origin', async () => {
    const a = await start()
    const chosen = await a.render({ object: { ...wedge2, eye: [0, 159, 0] }, size: 128 })
    expect(chosen.text).toContain('the magenta ring is the eye, CHOSEN, at 0, 1.325, 0 units')
    expect(chosen.data.eye).toEqual({ ticks: [0, 159, 0], chosen: true })
    expect(magentaRing(Buffer.from(chosen.images![0].data, 'base64')).n).toBeGreaterThan(10)
    const plain = await a.render({ object: wedge2, size: 128 })
    expect(plain.text).not.toMatch(/eye/)
    expect(plain.data.eye).toBeUndefined()
    expect(magentaRing(Buffer.from(plain.images![0].data, 'base64')).n).toBe(0)
    const auto = await a.render({ object: wedge2, size: 128, eye: true })
    expect(auto.text).toContain('the magenta ring is the eye, AUTO, at 0, 0.875, 0 units')
    const empty = await a.render({ object: { v: 2, name: 'Nothing', unit: 0, mode: 'solid', vertices: [], colors: [], faces: [] }, size: 128, eye: true })
    expect(empty.text).toContain('the magenta ring is the eye, AUTO, at 0, 0, 0 units')
    expect(empty.data.eye).toEqual({ ticks: [0, 0, 0], chosen: false })
    await expect(a.render({ layout: [{ piece: 'x', at: [0, 0, 0] }] as never, eye: true })).rejects.toThrow(/eye goes with one object/)
  }, 30_000)

  it('publish_object carries a valid eye to the feed and leaves a malformed one out, named', async () => {
    const a = await start()
    const r = await a.publishObject({ object: { ...wedge2, eye: [0, 159, -60] } })
    const ev = canonical.published.find((e) => e.id === r.data.eventId)!
    expect(JSON.parse(ev.content).eye).toEqual([0, 159, -60])
    const bad = await a.publishObject({ object: { ...wedge2, eye: [0, 159] } })
    expect(JSON.parse(canonical.published.find((e) => e.id === bad.data.eventId)!.content)).not.toHaveProperty('eye')
    expect(bad.text).toContain('"eye" was not three whole numbers of ticks from -491520 to 491520, so it is left out')
  }, 30_000)

  it('validate_object names an eye it finds in one line, a malformed one as left out, and opacity 0 in one line', async () => {
    const a = await start()
    const found = a.validateObject({ payload: { ...wedge2, eye: [0, 159, 0] } })
    expect(found.text).toContain('Eye, read only when worn as an avatar (DECK-0003 1.17): CHOSEN 0, 159, 0 ticks (0, 1.325, 0 units).')
    expect(found.data.eye).toEqual([0, 159, 0])
    const bad = a.validateObject({ payload: { ...wedge, eye: [0, 159] } })
    expect(bad.data.valid).toBe(true)
    expect(bad.data.repaired).toEqual(['eye'])
    expect(bad.text).toContain('"eye" was not three whole numbers of ticks from -491520 to 491520, so it is left out')
    expect(a.validateObject({ payload: wedge }).text).not.toMatch(/eye|opacity/i)
    expect(a.validateObject({ payload: { ...wedge, opacity: 0 } }).text).toContain('Opacity 0: a reader draws nothing of this object\'s own (DECK-0003 1.11; a glow still shows).')
  }, 30_000)
})

// The avatar's facing (DECK-0003 1.18, ruled 2026-11-16): how it turns as it
// moves, "path" (the default) or "upright". set_avatar takes it as face or in
// the payload, writes nothing for "path", writes "upright", refuses anything
// else with nothing signed, and says which facing goes out.
describe('set_avatar and the facing', () => {
  const sent = () => canonical.published.length
  const wedge2 = { ...wedge, v: 2, colors: [1, 1, 1, 1] }
  const lastContent = (a: Agent): Record<string, unknown> => JSON.parse(avatarsOf(a.pubkey).at(-1)!.content)

  it('the tool offers face, "path" or "upright", and its description says what each does', async () => {
    const server = createServer({} as unknown as Agent)
    const [x, y] = InMemoryTransport.createLinkedPair()
    await server.connect(x)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(y)
    const tool = (await client.listTools()).tools.find((t) => t.name === 'set_avatar')!
    expect((tool.inputSchema.properties as Record<string, { enum?: string[] }>).face.enum).toEqual(['path', 'upright'])
    expect(tool.description).toMatch(/"path" \(the default\) points your front, -Z, along your last move and tilts with it/)
    expect(tool.description).toMatch(/"upright" turns you only about the viewer's up and never tilts you, and a move straight up or down keeps your heading/)
    expect(tool.description).toMatch(/"path" writes nothing, "upright" is written into the payload, and any other value .* is refused/)
    expect(tool.description).not.toContain('\u2014')
    // A value the schema does not name never reaches the agent: the call is an error.
    const wrong = await client.callTool({ name: 'set_avatar', arguments: { object: wedge2, face: 'Upright' } })
    expect(wrong.isError).toBe(true)
    await client.close()
  })

  it('"path", given or left out, writes no face and reports path', async () => {
    const a = await start()
    const none = await a.setAvatar({ object: wedge2 })
    expect(none.text).toContain('facing path (the default: your front, the payload\'s -Z, points along your last move and tilts with it)')
    expect(none.data.face).toBe('path')
    expect(lastContent(a)).not.toHaveProperty('face')
    const given = await a.setAvatar({ object: wedge2, face: 'path' })
    expect(given.data.face).toBe('path')
    expect(lastContent(a)).not.toHaveProperty('face')
    // In the payload too, and as null: no choice.
    for (const face of ['path', null]) {
      const object = { ...wedge2, face }
      const r = await a.setAvatar({ object })
      expect(r.data.face).toBe('path')
      expect(lastContent(a)).not.toHaveProperty('face')
      expect(object).toHaveProperty('face', face)
    }
  }, 30_000)

  it('"upright", as face or in the payload, is written into the payload and reported', async () => {
    const a = await start()
    const r = await a.setAvatar({ object: wedge2, face: 'upright' })
    expect(r.text).toContain('facing upright (you turn only about the viewer\'s up and never tilt; a move straight up or down keeps your heading)')
    expect(r.data.face).toBe('upright')
    const ev = avatarsOf(a.pubkey).at(-1)!
    expect(JSON.parse(ev.content).face).toBe('upright')
    expect(paidShard(ev)?.extra?.face).toBe('upright')
    // A version 1 payload carries it as given: facing is a name, not a direction in the frame.
    const fromPayload = await a.setAvatar({ object: JSON.stringify({ ...wedge, face: 'upright' }) })
    expect(fromPayload.data.face).toBe('upright')
    expect(lastContent(a).face).toBe('upright')
  }, 30_000)

  it('face replaces the payload\'s: "path" removes an "upright" payload\'s, and the caller\'s object is left as it was', async () => {
    const a = await start()
    const object = { ...wedge2, face: 'upright' }
    const r = await a.setAvatar({ object, face: 'path' })
    expect(r.data.face).toBe('path')
    expect(lastContent(a)).not.toHaveProperty('face')
    expect(object.face).toBe('upright')
    await a.setAvatar({ object: wedge2, face: 'upright' })
    expect(lastContent(a).face).toBe('upright')
    // The input replaces even a payload face that would be refused on its own.
    for (const face of ['Upright', 'lean', 7]) {
      const r2 = await a.setAvatar({ object: { ...wedge2, face }, face: 'upright' })
      expect(r2.data.face).toBe('upright')
      expect(lastContent(a).face).toBe('upright')
    }
  }, 30_000)

  it('refuses a malformed face, as the input or in the payload, with nothing signed or published', async () => {
    const a = await start()
    const sign = vi.spyOn(a as unknown as { sign: (t: unknown) => unknown }, 'sign')
    const before = sent()
    const pending = a.outbox.state().pending.length
    for (const face of ['Upright', 'PATH', 'up', 'lean', '', 'upright ', 1, true, ['upright'], { mode: 'upright' }, null]) {
      await expect(a.setAvatar({ object: wedge2, face })).rejects.toThrow(/Not set: face must be "path" or "upright", in lower case \(DECK-0003 1\.18\); got .*Leave it out for "path"\. Nothing was signed or published\./)
      if (face === null) continue
      await expect(a.setAvatar({ object: { ...wedge2, face } })).rejects.toThrow(/Not set: "face" in the payload must be "path" or "upright", in lower case \(DECK-0003 1\.18\); got .*Leave face out \(or null\) for "path"\. Nothing was signed or published\./)
      await expect(a.setAvatar({ object: JSON.stringify({ ...wedge2, face }) })).rejects.toThrow(/Not set: "face" in the payload must be/)
    }
    await expect(a.setAvatar({ clear: true, face: 'upright' })).rejects.toThrow(/face goes with an avatar \(object or address\), not with clear/)
    expect(sign).not.toHaveBeenCalled()
    expect(sent()).toBe(before)
    expect(a.outbox.state().pending).toHaveLength(pending)
  }, 30_000)

  it('copied by address: an "upright" face is kept, a name this version does not know is carried (read as path), a malformed one is left out (path), and face replaces any', async () => {
    const a = await start()
    const author = generateSecretKey()
    const at = Math.floor(Date.now() / 1000)
    const upright = signEvent({ kind: 33331, created_at: at, tags: [['d', 'wedge-up']], content: JSON.stringify({ ...wedge2, face: 'upright' }) }, author)
    const bad = signEvent({ kind: 33331, created_at: at, tags: [['d', 'wedge-bad']], content: JSON.stringify({ ...wedge2, face: 'Upright' }) }, author)
    const lean = signEvent({ kind: 33331, created_at: at, tags: [['d', 'wedge-lean']], content: JSON.stringify({ ...wedge2, face: 'lean' }) }, author)
    canonical.seed(upright)
    canonical.seed(bad)
    canonical.seed(lean)
    const carried = await a.setAvatar({ address: `33331:${lean.pubkey}:wedge-lean` })
    expect(String(carried.data.source)).toContain('its face "lean" is a facing this version does not know, carried as found and read as path')
    expect(String(carried.data.source)).not.toContain('malformed face')
    expect(carried.data.face).toBe('path')
    expect(carried.text).toContain('facing path')
    expect(lastContent(a).face).toBe('lean')
    const kept = await a.setAvatar({ address: `33331:${upright.pubkey}:wedge-up` })
    expect(kept.data.face).toBe('upright')
    expect(lastContent(a).face).toBe('upright')
    const left = await a.setAvatar({ address: `33331:${bad.pubkey}:wedge-bad` })
    expect(String(left.data.source)).toContain('its malformed face is left out, so it faces along its path')
    expect(left.data.face).toBe('path')
    expect(lastContent(a)).not.toHaveProperty('face')
    const replaced = await a.setAvatar({ address: `33331:${bad.pubkey}:wedge-bad`, face: 'upright' })
    expect(String(replaced.data.source)).not.toContain('malformed face')
    expect(lastContent(a).face).toBe('upright')
    await a.setAvatar({ address: `33331:${upright.pubkey}:wedge-up`, face: 'path' })
    expect(lastContent(a)).not.toHaveProperty('face')
  }, 30_000)

  it('validate_object names an "upright" facing in one line, a malformed one as left out, and nothing for path', async () => {
    const a = await start()
    const up = a.validateObject({ payload: { ...wedge2, face: 'upright' } })
    expect(up.text).toContain('Facing, read only when worn as an avatar (DECK-0003 1.18): upright')
    expect(up.data.face).toBe('upright')
    const bad = a.validateObject({ payload: { ...wedge2, face: 'Upright' } })
    expect(bad.data.repaired).toEqual(['face'])
    expect(bad.data.face).toBe('path')
    expect(bad.text).toContain('"face" was not "path" or "upright", so it is left out: worn as an avatar, it faces along its path (DECK-0003 1.18).')
    const lean = a.validateObject({ payload: { ...wedge2, face: 'lean' } })
    expect(lean.data.repaired).toEqual([])
    expect(lean.data.face).toBe('path')
    expect(lean.data.unknownFace).toBe('lean')
    expect(lean.text).toContain('"face" "lean" is a facing this version does not know: it is carried as found, since a later revision may define it, and read as "path" (DECK-0003 1.18).')
    const path = a.validateObject({ payload: { ...wedge2, face: 'path' } })
    expect(path.text).not.toMatch(/facing|"face"/i)
    expect(path.data.face).toBe('path')
    expect(path.data.repaired).toEqual([])
  }, 30_000)
})
