// Opens test/fixtures/xor-door.json (a locked door cyberspace-mcp wrote,
// scripts/gen-door-fixture.ts) with ONOSENDAI's own code, as a finder in
// ONOSENDAI opens it: unbag the outer bag (lib/hidden.ts unbag), take the
// door (lib/looks.ts isDoor, doorHeightOf, lookTagsOf; lib/doors.ts
// doorRefusal), open it with the key item's secret (lib/doors.ts
// doorSecretWithKey), derive the room key and lookup id (roomKey,
// roomLookupId), find the room bag by its d and the door's author, and unbag
// it with the room key (store/rooms.ts openRoom does the same). Writes what
// ONOSENDAI read to test/fixtures/onosendai-door-read.json, with the
// fixture's sha256, for test/doorsInterop.test.ts.
//
// Run from a copy of ONOSENDAI's origin/v2 source (so ./src/lib resolves to
// ONOSENDAI), with this repository's tsx:
//   cp scripts/check-door-in-onosendai.ts <onosendai>/check-door.ts
//   (cd <onosendai> && <mcp>/node_modules/.bin/tsx check-door.ts <mcp>/test/fixtures/xor-door.json <mcp>/test/fixtures/onosendai-door-read.json <onosendai commit>)
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { unbag } from './src/lib/hidden'
import { doorRefusal, doorSecretWithKey, regionBase, roomKey, roomLookupId } from './src/lib/doors'
import { doorHeightOf, isDoor, lookTagsOf } from './src/lib/looks'

const [FIXTURE, OUT, COMMIT] = process.argv.slice(2)
const text = readFileSync(FIXTURE, 'utf8')
const fx = JSON.parse(text)
const hex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'))
const at = { x: BigInt(fx.at.x), y: BigInt(fx.at.y), z: BigInt(fx.at.z) }
const checks: Array<{ check: string; ok: boolean; detail?: string }> = []
const check = (name: string, ok: boolean, detail?: string) => { checks.push({ check: name, ok, ...(detail ? { detail } : {}) }) }

const outer = await unbag(fx.outerBag, hex(fx.outerLocationKey), async () => null, { at: regionBase(at, fx.bagHeight), plane: fx.plane }, fx.bagHeight)
const door = outer.find((h) => h.type === 'chest' && isDoor(h.inner?.tags))
check('ONOSENDAI finds a door in the outer bag', !!door)
const tags = door?.inner?.tags ?? []
const height = doorHeightOf(tags)
check('its door height', height === fx.roomHeight, String(height))
check('ONOSENDAI keeps it (doorRefusal is null)', doorRefusal(tags, fx.bagHeight, null) === null)
const looks = lookTagsOf(tags, door?.author ?? null)
check('its closed look', looks.closed?.name === fx.expect.closedLook, looks.closed?.name)
check('its open look', looks.open?.name === fx.expect.openLook, looks.open?.name)
check('its title', door?.chest?.name === fx.expect.door, door?.chest?.name)
let secret: string | null = null
try { secret = door?.chest ? doorSecretWithKey(door.chest, fx.keyItem.secretHex) : null } catch { secret = null }
check('the key item opens it and gives a door secret', !!secret && /^[0-9a-f]{64}$/.test(secret))
const rk = secret ? roomKey(hex(fx.roomLocationKey), hex(secret)) : null
const lookup = rk ? roomLookupId(rk) : ''
const roomBag = (fx.bags as Array<{ pubkey: string; tags: string[][] }>).find((e) => e.pubkey === door?.author && e.tags.some((t) => t[0] === 'd' && t[1] === lookup))
check('the room bag is there, by its d and the door\'s author', !!roomBag)
const inRoom = roomBag && rk ? await unbag(roomBag as never, rk, async () => null, { at: regionBase(at, fx.roomHeight), plane: fx.plane }, fx.roomHeight, undefined, { doorId: door!.eventId }) : []
const names = inRoom.filter((h) => h.plane === fx.plane).map((h) => h.shard?.name ?? h.type)
check('the room bag opens with the room key and holds what was hidden there', JSON.stringify(names) === JSON.stringify(fx.expect.roomEntries), JSON.stringify(names))

const result = {
  note: 'What ONOSENDAI\'s own reader read from test/fixtures/xor-door.json (scripts/check-door-in-onosendai.ts).',
  onosendai: COMMIT ?? 'unknown',
  fixtureSha256: createHash('sha256').update(text).digest('hex'),
  ok: checks.every((c) => c.ok),
  checks,
  read: { doorHeight: height, closedLook: looks.closed?.name ?? null, openLook: looks.open?.name ?? null, roomLookupId: lookup, roomEntries: names },
}
writeFileSync(OUT, JSON.stringify(result, null, 1) + '\n')
console.log(`${result.ok ? 'OK' : 'FAILED'}: ${checks.filter((c) => c.ok).length} of ${checks.length} checks`)
for (const c of checks) if (!c.ok) console.log(`  failed: ${c.check} ${c.detail ?? ''}`)
process.exit(result.ok ? 0 : 1)
