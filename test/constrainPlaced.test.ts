// constrainPlaced.test.ts: collision in WALK for shards already placed
// (arkinox, 2026-10-25: "if i tell XOR to edit his existing shards and turn
// on collision, will he be able to do that with the mcp?" ... "build it"),
// and the OPAQUE default place and publish_object write (ONOSENDAI #476).
// Over the MCP client, against fake relays only: constrain_placed signs an
// inline shard again where it stands with its lineage d and rewrites its bag
// in one step, keeping every other entry exactly as found, even one this
// server cannot read; a shard by reference has its own sealed object sealed
// again under the same d and its bag is not touched; a public object placed
// by reference (anyone's) is refused, or skipped in a selection; match, bag,
// all and a list of targets change many at once, one rewrite per bag; and
// every refusal changes nothing.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Agent } from '../src/agent.js'
import { bagTemplate, HIDDEN_KIND, SHARD_KIND, referenceTo, unbag, type BagEntry } from '../src/hidden/bags.js'
import { ALGO, decryptForRegion, encryptForRegion, regionKeyAt } from '../src/hidden/crypto.js'
import { MAX_CONSTRAIN_PER_CALL } from '../src/placed.js'
import { bytesToHex, signEvent, type NostrEvent } from '../src/nostr/event.js'
import { openEntries } from '../src/placed.js'
import { publicObjectTemplate } from '../src/publicObject.js'
import { createServer } from '../src/server.js'
import { validateSnoPayload } from '../src/sno.js'
import type { Calibration } from '../src/space/calibration.js'
import { positionHex } from '../src/space/coords.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork, type FakeRelay } from './fakeRelay.js'

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }

/** z mod 256 is 100: +1 stays in its h8 cube and its h3 cube; +12 leaves the h3 cube. */
const BASE = (1n << 40n) + 100n
const P = { x: BASE.toString(), y: BASE.toString(), z: BASE.toString(), plane: 0 }
const tetra = { v: 2, name: 'tetra', unit: 20, mode: 'solid', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], colors: [1, 2, 3, 4], faces: [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]] }
const named = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...tetra, name, ...extra })

/** An object too large for the bag: hidden by reference as a sealed kind 33331. */
function bigObject(name: string): Record<string, unknown> {
  const vertices: number[][] = []
  const faces: number[][] = []
  const colors: number[] = []
  for (let i = 0; i < 400; i++) {
    vertices.push([i % 20, Math.floor(i / 20), 0], [i % 20, Math.floor(i / 20), 1], [(i % 20) + 1, Math.floor(i / 20), 0])
    colors.push(1, 2, 3)
    faces.push([3 * i, 3 * i + 1, 3 * i + 2])
  }
  return { v: 2, name, unit: 20, mode: 'solid', vertices, colors, faces }
}

type Call = (name: string, args?: Record<string, unknown>) => Promise<{ text: string; data: Record<string, unknown>; isError: boolean }>

const agents: Agent[] = []
afterAll(async () => { for (const a of agents) await a.stop() })

interface World { a: Agent; call: Call; sk: Uint8Array; canonical: FakeRelay; mine: FakeRelay }

async function setup(): Promise<World> {
  const network = new FakeNetwork()
  const canonical = network.add(CANONICAL)
  const mine = network.add(MINE)
  const sk = generateSecretKey()
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-constrain-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
  const a = await Agent.start({
    stateDir: dir, relays: [CANONICAL, MINE], capCallSeconds: 30, capSessionSeconds: 120, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1200, ordersPollMs: 0,
  })
  agents.push(a)
  const server = createServer(a)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientSide)
  const call: Call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    return { text: (r.content as Array<{ text: string }>).map((c) => c.text ?? '').join('\n'), data: (r.structuredContent ?? {}) as Record<string, unknown>, isError: !!r.isError }
  }
  return { a, call, sk, canonical, mine }
}

function at(dz: bigint, height: number): Record<string, unknown> {
  return { coordinate: { ...P, z: (BASE + dz).toString() }, height }
}

function key(z: bigint, height: number): { key: Uint8Array; lookupId: string } {
  const k = regionKeyAt({ x: BASE, y: BASE, z }, height, 20)
  return { key: k.key, lookupId: k.lookupId }
}

function bagOn(relay: FakeRelay, pubkey: string, lookupId: string): NostrEvent | undefined {
  return relay.all().find((e) => e.kind === HIDDEN_KIND && e.pubkey === pubkey && e.tags.some((t) => t[0] === 'd' && t[1] === lookupId))
}

/** How many versions of one bag a relay was sent (a version sent straight and again by the outbox is one). */
function bagWrites(relay: FakeRelay, pubkey: string, lookupId: string): number {
  return new Set(relay.published.filter((e) => e.kind === HIDDEN_KIND && e.pubkey === pubkey && e.tags.some((t) => t[0] === 'd' && t[1] === lookupId)).map((e) => e.id)).size
}

async function entriesOf(bag: NostrEvent, regionKey: Uint8Array): Promise<BagEntry[]> {
  return (await openEntries(bag, regionKey)) ?? []
}

const payloadOf = (inner: { content: string }): Record<string, unknown> => JSON.parse(inner.content) as Record<string, unknown>

interface Row { id: string; lineage: string | null; type: string; label: string; byReference?: string; objectAddress?: string; walk?: { constrain: string | null; opacity: number } }
const rowsOf = (r: { data: Record<string, unknown> }): Row[] => (r.data.bags as Array<{ entries: Row[] }>).flatMap((b) => b.entries)

/**
 * A bag in the h8 cube at BASE as a client from before the default left it:
 * what the agent hid there, then a shard with no constrain field (signed by
 * the agent's key, as another session would), and an entry of a kind this
 * server does not read. The agent holds the key because it hid there first.
 */
async function seedOldShard(s: World, name = 'old wall'): Promise<{ old: NostrEvent; unknown: NostrEvent; bag: NostrEvent }> {
  await s.call('hide', { contents: { message: 'keep me' }, ...at(0n, 8) })
  const k = key(BASE, 8)
  const current = bagOn(s.mine, s.a.pubkey, k.lookupId)!
  const carried = await entriesOf(current, k.key)
  const old = signEvent({ kind: SHARD_KIND, created_at: current.created_at, content: JSON.stringify(named(name)), tags: [['C', positionHex({ x: BASE, y: BASE, z: BASE + 1n }, 0)], ['-']] }, s.sk)
  const unknown = signEvent({ kind: 30999, created_at: current.created_at, content: 'from a newer client', tags: [['x', 'y']] }, s.sk)
  const bag = signEvent(await bagTemplate([...carried, old, unknown], k.key, k.lookupId, 8, current.created_at + 5, HIDDEN_KIND), s.sk)
  s.mine.seed(bag)
  s.canonical.seed(bag)
  return { old, unknown, bag }
}


/** A bag a client from before the default left in the h`height` cube at BASE: what the agent hid there first, then `extra`. */
async function seedBag(s: World, height: number, extra: (now: number, k: { key: Uint8Array; lookupId: string }) => Promise<BagEntry[]>): Promise<NostrEvent> {
  await s.call('hide', { contents: { message: 'first here' }, ...at(0n, height) })
  const k = key(BASE, height)
  const current = bagOn(s.mine, s.a.pubkey, k.lookupId)!
  const carried = await entriesOf(current, k.key)
  const bag = signEvent(await bagTemplate([...carried, ...(await extra(current.created_at, k))], k.key, k.lookupId, height, current.created_at + 5, HIDDEN_KIND), s.sk)
  s.mine.seed(bag)
  s.canonical.seed(bag)
  return bag
}

/** A sealed kind 33331 as one written before the default: no constrain in what is sealed. */
async function oldSealed(s: World, payload: Record<string, unknown>, regionKey: Uint8Array, createdAt: number): Promise<NostrEvent> {
  const ct = await encryptForRegion(regionKey, JSON.stringify(payload))
  const object = signEvent({ kind: 33331, created_at: createdAt, content: 'hidden', tags: [['d', 'e'.repeat(32)], ['alt', 'hidden'], ['encrypted', ALGO, ct, 'cyberspace:region']] }, s.sk)
  s.mine.seed(object)
  s.canonical.seed(object)
  return object
}

const sealedPayload = async (relay: FakeRelay, regionKey: Uint8Array): Promise<Record<string, unknown>> =>
  JSON.parse((await decryptForRegion(regionKey, relay.all().find((e) => e.kind === 33331)!.tags.find((t) => t[0] === 'encrypted')![2]))!) as Record<string, unknown>

describe('place and publish_object write "opaque" when the payload chose none (ONOSENDAI #476)', () => {
  let s: World
  beforeEach(async () => { s = await setup() })

  it('an inline shard, a sealed object and a public object carry the default; a chosen word is kept; the answer says which', async () => {
    const r = await s.call('place', { object: named('plain'), ...at(0n, 8) })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('WALK: constrain "opaque"')
    expect(r.text).toContain('the default')
    const k = key(BASE, 8)
    const shardOf = async (name: string) => (await unbag(bagOn(s.mine, s.a.pubkey, k.lookupId)!, k.key, undefined, undefined, 8)).find((h) => h.shard?.name === name)!
    expect(payloadOf((await shardOf('plain')).inner).constrain).toBe('opaque')
    // A word the payload chose is written as it is, "off" included (never as no field).
    const off = await s.call('place', { object: named('see-through', { constrain: 'off' }), ...at(1n, 8) })
    expect(off.text).toContain('as the payload says')
    expect(payloadOf((await shardOf('see-through')).inner).constrain).toBe('off')
    // A malformed word is not a choice: the default goes in its place.
    await s.call('place', { object: named('shouty', { constrain: 'ALL' }), ...at(1n, 8) })
    expect(payloadOf((await shardOf('shouty')).inner).constrain).toBe('opaque')
    // Large: the sealed object's payload carries it.
    await s.call('place', { object: bigObject('big one'), ...at(0n, 3) })
    const object = s.mine.all().find((e) => e.kind === 33331)!
    const plain = await decryptForRegion(key(BASE, 3).key, object.tags.find((t) => t[0] === 'encrypted')![2])
    expect(JSON.parse(plain!).constrain).toBe('opaque')
    // publish_object: the default, and an explicit word kept.
    const pub = await s.call('publish_object', { object: named('feed piece') })
    expect(pub.isError).toBe(false)
    expect(pub.text).toContain('WALK: constrain "opaque"')
    expect(pub.data.constrain).toBe('opaque')
    const pubAll = await s.call('publish_object', { object: named('feed wall', { constrain: 'all' }) })
    expect(pubAll.data.constrain).toBe('all')
    const published = s.canonical.all().filter((e) => e.kind === 33331 && !e.tags.some((t) => t[0] === 'encrypted'))
    expect(published.map((e) => payloadOf(e).constrain).sort()).toEqual(['all', 'opaque'])
    // validate_object says what would be written, and counts it in the bytes.
    const v = await s.call('validate_object', { payload: named('check') })
    expect(v.data.constrain).toBe('opaque')
    const plainCheck = validateSnoPayload(named('check'))
    expect(v.data.bytes).toBe((plainCheck.ok ? plainCheck.bytes : 0) + ',"constrain":"opaque"'.length)
  }, 60_000)

  it('a public object placed by its address is its author\'s, and no default reaches it', async () => {
    const other = generateSecretKey()
    const v = validateSnoPayload(named('their tower'))
    if (!v.ok) throw new Error('invalid')
    // Written by another client without the field, as objects before 1.12 were.
    const theirs = signEvent({ ...publicObjectTemplate(v.shard, 'tower', 1_792_000_000), content: JSON.stringify(named('their tower')) }, other)
    s.canonical.seed(theirs)
    s.mine.seed(theirs)
    const r = await s.call('place', { address: `33331:${getPublicKey(other)}:tower`, ...at(0n, 8) })
    expect(r.isError).toBe(false)
    expect(s.canonical.all().find((e) => e.id === theirs.id)).toBeDefined()
    expect(s.canonical.published.some((e) => e.kind === 33331)).toBe(false)
  }, 60_000)
})

describe('constrain_placed', () => {
  let s: World
  beforeEach(async () => { s = await setup() })

  it('turns on collision for an old inline shard where it stands: signed again with its lineage, the bag rewritten once, everything else in it exactly as found', async () => {
    const { old, unknown } = await seedOldShard(s)
    const k = key(BASE, 8)
    const listed = rowsOf(await s.call('placed')).find((r) => r.label === 'old wall')!
    expect(listed.walk).toEqual({ constrain: null, opacity: 100 })
    const before = bagWrites(s.canonical, s.a.pubkey, k.lookupId)
    const r = await s.call('constrain_placed', { target: 'old wall', constrain: 'opaque' })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('Set constrain "opaque"')
    expect(bagWrites(s.canonical, s.a.pubkey, k.lookupId)).toBe(before + 1)
    const entries = await entriesOf(bagOn(s.canonical, s.a.pubkey, k.lookupId)!, k.key)
    expect(entries).toHaveLength(3)
    // The entry this server cannot read, and the message, are carried byte for byte.
    expect(entries.find((e) => (e as NostrEvent).id === unknown.id)).toEqual(unknown)
    expect(entries.some((e) => (e as NostrEvent).kind === 1)).toBe(true)
    const edited = entries.find((e) => (e as NostrEvent).kind === SHARD_KIND) as NostrEvent
    expect(edited.id).not.toBe(old.id)
    // ONOSENDAI's editedTemplate: the same C first, then the lineage d (the first id), then `-` once.
    expect(edited.tags[0]).toEqual(old.tags[0])
    expect(edited.tags[1]).toEqual(['d', old.id])
    expect(edited.tags.filter((t) => t[0] === '-')).toHaveLength(1)
    expect(payloadOf(edited)).toEqual({ ...named('old wall'), constrain: 'opaque' })
    const changed = (r.data.changed as Array<{ id: string; previousId: string; lineage: string }>)[0]
    expect(changed).toMatchObject({ id: edited.id, previousId: old.id, lineage: old.id })
    // A second change keeps the first id as the lineage, and an opacity rides along.
    const again = await s.call('constrain_placed', { target: edited.id.slice(0, 12), constrain: 'all', opacity: 40 })
    expect(again.isError).toBe(false)
    const twice = (await entriesOf(bagOn(s.canonical, s.a.pubkey, k.lookupId)!, k.key)).find((e) => (e as NostrEvent).kind === SHARD_KIND) as NostrEvent
    expect(twice.tags.find((t) => t[0] === 'd')).toEqual(['d', old.id])
    expect(payloadOf(twice)).toMatchObject({ constrain: 'all', opacity: 40 })
    const row = rowsOf(await s.call('placed')).find((r) => r.label === 'old wall')!
    expect(row.walk).toEqual({ constrain: 'all', opacity: 40 })
    expect(row.lineage).toBe(old.id)
    // Already so: nothing to change, nothing published.
    const published = s.canonical.published.length
    const same = await s.call('constrain_placed', { target: 'old wall', constrain: 'all' })
    expect(same.isError).toBe(false)
    expect(same.text).toContain('Nothing to change')
    expect(s.canonical.published.length).toBe(published)
    // Back to fully opaque: opacity 100 is no field (DECK-0003 1.11).
    await s.call('constrain_placed', { target: 'old wall', opacity: 100 })
    const opaque = (await entriesOf(bagOn(s.canonical, s.a.pubkey, k.lookupId)!, k.key)).find((e) => (e as NostrEvent).kind === SHARD_KIND) as NostrEvent
    expect(payloadOf(opaque)).not.toHaveProperty('opacity')
    expect(payloadOf(opaque).constrain).toBe('all')
  }, 60_000)

  it('a shard by reference: its sealed object is sealed again to the same place under the same d, and its bag is not touched', async () => {
    await s.call('place', { object: bigObject('big one'), ...at(0n, 3) })
    const k = key(BASE, 3)
    const objectBefore = s.mine.all().find((e) => e.kind === 33331)!
    const d = objectBefore.tags.find((t) => t[0] === 'd')![1]
    const bagBefore = bagOn(s.canonical, s.a.pubkey, k.lookupId)!
    const r = await s.call('constrain_placed', { target: 'big one', constrain: 'off' })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('sealed again under the same d')
    for (const relay of [s.canonical, s.mine]) {
      const now = relay.all().find((e) => e.kind === 33331)!
      expect(now.id).not.toBe(objectBefore.id)
      expect(now.tags.find((t) => t[0] === 'd')![1]).toBe(d)
      expect(now.created_at).toBeGreaterThan(objectBefore.created_at)
      expect(now.content).toBe(objectBefore.content)
      const plain = JSON.parse((await decryptForRegion(k.key, now.tags.find((t) => t[0] === 'encrypted')![2]))!) as Record<string, unknown>
      expect(plain.constrain).toBe('off')
      expect(plain.vertices).toEqual(bigObject('big one').vertices)
    }
    expect(bagOn(s.canonical, s.a.pubkey, k.lookupId)!.id).toBe(bagBefore.id)
    const row = rowsOf(await s.call('placed')).find((r) => r.label === 'big one')!
    expect(row.byReference).toBe('sealed')
    expect(row.objectAddress).toBe(`33331:${s.a.pubkey}:${d}`)
    expect(row.walk?.constrain).toBe('off')
    // No retraction of anything.
    expect(s.canonical.published.some((e) => e.kind === 5)).toBe(false)
  }, 60_000)

  it('refuses a public object placed by reference, anyone\'s, and skips it in a selection, changing the rest', async () => {
    const other = generateSecretKey()
    const v = validateSnoPayload(named('their tower'))
    if (!v.ok) throw new Error('invalid')
    const theirs = signEvent(publicObjectTemplate(v.shard, 'tower', 1_792_000_000), other)
    s.canonical.seed(theirs)
    s.mine.seed(theirs)
    await s.call('place', { address: `33331:${getPublicKey(other)}:tower`, ...at(0n, 8) })
    const mine = await s.call('publish_object', { object: named('my tower') })
    await s.call('place', { address: mine.data.address as string, ...at(1n, 8) })
    await s.call('place', { object: named('my wall'), ...at(1n, 8) })
    const published = s.canonical.published.length
    const refusedTheirs = await s.call('constrain_placed', { target: 'their tower', constrain: 'all' })
    expect(refusedTheirs.isError).toBe(true)
    expect(refusedTheirs.text).toContain('its setting is its author\'s')
    const refusedMine = await s.call('constrain_placed', { target: 'my tower', constrain: 'all' })
    expect(refusedMine.isError).toBe(true)
    expect(refusedMine.text).toContain('publish_object again with its d')
    expect(s.canonical.published.length).toBe(published)
    // Their object was never touched by anything.
    expect(s.canonical.all().find((e) => e.pubkey === getPublicKey(other))!.id).toBe(theirs.id)
    const all = await s.call('constrain_placed', { all: true, constrain: 'all' })
    expect(all.isError).toBe(false)
    expect((all.data.changed as Row[]).map((r) => r.label)).toEqual(['my wall'])
    expect((all.data.skipped as Row[]).map((r) => r.label).sort()).toEqual(['my tower', 'their tower'])
    expect(all.text).toContain('Skipped')
    expect(s.canonical.all().find((e) => e.pubkey === getPublicKey(other))!.id).toBe(theirs.id)
    expect(payloadOf(s.canonical.all().find((e) => e.kind === 33331 && e.pubkey === s.a.pubkey)!).constrain).toBe('opaque')
  }, 60_000)

  it('in bulk: match takes every shard whose name contains the words, across bags, one rewrite per bag; a list of targets and a bag work too', async () => {
    await s.call('place', { object: named('town square wall', { constrain: 'off' }), ...at(0n, 8) })
    await s.call('place', { object: named('town square floor', { constrain: 'off' }), ...at(1n, 8) })
    await s.call('hide', { contents: { message: 'town square sign' }, ...at(1n, 8) })
    await s.call('place', { object: named('town square arch', { constrain: 'off' }), ...at(0n, 3) })
    await s.call('place', { object: named('garden bench', { constrain: 'off' }), ...at(1n, 3) })
    const k8 = key(BASE, 8)
    const k3 = key(BASE, 3)
    const w8 = bagWrites(s.canonical, s.a.pubkey, k8.lookupId)
    const w3 = bagWrites(s.canonical, s.a.pubkey, k3.lookupId)
    const r = await s.call('constrain_placed', { match: 'Town Square', constrain: 'opaque' })
    expect(r.isError).toBe(false)
    expect((r.data.changed as Row[]).map((x) => x.label).sort()).toEqual(['town square arch', 'town square floor', 'town square wall'])
    expect(bagWrites(s.canonical, s.a.pubkey, k8.lookupId)).toBe(w8 + 1)
    expect(bagWrites(s.canonical, s.a.pubkey, k3.lookupId)).toBe(w3 + 1)
    const walk = (): Record<string, string | null | undefined> => Object.fromEntries(rowsOfNow.map((x) => [x.label, x.walk?.constrain]))
    let rowsOfNow = rowsOf(await s.call('placed'))
    expect(walk()).toEqual({ 'town square wall': 'opaque', 'town square floor': 'opaque', 'town square sign': undefined, 'town square arch': 'opaque', 'garden bench': 'off' })
    // A list of targets, each named as move_placed names one.
    const list = await s.call('constrain_placed', { target: ['garden bench', 'town square arch'], constrain: 'all' })
    expect(list.isError).toBe(false)
    expect((list.data.changed as Row[]).map((x) => x.label).sort()).toEqual(['garden bench', 'town square arch'])
    // Every shard in one bag.
    const bag = await s.call('constrain_placed', { bag: k8.lookupId.slice(0, 12), constrain: 'off' })
    expect(bag.isError).toBe(false)
    rowsOfNow = rowsOf(await s.call('placed'))
    expect(walk()).toEqual({ 'town square wall': 'off', 'town square floor': 'off', 'town square sign': undefined, 'town square arch': 'all', 'garden bench': 'all' })
    // The message in that bag is still there, as it was.
    expect(rowsOfNow.find((x) => x.label === 'town square sign')).toBeDefined()
  }, 60_000)

  it('refuses, changing nothing: no selector, two selectors, no setting, a word not one of the three, a name that is not a shard, a silent canonical relay', async () => {
    await s.call('hide', { contents: { message: 'a note' }, ...at(0n, 8) })
    await s.call('place', { object: named('pillar', { constrain: 'off' }), ...at(1n, 8) })
    const published = s.canonical.published.length
    const publishedMine = s.mine.published.length
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ constrain: 'all' }, 'exactly one of'],
      [{ target: 'pillar', all: true, constrain: 'all' }, 'exactly one of'],
      [{ target: 'pillar' }, 'Say what to set'],
      [{ target: 'a note', constrain: 'all' }, 'of type shard'],
      [{ match: 'nothing like it', constrain: 'all' }, 'no shard placed whose name contains'],
    ]
    for (const [args, words] of cases) {
      const r = await s.call('constrain_placed', args)
      expect(r.isError, JSON.stringify(args)).toBe(true)
      expect(r.text, JSON.stringify(args)).toContain(words)
    }
    // The schema refuses a word that is not one of the three, and any other type.
    expect((await s.call('constrain_placed', { target: 'pillar', constrain: 'ALL' })).isError).toBe(true)
    expect((await s.call('constrain_placed', { target: 'pillar', type: 'message', constrain: 'all' })).isError).toBe(true)
    expect(s.canonical.published.length).toBe(published)
    s.canonical.policy.silent = true
    const silent = await s.call('constrain_placed', { target: 'pillar', constrain: 'all' })
    expect(silent.isError).toBe(true)
    expect(silent.text).toContain('canonical relay did not answer')
    expect(s.mine.published.length).toBe(publishedMine)
  }, 60_000)

  it('a sealed object the canonical relay does not take is put back, and the shard keeps its old setting', async () => {
    await s.call('place', { object: bigObject('big one'), ...at(0n, 3) })
    const object = s.canonical.all().find((e) => e.kind === 33331)!
    const enc = object.tags.find((t) => t[0] === 'encrypted')![2]
    s.canonical.policy.refuse = (ev) => (ev.kind === 33331 && ev.created_at > object.created_at && ev.tags.find((t) => t[0] === 'encrypted')![2] !== enc ? 'blocked: not this one' : null)
    const r = await s.call('constrain_placed', { target: 'big one', constrain: 'all' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('keeps its old setting')
    expect(r.text).toContain('put back')
    for (const relay of [s.mine, s.canonical]) {
      const now = relay.all().find((e) => e.kind === 33331)!
      const plain = JSON.parse((await decryptForRegion(key(BASE, 3).key, now.tags.find((t) => t[0] === 'encrypted')![2]))!) as Record<string, unknown>
      expect(plain.constrain).toBe('opaque')
    }
  }, 60_000)
})

describe('move_placed writes the WALK default into a shard it writes again (DECK-0003 1.12, "including one that is moved")', () => {
  it('an old inline shard moved gains "opaque", every other field as it was; a chosen word is kept', async () => {
    const s = await setup()
    const { old } = await seedOldShard(s)
    const r = await s.call('move_placed', { target: 'old wall', by: { dz: 1 } })
    expect(r.isError).toBe(false)
    const k = key(BASE, 8)
    const moved = (await entriesOf(bagOn(s.canonical, s.a.pubkey, k.lookupId)!, k.key)).find((e) => (e as NostrEvent).kind === SHARD_KIND) as NostrEvent
    expect(moved.tags.find((t) => t[0] === 'd')).toEqual(['d', old.id])
    expect(payloadOf(moved)).toEqual({ ...named('old wall'), constrain: 'opaque' })
    expect(r.text).toContain('WALK: constrain "opaque"')
    expect(r.text).toContain('the default, written since it had none')
    await s.call('constrain_placed', { target: 'old wall', constrain: 'off' })
    await s.call('move_placed', { target: 'old wall', by: { dz: 1 } })
    const again = (await entriesOf(bagOn(s.canonical, s.a.pubkey, k.lookupId)!, k.key)).find((e) => (e as NostrEvent).kind === SHARD_KIND) as NostrEvent
    expect(payloadOf(again).constrain).toBe('off')
  }, 60_000)
})

describe('constrain_placed when a relay refuses (review of #44)', () => {
  let s: World
  beforeEach(async () => { s = await setup() })

  it('the canonical relay refusing the inline rewrite: not changed, its words verbatim, nothing recorded as set, the lesser relay put back, and a retry does it', async () => {
    await s.call('place', { object: named('gate', { constrain: 'off' }), ...at(0n, 8) })
    const k = key(BASE, 8)
    const before = bagOn(s.canonical, s.a.pubkey, k.lookupId)!
    s.canonical.policy.refuse = (ev) => (ev.kind === HIDDEN_KIND ? 'blocked: bags are closed today' : null)
    const r = await s.call('constrain_placed', { target: 'gate', constrain: 'all' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Changed nothing')
    expect(r.text).toContain('blocked: bags are closed today')
    expect(r.text).toContain('keeps its old setting')
    expect(r.text).toContain('went out again over it')
    expect(bagOn(s.canonical, s.a.pubkey, k.lookupId)!.id).toBe(before.id)
    // The lesser relay took the rewrite, then the bag as it was over it: every relay says "off".
    const onMine = (await unbag(bagOn(s.mine, s.a.pubkey, k.lookupId)!, k.key, undefined, undefined, 8)).find((h) => h.shard?.name === 'gate')!
    expect(payloadOf(onMine.inner).constrain).toBe('off')
    expect(rowsOf(await s.call('placed')).find((x) => x.label === 'gate')!.walk?.constrain).toBe('off')
    s.canonical.policy.refuse = () => null
    const again = await s.call('constrain_placed', { target: 'gate', constrain: 'all' })
    expect(again.isError).toBe(false)
    expect((again.data.changed as Row[]).map((x) => x.label)).toEqual(['gate'])
    const onCanonical = (await unbag(bagOn(s.canonical, s.a.pubkey, k.lookupId)!, k.key, undefined, undefined, 8)).find((h) => h.shard?.name === 'gate')!
    expect(payloadOf(onCanonical.inner).constrain).toBe('all')
  }, 60_000)

  it('in bulk across bags, some taken and some refused: the answer says exactly which shards changed', async () => {
    await s.call('place', { object: named('square wall', { constrain: 'off' }), ...at(0n, 8) })
    await s.call('place', { object: named('square floor', { constrain: 'off' }), ...at(1n, 8) })
    await s.call('place', { object: named('square arch', { constrain: 'off' }), ...at(0n, 3) })
    await s.call('place', { object: named('square gate', { constrain: 'off' }), ...at(1n, 3) })
    const k3 = key(BASE, 3)
    s.canonical.policy.refuse = (ev) => (ev.kind === HIDDEN_KIND && ev.tags.some((t) => t[0] === 'd' && t[1] === k3.lookupId) ? 'blocked: not this cube' : null)
    const r = await s.call('constrain_placed', { match: 'square', constrain: 'opaque' })
    expect(r.isError).toBe(false)
    expect((r.data.changed as Row[]).map((x) => x.label).sort()).toEqual(['square floor', 'square wall'])
    const failed = r.data.failed as Array<Row & { why: string }>
    expect(failed.map((x) => x.label).sort()).toEqual(['square arch', 'square gate'])
    for (const f of failed) expect(f.why).toContain('blocked: not this cube')
    expect(r.text).toContain('Not changed: shard "square arch"')
    const walk = async (): Promise<Record<string, string | null | undefined>> => Object.fromEntries(rowsOf(await s.call('placed')).map((x) => [x.label, x.walk?.constrain]))
    expect(await walk()).toEqual({ 'square wall': 'opaque', 'square floor': 'opaque', 'square arch': 'off', 'square gate': 'off' })
    s.canonical.policy.refuse = () => null
    const again = await s.call('constrain_placed', { match: 'square', constrain: 'opaque' })
    expect((again.data.changed as Row[]).map((x) => x.label).sort()).toEqual(['square arch', 'square gate'])
    expect((again.data.already as Row[]).map((x) => x.label).sort()).toEqual(['square floor', 'square wall'])
  }, 60_000)
})

describe('constrain_placed, more than one call\'s worth (review of #44, S1)', () => {
  it('the cap counts only shards that still need it, so the same call made again does the rest', async () => {
    const s = await setup()
    const n = MAX_CONSTRAIN_PER_CALL + 5
    await seedBag(s, 8, async (now) => Array.from({ length: n }, (_, i) => signEvent({ kind: SHARD_KIND, created_at: now, content: JSON.stringify(named(`brick ${i}`, { constrain: 'off' })), tags: [['C', positionHex({ x: BASE, y: BASE, z: BASE + 1n }, 0)], ['-']] }, s.sk)))
    const first = await s.call('constrain_placed', { all: true, constrain: 'opaque' })
    expect(first.isError).toBe(false)
    expect((first.data.changed as Row[]).length).toBe(MAX_CONSTRAIN_PER_CALL)
    expect(first.data.remaining).toBe(5)
    expect(first.text).toContain('Make the same call again')
    const second = await s.call('constrain_placed', { all: true, constrain: 'opaque' })
    expect((second.data.changed as Row[]).length).toBe(5)
    expect(second.data.remaining).toBe(0)
    expect((second.data.already as Row[]).length).toBe(MAX_CONSTRAIN_PER_CALL)
    const third = await s.call('constrain_placed', { all: true, constrain: 'opaque' })
    expect(third.text).toContain('Nothing to change')
    expect(rowsOf(await s.call('placed')).filter((x) => x.type === 'shard').every((x) => x.walk?.constrain === 'opaque')).toBe(true)
  }, 120_000)
})

describe('constrain_placed and move_placed, the smaller points of the review of #44', () => {
  let s: World
  beforeEach(async () => { s = await setup() })

  it('one sealed object named by two placements is sealed again once and reported once (N1)', async () => {
    let object!: NostrEvent
    await seedBag(s, 3, async (now, k) => {
      object = await oldSealed(s, bigObject('twin'), k.key, now)
      return [referenceTo(object, { x: BASE, y: BASE, z: BASE + 1n }, 0, CANONICAL), referenceTo(object, { x: BASE, y: BASE, z: BASE + 2n }, 0, CANONICAL)]
    })
    const r = await s.call('constrain_placed', { all: true, constrain: 'all' })
    expect(r.isError).toBe(false)
    expect((r.data.changed as Row[]).map((x) => x.label)).toEqual(['twin'])
    expect(s.canonical.published.filter((e) => e.kind === 33331)).toHaveLength(1)
    expect((await sealedPayload(s.canonical, key(BASE, 3).key)).constrain).toBe('all')
  }, 60_000)

  it('an opacity alone on a shard with no setting says it now carries "opaque" too (N2)', async () => {
    await seedBag(s, 8, async (now) => [signEvent({ kind: SHARD_KIND, created_at: now, content: JSON.stringify(named('pane')), tags: [['C', positionHex({ x: BASE, y: BASE, z: BASE + 1n }, 0)], ['-']] }, s.sk)])
    const r = await s.call('constrain_placed', { target: 'pane', opacity: 50 })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('now carry constrain "opaque"')
    expect(r.text).toContain('see-through')
  }, 60_000)

  it('move_placed says the setting it writes, and reseals a sealed shard moved inside its bag when it had none (L1, L2)', async () => {
    let object!: NostrEvent
    await seedBag(s, 3, async (now, k) => {
      object = await oldSealed(s, bigObject('old big'), k.key, now)
      return [referenceTo(object, { x: BASE, y: BASE, z: BASE + 1n }, 0, CANONICAL)]
    })
    const r = await s.call('move_placed', { target: 'old big', by: { dz: 1 } })
    expect(r.isError).toBe(false)
    expect(r.data.sameBag).toBe(true)
    expect(r.text).toContain('WALK: constrain "opaque"')
    expect(r.text).toContain('sealed again under the same d')
    const now = s.canonical.all().find((e) => e.kind === 33331)!
    expect(now.id).not.toBe(object.id)
    expect(now.tags.find((t) => t[0] === 'd')![1]).toBe('e'.repeat(32))
    expect((await sealedPayload(s.canonical, key(BASE, 3).key)).constrain).toBe('opaque')
    // Once it has a word, a move inside its bag leaves the object as it is.
    const again = await s.call('move_placed', { target: 'old big', by: { dz: 1 } })
    expect(again.isError).toBe(false)
    expect(s.canonical.all().find((e) => e.kind === 33331)!.id).toBe(now.id)
    // A chest's objects are said too.
    const chest = await s.call('seal_chest', { name: 'Crate', lock: s.a.pubkey, contents: [{ object: named('little statue') }], height: 5, coordinate: { ...P, z: (BASE + 1n).toString() } })
    expect(chest.isError).toBe(false)
    expect(chest.text).toContain('WALK for the object(s) sealed in it: "little statue" constrain "opaque"')
  }, 60_000)
})
