// doorsInterop.test.ts: a locked door this server wrote, opened by
// ONOSENDAI's own reader. test/fixtures/xor-door.json is the door as
// cyberspace-mcp publishes it (scripts/gen-door-fixture.ts: a throwaway
// agent, key and door on the in-memory relay); test/fixtures/
// onosendai-door-read.json is what ONOSENDAI's code read from exactly that
// file (scripts/check-door-in-onosendai.ts, run in ONOSENDAI's origin/v2:
// lib/hidden.ts unbag, lib/looks.ts isDoor, doorHeightOf, lookTagsOf,
// lib/doors.ts doorRefusal, doorSecretWithKey, roomKey, roomLookupId). This
// test holds the two together, so a change to how doors are written fails
// here until both are generated again and ONOSENDAI still opens it.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { v2 as nip44 } from 'nostr-tools/nip44'
import { describe, expect, it } from 'vitest'
import { unbag } from '../src/hidden/bags.js'
import { doorSecretOf, roomKey, roomLookupId } from '../src/hidden/doors.js'
import { hexToBytes, type NostrEvent } from '../src/nostr/event.js'

const text = readFileSync(new URL('./fixtures/xor-door.json', import.meta.url), 'utf8')
const fx = JSON.parse(text)
const read = JSON.parse(readFileSync(new URL('./fixtures/onosendai-door-read.json', import.meta.url), 'utf8'))

describe('a door cyberspace-mcp wrote, opened by ONOSENDAI', () => {
  it('was read by ONOSENDAI from exactly this fixture, and every check passed', () => {
    expect(read.fixtureSha256).toBe(createHash('sha256').update(text).digest('hex'))
    expect(read.ok).toBe(true)
    expect(read.checks.length).toBeGreaterThanOrEqual(9)
    expect(read.read).toMatchObject({ doorHeight: fx.roomHeight, closedLook: fx.expect.closedLook, openLook: fx.expect.openLook, roomEntries: fx.expect.roomEntries })
  })

  it('opens the same way here: the key gives the secret, the secret and the place give the room ONOSENDAI found', async () => {
    const at = { x: BigInt(fx.at.x), y: BigInt(fx.at.y), z: BigInt(fx.at.z) }
    const outer = await unbag(fx.outerBag as NostrEvent, hexToBytes(fx.outerLocationKey), async () => null, { at, plane: fx.plane }, fx.bagHeight)
    const door = outer.find((h) => h.type === 'chest')!
    const lock = door.inner.tags.find((t: string[]) => t[0] === 'lock')!
    const secret = doorSecretOf(nip44.decrypt(door.inner.content, nip44.utils.getConversationKey(hexToBytes(fx.keyItem.secretHex), lock[2])))!
    const lookup = roomLookupId(roomKey(hexToBytes(fx.roomLocationKey), hexToBytes(secret)))
    expect(lookup).toBe(read.read.roomLookupId)
  })
})
