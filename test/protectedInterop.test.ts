// protectedInterop.test.ts: the rules of 2026-10-20 (arkinox, "1 plus 2"),
// against ONOSENDAI. fixtures/onosendai-protected.json was made with
// ONOSENDAI's own code (#409, scripts/gen-onosendai-protected-fixture.ts):
// its inner templates, its rumor of a message and its moves, a bag it sealed,
// what its readers made of that bag, and what its readers made of a bag this
// server's code wrote. Every item sealed in a bag or a chest carries NIP-70
// `-`; a hidden message is a rumor (an id, no sig) vouched for by the bag or
// the chest that holds it; a signed message from before still reads.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getEventHash } from 'nostr-tools/pure'
import {
  chestInnerTemplate, editedTemplate, innerAuthentic, isProtectedTags, itemLineage, keyInnerTemplate, messageInnerTemplate, rumorOf, shardInnerTemplate, unbag,
  type ChestItem, type KeyItem, type Rumor,
} from '../src/hidden/bags.js'
import { forgeKey, openWithSecret, readContents, sealEntries } from '../src/hidden/chests.js'
import { hexToBytes, type EventTemplate, type NostrEvent } from '../src/nostr/event.js'
import type { ShardModel } from 'sno-core/shards'
import { fromPayload } from 'sno-core/shards'

interface Row { type: string; id: string; author: string; signed: boolean; protected: boolean; label: string }
interface Fixture {
  agent: string; hider: string; height: number; regionKeyHex: string; at: { x: string; y: string; z: string; plane: 0 | 1 }
  brassSecretHex: string; copperSecretHex: string
  templates: { shard: EventTemplate; message: EventTemplate; messageRumor: Rumor; key: EventTemplate; chest: EventTemplate; chestInput: ChestItem; keyInput: KeyItem; edited: Array<{ name: string; next: EventTemplate; previous: { id: string; kind: number; tags: string[][] }; onosendai: EventTemplate }> }
  bag: NostrEvent
  onosendaiRead: { items: Row[]; vault: Array<{ type: string; id: string; verified: boolean; text: string | null }> }
  mcpBag: NostrEvent
  reverse: { items: Array<Row & { lineage: string | null }>; chest: Array<{ type: string; verified: boolean; text: string | null }>; movedLineage: string }
}

const fx = JSON.parse(readFileSync(new URL('./fixtures/onosendai-protected.json', import.meta.url), 'utf8')) as Fixture
const at = { x: BigInt(fx.at.x), y: BigInt(fx.at.y), z: BigInt(fx.at.z) }
const plane = fx.at.plane
const T = fx.templates.message.created_at
const shard = fromPayload(JSON.parse(readFileSync(new URL('./fixtures/xor-stella-octangula.json', import.meta.url), 'utf8')), 'x'.repeat(64)) as ShardModel
const key = hexToBytes(fx.regionKeyHex)

describe('templates, against ONOSENDAI #409', () => {
  it('shard, message, key and chest are ONOSENDAI\'s, tag for tag, each with `-` once', () => {
    // The fixture is from ONOSENDAI #409, before #476 wrote the WALK default
    // ("constrain": "opaque", DECK-0003 1.12) at the end of every shard it
    // hides: tag for tag the same, and the payload the same but for that
    // field. constrainInterop.test.ts pins the payload against #476 itself.
    expect(shardInnerTemplate(shard, at, plane, T)).toEqual({ ...fx.templates.shard, content: `${fx.templates.shard.content.slice(0, -1)},"constrain":"opaque"}` })
    expect(messageInnerTemplate('A fixed message.', at, plane, T)).toEqual(fx.templates.message)
    expect(keyInnerTemplate(fx.templates.keyInput, at, plane, T)).toEqual(fx.templates.key)
    expect(chestInnerTemplate(fx.templates.chestInput, at, plane, T)).toEqual(fx.templates.chest)
    for (const t of [fx.templates.shard, fx.templates.message, fx.templates.key, fx.templates.chest]) expect(t.tags.filter((x) => x[0] === '-')).toHaveLength(1)
  })

  it('a message rumor is ONOSENDAI\'s: same id, no sig', () => {
    const r = rumorOf(messageInnerTemplate('A fixed message.', at, plane, T), fx.hider)
    expect(r).toEqual(fx.templates.messageRumor)
    expect('sig' in r).toBe(false)
    expect(r.id).toBe(getEventHash({ kind: r.kind, created_at: r.created_at, tags: r.tags, content: r.content, pubkey: r.pubkey }))
  })

  it('a move is ONOSENDAI\'s: `-` gained once by a version that lacked it, never twice, lineage kept', () => {
    for (const c of fx.templates.edited) {
      const t = editedTemplate(c.next, c.previous)
      expect(t, c.name).toEqual(c.onosendai)
      expect(t.tags.filter((x) => x[0] === '-'), c.name).toHaveLength(1)
      expect(t.tags.find((x) => x[0] === 'd')?.[1], c.name).toBe(c.previous.id)
    }
  })
})

describe('ONOSENDAI\'s bag, read here', () => {
  it('reads exactly what ONOSENDAI read: a rumor message, a shard, a key, a chest, and a signed message from before', async () => {
    const items = await unbag(fx.bag, key, undefined, undefined, fx.height)
    expect(items.map((h) => ({
      type: h.type, id: h.eventId, author: h.author, signed: typeof h.inner.sig === 'string' && h.inner.sig.length > 0, protected: isProtectedTags(h.inner.tags), label: h.text ?? h.shard?.name ?? h.key?.name ?? h.chest?.name,
    }))).toEqual(fx.onosendaiRead.items)
    // The rumor is the hider's: the bag vouches for it.
    expect(fx.onosendaiRead.items.filter((i) => i.type === 'message').map((i) => [i.signed, i.protected])).toEqual([[false, true], [true, false]])
  })

  it('opens ONOSENDAI\'s chest to what ONOSENDAI read: its rumor vouched for by the chest, its legacy message and key by their signatures', async () => {
    const items = await unbag(fx.bag, key, undefined, undefined, fx.height)
    const vault = items.find((h) => h.type === 'chest')!
    const raw = openWithSecret(vault.chest!, fx.brassSecretHex)
    const read = readContents(raw, vault.inner.pubkey)
    expect(read.map((c) => ({ type: c.body.type, id: c.id, verified: c.verified, text: c.body.text ?? null }))).toEqual(fx.onosendaiRead.vault)
    // With nobody to vouch for it, the rumor's author is a claim.
    expect(readContents(raw).map((c) => c.verified)).toEqual([false, true, true])
  })
})

describe('this server\'s bag, read by ONOSENDAI', () => {
  it('ONOSENDAI read every entry: two rumor messages (one a moved legacy note keeping its lineage), a signed key and a signed chest, all with `-`', () => {
    expect(fx.reverse.items.map((i) => `${i.type}:${i.signed ? 'signed' : 'rumor'}:${i.protected ? '-' : ''}`)).toEqual(['message:rumor:-', 'key:signed:-', 'chest:signed:-', 'message:rumor:-'])
    expect(fx.reverse.items.every((i) => i.author === fx.agent)).toBe(true)
    expect(fx.reverse.items[3].lineage).toBe(fx.reverse.movedLineage)
    expect(fx.reverse.chest).toEqual([{ type: 'message', verified: true, text: 'Sealed by the agent.' }, { type: 'shard', verified: true, text: null }])
  })

  it('and this server reads its own bag the same way', async () => {
    const items = await unbag(fx.mcpBag, key, undefined, undefined, fx.height)
    expect(items.map((h) => h.type)).toEqual(fx.reverse.items.map((i) => i.type))
    expect(items.map((h) => h.eventId)).toEqual(fx.reverse.items.map((i) => i.id))
    expect(itemLineage(items[3].inner)).toBe(fx.reverse.movedLineage)
  })
})

describe('the reader rules, here as in ONOSENDAI', () => {
  const r = rumorOf(messageInnerTemplate('x', at, plane, T), fx.agent)
  it('a rumor must be a message by the bag signer whose id is its hash; anything with a sig must verify', () => {
    expect(innerAuthentic(r, fx.agent)).toBe(true)
    expect(innerAuthentic({ ...r, sig: '' }, fx.agent)).toBe(true)
    expect(innerAuthentic(r, fx.hider)).toBe(false)
    expect(innerAuthentic({ ...r, id: 'ff'.repeat(32) }, fx.agent)).toBe(false)
    expect(innerAuthentic({ ...r, content: 'changed' }, fx.agent)).toBe(false)
    expect(innerAuthentic({ ...r, sig: '00'.repeat(64) }, fx.agent)).toBe(false)
    expect(innerAuthentic(rumorOf(shardInnerTemplate(shard, at, plane, T), fx.agent), fx.agent)).toBe(false)
  })

  it('a chest vouches only for a message rumor of its own signer, with its own id', () => {
    const lock = forgeKey('Lock')
    const mine = rumorOf(messageInnerTemplate('mine', at, plane, T), fx.agent)
    const theirs = rumorOf(messageInnerTemplate('theirs', at, plane, T), fx.hider)
    const badId = { ...rumorOf(messageInnerTemplate('bad id', at, plane, T), fx.agent), id: 'ee'.repeat(32) }
    const keyRumor = rumorOf(keyInnerTemplate(lock, at, plane, T), fx.agent)
    const raw = openWithSecret({ ...sealEntries([mine, theirs, badId, keyRumor], lock.itemPubkey) }, lock.secretHex)
    expect(readContents(raw, fx.agent).map((c) => [c.body.text ?? c.body.type, c.verified])).toEqual([['mine', true], ['theirs', false], ['bad id', false], ['key', false]])
    expect(readContents(raw).every((c) => !c.verified)).toBe(true)
  })
})
