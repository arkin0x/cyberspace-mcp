// Generates test/fixtures/xor-door.json: a locked door as this server writes
// it (DECK-0004 §3.7), for ONOSENDAI's own reader to open
// (scripts/check-door-in-onosendai.ts) and for test/doorsInterop.test.ts.
// A throwaway agent on the in-memory relay forges a key, seals a door to it
// with a closed and an open look, and places a shard in the door's room;
// the fixture keeps the published bags, the key item's secret (throwaway,
// as a finder would hold it) and the two location keys a finder derives.
// Nothing touches the network.
//
//   npx tsx scripts/gen-door-fixture.ts test/fixtures/xor-door.json
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { generateSecretKey } from 'nostr-tools/pure'
import { Agent } from '../src/agent.js'
import { regionKeyAt } from '../src/hidden/crypto.js'
import { bytesToHex } from '../src/nostr/event.js'
import { createServer } from '../src/server.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork } from '../test/fakeRelay.js'
import { readFileSync } from 'node:fs'

const OUT = process.argv[2] ?? 'test/fixtures/xor-door.json'
const CANONICAL = 'wss://canonical.example'
const network = new FakeNetwork()
const relay = network.add(CANONICAL)
const dir = mkdtempSync(join(tmpdir(), 'gen-door-'))
StateDir.open(dir)
writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(generateSecretKey()), createdAt: 'fixture' }), { mode: 0o600 })
const a = await Agent.start({ stateDir: dir, relays: [CANONICAL], capCallSeconds: 30, capSessionSeconds: 120, maxSidestepHeight: 24, allowRespawn: false, websocketImplementation: network.WebSocket, calibration: { version: 1, at: Date.now(), fingerprint: 'fixture', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }, relayMaxWaitMs: 1500, ordersPollMs: 0 } as Parameters<typeof Agent.start>[0])
const server = createServer(a)
const [c, s] = InMemoryTransport.createLinkedPair()
await server.connect(s)
const client = new Client({ name: 'gen', version: '0' })
await client.connect(c)
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args })
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`)
}
const box = (name: string, constrain: string) => ({ v: 2, name, unit: 0, mode: 'solid', vertices: [[-1, 0, -1], [1, 0, -1], [1, 3, -1], [-1, 3, -1], [-1, 0, 0], [1, 0, 0], [1, 3, 0], [-1, 3, 0]], colors: [7, 7, 7, 7, 7, 7, 7, 7], faces: [[4, 5, 6], [4, 6, 7], [1, 0, 3], [1, 3, 2], [5, 1, 2], [5, 2, 6], [0, 4, 7], [0, 7, 3], [3, 7, 6], [3, 6, 2], [0, 1, 5], [0, 5, 4]], constrain })

await call('forge_item', { name: 'Vault Key', about: 'Opens the vault.', coordinate: { dx: 40, dy: 0, dz: 0 }, height: 5 })
await call('seal_door', { name: 'Vault door', lock: 'Vault Key', room_height: 4, height: 5, coordinate: { dx: 0, dy: 0, dz: 0 }, look: { object: box('slab', 'all') }, open_look: { object: box('slab open', 'off'), turn: 180 } })
await call('place', { object: box('statue', 'all'), coordinate: { dx: 0, dy: 0, dz: 0 }, height: 4 })

const place = (a as unknown as { keeper: { place(): { position: { x: bigint; y: bigint; z: bigint }; plane: 0 | 1 } } }).keeper.place()
const items = JSON.parse(readFileSync(join(dir, 'keys', 'items.json'), 'utf8')).items as Array<{ name: string; secretHex: string; itemPubkey: string }>
const key = items.find((i) => i.name === 'Vault Key')!
const h5 = regionKeyAt(place.position, 5, 16), h4 = regionKeyAt(place.position, 4, 16)
const bags = relay.all().filter((e) => e.pubkey === a.pubkey && e.kind === 33330)
const outer = bags.find((e) => e.tags.some((t) => t[0] === 'd' && t[1] === h5.lookupId))!
const fixture = {
  note: 'A locked door written by cyberspace-mcp (scripts/gen-door-fixture.ts): throwaway keys, nothing published.',
  agent: a.pubkey,
  at: { x: place.position.x.toString(), y: place.position.y.toString(), z: place.position.z.toString() },
  plane: place.plane,
  keyItem: { name: key.name, itemPubkey: key.itemPubkey, secretHex: key.secretHex },
  bagHeight: 5,
  roomHeight: 4,
  outerLocationKey: bytesToHex(h5.key),
  roomLocationKey: bytesToHex(h4.key),
  outerBag: outer,
  bags: bags.filter((e) => e !== outer),
  expect: { door: 'Vault door', closedLook: 'slab', openLook: 'slab open', roomEntries: ['statue'] },
}
writeFileSync(OUT, JSON.stringify(fixture, null, 1) + '\n')
await a.stop()
console.log(`wrote ${OUT}`)
process.exit(0)
