// avatar.test.ts: set_avatar publishes the kind 11333 ONOSENDAI publishes
// and draws (arkinox, 2026-10-11), with no proof of work (spec 8.10, ruled
// 2026-11). The fixture in fixtures/onosendai.json was made with ONOSENDAI's
// own code (26a8f31, origin/v2 17fa254 plus PR #305's chat mentions:
// src/lib/avatar.ts, avatarMine.ts, client.ts) and test keys while avatars
// still owed work: it carries a nonce tag and must still read. The reading
// rules are ONOSENDAI's paidShard, ported in avatar.ts over cyberspace-core's
// verifyAvatar. Fake relays only.

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { nip19 } from 'nostr-tools'
import { generateSecretKey } from 'nostr-tools/pure'
import { Agent } from '../src/agent.js'
import { toPayload } from 'sno-core/shards'
import { AVATAR_CONTENT_MAX, AVATAR_CONTENT_WARN, AVATAR_KIND, avatarFromEvent, avatarTemplate, paidShard, verifyAvatar } from '../src/avatar.js'
import { signEvent, type NostrEvent } from '../src/nostr/event.js'
import { validateSnoPayload } from '../src/sno.js'
import type { Calibration } from '../src/space/calibration.js'
import { FakeNetwork } from './fakeRelay.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createServer } from '../src/server.js'
import { renderShard } from '../src/render.js'
import { centroid, magentaRing } from './pngDecode.js'

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
    for (const eye of [[0, 159], [0, 159, 0, 0], [0, 1.5, 0], [0, 7681, 0], [-7681, 0, 0], '0, 159, 0', true]) {
      await expect(a.setAvatar({ object: { ...wedge, eye } })).rejects.toThrow(/Not set: "eye" must be three whole numbers of ticks \(120 a unit\), each from -7680 to 7680 \(DECK-0003 1\.17\); got .*Leave eye out \(or null\) for the automatic eye\. Nothing was signed or published\./)
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
    expect(bad.text).toContain('"eye" was not three whole numbers of ticks from -7680 to 7680, so it is left out')
  }, 30_000)

  it('validate_object names an eye it finds in one line, a malformed one as left out, and opacity 0 in one line', async () => {
    const a = await start()
    const found = a.validateObject({ payload: { ...wedge2, eye: [0, 159, 0] } })
    expect(found.text).toContain('Eye, read only when worn as an avatar (DECK-0003 1.17): CHOSEN 0, 159, 0 ticks (0, 1.325, 0 units).')
    expect(found.data.eye).toEqual([0, 159, 0])
    const bad = a.validateObject({ payload: { ...wedge, eye: [0, 159] } })
    expect(bad.data.valid).toBe(true)
    expect(bad.data.repaired).toEqual(['eye'])
    expect(bad.text).toContain('"eye" was not three whole numbers of ticks from -7680 to 7680, so it is left out')
    expect(a.validateObject({ payload: wedge }).text).not.toMatch(/eye|opacity/i)
    expect(a.validateObject({ payload: { ...wedge, opacity: 0 } }).text).toContain('Opacity 0: a reader draws nothing of this object\'s own (DECK-0003 1.11; a glow still shows).')
  }, 30_000)
})
