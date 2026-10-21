// itemModel.test.ts: the SNO an item wears and how it moves, as ONOSENDAI
// writes and reads them (ONOSENDAI#439, src/lib/itemModel.ts and the
// keyItemOf/keyInnerTemplate changes in src/lib/hidden.ts on branch
// feat/item-model; spec draft DECK-0004 2.5, arkin0x/cyberspace#74). The
// expected tags and readings below were printed by ONOSENDAI's own
// keyInnerTemplate and keyItemOf at that branch, run outside this
// repository, and are hardcoded here. An item without the tags is the item
// it always was; a held item copied into a chest keeps its model and
// motions. No network.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { KEY_KIND, MAX_CARRIED_BYTES, MAX_CARRIED_TAGS, carriedTags, keyInnerTemplate, keyItemOf, type KeyItem } from '../src/hidden/bags.js'
import { forgeKey, openWithSecret, readContents, sealEntries } from '../src/hidden/chests.js'
import { animationOf, isModelAddress, lookOf, modelOf, modelTags } from '../src/hidden/itemModel.js'
import { itemRow } from '../src/items.js'
import { hexToBytes, signEvent } from '../src/nostr/event.js'
import { KeyStore, keyItemOfHeld, type HeldItem } from '../src/space/regionKeys.js'
import { StateDir } from '../src/state/dir.js'

const secretHex = '07'.repeat(32)
const itemPubkey = getPublicKey(hexToBytes(secretHex))
const ADDRESS = `33331:${'ab'.repeat(32)}:lantern-1`
const at = { x: 5n, y: 7n, z: 9n }

/** The key item ONOSENDAI was given: motions out of order and one twice, as a careless writer might pass them. */
const lantern: KeyItem = {
  name: 'Lantern', about: 'It glows.', itemPubkey, secretHex,
  model: { address: ADDRESS, relay: 'wss://relay.example' },
  animation: ['spin-x', 'bob', 'spin-y', 'bob'],
}

/** What ONOSENDAI's keyInnerTemplate wrote for `lantern` at (5, 7, 9) on plane 1, created_at 1700000000. */
const ONOSENDAI_TEMPLATE = {
  kind: 3340,
  created_at: 1700000000,
  content: 'It glows.',
  tags: [
    ['C', '000000000000000000000000000000000000000000000000000000000000072f'],
    ['title', 'Lantern'],
    ['item', '989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f'],
    ['secret', '0707070707070707070707070707070707070707070707070707070707070707'],
    ['-'],
    ['model', '33331:abababababababababababababababababababababababababababababababab:lantern-1', 'wss://relay.example'],
    ['animate', 'bob', 'spin-y', 'spin-x'],
  ],
}

describe('the model and animate tags, against ONOSENDAI (feat/item-model)', () => {
  it('keyInnerTemplate writes ONOSENDAI\'s template tag for tag, and both read it back the same', () => {
    const t = keyInnerTemplate(lantern, at, 1, 1700000000)
    expect(t).toEqual(ONOSENDAI_TEMPLATE)
    // ONOSENDAI's keyItemOf of that template: the motions in ANIMATIONS order, each once.
    expect(keyItemOf(t)).toEqual({
      name: 'Lantern', about: 'It glows.', itemPubkey, secretHex,
      model: { address: ADDRESS, relay: 'wss://relay.example' },
      animation: ['bob', 'spin-y', 'spin-x'],
    })
    // Round trip: what was read writes the same tags again.
    expect(keyInnerTemplate(keyItemOf(t)!, at, 1, 1700000000)).toEqual(ONOSENDAI_TEMPLATE)
  })

  it('a relay hint that is not ws or wss is dropped, and one motion is written alone (as ONOSENDAI writes it)', () => {
    const t = keyInnerTemplate({ ...lantern, model: { address: ADDRESS, relay: 'http://x' }, animation: ['spin-y'] }, at, 1, 1700000000)
    expect(t.tags.slice(5)).toEqual([['model', ADDRESS], ['animate', 'spin-y']])
  })

  it('reads as ONOSENDAI reads: motions only with a model, the first valid model, known names, every animate tag', () => {
    // ONOSENDAI read an animate tag with no model as an item with neither.
    expect(keyItemOf({ kind: KEY_KIND, content: 'x', tags: [['secret', secretHex], ['animate', 'bob']] })).toEqual({ name: 'key', about: 'x', itemPubkey, secretHex })
    // An uppercase pubkey is no address; an ftp hint is no hint; wobble is skipped; two animate tags read as one.
    const read = keyItemOf({ kind: KEY_KIND, content: 'x', tags: [['secret', secretHex], ['model', `33331:${'AB'.repeat(32)}:d`], ['model', `33331:${'cd'.repeat(32)}:x`, 'ftp://no'], ['animate', 'spin-y', 'wobble'], ['animate', 'bob', 'spin-y']] })
    expect(read).toEqual({ name: 'key', about: 'x', itemPubkey, secretHex, model: { address: `33331:${'cd'.repeat(32)}:x` }, animation: ['bob', 'spin-y'] })
  })

  it('the address check is strict', () => {
    const pk = 'ab'.repeat(32)
    expect(isModelAddress(`33331:${pk}:d`)).toBe(true)
    expect(isModelAddress(`33331:${pk}:${'x'.repeat(128)}`)).toBe(true)
    for (const bad of [`3333:${pk}:d`, `30023:${pk}:d`, `33331:${pk.slice(2)}:d`, `33331:${pk.toUpperCase()}:d`, `33331:${pk}:`, `33331:${pk}`, `33331:${pk}:a b`, `33331:${pk}:${'x'.repeat(129)}`, '']) {
      expect(isModelAddress(bad)).toBe(false)
    }
    expect(modelOf([['model', `33331:${pk}:d`, 'wss://r.example'], ['model', `33331:${'cd'.repeat(32)}:e`]])).toEqual({ address: `33331:${pk}:d`, relay: 'wss://r.example' })
    expect(modelOf([['model', 'nope'], 'not a tag', ['model', 5]])).toBeNull()
    expect(animationOf([['animate', 'spin-x', 'spin-x', 'bob']])).toEqual(['bob', 'spin-x'])
  })

  it('writes nothing without a valid model, and no animate tag without a motion', () => {
    expect(modelTags(undefined, ['bob'])).toEqual([])
    expect(modelTags({ address: 'not an address' }, ['bob'])).toEqual([])
    expect(modelTags({ address: ADDRESS }, [])).toEqual([['model', ADDRESS]])
    expect(modelTags({ address: ADDRESS }, undefined)).toEqual([['model', ADDRESS]])
  })
})

describe('an item without the tags', () => {
  it('is written and read exactly as before', () => {
    const item = forgeKey('plain', 'no model')
    const t = keyInnerTemplate(item, at, 1, 1)
    expect(t.tags.map((x) => x[0])).toEqual(['C', 'title', 'item', 'secret', '-'])
    const read = keyItemOf(t)!
    expect(read).toEqual(item)
    expect('model' in read).toBe(false)
    expect('animation' in read).toBe(false)
  })
})

describe('holding an item keeps its look, and so does a copy sealed into a chest', () => {
  const dir = () => StateDir.open(mkdtempSync(join(tmpdir(), 'cyberspace-mcp-item-model-')))

  it('a found item is held with its model and motions, across a restart, and items lists them', () => {
    const state = dir()
    const found = keyItemOf(keyInnerTemplate(lantern, at, 1, 1700000000))!
    const keys = new KeyStore(state)
    keys.holdItem({ itemPubkey: found.itemPubkey, secretHex: found.secretHex, name: found.name, about: found.about, foundIn: 'look', at: 1, source: 'found', ...lookOf(found) })
    const again = new KeyStore(state).items.get(itemPubkey)!
    expect(again.model).toEqual({ address: ADDRESS, relay: 'wss://relay.example' })
    expect(again.animation).toEqual(['bob', 'spin-y', 'spin-x'])
    const row = itemRow(again, keys)
    expect(row.model).toEqual({ address: ADDRESS, relay: 'wss://relay.example' })
    expect(row.animation).toEqual(['bob', 'spin-y', 'spin-x'])
    expect(JSON.stringify(row)).not.toContain(secretHex)
  })

  it('a held item copied into a chest keeps its model and motions; one held before the tags gets none', () => {
    const held: HeldItem = { itemPubkey, secretHex, name: 'Lantern', about: 'It glows.', foundIn: 'look', at: 1, source: 'found', model: { address: ADDRESS, relay: 'wss://relay.example' }, animation: ['bob', 'spin-y', 'spin-x'] }
    // What the agent seals for a { item } chest entry (agent.ts entriesFor).
    const template = keyInnerTemplate(keyItemOfHeld(held), at, 1, 1700000000)
    expect(template).toEqual(ONOSENDAI_TEMPLATE)
    // Signed, it gains this server's client tag last, as every item it signs does.
    const sk = generateSecretKey()
    const copy = signEvent(template, sk)
    expect(copy.tags.slice(5)).toEqual([...ONOSENDAI_TEMPLATE.tags.slice(5), ['client', 'cyberspace-mcp']])
    const lock = forgeKey('lock')
    const { payload, senderPubkey } = sealEntries([copy], lock.itemPubkey)
    const contents = readContents(openWithSecret({ senderPubkey, payload }, lock.secretHex), getPublicKey(sk))
    expect(contents).toHaveLength(1)
    expect(contents[0].body.key).toEqual({ name: 'Lantern', about: 'It glows.', itemPubkey, secretHex, model: { address: ADDRESS, relay: 'wss://relay.example' }, animation: ['bob', 'spin-y', 'spin-x'] })

    // A row from an items.json written before 2026-10-21: no model, no animation, and the copy is the plain item.
    const old: HeldItem = { itemPubkey, secretHex, name: 'Lantern', about: 'It glows.', foundIn: 'look', at: 1 }
    expect(keyItemOfHeld(old)).toEqual({ name: 'Lantern', about: 'It glows.', itemPubkey, secretHex })
    expect(keyInnerTemplate(keyItemOfHeld(old), at, 1, 1).tags.map((x) => x[0])).toEqual(['C', 'title', 'item', 'secret', '-'])
  })
})

describe('the tags a copy carries over (carriedTags)', () => {
  it('keeps the item\'s own tags in order and drops what the copy writes itself or must not re-sign', () => {
    const imeta = ['imeta', 'url data:image/png;base64,AAAA', 'dim 2x2']
    const tags: unknown[] = [
      ['C', 'ff'], ['title', 'x'], ['name', 'x'], ['item', 'ab'], ['secret', 'cd'], ['about', 'x'], ['d', 'x'], ['-'], ['client', 'ONOSENDAI'],
      imeta, ['p', 'ab'.repeat(32)], ['e', 'cd'.repeat(32)], ['a', '1:2:3'], ['q', 'x'], ['t', 'lamp'], ['k', '1'],
      ['model', ADDRESS], ['delegation', 'x', 'y', 'z'], ['nonce', '1', '20'], ['animate', 'bob'],
      ['flavor', 'x'], 'not a tag', [], [5, 'x'], ['odd', 5], ['', 'empty name'],
    ]
    expect(carriedTags(tags)).toEqual([imeta, ['model', ADDRESS], ['animate', 'bob'], ['flavor', 'x']])
  })

  it('caps the count and the bytes, keeping order and skipping a tag that would pass the byte cap', () => {
    const many = Array.from({ length: 40 }, (_, i) => ['n' + i, String(i)])
    expect(carriedTags(many)).toEqual(many.slice(0, MAX_CARRIED_TAGS))
    // An imeta with an 8192-character data URI fits; a second one would pass 12 KB and is skipped; a small tag after it is kept.
    const big = ['imeta', 'url data:image/png;base64,' + 'A'.repeat(8192), 'dim 32x32']
    const kept = carriedTags([big, big, ['flavor', 'x']])
    expect(kept).toEqual([big, ['flavor', 'x']])
    expect(new TextEncoder().encode(JSON.stringify(kept)).length).toBeLessThanOrEqual(MAX_CARRIED_BYTES)
  })

  it('a key item with carried tags writes them verbatim instead of its model fields: no model or animate twice', () => {
    const carried = [['imeta', 'url https://x.example/a.png', 'dim 8x8'], ['model', ADDRESS, 'wss://relay.example'], ['animate', 'spin-y'], ['flavor', 'x']]
    const t = keyInnerTemplate({ ...lantern, carried }, at, 1, 1700000000)
    expect(t.tags.slice(5)).toEqual(carried)
    expect(t.tags.filter((x) => x[0] === 'model')).toHaveLength(1)
    expect(t.tags.filter((x) => x[0] === 'animate')).toHaveLength(1)
    // Carried tags are filtered again on the way out: a row edited by hand cannot make the copy re-sign a p tag.
    expect(keyInnerTemplate({ ...lantern, carried: [['p', 'ab'.repeat(32)], ['flavor', 'x']] }, at, 1, 1).tags.slice(5)).toEqual([['flavor', 'x']])
  })

  it('a row held before the tags were kept gains them when the item is read again, and nothing else of it changes', () => {
    const state = StateDir.open(mkdtempSync(join(tmpdir(), 'cyberspace-mcp-item-backfill-')))
    const keys = new KeyStore(state)
    const old: HeldItem = { itemPubkey, secretHex, name: 'Lantern', about: 'First sentence.', foundIn: 'first', at: 1, source: 'found', hider: 'aa'.repeat(32), eventId: 'ee'.repeat(32) }
    expect(keys.holdItem(old)).toBe(true)
    const carried = [['model', ADDRESS], ['animate', 'bob'], ['flavor', 'x']]
    const again = { ...old, name: 'Renamed', about: 'Other.', foundIn: 'second', at: 2, source: 'taken' as const, eventId: 'ff'.repeat(32), model: { address: ADDRESS }, animation: ['bob' as const], carried }
    expect(keys.holdItem(again)).toBe(false)
    expect(new KeyStore(state).items.get(itemPubkey)).toEqual({ ...old, model: { address: ADDRESS }, animation: ['bob'], carried })
    // Once filled, a third reading changes nothing.
    expect(keys.holdItem({ ...again, carried: [['other', 'y']] })).toBe(false)
    expect(keys.items.get(itemPubkey)!.carried).toEqual(carried)
    expect(keyInnerTemplate(keyItemOfHeld(keys.items.get(itemPubkey)!), at, 1, 1).tags.slice(5)).toEqual(carried)
  })
})
