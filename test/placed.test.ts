// placed.test.ts: what the agent placed, taken down and moved, as ONOSENDAI
// does it (arkinox, 2026-10-20: "xor doesn't know how to delete shards or
// bags he's placed ... 'move this 12 gibsons toward Z+'"). Over the MCP
// client, against fake relays only: placed lists every bag and thing with
// ids and "last"; remove_placed rewrites the bag without the thing, keeping
// everything else in it, even what another session added that this server
// never saw, and deletes the bag (NIP-09) when it was the last thing;
// whole_bag deletes it whole; move_placed by { dz: 12 } signs the thing again
// with its lineage d, inside its bag or across a cube's edge (two bags), and
// a shard by reference is resealed under the same d, never retracted; a
// removed sealed shard's object is retracted. Every refusal changes nothing:
// no relay answering, a newer version this server signed than the relays
// show, a name that fits several things.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Agent } from '../src/agent.js'
import { bagTemplate, chestInnerTemplate, HIDDEN_KIND, messageInnerTemplate, rumorOf, unbag, type BagEntry } from '../src/hidden/bags.js'
import { sealEntries } from '../src/hidden/chests.js'
import { spawnPlace } from '../src/space/coords.js'
import { regionKeyAt } from '../src/hidden/crypto.js'
import { readComment } from '../src/hidden/comments.js'
import { decryptForRegion } from '../src/hidden/crypto.js'
import { bytesToHex, hexToBytes, nowSeconds, signEvent, type NostrEvent } from '../src/nostr/event.js'
import { openEntries } from '../src/placed.js'
import { createServer } from '../src/server.js'
import type { Calibration } from '../src/space/calibration.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork, type FakeRelay } from './fakeRelay.js'

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }

/** A point whose low bits leave room: z mod 256 is 100, so +12 stays in its h8 cube and leaves its h3 cube. */
const BASE = (1n << 40n) + 100n
const P = { x: BASE.toString(), y: BASE.toString(), z: BASE.toString(), plane: 0 }
const tetra = { v: 2, name: 'tetra', unit: 20, mode: 'solid', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], colors: [1, 2, 3, 4], faces: [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]] }

/** An object too large for the bag (over 16384 bytes): hidden by reference as a sealed kind 33331. */
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

interface World { a: Agent; call: Call; sk: Uint8Array; canonical: FakeRelay; mine: FakeRelay; network: FakeNetwork; dir: string }

async function setup(policy: { canonical?: Parameters<FakeNetwork['add']>[1] } = {}): Promise<World> {
  const network = new FakeNetwork()
  const canonical = network.add(CANONICAL, policy.canonical)
  const mine = network.add(MINE)
  const sk = generateSecretKey()
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-placed-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
  return { ...(await connect(network, dir)), sk, canonical, mine, network, dir }
}

/** Start an agent on a state directory and connect an MCP client to it. */
async function connect(network: FakeNetwork, dir: string): Promise<{ a: Agent; call: Call }> {
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
  return { a, call }
}

/** Stop the world's agent and start a new one on the same state directory, as a restart does. */
async function restart(w: World, before: () => void = () => {}): Promise<World> {
  await w.a.stop()
  agents.splice(agents.indexOf(w.a), 1)
  before()
  return { ...w, ...(await connect(w.network, w.dir)) }
}

/** The agent's bags a relay holds now, by lookup id. */
function bagsOn(relay: FakeRelay, pubkey: string): Map<string, NostrEvent> {
  const out = new Map<string, NostrEvent>()
  for (const e of relay.all()) if (e.kind === HIDDEN_KIND && e.pubkey === pubkey) out.set(e.tags.find((t) => t[0] === 'd')![1], e)
  return out
}

/** A point as the per-axis input, moved along z. */
function at(dz: bigint, height?: number): Record<string, unknown> {
  return { coordinate: { ...P, z: (BASE + dz).toString() }, ...(height === undefined ? {} : { height }) }
}

function key(z: bigint, height: number): { key: Uint8Array; lookupId: string } {
  const k = regionKeyAt({ x: BASE, y: BASE, z }, height, 20)
  return { key: k.key, lookupId: k.lookupId }
}

async function entriesOf(bag: NostrEvent, regionKey: Uint8Array): Promise<BagEntry[]> {
  return (await openEntries(bag, regionKey)) ?? []
}

interface Row { id: string; lineage: string | null; type: string; label: string; at: { x: string; y: string; z: string }; byReference?: string; objectAddress?: string }
const rowsOf = (r: { data: Record<string, unknown> }): Row[] => (r.data.bags as Array<{ entries: Row[] }>).flatMap((b) => b.entries)

describe('placed, remove_placed and move_placed', () => {
  let s: Awaited<ReturnType<typeof setup>>
  beforeEach(async () => { s = await setup() })

  it('lists every bag and thing with ids and positions, and "last" is the newest', async () => {
    const m = await s.call('hide', { contents: { message: 'first note' }, ...at(0n), height: 8 })
    expect(m.isError).toBe(false)
    expect(m.text).toContain('remove_placed')
    await s.call('hide', { contents: { object: tetra }, ...at(1n), height: 8 })
    await new Promise((r) => setTimeout(r, 1100))
    await s.call('hide', { contents: { key: { name: 'Brass Key', about: 'opens nothing yet' } }, ...at(2n), height: 3 })
    const list = await s.call('placed')
    expect(list.isError).toBe(false)
    const rows = rowsOf(list)
    expect(rows.map((r) => r.label).sort()).toEqual(['Brass Key', 'first note', 'tetra'])
    expect((list.data.last as Row).label).toBe('Brass Key')
    expect(list.text).toContain('remove_placed')
    expect(list.text).toContain('by: { dz: 12 }')
    const tetraRow = rows.find((r) => r.label === 'tetra')!
    expect(tetraRow.at.z).toBe((BASE + 1n).toString())
    expect(tetraRow.lineage).toBe(tetraRow.id)
    // A filter by name.
    expect(rowsOf(await s.call('placed', { match: 'note' })).map((r) => r.label)).toEqual(['first note'])
  }, 60_000)

  it('removes one thing and keeps the rest of the bag, including what another session added that this server never saw', async () => {
    await s.call('hide', { contents: { message: 'keep me' }, ...at(0n), height: 8 })
    await s.call('hide', { contents: { object: tetra }, ...at(1n), height: 8 })
    // Another session of the same key rewrote the bag with one more thing: only the relay knows it.
    const k = key(BASE, 8)
    const current = bagsOn(s.mine, s.a.pubkey).get(k.lookupId)!
    const carried = await entriesOf(current, k.key)
    const other = signEvent(messageInnerTemplate('from another session', { x: BASE, y: BASE, z: BASE + 3n }, 0, current.created_at), s.sk)
    const newer = signEvent(await bagTemplate([...carried, other], k.key, k.lookupId, 8, current.created_at + 5, HIDDEN_KIND), s.sk)
    s.mine.seed(newer)
    s.canonical.seed(newer)
    const r = await s.call('remove_placed', { target: 'tetra' })
    expect(r.isError).toBe(false)
    expect(r.data.left).toBe(2)
    const after = bagsOn(s.mine, s.a.pubkey).get(k.lookupId)!
    expect(after.created_at).toBeGreaterThan(newer.created_at)
    const kept = (await unbag(after, k.key, undefined, undefined, 8)).map((h) => h.text ?? h.shard?.name)
    expect(kept.sort()).toEqual(['from another session', 'keep me'])
  }, 60_000)

  it('deletes the bag (NIP-09) when the last thing in it is removed, and whole_bag deletes a bag at once', async () => {
    await s.call('hide', { contents: { message: 'alone' }, ...at(0n), height: 8 })
    const k = key(BASE, 8)
    const bag = bagsOn(s.mine, s.a.pubkey).get(k.lookupId)!
    const r = await s.call('remove_placed', { target: 'last' })
    expect(r.isError).toBe(false)
    expect(r.data.deletedBag).toBe(true)
    const del = s.mine.all().find((e) => e.kind === 5)!
    expect(del.tags.slice(0, 3)).toEqual([['a', `33330:${s.a.pubkey}:${k.lookupId}`], ['e', bag.id], ['k', '33330']])
    expect(del.content).toBe('hidden content removed')
    expect(bagsOn(s.mine, s.a.pubkey).has(k.lookupId)).toBe(false)
    expect(rowsOf(await s.call('placed'))).toEqual([])
    // A hide there afterwards is newer than the deletion, so the relay keeps it.
    const again = await s.call('hide', { contents: { message: 'back again' }, ...at(0n), height: 8 })
    expect(again.isError).toBe(false)
    expect(bagsOn(s.mine, s.a.pubkey).get(k.lookupId)!.created_at).toBeGreaterThan(del.created_at)
    await s.call('hide', { contents: { message: 'second' }, ...at(1n), height: 8 })
    const whole = await s.call('remove_placed', { target: 'second', whole_bag: true })
    expect(whole.isError).toBe(false)
    expect((whole.data.removed as Row[]).length).toBe(2)
    expect(bagsOn(s.mine, s.a.pubkey).has(k.lookupId)).toBe(false)
  }, 60_000)

  it('moves a thing 12 gibsons toward Z+ inside its bag: signed again with its lineage, one rewrite, the rest kept', async () => {
    const hid = await s.call('hide', { contents: { object: tetra }, ...at(0n), height: 8 })
    expect(hid.isError).toBe(false)
    await s.call('hide', { contents: { message: 'neighbour' }, ...at(1n), height: 8 })
    const before = rowsOf(await s.call('placed')).find((r) => r.label === 'tetra')!
    const r = await s.call('move_placed', { target: 'tetra', by: { dz: 12 } })
    expect(r.isError).toBe(false)
    expect(r.data.sameBag).toBe(true)
    expect(r.text).toContain('+12 z')
    const k = key(BASE, 8)
    const bag = bagsOn(s.mine, s.a.pubkey).get(k.lookupId)!
    const items = await unbag(bag, k.key, undefined, undefined, 8)
    expect(items.map((h) => h.text ?? h.shard?.name).sort()).toEqual(['neighbour', 'tetra'])
    const moved = items.find((h) => h.type === 'shard')!
    expect(moved.at.z).toBe(BASE + 12n)
    expect(moved.inner.id).not.toBe(before.id)
    // ONOSENDAI's editedTemplate: C first, then the lineage d, then what the old version carried.
    expect(moved.inner.tags[0][0]).toBe('C')
    expect(moved.inner.tags[1]).toEqual(['d', before.id])
    // A second move keeps the first id.
    await s.call('move_placed', { target: 'last', by: { dx: -1 } })
    const again = (await unbag(bagsOn(s.mine, s.a.pubkey).get(k.lookupId)!, k.key, undefined, undefined, 8)).find((h) => h.type === 'shard')!
    expect(again.inner.tags.find((t) => t[0] === 'd')).toEqual(['d', before.id])
    expect(again.at.x).toBe(BASE - 1n)
  }, 60_000)

  it('moves across a cube edge: the new bag first, then the old one rewritten or deleted, and a comment names the lineage', async () => {
    await s.call('hide', { contents: { message: 'travelling note' }, ...at(0n), height: 3 })
    await s.call('hide', { contents: { message: 'stays behind' }, ...at(1n), height: 3 })
    const first = rowsOf(await s.call('placed')).find((r) => r.label === 'travelling note')!
    const r = await s.call('move_placed', { target: 'travelling note', by: { dz: 12 } })
    expect(r.isError).toBe(false)
    expect(r.data.sameBag).toBe(false)
    const oldK = key(BASE, 3)
    const newK = key(BASE + 12n, 3)
    expect(oldK.lookupId).not.toBe(newK.lookupId)
    const oldItems = await unbag(bagsOn(s.mine, s.a.pubkey).get(oldK.lookupId)!, oldK.key, undefined, undefined, 3)
    expect(oldItems.map((h) => h.text)).toEqual(['stays behind'])
    const newItems = await unbag(bagsOn(s.mine, s.a.pubkey).get(newK.lookupId)!, newK.key, undefined, undefined, 3)
    expect(newItems.map((h) => h.text)).toEqual(['travelling note'])
    expect(newItems[0].inner.tags.find((t) => t[0] === 'd')).toEqual(['d', first.id])
    // Moving the other one out too empties the old bag, which is then deleted.
    const out = await s.call('move_placed', { target: 'stays behind', to: { ...P, z: (BASE + 13n).toString() } })
    expect(out.isError).toBe(false)
    expect(bagsOn(s.mine, s.a.pubkey).has(oldK.lookupId)).toBe(false)
    expect(s.mine.all().some((e) => e.kind === 5 && e.tags.some((t) => t[0] === 'a' && t[1].endsWith(oldK.lookupId)))).toBe(true)
    // A comment on the moved note answers its first id, as ONOSENDAI's do.
    await s.call('find', {})
    const moved = rowsOf(await s.call('placed')).find((r) => r.label === 'travelling note')!
    expect(moved.lineage).toBe(first.id)
    // find must have opened the new bag for comment to know it: the agent stands elsewhere, so hide's own record is what comment uses.
    const c = await s.call('comment', { target: moved.id.slice(0, 12), text: 'it moved' })
    expect(c.isError).toBe(false)
    const comment = s.mine.all().find((e) => e.kind === 1111)!
    const read = await readComment(comment, newK.key)
    expect(read?.parentId).toBe(first.id)
  }, 60_000)

  it('a shard by reference moved to another region is resealed under the same d and never retracted; removing it retracts its object', async () => {
    const hid = await s.call('hide', { contents: { object: bigObject('big one') }, ...at(0n), height: 3 })
    expect(hid.isError).toBe(false)
    const objectBefore = s.mine.all().find((e) => e.kind === 33331)!
    const d = objectBefore.tags.find((t) => t[0] === 'd')![1]
    const row = rowsOf(await s.call('placed')).find((r) => r.label === 'big one')!
    expect(row.byReference).toBe('sealed')
    expect(row.objectAddress).toBe(`33331:${s.a.pubkey}:${d}`)
    const r = await s.call('move_placed', { target: 'big one', by: { dz: 12 } })
    expect(r.isError).toBe(false)
    const objectAfter = s.mine.all().find((e) => e.kind === 33331)!
    expect(objectAfter.id).not.toBe(objectBefore.id)
    expect(objectAfter.tags.find((t) => t[0] === 'd')![1]).toBe(d)
    expect(objectAfter.created_at).toBeGreaterThan(objectBefore.created_at)
    const newK = key(BASE + 12n, 3)
    const enc = objectAfter.tags.find((t) => t[0] === 'encrypted')!
    expect(await decryptForRegion(newK.key, enc[2])).not.toBeNull()
    expect(await decryptForRegion(key(BASE, 3).key, enc[2])).toBeNull()
    // No retraction of the object: the old bag held only it, so the old bag is deleted, the object stays.
    expect(s.mine.all().filter((e) => e.kind === 5).every((e) => !e.tags.some((t) => t[0] === 'a' && t[1].startsWith('33331:')))).toBe(true)
    const newBag = bagsOn(s.mine, s.a.pubkey).get(newK.lookupId)!
    const ref = (await entriesOf(newBag, newK.key))[0] as string[]
    expect(ref[0]).toBe('a')
    expect(ref[1]).toBe(`33331:${s.a.pubkey}:${d}`)
    // Placed reads it back through the reference, at its new point.
    const moved = rowsOf(await s.call('placed')).find((r) => r.label === 'big one')!
    expect(moved.at.z).toBe((BASE + 12n).toString())
    // Removing it now takes its sealed object down too (ONOSENDAI deleteInstance).
    const gone = await s.call('remove_placed', { target: 'big one' })
    expect(gone.isError).toBe(false)
    expect(gone.text).toContain('taken down too')
    expect(s.mine.all().some((e) => e.kind === 33331)).toBe(false)
  }, 60_000)

  it('refuses a name that fits several things, and changes nothing', async () => {
    await s.call('hide', { contents: { object: tetra }, ...at(0n), height: 8 })
    await s.call('hide', { contents: { object: tetra }, ...at(1n), height: 8 })
    const published = s.mine.published.length
    const r = await s.call('remove_placed', { target: 'tetra' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('2 things you placed are called "tetra"')
    expect(s.mine.published.length).toBe(published)
  }, 60_000)

  it('builds on the newest version this server signed when every relay lost it, so nothing in it is lost and the cube is never locked', async () => {
    await s.call('hide', { contents: { message: 'one' }, ...at(0n), height: 8 })
    await s.call('hide', { contents: { message: 'two' }, ...at(1n), height: 8 })
    // The relays lose the newest version (a relay wiped, or one that never took it) and the outbox no longer carries it.
    const k = key(BASE, 8)
    for (const relay of [s.mine, s.canonical]) relay.events.delete(`33330:${s.a.pubkey}:${k.lookupId}`)
    const older = signEvent(await bagTemplate([signEvent(messageInnerTemplate('one', { x: BASE, y: BASE, z: BASE }, 0, 1), s.sk)], k.key, k.lookupId, 8, 2, HIDDEN_KIND), s.sk)
    s.mine.seed(older)
    s.a.outbox.entries.splice(0, s.a.outbox.entries.length)
    const r = await s.call('hide', { contents: { message: 'three' }, ...at(2n), height: 8 })
    expect(r.isError).toBe(false)
    const bag = bagsOn(s.mine, s.a.pubkey).get(k.lookupId)!
    expect((await unbag(bag, k.key, undefined, undefined, 8)).map((h) => h.text).sort()).toEqual(['one', 'three', 'two'])
  }, 60_000)

  it('needs a target, takes names exactly, and "last" with a type is the newest of that type', async () => {
    await s.call('hide', { contents: { object: { ...tetra, name: 'Red Cube' } }, ...at(0n), height: 8 })
    await s.call('hide', { contents: { message: 'I placed my first shard here!' }, ...at(1n), height: 8 })
    const published = s.mine.published.length
    for (const args of [{}, { whole_bag: true }, { target: '' }]) {
      const r = await s.call('remove_placed', args)
      expect(r.isError).toBe(true)
      expect(r.text).toContain('Say what to remove')
    }
    // "shard" is part of the message, never a name: refused, with what was close.
    const partial = await s.call('remove_placed', { target: 'shard' })
    expect(partial.isError).toBe(true)
    expect(partial.text).toContain('I placed my first shard here!')
    expect(s.mine.published.length).toBe(published)
    // "the shard you placed": last of type shard, though the message is newer.
    const r = await s.call('remove_placed', { target: 'last', type: 'shard' })
    expect(r.isError).toBe(false)
    expect((r.data.removed as Row).label).toBe('Red Cube')
    expect(rowsOf(await s.call('placed')).map((x) => x.label)).toEqual(['I placed my first shard here!'])
  }, 60_000)

  it('does not move a chest', async () => {
    await s.call('hide', { contents: { key: { name: 'Brass Key' } }, ...at(0n), height: 8 })
    await s.call('hide', { contents: { chest: { name: 'Box', lock: 'Brass Key', entries: [{ message: 'inside' }] } }, ...at(1n), height: 8 })
    const r = await s.call('move_placed', { target: 'Box', by: { dz: 12 } })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('A chest cannot be moved')
  }, 60_000)

  it('runs calls on one bag one at a time: nothing is lost when they come together', async () => {
    await s.call('hide', { contents: { message: 'gone soon' }, ...at(0n), height: 8 })
    await Promise.all([
      s.call('hide', { contents: { message: 'a' }, ...at(1n), height: 8 }),
      s.call('hide', { contents: { message: 'b' }, ...at(2n), height: 8 }),
      s.call('remove_placed', { target: 'gone soon' }),
      s.call('hide', { contents: { message: 'c' }, ...at(3n), height: 8 }),
    ])
    const k = key(BASE, 8)
    const bag = bagsOn(s.mine, s.a.pubkey).get(k.lookupId)!
    expect((await unbag(bag, k.key, undefined, undefined, 8)).map((h) => h.text).sort()).toEqual(['a', 'b', 'c'])
  }, 60_000)

  it('leaves a sealed object up while another of your bags still names it', async () => {
    await s.call('hide', { contents: { object: bigObject('big one') }, ...at(0n), height: 3 })
    const k = key(BASE, 3)
    const ref = (await entriesOf(bagsOn(s.mine, s.a.pubkey).get(k.lookupId)!, k.key))[0]
    // A second bag of the agent's, in another cube it holds the key to, names the same object.
    const other = s.a.keys.keyAt({ x: BASE, y: BASE, z: BASE + 64n }, 3, 'hide')
    const otherBag = signEvent(await bagTemplate([ref], hexToBytes(other.keyHex), other.lookupId, 3, nowSeconds(), HIDDEN_KIND), s.sk)
    s.mine.seed(otherBag)
    s.canonical.seed(otherBag)
    const r = await s.call('remove_placed', { target: 'big one' })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('another of your placements names it')
    expect(s.mine.all().some((e) => e.kind === 5 && e.tags.some((t) => t[0] === 'a' && t[1].startsWith('33331:')))).toBe(false)
  }, 60_000)
})

describe('when a relay refuses or is silent', () => {
  it('a deletion every relay refused leaves the bag listed, so it can be removed again', async () => {
    const s = await setup()
    await s.call('hide', { contents: { message: 'only' }, ...at(0n), height: 8 })
    for (const r of [s.mine, s.canonical]) r.policy.refuse = (ev) => (ev.kind === 5 ? 'blocked: no deletions today' : null)
    const r = await s.call('remove_placed', { target: 'only' })
    expect(r.text).toContain('blocked: no deletions today')
    expect(rowsOf(await s.call('placed')).map((x) => x.label)).toEqual(['only'])
    for (const rl of [s.mine, s.canonical]) rl.policy.refuse = () => null
    const again = await s.call('remove_placed', { target: 'only' })
    expect(again.isError).toBe(false)
    expect(bagsOn(s.mine, s.a.pubkey).has(key(BASE, 8).lookupId)).toBe(false)
  }, 60_000)

  it('a deletion only a lesser relay took leaves the bag listed while the canonical relay serves it', async () => {
    const s = await setup()
    await s.call('hide', { contents: { message: 'still on canonical' }, ...at(0n), height: 8 })
    s.canonical.policy.refuse = (ev) => (ev.kind === 5 ? 'blocked: no deletions here' : null)
    const r = await s.call('remove_placed', { target: 'still on canonical' })
    expect(r.text).toContain('blocked: no deletions here')
    expect(bagsOn(s.mine, s.a.pubkey).has(key(BASE, 8).lookupId)).toBe(false)
    expect(rowsOf(await s.call('placed')).map((x) => x.label)).toEqual(['still on canonical'])
    s.canonical.policy.refuse = () => null
    const again = await s.call('remove_placed', { target: 'still on canonical' })
    expect(again.isError).toBe(false)
    expect(bagsOn(s.canonical, s.a.pubkey).has(key(BASE, 8).lookupId)).toBe(false)
  }, 60_000)

  it('refuses to rewrite when the canonical relay is silent, though another relay answers', async () => {
    const s = await setup()
    await s.call('hide', { contents: { message: 'keep' }, ...at(0n), height: 8 })
    await s.call('hide', { contents: { message: 'x' }, ...at(1n), height: 8 })
    s.canonical.policy.silent = true
    const published = s.mine.published.length
    const r = await s.call('remove_placed', { target: 'x' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('canonical relay did not answer')
    expect(s.mine.published.length).toBe(published)
  }, 60_000)

  it('a move the canonical relay does not take leaves the old copy there, never a hole', async () => {
    const s = await setup()
    await s.call('hide', { contents: { message: 'stays' }, ...at(1n), height: 3 })
    await s.call('hide', { contents: { message: 'mover' }, ...at(0n), height: 3 })
    const oldK = key(BASE, 3)
    const newK = key(BASE + 12n, 3)
    s.canonical.policy.refuse = (ev) => (ev.kind === HIDDEN_KIND && ev.tags.some((t) => t[0] === 'd' && t[1] === newK.lookupId) ? 'blocked: too big' : null)
    const before = bagsOn(s.canonical, s.a.pubkey).get(oldK.lookupId)!
    const r = await s.call('move_placed', { target: 'mover', by: { dz: 12 } })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('canonical relay did not take the bag at the new place')
    // On the canonical relay the old bag is untouched, so the thing is still there.
    expect(bagsOn(s.canonical, s.a.pubkey).get(oldK.lookupId)!.id).toBe(before.id)
    expect((await unbag(before, oldK.key, undefined, undefined, 3)).map((h) => h.text).sort()).toEqual(['mover', 'stays'])
  }, 60_000)

  it('a reseal the canonical relay does not take is put back, and nothing moves', async () => {
    const s = await setup()
    await s.call('hide', { contents: { object: bigObject('big one') }, ...at(0n), height: 3 })
    const object = s.canonical.all().find((e) => e.kind === 33331)!
    s.canonical.policy.refuse = (ev) => (ev.kind === 33331 && ev.created_at > object.created_at && ev.content === object.content && ev.tags.find((t) => t[0] === 'encrypted')![2] !== object.tags.find((t) => t[0] === 'encrypted')![2] ? 'blocked: not this one' : null)
    const r = await s.call('move_placed', { target: 'big one', by: { dz: 12 } })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Nothing was moved')
    // Wherever the resealed object landed, the newest version there opens with the old place's key.
    for (const relay of [s.mine, s.canonical]) {
      const now = relay.all().find((e) => e.kind === 33331)!
      expect(await decryptForRegion(key(BASE, 3).key, now.tags.find((t) => t[0] === 'encrypted')![2])).not.toBeNull()
    }
    expect(s.a.keys.putBacks).toEqual([])
    expect(bagsOn(s.mine, s.a.pubkey).has(key(BASE + 12n, 3).lookupId)).toBe(false)
  }, 60_000)
})
describe('when no relay answers', () => {
  it('hide, remove_placed and move_placed refuse rather than write a bag blind', async () => {
    const s = await setup()
    await s.call('hide', { contents: { message: 'precious' }, ...at(0n), height: 8 })
    for (const r of [s.mine, s.canonical]) r.policy.silent = true
    const published = s.mine.published.length + s.canonical.published.length
    const h = await s.call('hide', { contents: { message: 'blind' }, ...at(1n), height: 8 })
    expect(h.isError).toBe(true)
    expect(h.text).toContain('canonical relay did not answer')
    const p = await s.call('placed')
    expect(p.isError).toBe(true)
    expect((await s.call('remove_placed', { target: 'last' })).isError).toBe(true)
    expect((await s.call('move_placed', { target: 'last', by: { dz: 12 } })).isError).toBe(true)
    expect(s.mine.published.length + s.canonical.published.length).toBe(published)
  }, 60_000)
})

describe('a move that no relay takes', () => {
  it('has not happened: the old copy stays and the new bag never lands later', async () => {
    const s = await setup()
    await s.call('hide', { contents: { message: 'stay put' }, ...at(0n), height: 3 })
    // Both relays answer reads but refuse every new bag from now on.
    for (const r of [s.mine, s.canonical]) r.policy.refuse = (ev) => (ev.kind === HIDDEN_KIND ? 'blocked: read-only for this test' : null)
    const oldK = key(BASE, 3)
    const before = bagsOn(s.mine, s.a.pubkey).get(oldK.lookupId)!
    const r = await s.call('move_placed', { target: 'last', by: { dz: 12 } })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Nothing was moved')
    expect(bagsOn(s.mine, s.a.pubkey).get(oldK.lookupId)!.id).toBe(before.id)
    expect(bagsOn(s.mine, s.a.pubkey).has(key(BASE + 12n, 3).lookupId)).toBe(false)
    expect(s.a.outbox.pending().some((e) => e.event.kind === HIDDEN_KIND && e.event.tags.some((t) => t[0] === 'd' && t[1] === key(BASE + 12n, 3).lookupId))).toBe(false)
    // And the bag is not called stale afterwards: the record never took the abandoned version.
    for (const rl of [s.mine, s.canonical]) rl.policy.refuse = () => null
    const list = await s.call('placed')
    expect(list.isError).toBe(false)
    expect((list.data.bags as Array<{ stale: boolean }>).every((b) => !b.stale)).toBe(true)
  }, 60_000)
})

describe('a deleted bag stays deleted', () => {
  it('after a deletion that only a retry delivered, once the outbox no longer carries it', async () => {
    const s = await setup()
    await s.call('hide', { contents: { message: 'removed for good' }, ...at(0n), height: 8 })
    // The first send of the deletion fails for a reason that is not a refusal, so the outbox retries it.
    for (const r of [s.mine, s.canonical]) r.policy.refuse = (ev) => (ev.kind === 5 ? 'connection hiccup' : null)
    await s.call('remove_placed', { target: 'removed for good' })
    for (const r of [s.mine, s.canonical]) r.policy.refuse = () => null
    await s.a.outbox.retry()
    const k = key(BASE, 8)
    expect(bagsOn(s.canonical, s.a.pubkey).has(k.lookupId)).toBe(false)
    // The outbox trims its history; only the record is left.
    s.a.outbox.entries.splice(0, s.a.outbox.entries.length)
    expect(rowsOf(await s.call('placed'))).toEqual([])
    await s.call('hide', { contents: { message: 'fresh' }, ...at(1n), height: 8 })
    const bag = bagsOn(s.canonical, s.a.pubkey).get(k.lookupId)!
    expect((await unbag(bag, k.key, undefined, undefined, 8)).map((h) => h.text)).toEqual(['fresh'])
  }, 60_000)

  it('when another session of the same key deleted it, which this server never sent', async () => {
    const s = await setup()
    await s.call('hide', { contents: { message: 'theirs to delete' }, ...at(0n), height: 8 })
    const k = key(BASE, 8)
    const bag = bagsOn(s.canonical, s.a.pubkey).get(k.lookupId)!
    const del = signEvent({ kind: 5, created_at: bag.created_at + 1, content: '', tags: [['a', `33330:${s.a.pubkey}:${k.lookupId}`], ['e', bag.id], ['k', '33330']] }, s.sk)
    s.canonical.seed(del)
    s.mine.seed(del)
    s.a.outbox.entries.splice(0, s.a.outbox.entries.length)
    expect(rowsOf(await s.call('placed'))).toEqual([])
    await s.call('hide', { contents: { message: 'fresh' }, ...at(1n), height: 8 })
    const after = bagsOn(s.canonical, s.a.pubkey).get(k.lookupId)!
    expect((await unbag(after, k.key, undefined, undefined, 8)).map((h) => h.text)).toEqual(['fresh'])
  }, 60_000)
})

describe('a restart', () => {
  it('adopts bags hidden before keys/mine.json existed, and puts back the object of a move it stopped in the middle of', async () => {
    let s = await setup()
    await s.call('hide', { contents: { message: 'old placement' }, ...at(0n), height: 8 })
    const rollback = signEvent({ kind: 33331, created_at: 5, content: 'x', tags: [['d', 'abc']] }, s.sk)
    s.a.keys.holdPutBack({ rollback, newLookupId: 'never-written', newBagId: 'none' })
    s = await restart(s, () => {
      // As if mine.json had only the put-back: the bag record is gone, as on a state directory from before this change.
      writeFileSync(join(s.dir, 'keys', 'mine.json'), JSON.stringify({ version: 1, bags: [], putBacks: [{ rollback, newLookupId: 'never-written', newBagId: 'none' }] }))
    })
    expect(s.a.keys.mine.has(key(BASE, 8).lookupId)).toBe(true)
    expect(s.a.keys.putBacks).toEqual([])
    expect(s.a.outbox.entries.some((e) => e.event.id === rollback.id)).toBe(true)
    const r = await s.call('remove_placed', { target: 'old placement' })
    expect(r.isError).toBe(false)
  }, 60_000)

  it('does not put back the object of a move that finished before the stop', async () => {
    let s = await setup()
    await s.call('hide', { contents: { message: 'here' }, ...at(0n), height: 8 })
    const k = key(BASE, 8)
    const rec = s.a.keys.mine.get(k.lookupId)!
    const rollback = signEvent({ kind: 33331, created_at: 5, content: 'x', tags: [['d', 'abc']] }, s.sk)
    s.a.keys.holdPutBack({ rollback, newLookupId: k.lookupId, newBagId: rec.lastBagId! })
    s = await restart(s)
    expect(s.a.keys.putBacks).toEqual([])
    expect(s.a.outbox.entries.some((e) => e.event.id === rollback.id)).toBe(false)
  }, 60_000)
})

describe('what the agent hides and moves follows the rules of 2026-10-20 (`-`, messages as rumors)', () => {
  let s: Awaited<ReturnType<typeof setup>>
  beforeEach(async () => { s = await setup() })

  it('hide writes a message as a rumor with `-`, an object signed with `-`; a move keeps the message a rumor and gives a signed message from before `-` once', async () => {
    await s.call('hide', { contents: { message: 'no proof of me' }, ...at(0n), height: 8 })
    await s.call('hide', { contents: { object: tetra }, ...at(1n), height: 8 })
    const k = key(BASE, 8)
    const current = bagsOn(s.mine, s.a.pubkey).get(k.lookupId)!
    const entries = await entriesOf(current, k.key) as Array<Record<string, unknown> & { kind: number; tags: string[][]; id: string; pubkey: string }>
    const msg = entries.find((e) => e.kind === 1)!
    expect('sig' in msg).toBe(false)
    expect(msg.pubkey).toBe(s.a.pubkey)
    expect(msg.tags.map((t) => t[0])).toEqual(['C', '-', 'client'])
    const obj = entries.find((e) => e.kind === 3330)!
    expect(typeof obj.sig).toBe('string')
    expect(obj.tags.filter((t) => t[0] === '-')).toHaveLength(1)
    // The bag reads both, the rumor as the agent's.
    const read = await unbag(current, k.key, undefined, undefined, 8)
    expect(read.map((h) => [h.type, h.author])).toEqual([['message', s.a.pubkey], ['shard', s.a.pubkey]])

    // A signed message hidden before 2026-10-20, with no `-`, as another session wrote it.
    const legacy = signEvent({ kind: 1, created_at: current.created_at, content: 'signed long ago', tags: [['C', read[0].inner.tags[0][1].replace(/.$/, (c) => (c === '0' ? '1' : '0'))]] }, s.sk)
    const withLegacy = signEvent(await bagTemplate([...entries as BagEntry[], legacy], k.key, k.lookupId, 8, current.created_at + 5, HIDDEN_KIND), s.sk)
    s.mine.seed(withLegacy)
    s.canonical.seed(withLegacy)
    expect((await unbag(withLegacy, k.key, undefined, undefined, 8)).map((h) => h.text ?? h.shard?.name)).toContain('signed long ago')

    for (const [target, old] of [['no proof of me', msg.id], ['signed long ago', legacy.id]] as const) {
      const r = await s.call('move_placed', { target, by: { dx: 1 } })
      expect(r.isError, target).toBe(false)
      const now = bagsOn(s.mine, s.a.pubkey).get(k.lookupId)!
      const moved = (await entriesOf(now, k.key) as Array<Record<string, unknown> & { kind: number; content: string; tags: string[][] }>).find((e) => e.kind === 1 && e.content === target)!
      expect('sig' in moved, target).toBe(false)
      expect(moved.tags.filter((t) => t[0] === '-'), target).toHaveLength(1)
      expect(moved.tags.find((t) => t[0] === 'd'), target).toEqual(['d', old])
      expect((await unbag(now, k.key, undefined, undefined, 8)).some((h) => h.text === target && h.author === s.a.pubkey), target).toBe(true)
    }
    // Dumped for a cross-check with ONOSENDAI's own reader, when asked.
    if (process.env.PROTECT_INTEROP_DUMP) writeFileSync(process.env.PROTECT_INTEROP_DUMP, JSON.stringify({ bag: bagsOn(s.mine, s.a.pubkey).get(k.lookupId)!, keyHex: bytesToHex(k.key), height: 8 }))
  }, 60_000)

  it('a chest inside a chest vouches for its rumors only when its own author is a fact', async () => {
    const lock = await s.call('forge_item', { name: 'Iron Key', height: 5 })
    expect(lock.isError).toBe(false)
    const lockPub = (lock.data.item as { itemPubkey: string }).itemPubkey
    const other = generateSecretKey()
    const otherPub = getPublicKey(other)
    const here = spawnPlace(s.a.pubkey)
    const T = nowSeconds()
    const innerChest = (inner: BagEntry[], name: string, signedBy?: Uint8Array): BagEntry => {
      const sealed = sealEntries(inner, lockPub)
      const t = chestInnerTemplate({ name, lockPubkey: lockPub, senderPubkey: sealed.senderPubkey, requires: '', payload: sealed.payload }, here.position, here.plane, T)
      return signedBy ? signEvent(t, signedBy) : rumorOf(t, otherPub)
    }
    // Another key's rumor, inside an UNSIGNED chest claiming that key: nobody vouches for it.
    const forged = innerChest([rumorOf(messageInnerTemplate('I am someone else', here.position, here.plane, T), otherPub)], 'Forged Box')
    // The same, inside a chest that key really signed: its signature vouches for it.
    const real = innerChest([rumorOf(messageInnerTemplate('I really am', here.position, here.plane, T), otherPub)], 'Real Box', other)
    const outerSealed = sealEntries([forged, real], lockPub)
    const outer = signEvent(chestInnerTemplate({ name: 'Outer', lockPubkey: lockPub, senderPubkey: outerSealed.senderPubkey, requires: '', payload: outerSealed.payload }, here.position, here.plane, T), s.sk)
    const k = regionKeyAt(here.position, 6, 20)
    const bag = signEvent(await bagTemplate([outer], k.key, k.lookupId, 6, T, HIDDEN_KIND), s.sk)
    s.mine.seed(bag)
    s.canonical.seed(bag)
    await s.call('find', {})
    const o = await s.call('open_chest', { chest: outer.id.slice(0, 12) })
    expect(o.isError, o.text).toBe(false)
    const ids = new Map([...s.a.keys.chests.values()].filter((c) => c.inChest === outer.id).map((c) => [c.name, c]))
    expect(ids.get('Forged Box')?.vouches).toBeUndefined()
    expect(ids.get('Real Box')?.vouches).toBe(true)
    const f = await s.call('open_chest', { chest: ids.get('Forged Box')!.id.slice(0, 12) })
    expect(f.text).toContain('I am someone else')
    expect(f.text).toContain('the author is a claim')
    const r = await s.call('open_chest', { chest: ids.get('Real Box')!.id.slice(0, 12) })
    expect(r.text).toContain('I really am')
    expect(r.text).not.toContain('the author is a claim')
  }, 60_000)

  it('seal_chest writes its messages as rumors; open_chest and take say the chest vouches for them', async () => {
    const lock = await s.call('forge_item', { name: 'Tin Key', height: 5, coordinate: P })
    expect(lock.isError).toBe(false)
    const sealed = await s.call('seal_chest', { name: 'Tin Box', lock: 'tin key', contents: [{ message: 'vouched for by the box' }], height: 5, coordinate: { ...P, z: (BASE + 1n).toString() } })
    expect(sealed.isError).toBe(false)
    const chestId = (sealed.data.chest as { id: string }).id
    await s.call('find', {})
    const opened = await s.call('open_chest', { chest: chestId.slice(0, 12) })
    expect(opened.isError).toBe(false)
    expect(opened.text).toContain('vouched for by the box')
    expect(opened.text).not.toContain('the author is a claim')
    const took = await s.call('take', { chest: chestId.slice(0, 12) })
    expect(took.isError).toBe(false)
    const row = (took.data.took as Array<{ type: string; verified: boolean }>)[0]
    expect(row).toMatchObject({ type: 'message', verified: true })
  }, 60_000)
})
