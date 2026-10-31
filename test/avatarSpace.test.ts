// avatarSpace.test.ts: the agent's avatar never overlaps a person's
// (arkinox, 2026-10-11: "the avatar is larger than 1 gibson, so I don't want
// him to be adjacent to me. avatar overlap feels wrong."). The sizes are
// ONOSENDAI's (origin/v2 1a3d87b: src/scene/AvatarShape.tsx draws the
// default as an icosahedron of radius 0.5 in a one-gibson cell, and
// src/lib/avatar.ts avatarScale draws a kind 11333 shard at true scale,
// shrunk to reach 4 cells at most); the spacing is both avatars' half-extents
// and a gibson between, on some axis, at true scale (the 2^0 zoom). End to end over the fake relays: a person's
// paid avatar is read in the background and widens their box, an avatar not
// read (or never published) is the default, a bot is never protected, the
// follow tool aims just outside the operator's box, and a ride's exit says
// how far to step off. No real relay is touched; every key is generated here.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { fromPayload } from 'sno-core/shards'
import { Agent } from '../src/agent.js'
import { avatarTemplate, avatarWork, nonceTagged } from '../src/avatar.js'
import { mineChunk } from '../src/avatarMine.js'
import { AvatarSizes } from '../src/avatarSizes.js'
import { hopTemplate, spawnTemplate } from '../src/chain/builder.js'
import { bytesToHex, nowSeconds, signEvent, type NostrEvent } from '../src/nostr/event.js'
import { validateSnoPayload } from '../src/sno.js'
import type { Calibration } from '../src/space/calibration.js'
import { distanceBetween, placeFromHex, placeOf, type Place } from '../src/space/coords.js'
import { DEFAULT_AVATAR_RADIUS, avatarRadius, clearOf, nearestClear, spacingFor } from '../src/space/personalSpace.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork, type FakeRelay } from './fakeRelay.js'
import { fakeHopProof } from './fakeHop.js'

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'
const GENERAL = 'wss://general.example'
const INBOX = 'wss://inbox.example/'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }

/** XOR's avatar as he published it (2026-10-11): a stella octangula, unit 0, every vertex at a corner of the one-gibson cube. */
const xorPayload = JSON.parse(readFileSync(new URL('./fixtures/xor-stella-octangula.json', import.meta.url), 'utf8')) as Record<string, unknown>
/** The same shape a size up (unit 1): it reaches two gibsons on each axis, 18 bits of work. */
const bigPayload = { ...xorPayload, name: 'Big star', unit: 1 }
const BIG_RADIUS = 2

function shardOf(payload: unknown) {
  const v = validateSnoPayload(payload)
  if (!v.ok) throw new Error('invalid payload')
  return v.shard
}

/** A paid kind 11333 for this key, mined here with the server's own chunk loop. */
function paidAvatar(payload: unknown, sk: Uint8Array): NostrEvent {
  const shard = shardOf(payload)
  const t = avatarTemplate(shard, nowSeconds() - 60)
  const pubkey = getPublicKey(sk)
  const bits = avatarWork(JSON.parse(t.content))
  let found = null
  for (let from = 0; !found; from += 8192) found = mineChunk({ ...t, pubkey }, bits, from, 8192)
  return signEvent(nonceTagged(t, found.nonce, bits), sk)
}

describe('how big ONOSENDAI draws an avatar', () => {
  it('the default is half a gibson; XOR\'s stella octangula reaches the cube\'s corner', () => {
    expect(avatarRadius(null)).toBe(DEFAULT_AVATAR_RADIUS)
    // Reach 1 (every vertex at a corner, 120 ticks on each axis) at unit 0: one gibson on each axis.
    expect(avatarRadius(shardOf(xorPayload))).toBe(1)
    expect(avatarRadius(shardOf(bigPayload))).toBe(BIG_RADIUS)
  })

  it('a shape past four cells on an axis is shrunk to four, as avatarScale does', () => {
    // Unit 3: the corners are 8 gibsons out on every axis, drawn at 4.
    expect(avatarRadius(shardOf({ ...xorPayload, unit: 3 }))).toBe(4)
    // A shard with no vertices is drawn as the default.
    expect(avatarRadius(fromPayload({ v: 2, name: 'empty', unit: 0, mode: 'solid', vertices: [], faces: [] }, 'x'))).toBe(DEFAULT_AVATAR_RADIUS)
  })

  it('the spacing is both radii and a gibson, in whole gibsons', () => {
    expect(spacingFor(0.5, 0.5)).toBe(2)
    // XOR beside a default avatar: 1 + 0.5 + 1 = 2.5, so 3 whole gibsons.
    expect(spacingFor(1, 0.5)).toBe(3)
    expect(spacingFor(0.5, BIG_RADIUS)).toBe(4)
    // The most two avatars ever need: 4 + 4 + 1.
    expect(spacingFor(4, 4)).toBe(9)
  })

  it('boxes clear on any one axis; another plane never conflicts; the nearest clear point is just outside', () => {
    const p = placeOf({ x: 1000n, y: 1000n, z: 1000n }, 0)
    const at = (dx: bigint, dy: bigint, plane: 0 | 1 = 0): Place => placeOf({ x: 1000n + dx, y: 1000n + dy, z: 1000n }, plane)
    const body = { place: p, radius: BIG_RADIUS }
    expect(clearOf(at(3n, 3n), body, 0.5)).toBe(false)
    expect(clearOf(at(4n, 0n), body, 0.5)).toBe(true)
    expect(clearOf(at(0n, 0n, 1), body, 0.5)).toBe(true)
    const free = nearestClear(p, at(-20n, 0n), [body], 0.5)!
    expect(free.hex).toBe(at(-4n, 0n).hex)
  })
})

describe('avatar sizes are read in the background', () => {
  it('answers the default at once while the read is in flight, then the avatar read; one query per batch', async () => {
    const sk = generateSecretKey()
    const pk = getPublicKey(sk)
    const ev = paidAvatar(bigPayload, sk)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const queries: unknown[] = []
    const sizes = new AvatarSizes({ query: async (f) => { queries.push(f); await gate; return [ev] } })
    expect(sizes.radius(pk)).toBe(DEFAULT_AVATAR_RADIUS)
    expect(sizes.radius('ab'.repeat(32))).toBe(DEFAULT_AVATAR_RADIUS)
    expect(sizes.describe(pk).read).toBe(false)
    release()
    await sizes.settled()
    expect(queries).toHaveLength(1)
    expect(sizes.radius(pk)).toBe(BIG_RADIUS)
    expect(sizes.describe(pk)).toEqual({ name: 'Big star', read: true })
    // Read lately: no second query.
    sizes.radius(pk)
    await sizes.settled()
    expect(queries).toHaveLength(1)
  })

  it('a relay that fails leaves the default, and an unpaid shape is the default', async () => {
    const failing = new AvatarSizes({ query: async () => { throw new Error('down') } })
    failing.want(['cd'.repeat(32)])
    await failing.settled()
    expect(failing.radius('cd'.repeat(32))).toBe(DEFAULT_AVATAR_RADIUS)
    const sk = generateSecretKey()
    const unpaid = signEvent(avatarTemplate(shardOf(bigPayload), nowSeconds()), sk)
    const sizes = new AvatarSizes({ query: async () => [unpaid] })
    sizes.want([unpaid.pubkey])
    await sizes.settled()
    expect(sizes.radius(unpaid.pubkey)).toBe(DEFAULT_AVATAR_RADIUS)
  })
})

function dirWithKey(sk: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-avspace-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
  return dir
}

interface World { network: FakeNetwork; canonical: FakeRelay; mine: FakeRelay; general: FakeRelay }

function world(): World {
  const network = new FakeNetwork()
  const canonical = network.add(CANONICAL, { refuse: (ev) => (ev.kind === 1059 ? 'blocked: kind 1059 is not accepted here' : null) })
  const mine = network.add(MINE)
  const general = network.add(GENERAL, { requireAuth: false })
  network.add(INBOX, { challengeOnReq: true, protectWraps: true, requireAuthToPublish: true })
  return { network, canonical, mine, general }
}

const running: Agent[] = []
afterAll(async () => { for (const a of running) await a.stop() })

async function start(w: World, dir: string, operator?: string): Promise<Agent> {
  const a = await Agent.start({
    stateDir: dir, relays: [CANONICAL, MINE], ...(operator ? { operator } : {}), capCallSeconds: 30, capSessionSeconds: 300, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: w.network.WebSocket, calibration: cal, relayMaxWaitMs: 1500, lookupRelays: [GENERAL],
  })
  running.push(a)
  return a
}

async function until(what: string, ok: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** A chain signed by a test key, as any client would publish it. */
class Walker {
  readonly pubkey: string
  readonly spawn: NostrEvent
  head: NostrEvent
  private at: number
  constructor(private readonly sk: Uint8Array, at = nowSeconds() - 600) {
    this.pubkey = getPublicKey(sk)
    this.at = at
    this.spawn = signEvent(spawnTemplate(this.pubkey, this.at), sk)
    this.head = this.spawn
  }

  hop(to: Place): NostrEvent {
    this.at = Math.max(this.at + 1, nowSeconds())
    const prevC = this.head.tags.find((t) => t[0] === 'C')![1]
    this.head = signEvent(hopTemplate({ createdAt: this.at, genesisId: this.spawn.id, previousId: this.head.id, prevCoordHex: prevC, to: to.position, plane: to.plane, ...fakeHopProof() }), this.sk)
    return this.head
  }
}

const east = (p: Place, dx: bigint, dy = 0n): Place => placeOf({ x: p.position.x + dx, y: p.position.y + dy, z: p.position.z }, p.plane)
const profile = (sk: Uint8Array, content: Record<string, unknown>): NostrEvent => finalizeEvent({ kind: 0, created_at: nowSeconds(), tags: [], content: JSON.stringify(content) }, sk) as NostrEvent

describe('the agent near people, by their avatars', () => {
  const w = world()
  const agentSk = generateSecretKey()
  const home = placeFromHex(getPublicKey(agentSk))
  const bigSk = generateSecretKey()
  const big = new Walker(bigSk)
  const plainSk = generateSecretKey()
  const plain = new Walker(plainSk)
  const botSk = generateSecretKey()
  const bot = new Walker(botSk)
  const bigAt = east(home, 40n)
  const plainAt = east(home, 70n)
  const botAt = east(home, 100n)
  let a: Agent

  beforeAll(async () => {
    a = await start(w, dirWithKey(agentSk))
    await a.identity({ name: 'xor' })
    await a.hop({ target: { dx: 5, dy: 0, dz: 0 } })
    // A human with a large paid avatar, a human with none, and a bot with a large one.
    w.mine.seed(profile(bigSk, { name: 'star' }), profile(plainSk, { name: 'plain' }), profile(botSk, { name: 'other-agent', bot: true }))
    w.canonical.seed(paidAvatar(bigPayload, bigSk), paidAvatar(bigPayload, botSk))
    for (const [walker, at] of [[big, bigAt], [plain, plainAt], [bot, botAt]] as const) {
      w.canonical.inject(walker.spawn)
      w.canonical.inject(walker.hop(at))
    }
    await until('presence', () => [big, plain, bot].every((x) => a.presence.people.has(x.pubkey)))
    await a.presence.fetchProfiles()
    // Read in the background on arrival; waited for here only so the test is deterministic.
    a.avatars.want([big.pubkey, plain.pubkey, bot.pubkey])
    await a.avatars.settled()
  }, 60_000)

  it('refuses a landing whose box would overlap a large avatar, and accepts one just outside', async () => {
    expect(a.avatars.radius(big.pubkey)).toBe(BIG_RADIUS)
    // Three gibsons off: inside the big avatar's box (2 + 0.5 + 1 = 3.5, so 4).
    const inside = await a.planHop({ target: east(home, 37n).hex })
    const said = inside.data.refused as string
    expect(said).toContain('The human star')
    expect(said).toContain('"Big star" reaches 2.00 gibsons')
    expect(said).toContain('at least 4 gibsons')
    expect(said).toContain('at coarser zooms every avatar nearby overlaps on screen by design')
    expect(said).toContain(`Land just outside instead, at ${east(home, 36n).hex}`)
    // Off the axis too: two east and three north is inside on both.
    expect((await a.planHop({ target: east(home, 38n, 3n).hex })).data.refused).toContain('The human star')
    // Just outside, on either axis: accepted.
    expect((await a.planHop({ target: east(home, 36n).hex })).data.refused).toBeNull()
    expect((await a.planHop({ target: east(home, 38n, 4n).hex })).data.refused).toBeNull()
  }, 30_000)

  it('a person with no avatar is the default size', async () => {
    expect(a.avatars.radius(plain.pubkey)).toBe(DEFAULT_AVATAR_RADIUS)
    const close = await a.planHop({ target: east(home, 69n).hex })
    expect(close.data.refused).toContain('The human plain')
    expect(close.data.refused).toContain('the default')
    expect(close.data.refused).toContain('at least 2 gibsons')
    expect((await a.planHop({ target: east(home, 68n).hex })).data.refused).toBeNull()
  }, 30_000)

  it('bots may overlap bots: a bot\'s large avatar is no bar', async () => {
    expect(a.avatars.radius(bot.pubkey)).toBe(BIG_RADIUS)
    expect((await a.planHop({ target: east(home, 101n).hex })).data.refused).toBeNull()
  }, 30_000)

  it('a ride\'s exit beside the large avatar names how far to step off, priced', async () => {
    const stop = east(home, 41n).hex
    const spy = vi.spyOn(a.transit, 'ride').mockResolvedValue({ text: 'Ride signed.', data: { action: 'hyperjump', where: { hex: stop } } })
    try {
      const r = await a.ride({ to: 900000 })
      expect(r.text).toContain('the rule that your avatar never overlaps a person\'s yields here')
      expect(r.text).toContain('The human star')
      const fixed = r.data.fixedPoint as { sharedWith: string[]; stepOff: string; stepOffGibsons: string; stepOffSeconds: number }
      expect(fixed.sharedWith).toEqual([big.pubkey])
      // Just outside the box: four gibsons from the star on one axis. On x
      // that is three or five from the stop; on y or z, four. nearestClear
      // takes the cheapest of these, the lowest wall from the stop first,
      // and the walls depend on where this run's random key put home, so
      // which one wins is not fixed (it was asserted as x only, 2026-10-14).
      const off = placeFromHex(fixed.stepOff)
      expect(clearOf(off, { place: bigAt, radius: BIG_RADIUS }, DEFAULT_AVATAR_RADIUS)).toBe(true)
      const stopAt = placeFromHex(stop)
      expect(distanceBetween(stopAt, off).chebyshev.toString()).toBe(fixed.stepOffGibsons)
      const need = BigInt(spacingFor(DEFAULT_AVATAR_RADIUS, BIG_RADIUS))
      const candidates = (['x', 'y', 'z'] as const).flatMap((axis) => [need, -need].map((d) => placeOf({ ...stopAt.position, [axis]: bigAt.position[axis] + d }, stopAt.plane)))
      expect(candidates.map((c) => c.hex)).toContain(off.hex)
      const lowest = Math.min(...candidates.map((c) => distanceBetween(stopAt, c).maxLca))
      expect(distanceBetween(stopAt, off).maxLca).toBe(lowest)
      expect(r.text).toContain(`Step off by ${fixed.stepOffGibsons} gibsons now, to ${fixed.stepOff} (one hop`)
      expect(typeof fixed.stepOffSeconds).toBe('number')
    } finally {
      spy.mockRestore()
    }
  }, 30_000)
})

describe('following an operator with a large avatar', () => {
  const w = world()
  const opSk = generateSecretKey()
  const op = getPublicKey(opSk)
  const agentSk = generateSecretKey()
  const me = getPublicKey(agentSk)
  const home = placeFromHex(me)
  const operator = new Walker(opSk)

  it('aims just outside the operator\'s box, not beside their gibson', async () => {
    w.general.seed(finalizeEvent({ kind: 10050, created_at: nowSeconds(), tags: [['relay', INBOX]], content: '' }, opSk) as NostrEvent, finalizeEvent({ kind: 3, created_at: nowSeconds(), tags: [['p', me]], content: '' }, opSk) as NostrEvent)
    w.canonical.seed(paidAvatar(bigPayload, opSk))
    const a = await start(w, dirWithKey(agentSk), op)
    await a.identity({ name: 'xor' })
    await a.hop({ target: { dx: 5, dy: 0, dz: 0 } })
    w.canonical.seed(operator.spawn, operator.hop(east(home, 30n)))
    a.avatars.want([op])
    await a.avatars.settled()

    const r = await a.followOperator({ on: true })
    // Their avatar reaches 2 gibsons, the agent's 0.5, and a gibson between: 3.5, so four gibsons off.
    expect((r.data.beside as { hex: string }).hex).toBe(east(home, 26n).hex)
    expect((r.data.plan as { refused: string | null }).refused).toBeNull()
    // The old aim, the gibson beside them, is refused.
    expect((await a.planHop({ target: east(home, 29n).hex })).data.refused).toContain('Your operator')
  }, 60_000)
})
