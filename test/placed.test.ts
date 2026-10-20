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
import { bagTemplate, HIDDEN_KIND, messageInnerTemplate, unbag, type BagEntry } from '../src/hidden/bags.js'
import { regionKeyAt } from '../src/hidden/crypto.js'
import { readComment } from '../src/hidden/comments.js'
import { decryptForRegion } from '../src/hidden/crypto.js'
import { bytesToHex, signEvent, type NostrEvent } from '../src/nostr/event.js'
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

async function setup(policy: { canonical?: Parameters<FakeNetwork['add']>[1] } = {}): Promise<{ a: Agent; call: Call; sk: Uint8Array; canonical: FakeRelay; mine: FakeRelay; network: FakeNetwork }> {
  const network = new FakeNetwork()
  const canonical = network.add(CANONICAL, policy.canonical)
  const mine = network.add(MINE)
  const sk = generateSecretKey()
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-placed-'))
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
  return { a, call, sk, canonical, mine, network }
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

  it('refuses a newer version this server signed that the relays do not show, and changes nothing', async () => {
    await s.call('hide', { contents: { message: 'one' }, ...at(0n), height: 8 })
    await s.call('hide', { contents: { message: 'two' }, ...at(1n), height: 8 })
    // The relays lose the newest version (a relay that rolled back); the outbox no longer carries it.
    const k = key(BASE, 8)
    for (const relay of [s.mine, s.canonical]) relay.events.delete(`33330:${s.a.pubkey}:${k.lookupId}`)
    const older = signEvent(await bagTemplate([signEvent(messageInnerTemplate('one', { x: BASE, y: BASE, z: BASE }, 0, 1), s.sk)], k.key, k.lookupId, 8, 2, HIDDEN_KIND), s.sk)
    s.mine.seed(older)
    s.a.outbox.entries.splice(0, s.a.outbox.entries.length)
    const published = s.mine.published.length
    const r = await s.call('hide', { contents: { message: 'three' }, ...at(2n), height: 8 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('do not have the newest version')
    expect(s.mine.published.length).toBe(published)
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
    expect(h.text).toContain('No relay answered')
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

describe('bags hidden before this record existed', () => {
  it('are adopted from what find and hide noted, so a restart on an old state directory can still remove them', async () => {
    const s = await setup()
    await s.call('hide', { contents: { message: 'old placement' }, ...at(0n), height: 8 })
    // As if keys/mine.json had never been written.
    s.a.keys.mine.clear()
    const r = await s.call('remove_placed', { target: 'old placement' })
    expect(r.isError).toBe(false)
    expect(getPublicKey(s.sk)).toBe(s.a.pubkey)
  }, 60_000)
})
