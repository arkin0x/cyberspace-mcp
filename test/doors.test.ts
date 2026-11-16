// doors.test.ts: locked doors (DECK-0004 §3.7). The room key against the
// spec's own vectors (kinds-vectors.json, locks.room and locks.door); then a
// real agent on the in-memory relay forges a key, seals a door with looks,
// places a shard in the room, and the published events are opened the way a
// finder opens them, with nothing but the key item's secret: the door gives
// its secret, the secret and the place give the room key, and the room bag
// (signed by the door's author, with no height, hint, sector or contents
// tag) opens to the shard. The secret is kept in the state directory, mode
// 600, and never appears in a tool's answer. ONOSENDAI's own reader opens
// the same events in doorsInterop.test.ts. No network; throwaway keys.

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { v2 as nip44 } from 'nostr-tools/nip44'
import { generateSecretKey } from 'nostr-tools/pure'
import { afterAll, describe, expect, it } from 'vitest'
import { Agent } from '../src/agent.js'
import { unbag } from '../src/hidden/bags.js'
import { decryptForRegion, regionKeyAt } from '../src/hidden/crypto.js'
import { doorSecretOf, roomKey, roomLookupId } from '../src/hidden/doors.js'
import { bytesToHex, hexToBytes, type NostrEvent } from '../src/nostr/event.js'
import { createServer } from '../src/server.js'
import type { Calibration } from '../src/space/calibration.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork } from './fakeRelay.js'

const vectors = JSON.parse(readFileSync(new URL('./fixtures/deck4-door-vectors.json', import.meta.url), 'utf8'))
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }

/** A small closed box (wire frame), standing for a door's look. */
const SLAB = { v: 2, name: 'slab', unit: 0, mode: 'solid', vertices: [[-1, 0, -1], [1, 0, -1], [1, 3, -1], [-1, 3, -1], [-1, 0, 0], [1, 0, 0], [1, 3, 0], [-1, 3, 0]], colors: [7, 7, 7, 7, 7, 7, 7, 7], faces: [[4, 5, 6], [4, 6, 7], [1, 0, 3], [1, 3, 2], [5, 1, 2], [5, 2, 6], [0, 4, 7], [0, 7, 3], [3, 7, 6], [3, 6, 2], [0, 1, 5], [0, 5, 4]], constrain: 'all' }
const PRIZE = { ...SLAB, name: 'statue' }

describe('the room key, against the spec\'s vectors', () => {
  it('derives locks.room\'s room key and lookup id from its location key and door secret', () => {
    const k = roomKey(hexToBytes(vectors.room.location_key), hexToBytes(vectors.room.door_secret))
    expect(bytesToHex(k)).toBe(vectors.room.room_key)
    expect(roomLookupId(k)).toBe(vectors.room.room_lookup_id)
  })

  it('opens locks.door with its lock secret, reads its door secret, and derives its room', () => {
    const door = vectors.door.event as NostrEvent
    const lock = door.tags.find((t) => t[0] === 'lock')!
    const plaintext = nip44.decrypt(door.content, nip44.utils.getConversationKey(hexToBytes(vectors.door.lock_secret), lock[2]))
    const secret = doorSecretOf(plaintext)
    expect(secret).toBe(vectors.door.door_secret)
    const k = roomKey(hexToBytes(vectors.door.location_key), hexToBytes(secret!))
    expect(bytesToHex(k)).toBe(vectors.door.room_key)
    expect(roomLookupId(k)).toBe(vectors.door.room_lookup_id)
  })
})

describe('seal_door: a door, its room, and what a finder reads', () => {
  const CANONICAL = 'wss://canonical.example'
  const network = new FakeNetwork()
  const relay = network.add(CANONICAL)
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-doors-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(generateSecretKey()), createdAt: 'test' }), { mode: 0o600 })
  const agents: Agent[] = []
  afterAll(async () => { for (const a of agents) await a.stop() })
  const answers: string[] = []

  async function start() {
    const last = agents.pop()
    if (last) await last.stop()
    const a = await Agent.start({ stateDir: dir, relays: [CANONICAL], capCallSeconds: 30, capSessionSeconds: 120, maxSidestepHeight: 24, allowRespawn: false, websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1500, ordersPollMs: 0 } as Parameters<typeof Agent.start>[0])
    agents.push(a)
    const server = createServer(a)
    const [c, s] = InMemoryTransport.createLinkedPair()
    await server.connect(s)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(c)
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args })
      const text = (r.content as Array<{ text?: string }>).map((x) => x.text ?? '').join('\n')
      answers.push(text, JSON.stringify(r.structuredContent ?? {}))
      return { text, data: (r.structuredContent ?? {}) as Record<string, unknown>, isError: !!r.isError }
    }
    return { a, call }
  }

  it('seals a door to a forged key, hides a shard in its room, and a finder holding the key opens both', async () => {
    const { a, call } = await start()
    const here = { dx: 0, dy: 0, dz: 0 }
    const key = await call('forge_item', { name: 'Vault Key', about: 'Opens the vault.', coordinate: { dx: 40, dy: 0, dz: 0 }, height: 5 })
    expect(key.isError, key.text).toBe(false)
    const door = await call('seal_door', { name: 'Vault door', lock: 'Vault Key', room_height: 4, height: 5, coordinate: here, look: { object: SLAB }, open_look: { object: { ...SLAB, name: 'slab open', constrain: 'off' }, turn: 180 } })
    expect(door.isError, door.text).toBe(false)
    expect(door.text).toContain('locked door "Vault door"')
    const placed = await call('place', { object: PRIZE, coordinate: here, height: 4 })
    expect(placed.isError, placed.text).toBe(false)
    expect(placed.text).toContain('inside the room of your door "Vault door"')
    // Outside the room, or at another height, is an ordinary bag.
    const outside = await call('place', { object: { ...PRIZE, name: 'outside' }, coordinate: here, height: 6 })
    expect(outside.text).not.toContain('room of your door')

    // What was published, read with nothing but the key item's secret.
    const mine = relay.all().filter((e) => e.pubkey === a.pubkey && e.kind === 33330)
    const items = JSON.parse(readFileSync(join(dir, 'keys', 'items.json'), 'utf8')).items as Array<{ name: string; secretHex: string }>
    const keySecret = items.find((i) => i.name === 'Vault Key')!.secretHex
    const pos = (a as unknown as { keeper: { place(): { position: { x: bigint; y: bigint; z: bigint }; plane: 0 | 1 } } }).keeper.place().position
    const h5 = regionKeyAt(pos, 5, 16)
    const outer = mine.find((e) => e.tags.some((t) => t[0] === 'd' && t[1] === h5.lookupId))!
    const outerItems = await unbag(outer, h5.key, async () => null, { at: pos, plane: (a as unknown as { keeper: { place(): { position: { x: bigint; y: bigint; z: bigint }; plane: 0 | 1 } } }).keeper.place().plane }, 5)
    const found = outerItems.find((h) => h.type === 'chest')!
    expect(found).toBeTruthy()
    const tags = found.inner.tags
    // ONOSENDAI's order (its chestInnerTemplate), then the client tag every item this server signs carries.
    expect(tags.map((t) => t[0]).filter((n) => n !== 'client')).toEqual(['C', 'title', 'lock', 'requires', 'look', 'look', 'door', '-'])
    expect(tags.find((t) => t[0] === 'door')).toEqual(['door', '4'])
    expect(tags.filter((t) => t[0] === 'look').map((t) => t.length)).toEqual([2, 3])
    expect(JSON.parse(tags.find((t) => t[0] === 'look' && t.length === 3)![1]).constrain).toBe('off')
    const lock = tags.find((t) => t[0] === 'lock')!
    const secret = doorSecretOf(nip44.decrypt(found.inner.content, nip44.utils.getConversationKey(hexToBytes(keySecret), lock[2])))
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    const rk = roomKey(regionKeyAt(pos, 4, 16).key, hexToBytes(secret!))
    const roomBag = mine.find((e) => e.tags.some((t) => t[0] === 'd' && t[1] === roomLookupId(rk)))!
    expect(roomBag, 'the room bag').toBeTruthy()
    expect(roomBag.content).toBe('')
    // Only the required tags (and the client tag ONOSENDAI's room bags carry too).
    expect(roomBag.tags.map((t) => t[0]).filter((n) => n !== 'client')).toEqual(['d', 'encrypted', 'version'])
    const inRoom = await unbag(roomBag, rk, async () => null, { at: pos, plane: (a as unknown as { keeper: { place(): { position: { x: bigint; y: bigint; z: bigint }; plane: 0 | 1 } } }).keeper.place().plane }, 4)
    expect(inRoom.map((h) => (h.shard?.name ?? h.type))).toEqual(['statue'])
    // The ordinary h4 bag at that place holds nothing of the room.
    const h4 = regionKeyAt(pos, 4, 16)
    expect(mine.some((e) => e.tags.some((t) => t[0] === 'd' && t[1] === h4.lookupId))).toBe(false)

    // The secret: kept in the state directory (mode 600), never in an answer.
    const kept = JSON.parse(readFileSync(join(dir, 'keys', 'doors.json'), 'utf8'))
    expect(kept.doors[0].secret).toBe(secret)
    expect(statSync(join(dir, 'keys', 'doors.json')).mode & 0o077).toBe(0)
    for (const t of answers) expect(t).not.toContain(secret!)
  })

  it('reuses the room\'s secret for a second door of the same room, and refuses what a room cannot hold', async () => {
    const { call } = await start()
    const second = await call('seal_door', { name: 'Back door', lock: 'Vault Key', room_height: 4, height: 5, coordinate: { dx: 0, dy: 0, dz: 0 } })
    expect(second.isError, second.text).toBe(false)
    const kept = JSON.parse(readFileSync(join(dir, 'keys', 'doors.json'), 'utf8')).doors as Array<{ secret: string }>
    expect(kept).toHaveLength(2)
    expect(kept[1].secret).toBe(kept[0].secret)
    expect((await call('seal_door', { name: 'Too big', lock: 'Vault Key', room_height: 6, height: 5 })).text).toMatch(/REFUSED: room_height must be a whole number from 1 to the height of the bag/)
    expect((await call('hide', { contents: { message: 'hello' }, coordinate: { dx: 0, dy: 0, dz: 0 }, height: 4, riddle: 'who?' })).text).toMatch(/REFUSED: This place is inside the room of your door/)
    // A door of the same room hidden at the room's own height stands in the ordinary bag, beside the first, with the same secret (§3.7.5).
    const same = await call('seal_door', { name: 'Side door', lock: 'Vault Key', room_height: 4, height: 4 })
    expect(same.isError, same.text).toBe(false)
    expect(same.text).not.toContain('room of your door')
    // A smaller door inside the room goes into the room bag (§3.7.6).
    const inner = await call('seal_door', { name: 'Inner door', lock: 'Vault Key', room_height: 3, height: 4 })
    expect(inner.text).toContain('inside the room of your door')
    const doors = JSON.parse(readFileSync(join(dir, 'keys', 'doors.json'), 'utf8')).doors as Array<{ name: string; secret: string; plane: number }>
    expect(doors.find((d) => d.name === 'Side door')!.secret).toBe(doors[0].secret)
    expect(doors.find((d) => d.name === 'Inner door')!.secret).not.toBe(doors[0].secret)
  })

  it('keeps a room\'s things in it: a move inside stays in the room bag, a move out is refused, a reference placed there joins it, and the twin plane gets its own secret', async () => {
    const { a, call } = await start()
    const pos = (a as unknown as { keeper: { place(): { position: { x: bigint; y: bigint; z: bigint }; plane: 0 | 1 } } }).keeper.place()
    // A move inside the room (one gibson, staying in the same h4 cube): the statue stays in the room bag.
    const step = pos.position.x % 16n < 15n ? 1 : -1
    const within = await call('move_placed', { target: 'statue', by: { dx: step } })
    expect(within.isError, within.text).toBe(false)
    expect(within.data.lookupId ?? within.text).not.toBe(regionKeyAt(pos.position, 4, 16).lookupId)
    const out = await call('move_placed', { target: 'statue', to: { dx: 0, dy: 0, dz: 0 }, height: 6 })
    expect(out.text).toMatch(/REFUSED: .*inside one of your locked rooms/)
    const pub = await call('publish_object', { object: { ...PRIZE, name: 'public statue' } })
    expect(pub.isError, pub.text).toBe(false)
    const ref = await call('place', { address: (pub.data as { address: string }).address, coordinate: { dx: 0, dy: 0, dz: 0 }, height: 4 })
    expect(ref.isError, ref.text).toBe(false)
    const doors = JSON.parse(readFileSync(join(dir, 'keys', 'doors.json'), 'utf8')).doors as Array<{ name: string; secret: string; roomLookupId?: string }>
    const roomLookup = doors[0].roomLookupId!
    expect(roomLookup).toMatch(/^[0-9a-f]{64}$/)
    const roomBag = relay.all().find((e) => e.kind === 33330 && e.tags.some((t) => t[0] === 'd' && t[1] === roomLookup))!
    const rk = roomKey(regionKeyAt(pos.position, 4, 16).key, hexToBytes(doors[0].secret))
    const entries = JSON.parse((await decryptForRegion(rk, roomBag.tags.find((t) => t[0] === 'encrypted')![2]))!) as unknown[]
    // The statue, the inner door, and the reference to the public statue.
    expect(entries.some((e) => Array.isArray(e) && e[0] === 'a' && String(e[1]).startsWith('33331:'))).toBe(true)
    expect(entries.length).toBe(3)
    // The twin region in the other plane is another room, with another secret.
    const other = pos.plane === 0 ? 1 : 0
    const twin = await call('seal_door', { name: 'Twin door', lock: 'Vault Key', room_height: 4, height: 5, coordinate: { x: pos.position.x.toString(), y: pos.position.y.toString(), z: pos.position.z.toString(), plane: other } })
    expect(twin.isError, twin.text).toBe(false)
    const after = JSON.parse(readFileSync(join(dir, 'keys', 'doors.json'), 'utf8')).doors as Array<{ name: string; secret: string }>
    expect(after.find((d) => d.name === 'Twin door')!.secret).not.toBe(after[0].secret)
  })

  it('removes a door of several, but not the last door of a room that still holds things', async () => {
    const { call } = await start()
    expect((await call('remove_placed', { target: 'Back door' })).isError).toBe(false)
    expect((await call('remove_placed', { target: 'Side door' })).isError).toBe(false)
    const last = await call('remove_placed', { target: 'Vault door' })
    expect(last.text).toMatch(/REFUSED: "Vault door" is the last door of its room/)
    const names = (JSON.parse(readFileSync(join(dir, 'keys', 'doors.json'), 'utf8')).doors as Array<{ name: string }>).map((d) => d.name)
    expect(names).toContain('Vault door')
    expect(names).not.toContain('Back door')
  })
})
