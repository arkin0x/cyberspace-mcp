// bags.test.ts: sealing to a region and opening again, the chat envelope
// (after ONOSENDAI's chatBag.test.ts), the one-bag-per-region merge, and an
// object hidden by reference.

import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { newShard } from 'sno-core/shards'
import {
  CHAT_BAG_KIND, CHAT_KIND, HIDDEN_KIND, KEY_KIND, bagEntries, bagSettingsOf, bagTemplate, heightHint, chatInnerTemplate, chatInners, chatRumor, chestInnerTemplate, chestItemOf, ciphertextOf,
  keyInnerTemplate, keyItemOf, messageInnerTemplate, objectTemplate, readItem, referenceTo, unbag, entryKey,
} from '../src/hidden/bags.js'
import { forgeKey, openWithSecret, openerFor, readContents, sealEntries } from '../src/hidden/chests.js'
import { decryptForRegion, encryptForRegion } from '../src/hidden/crypto.js'
import { bytesToHex, signEvent } from '../src/nostr/event.js'

const key = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)
const at = { x: 1n << 40n, y: 5n, z: 9n }
const lookup = 'aa'.repeat(32)

async function said(text: string, sk = generateSecretKey()) {
  const inner = chatRumor(chatInnerTemplate(text, at, 0, 1_700_000_000, lookup), getPublicKey(sk))
  const outer = signEvent(await bagTemplate([inner], key, lookup, 12, 1_700_000_000, CHAT_BAG_KIND), sk)
  return { inner, outer, sk }
}

describe('the cipher', () => {
  it('round-trips and stays shut to the wrong key', async () => {
    const ct = await encryptForRegion(key, 'chalk')
    expect(await decryptForRegion(key, ct)).toBe('chalk')
    expect(await decryptForRegion(new Uint8Array(32), ct)).toBeNull()
  })
})

describe('the height tag: H, read with a fallback to a legacy h (spec 8.6)', () => {
  const ev = (...height: string[][]) => ({ tags: [['d', lookup], ['version', '2'], ...height] })

  it('a bag writes H, never h', async () => {
    const bag = await bagTemplate([], key, lookup, 7, 1, HIDDEN_KIND)
    expect(bag.tags).toContainEqual(['H', '7'])
    expect(bag.tags.some((t) => t[0] === 'h')).toBe(false)
    const quiet = await bagTemplate([], key, lookup, 7, 1, HIDDEN_KIND, { heightTag: false, hint: null, riddle: '' })
    expect(quiet.tags.some((t) => t[0] === 'H' || t[0] === 'h')).toBe(false)
  })

  it('reads H', () => {
    expect(heightHint(ev(['H', '6']))).toBe(6)
  })

  it('reads a legacy h when there is no H', () => {
    expect(heightHint(ev(['h', '7']))).toBe(7)
  })

  it('reads H alone when both are present, whatever h says', () => {
    expect(heightHint(ev(['h', '7'], ['H', '6']))).toBe(6)
    expect(heightHint(ev(['H', '6'], ['h', '7']))).toBe(6)
    expect(heightHint(ev(['H', '06'], ['h', '7']))).toBeNull()
    expect(heightHint(ev(['H'], ['h', '7']))).toBeNull()
  })

  it('states no height when there is neither, or the tag it reads appears twice', () => {
    expect(heightHint(ev())).toBeNull()
    expect(heightHint(ev(['H', '6'], ['H', '6']))).toBeNull()
    expect(heightHint(ev(['h', '7'], ['h', '7']))).toBeNull()
  })

  it('a bag that said its height with h opens at it, and is rewritten with H', async () => {
    const sk = generateSecretKey()
    const ct = await encryptForRegion(key, '[]')
    const old = signEvent({ kind: HIDDEN_KIND, created_at: 1, content: '', tags: [['d', lookup], ['encrypted', 'aes-256-gcm', ct], ['version', '2'], ['h', '7']] }, sk)
    const settings = bagSettingsOf(old, 7)
    expect(settings.heightTag).toBe(true)
    const next = await bagTemplate([], key, lookup, 7, 2, HIDDEN_KIND, settings)
    expect(next.tags).toContainEqual(['H', '7'])
    expect(next.tags.some((t) => t[0] === 'h')).toBe(false)
  })
})

describe('the ephemeral envelope', () => {
  it('is a 33330 in everything but the kind', async () => {
    const { outer } = await said('hello')
    expect(outer.kind).toBe(CHAT_BAG_KIND)
    expect(outer.tags.find((t) => t[0] === 'd')?.[1]).toBe(lookup)
    expect(outer.tags.find((t) => t[0] === 'H')?.[1]).toBe('12')
    expect(outer.tags.some((t) => t[0] === 'h')).toBe(false)
    expect(ciphertextOf(outer)).not.toBeNull()
  })

  it('opens with the region key and gives back the line', async () => {
    const { inner, outer } = await said('is anyone here')
    const lines = await chatInners(outer, key)
    expect(lines).toHaveLength(1)
    expect(lines[0].id).toBe(inner.id)
    expect(lines[0].kind).toBe(CHAT_KIND)
  })

  it('stays shut to the wrong key', async () => {
    const { outer } = await said('secret')
    expect(await chatInners(outer, new Uint8Array(32).map((_, i) => (i * 11 + 1) & 0xff))).toHaveLength(0)
  })

  it('refuses a line wrapped by someone who did not sign it', async () => {
    const speaker = generateSecretKey()
    const wrapper = generateSecretKey()
    const inner = chatRumor(chatInnerTemplate('not mine to carry', at, 0, 1, lookup), getPublicKey(speaker))
    const outer = signEvent(await bagTemplate([inner], key, lookup, 12, 1, CHAT_BAG_KIND), wrapper)
    expect(getPublicKey(speaker)).not.toBe(outer.pubkey)
    expect(await chatInners(outer, key)).toHaveLength(0)
  })

  it('caps a line at the chat length', () => {
    expect(chatInnerTemplate('x'.repeat(2000), at, 0, 1, lookup).content).toHaveLength(500)
  })

  it('seals the line as a rumor: an id, no signature (arkinox, 2026-10-13)', async () => {
    const { inner } = await said('no proof of me')
    expect('sig' in inner).toBe(false)
    expect(inner.id).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a rumor whose id is not its own hash', async () => {
    const sk = generateSecretKey()
    const inner = { ...chatRumor(chatInnerTemplate('forged id', at, 0, 1, lookup), getPublicKey(sk)), id: 'ff'.repeat(32) }
    const outer = signEvent(await bagTemplate([inner], key, lookup, 12, 1, CHAT_BAG_KIND), sk)
    expect(await chatInners(outer, key)).toHaveLength(0)
  })

  it('still reads a signed line from an older client, when its signature holds', async () => {
    const sk = generateSecretKey()
    const inner = signEvent(chatInnerTemplate('from before', at, 0, 1, lookup), sk)
    const outer = signEvent(await bagTemplate([inner], key, lookup, 12, 1, CHAT_BAG_KIND), sk)
    const lines = await chatInners(outer, key)
    expect(lines).toHaveLength(1)
    expect(lines[0].id).toBe(inner.id)
  })

  it('reads a line whose sig is the empty string as a rumor (DECK-0005 §3.2 rule 5)', async () => {
    const sk = generateSecretKey()
    const inner = { ...chatRumor(chatInnerTemplate('empty is none', at, 0, 1, lookup), getPublicKey(sk)), sig: '' }
    const outer = signEvent(await bagTemplate([inner], key, lookup, 12, 1, CHAT_BAG_KIND), sk)
    const lines = await chatInners(outer, key)
    expect(lines).toHaveLength(1)
    expect(lines[0].id).toBe(inner.id)
    expect(lines[0].pubkey).toBe(outer.pubkey)
  })

  it('still refuses an empty-sig line whose id is not its own hash', async () => {
    const sk = generateSecretKey()
    const inner = { ...chatRumor(chatInnerTemplate('forged', at, 0, 1, lookup), getPublicKey(sk)), id: 'ff'.repeat(32), sig: '' }
    const outer = signEvent(await bagTemplate([inner], key, lookup, 12, 1, CHAT_BAG_KIND), sk)
    expect(await chatInners(outer, key)).toHaveLength(0)
  })

  it('still refuses an empty-sig line wrapped by someone who did not say it', async () => {
    const speaker = generateSecretKey()
    const inner = { ...chatRumor(chatInnerTemplate('not mine', at, 0, 1, lookup), getPublicKey(speaker)), sig: '' }
    const outer = signEvent(await bagTemplate([inner], key, lookup, 12, 1, CHAT_BAG_KIND), generateSecretKey())
    expect(await chatInners(outer, key)).toHaveLength(0)
  })

  it('refuses a line whose sig is present but not a string', async () => {
    const sk = generateSecretKey()
    for (const sig of [null, 0, false]) {
      const inner = { ...chatRumor(chatInnerTemplate('odd sig', at, 0, 1, lookup), getPublicKey(sk)), sig }
      const outer = signEvent(await bagTemplate([inner as never], key, lookup, 12, 1, CHAT_BAG_KIND), sk)
      expect(await chatInners(outer, key)).toHaveLength(0)
    }
  })

  it('refuses a signed line whose signature does not hold', async () => {
    const sk = generateSecretKey()
    const inner = { ...signEvent(chatInnerTemplate('tampered', at, 0, 1, lookup), sk), sig: '00'.repeat(64) }
    const outer = signEvent(await bagTemplate([inner], key, lookup, 12, 1, CHAT_BAG_KIND), sk)
    expect(await chatInners(outer, key)).toHaveLength(0)
  })
})

describe('one bag per author per region', () => {
  it('a rewrite carries the old entries forward and adds the new one', async () => {
    const sk = generateSecretKey()
    const first = signEvent(messageInnerTemplate('first', at, 1, 1_700_000_000), sk)
    const bag1 = signEvent(await bagTemplate([first], key, lookup, 6, 1_700_000_000, HIDDEN_KIND), sk)
    const carried = await bagEntries(bag1, key)
    expect(carried.map(entryKey)).toEqual([first.id])
    const second = signEvent(messageInnerTemplate('second', at, 1, 1_700_000_001), sk)
    const bag2 = signEvent(await bagTemplate([...carried, second], key, lookup, 6, 1_700_000_001, HIDDEN_KIND), sk)
    expect(bag2.created_at).toBeGreaterThan(bag1.created_at)
    expect(bag2.tags.find((t) => t[0] === 'd')?.[1]).toBe(lookup)
    const items = await unbag(bag2, key, undefined, undefined, 6)
    expect(items.map((h) => h.text)).toEqual(['first', 'second'])
    expect(items.every((h) => h.author === getPublicKey(sk) && h.height === 6)).toBe(true)
  })

  it('carries a hint, and a hint that cannot contain the region is refused', async () => {
    const sk = generateSecretKey()
    const item = signEvent(messageInnerTemplate('x', at, 1, 1), sk)
    const bag = signEvent(await bagTemplate([item], key, lookup, 6, 1, HIDDEN_KIND, { heightTag: true, hint: [30, 30, 30], riddle: 'look low' }, { at, plane: 1 }), sk)
    expect(bag.tags.find((t) => t[0] === 'hint')?.slice(2)).toEqual(['30', '30', '30'])
    expect(bag.tags.find((t) => t[0] === 'S')).toBeTruthy()
    expect(bag.content).toBe('look low')
    await expect(bagTemplate([item], key, lookup, 6, 1, HIDDEN_KIND, { heightTag: true, hint: [5, 30, 30], riddle: '' }, { at, plane: 1 })).rejects.toThrow(/cannot contain/)
  })
})

describe('an object hidden by reference (DECK-0003 3.4)', () => {
  it('is a sealed kind 33331 that opens with the bag\'s key and says nothing about where it is', async () => {
    const sk = generateSecretKey()
    const shard = newShard('monument')
    shard.vertices = [{ p: [0, 0, 0], c: [1, 0, 0] }, { p: [1, 0, 0], c: [0, 1, 0] }, { p: [0, 1, 0], c: [0, 0, 1] }]
    shard.faces = [[0, 1, 2]]
    shard.mode = 'solid'
    const object = signEvent(await objectTemplate(shard, key, 'd-1', 1), sk)
    expect(object.tags.map((t) => t[0]).sort()).toEqual(['alt', 'client', 'd', 'encrypted'])
    const ref = referenceTo(object, at, 1, '')
    const bag = signEvent(await bagTemplate([ref], key, lookup, 6, 1, HIDDEN_KIND), sk)
    const found = await unbag(bag, key, async (r) => (r[1] === `33331:${object.pubkey}:d-1` ? object : null), undefined, 6)
    expect(found).toHaveLength(1)
    expect(found[0].type).toBe('shard')
    expect(found[0].shard?.name).toBe('monument')
    expect(found[0].ref).toEqual(ref)
    // Without a resolver the reference is a missing entry, not an error.
    expect(await unbag(bag, key, undefined, undefined, 6)).toHaveLength(0)
  })
})

describe('key and chest items (Keys and Chests B1, as ONOSENDAI writes them at f9db752)', () => {
  it('a key rides its secret in a tag and its sentence as the content, and reads back whole', async () => {
    const item = forgeKey('lantern', 'lights the way')
    const t = keyInnerTemplate(item, at, 1, 1)
    expect(t.kind).toBe(KEY_KIND)
    expect(t.tags.map((x) => x[0])).toEqual(['C', 'title', 'item', 'secret', '-'])
    expect(t.tags.find((x) => x[0] === 'title')?.[1]).toBe('lantern')
    expect(t.tags.find((x) => x[0] === 'secret')?.[1]).toBe(item.secretHex)
    expect(t.tags.find((x) => x[0] === 'item')?.[1]).toBe(item.itemPubkey)
    expect(t.content).toBe('lights the way')
    expect(keyItemOf(t)).toEqual(item)
    // Through a bag sealed to the region, signed, and out again as a key item.
    const sk = generateSecretKey()
    const inner = signEvent(t, sk)
    const bag = signEvent(await bagTemplate([inner], key, lookup, 6, 1, HIDDEN_KIND), sk)
    const opened = await unbag(bag, key, undefined, undefined, 6)
    expect(opened).toHaveLength(1)
    expect(opened[0].type).toBe('key')
    expect(opened[0].key).toEqual(item)
    expect(readItem(inner)).toEqual({ type: 'key', key: item })
  })

  it('still reads a key forged the earlier way: the secret as content, name and about tags', () => {
    const key = forgeKey('old lantern', 'an older sentence')
    const read = keyItemOf({ kind: KEY_KIND, content: key.secretHex, tags: [['name', 'old lantern'], ['about', 'an older sentence'], ['item', key.itemPubkey]] })
    expect(read).toEqual(key)
  })

  it('refuses a key whose item tag does not match its secret, or whose secret is not a key', () => {
    const key = forgeKey('x')
    expect(keyItemOf({ kind: KEY_KIND, content: '', tags: [['secret', key.secretHex], ['item', 'ab'.repeat(32)]] })).toBeNull()
    expect(keyItemOf({ kind: KEY_KIND, content: '', tags: [['secret', 'not hex']] })).toBeNull()
  })

  it('a chest names itself with title, caps requires, and opens with the lock\'s secret or the right held key', () => {
    const sk = generateSecretKey()
    const lockSk = generateSecretKey()
    const lockPub = getPublicKey(lockSk)
    const inner = signEvent(messageInnerTemplate('inside the box', at, 1, 1), sk)
    const sealed = sealEntries([inner], lockPub)
    const chest = { name: 'strongbox', lockPubkey: lockPub, senderPubkey: sealed.senderPubkey, requires: 'r'.repeat(100), payload: sealed.payload }
    const t = chestInnerTemplate(chest, at, 1, 1)
    expect(t.tags.map((x) => x[0])).toEqual(['C', 'title', 'lock', 'requires', '-'])
    const read = chestItemOf(t)!
    expect(read.name).toBe('strongbox')
    expect(read.requires).toHaveLength(64)
    const contents = readContents(openWithSecret(read, bytesToHex(lockSk)))
    expect(contents).toHaveLength(1)
    expect(contents[0].body.text).toBe('inside the box')
    expect(contents[0].verified).toBe(true)
    expect(() => openWithSecret(read, bytesToHex(generateSecretKey()))).toThrow()
    const held = { itemPubkey: lockPub, secretHex: bytesToHex(lockSk) }
    expect(openerFor(read, [held], 'me')).toEqual({ by: 'key', key: held })
    expect(openerFor(read, [], lockPub)).toEqual({ by: 'self' })
    expect(openerFor(read, [], 'someone else')).toBeNull()
  })
})
