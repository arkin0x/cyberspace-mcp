// items.test.ts: items and chests as ONOSENDAI plays them (Keys and Chests
// B1 and its 2026-10-10 addendum; arkinox, 2026-10-12: "I don't think the
// MCP server gives the agent any knowledge of items or sealed chests or how
// to use them"). fixtures/onosendai-items.json was made with ONOSENDAI's own
// code (origin/v2 b615675: src/lib/hidden.ts, chests.ts, inventory.ts,
// client.ts and comments.ts, run outside this repository) and test keys: a
// bag ONOSENDAI sealed at the test agent's spawn holding an item and three
// chests, a bag it sealed at h0 (the spawn gibson alone), its key, chest and
// comment templates for fixed inputs, and what ONOSENDAI's readers made of a
// key, a chest and a comment sealed by this server's code. The agent scans
// h0 to h12 as ONOSENDAI does, and comments as ONOSENDAI comments. The agent finds, holds,
// opens and takes what ONOSENDAI hid; what the agent forges and seals has
// ONOSENDAI's tags exactly; no answer, log or state file but the item store
// carries an item's secret. Fake relays only.

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Agent, Refusal } from '../src/agent.js'
import { chestInnerTemplate, chestItemOf, keyInnerTemplate, keyItemOf, unbag, type KeyItem } from '../src/hidden/bags.js'
import { openWithSecret, readContents } from '../src/hidden/chests.js'
import { commentTemplate, readComment } from '../src/hidden/comments.js'
import { hexToBytes, type NostrEvent } from '../src/nostr/event.js'
import { createServer } from '../src/server.js'
import type { Calibration } from '../src/space/calibration.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork } from './fakeRelay.js'

interface Fixture {
  agentSecretHex: string
  agent: string
  hider: string
  height: number
  lookupId: string
  regionKeyHex: string
  at: { x: string; y: string; z: string; plane: 0 | 1 }
  bag: NostrEvent
  expect: {
    key: { name: string; about: string; itemPubkey: string; eventId: string }
    nextKey: { name: string; itemPubkey: string }
    vault: { id: string; name: string; requires: string; texts: string[]; shardName: string }
    gift: { id: string; name: string; text: string }
    locked: { id: string; name: string; lock: string }
  }
  templates: { key: { kind: number; created_at: number; tags: string[][]; content: string }; chest: { kind: number; created_at: number; tags: string[][]; content: string }; chestInput: { name: string; lockPubkey: string; senderPubkey: string; requires: string; payload: string } }
  mcpBag: NostrEvent
  h0: { lookupId: string; bag: NostrEvent; text: string; messageId: string }
  comments: {
    subject: { author: string; lookupId: string }
    cases: Array<{ name: string; parent: { id: string; kind: number; pubkey: string }; template: { kind: number; created_at: number; tags: string[][]; content: string } }>
    mcpComment: NostrEvent
    onosendaiRead: { count: number; text: string; sealed: boolean; pubkey: string; parentId: string }
  }
  reverse: { keyName: string; keyAbout: string; keyItemPubkey: string; keyMatches: boolean; chestName: string; chestRequires: string; chestLock: string; contents: Array<{ type: string; verified: boolean; text: string | null; shardName: string | null }> }
}

const fx = JSON.parse(readFileSync(new URL('./fixtures/onosendai-items.json', import.meta.url), 'utf8')) as Fixture
const at = { x: BigInt(fx.at.x), y: BigInt(fx.at.y), z: BigInt(fx.at.z) }
const regionKey = hexToBytes(fx.regionKeyHex)
/** The Brass Key's secret, out of ONOSENDAI's own template; never to appear in an answer. */
const brassSecret = fx.templates.key.tags.find((t) => t[0] === 'secret')![1]

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }

describe('the wire, against ONOSENDAI (b615675)', () => {
  it('a key item and a chest are ONOSENDAI\'s templates, tag for tag', () => {
    const key: KeyItem = { name: 'Fixed', about: 'A fixed sentence.', itemPubkey: fx.expect.key.itemPubkey, secretHex: brassSecret }
    const t = fx.templates.key
    expect(keyInnerTemplate(key, at, fx.at.plane, t.created_at)).toEqual(t)
    expect(chestInnerTemplate(fx.templates.chestInput, at, fx.at.plane, fx.templates.chest.created_at)).toEqual(fx.templates.chest)
    // The secret rides in its own tag and never in the content (#256), with title, item and the NIP-70 "-".
    expect(t.tags.map((x) => x[0])).toEqual(['C', 'title', 'item', 'secret', '-'])
    expect(t.content).not.toContain(brassSecret)
    expect(fx.templates.chest.tags.map((x) => x[0])).toEqual(['C', 'title', 'lock', 'requires'])
  })

  it('reads ONOSENDAI\'s bag: the item, and chests sealed to it, to the agent, and to an item nobody here holds', async () => {
    const items = await unbag(fx.bag, regionKey, undefined, undefined, fx.height)
    expect(items.map((h) => h.type)).toEqual(['key', 'chest', 'chest', 'chest'])
    expect(keyItemOf(items[0].inner)).toMatchObject({ name: fx.expect.key.name, about: fx.expect.key.about, itemPubkey: fx.expect.key.itemPubkey })
    const vault = chestItemOf(items[1].inner)!
    expect(vault).toMatchObject({ name: 'Vault', lockPubkey: fx.expect.key.itemPubkey, requires: 'the Brass Key' })
    const inside = readContents(openWithSecret(vault, brassSecret))
    expect(inside.map((c) => c.body.type)).toEqual(['message', 'message', 'shard', 'key'])
    expect(inside.every((c) => c.verified && c.event.pubkey === fx.hider)).toBe(true)
    expect(inside[3].body.key).toMatchObject({ name: fx.expect.nextKey.name, itemPubkey: fx.expect.nextKey.itemPubkey })
    expect(() => openWithSecret(chestItemOf(items[3].inner)!, brassSecret)).toThrow()
  })

  it('ONOSENDAI read what this server forged and sealed (the reverse, recorded at generation), and so does this server', async () => {
    expect(fx.reverse).toMatchObject({ keyName: 'Copper Key', keyAbout: 'Made by the agent.', keyMatches: true, chestName: 'Agent Chest', chestRequires: 'the Copper Key', chestLock: fx.reverse.keyItemPubkey })
    expect(fx.reverse.contents).toEqual([
      { type: 'message', verified: true, text: 'Sealed by the agent.', shardName: null },
      { type: 'shard', verified: true, text: null, shardName: fx.expect.vault.shardName },
    ])
    const mine = await unbag(fx.mcpBag, regionKey, undefined, undefined, fx.height)
    const key = mine.find((h) => h.type === 'key')!.key!
    expect(key.itemPubkey).toBe(fx.reverse.keyItemPubkey)
    const chest = mine.find((h) => h.type === 'chest')!.chest!
    expect(readContents(openWithSecret(chest, key.secretHex)).map((c) => c.body.text ?? c.body.shard?.name)).toEqual(['Sealed by the agent.', fx.expect.vault.shardName])
  })
})

describe('comments, against ONOSENDAI (b615675)', () => {
  it('a comment on an item, a chest and a thing inside a chest is ONOSENDAI\'s template, tag for tag (the client named as this server)', () => {
    for (const c of fx.comments.cases) {
      const ours = commentTemplate(fx.comments.subject, c.parent, 'CIPHERTEXT', c.template.created_at)
      const theirs = { ...c.template, tags: c.template.tags.map((t) => (t[0] === 'client' ? ['client', 'cyberspace-mcp'] : t)) }
      expect(ours).toEqual(theirs)
      expect(ours.tags.map((t) => t[0])).toEqual(['A', 'K', 'P', 'e', 'k', 'p', 'client', 'encrypted'])
    }
  })

  it('ONOSENDAI threaded a comment this server sealed under the item it answers, and opened its words', async () => {
    expect(fx.comments.onosendaiRead).toMatchObject({ count: 1, text: 'Found a coin in the Vault.', sealed: false, pubkey: fx.agent, parentId: fx.comments.cases[2].parent.id })
    const read = await readComment(fx.comments.mcpComment, regionKey)
    expect(read).toEqual({ root: `33330:${fx.hider}:${fx.lookupId}`, parentId: fx.comments.cases[2].parent.id, parentKind: 1, text: 'Found a coin in the Vault.' })
  })
})

describe('the agent and ONOSENDAI\'s items and chests', () => {
  const network = new FakeNetwork()
  const canonical = network.add(CANONICAL, { refuse: (ev) => ([0, 33330].includes(ev.kind) ? 'blocked: not a member yet' : null) })
  const mine = network.add(MINE)
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-items-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: fx.agentSecretHex, createdAt: 'test' }), { mode: 0o600 })
  const logs: string[] = []
  const answers: string[] = []
  const agents: Agent[] = []
  afterAll(async () => { for (const a of agents) await a.stop() })

  async function start(): Promise<{ a: Agent; call: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; data: Record<string, unknown>; isError: boolean }> }> {
    const a = await Agent.start({
      stateDir: dir, relays: [CANONICAL, MINE], capCallSeconds: 30, capSessionSeconds: 120, maxSidestepHeight: 24, allowRespawn: false,
      websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1500, ordersPollMs: 0, log: (l) => logs.push(l),
    })
    agents.push(a)
    const server = createServer(a, (l) => logs.push(l))
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientSide)
    return {
      a,
      call: async (name, args = {}) => {
        const r = await client.callTool({ name, arguments: args })
        answers.push(JSON.stringify(r))
        return { text: (r.content as Array<{ text: string }>).map((c) => c.text ?? '').join('\n'), data: (r.structuredContent ?? {}) as Record<string, unknown>, isError: !!r.isError }
      },
    }
  }

  async function restart(): ReturnType<typeof start> {
    const last = agents.pop()
    if (last) await last.stop()
    return start()
  }

  it('finds the item, holds it, opens what it can, and remembers the rest; items says what each item opens', async () => {
    mine.seed(fx.bag, fx.h0.bag)
    const { a, call } = await start()
    expect(a.pubkey).toBe(fx.agent)
    const found = await call('find', { max_height: fx.height })
    expect(found.text).toContain('Brass Key')
    expect(found.text).toContain('open_chest')
    // The bag ONOSENDAI hid at h0, the spawn gibson alone, is found, and find says which cubes it scanned (arkinox, 2026-10-12).
    expect(found.text).toContain(fx.h0.text)
    expect(found.text).toContain(`Scanned the ${fx.height + 1} cubes of height 0 to ${fx.height} that contain the gibson you stand on`)
    expect(found.data.scanned).toMatchObject({ heights: [0, fx.height] })
    expect((found.data.bags as Array<{ height: number }>).map((b) => b.height).sort()).toEqual([0, fx.height])
    // The passive scan holds the h0 key too, as ONOSENDAI's thirteen.
    expect(a.keys.byLookupId(fx.h0.lookupId)?.height).toBe(0)
    const full = await call('find', {})
    expect(full.text).toContain('Scanned the 13 cubes of height 0 to 12')
    // The item is held, with where it came from and who made it.
    const brass = a.keys.items.get(fx.expect.key.itemPubkey)!
    expect(brass).toMatchObject({ name: 'Brass Key', source: 'found', hider: fx.hider, eventId: fx.expect.key.eventId, place: { lookupId: fx.lookupId, height: fx.height, x: fx.at.x } })
    // The next item, inside the Vault the Brass Key opened, is held too (reading is holding).
    expect(a.keys.items.get(fx.expect.nextKey.itemPubkey)).toMatchObject({ name: 'Silver Key', source: 'found', from: { chestId: fx.expect.vault.id, chestName: 'Vault' } })
    // All three chests are remembered, sealed.
    expect([...a.keys.chests.keys()].sort()).toEqual([fx.expect.vault.id, fx.expect.gift.id, fx.expect.locked.id].sort())

    const items = await call('items')
    expect(items.text).toContain('An item is a key')
    expect(items.text).toContain(`"Brass Key": "Opens the vault under the stop.". Public key ${fx.expect.key.itemPubkey}`)
    expect(items.text).toContain(`opens "Vault" (open_chest ${fx.expect.vault.id.slice(0, 12)}`)
    expect(items.text).toContain('sealed to you: open_chest')
    expect(items.text).toMatch(/"Locked".*sealed to .*; it needs an item you have not found/)
    const rows = items.data.items as Array<{ name: string; opens: Array<{ id: string }> }>
    expect(rows.find((r) => r.name === 'Brass Key')!.opens.map((c) => c.id)).toEqual([fx.expect.vault.id])
  }, 60_000)

  it('open_chest says what each thing is for; take keeps it, across a restart, and objects render by id', async () => {
    let { a, call } = await restart()
    void a
    const opened = await call('open_chest', { chest: 'vault' })
    expect(opened.isError).toBe(false)
    expect(opened.text).toContain('with your item "Brass Key"')
    expect(opened.text).toContain('"The vault remembers."')
    expect(opened.text).toMatch(/coin by .*cashuBexampletokenAAAA.*Never say it in chat/)
    expect(opened.text).toMatch(/object "XOR stella octangula".*render it with id/)
    expect(opened.text).toMatch(/item "Silver Key".*you hold it now/)
    const contents = opened.data.contents as Array<{ id: string; type: string; coin?: boolean }>
    expect(contents.map((c) => c.type)).toEqual(['message', 'message', 'shard', 'key'])
    expect(contents[1].coin).toBe(true)

    const gift = await call('open_chest', { chest: fx.expect.gift.id.slice(0, 10) })
    expect(gift.text).toContain('your own key (it was sealed to you)')
    expect(gift.text).toContain(fx.expect.gift.text)

    const locked = await call('open_chest', { chest: 'Locked' })
    expect(locked.isError).toBe(true)
    expect(locked.text).toContain(fx.expect.locked.lock)

    const shardId = contents[2].id
    const took = await call('take', { chest: fx.expect.vault.id.slice(0, 12), content: shardId.slice(0, 10) })
    expect(took.text).toContain('Took 1 thing(s)')
    const all = await call('take', { chest: 'Vault' })
    // The two messages, and the Silver Key (held since find opened the Vault, taken now); the object was taken already.
    expect((all.data.took as unknown[]).length).toBe(3)
    expect((all.data.already as unknown[]).length).toBe(1)
    const again = await call('take', { chest: 'Vault' })
    expect(again.text).toContain('Nothing new to take')

    // A restart: the taken object still renders by its id; nothing else of the session is remembered.
    ;({ a, call } = await restart())
    const pic = await call('render', { id: shardId.slice(0, 12) })
    expect(pic.isError).toBe(false)
    const items = await call('items')
    expect(items.text).toContain('Taken from chests (4)')
    expect(items.text).toContain('coin "Here is a coin: cashuBexampletokenAAAA"')

    // A comment on the coin inside the Vault, as ONOSENDAI writes one: root the bag, parent the coin, words sealed to the place.
    const plain = (tags: string[][]): string[][] => tags.filter((t) => t[0] !== 'encrypted' && t[0] !== 'client')
    const coinId = contents[1].id
    const said = await call('comment', { target: coinId.slice(0, 12), text: 'A coin was here, and I left it for the next finder.' })
    expect(said.isError).toBe(false)
    const ev = mine.all().find((e) => e.id === (said.data.id as string))!
    expect(plain(ev.tags)).toEqual(plain(fx.comments.cases[2].template.tags))
    expect(ev.tags.map((t) => t[0])).toEqual(['A', 'K', 'P', 'e', 'k', 'p', 'client', 'encrypted'])
    expect(ev.content).toBe(fx.comments.cases[2].template.content)
    expect(await readComment(ev, regionKey)).toMatchObject({ parentId: coinId, text: 'A coin was here, and I left it for the next finder.' })
    // On the chest itself and on the item in the bag: the same scope, their own kinds.
    const onChest = await call('comment', { target: fx.expect.vault.id.slice(0, 12), text: 'Opened it with the Brass Key.' })
    expect(plain(mine.all().find((e) => e.id === onChest.data.id)!.tags)).toEqual(plain(fx.comments.cases[1].template.tags))
    const onKey = await call('comment', { target: fx.expect.key.eventId.slice(0, 12), text: 'Found the key.' })
    expect(plain(mine.all().find((e) => e.id === onKey.data.id)!.tags)).toEqual(plain(fx.comments.cases[0].template.tags))
    // Never a coin; never something it never opened.
    expect((await call('comment', { target: coinId.slice(0, 12), text: 'here: cashuBexampletokenAAAA' })).text).toContain('Cashu token')
    expect((await call('comment', { target: 'deadbeefdeadbeef', text: 'x' })).text).toContain('Nothing you opened has an id starting deadbeefdeadbeef')
  }, 60_000)

  it('forges an item and seals chests to it the way ONOSENDAI does, and refuses a lock it cannot seal to', async () => {
    const { a, call } = await restart()
    const forged = await call('forge_item', { name: 'Glass Key', about: 'Made here.', height: 5 })
    expect(forged.isError).toBe(false)
    const item = forged.data.item as { name: string; itemPubkey: string }
    expect(item.name).toBe('Glass Key')
    expect(a.keys.items.get(item.itemPubkey)).toMatchObject({ source: 'forged', hider: a.pubkey })

    const sealed = await call('seal_chest', { name: 'Cache', lock: 'glass key', contents: [{ message: 'for whoever holds glass' }, { key: { name: 'Next', about: 'onward' } }, { item: 'Brass Key' }], height: 5 })
    expect(sealed.isError).toBe(false)
    const chest = sealed.data.chest as { id: string; requires: string; lock: string }
    expect(chest).toMatchObject({ lock: item.itemPubkey, requires: 'the Glass Key' })
    expect(sealed.text).toContain('you hold the new item(s) "Next"')

    // The bag as published: the chest has ONOSENDAI's tags and opens with the Glass Key into what ONOSENDAI reads.
    const bag = mine.all().filter((e) => e.kind === 33330 && e.pubkey === a.pubkey).sort((x, y) => y.created_at - x.created_at)[0]
    const lookupId = bag.tags.find((t) => t[0] === 'd')![1]
    const key = [...a.keys.keys.values()].find((k) => k.lookupId === lookupId)!
    const inside = await unbag(bag, hexToBytes(key.keyHex), undefined, undefined, 5)
    const glass = inside.find((h) => h.type === 'key')!
    // ONOSENDAI's tags in ONOSENDAI's order; the signer then adds its client tag last, as ONOSENDAI's attributed() adds its own.
    expect(glass.inner.tags.map((t) => t[0])).toEqual(['C', 'title', 'item', 'secret', '-', 'client'])
    const cache = inside.find((h) => h.type === 'chest' && h.eventId === chest.id)!
    expect(cache.inner.tags.map((t) => t[0])).toEqual(['C', 'title', 'lock', 'requires', 'client'])
    expect(cache.inner.tags.find((t) => t[0] === 'title')![1]).toBe('Cache')
    const cacheContents = readContents(openWithSecret(cache.chest!, a.keys.items.get(item.itemPubkey)!.secretHex))
    expect(cacheContents.map((c) => c.body.type)).toEqual(['message', 'key', 'key'])
    // The copy of the Brass Key is the same keypair: whoever finds it opens the Vault.
    expect(cacheContents[2].body.key!.itemPubkey).toBe(fx.expect.key.itemPubkey)

    // A lock that is no key is refused, and so is an item the agent does not hold.
    const bad = await call('seal_chest', { name: 'Nope', lock: 'f'.repeat(64), contents: [{ message: 'x' }], height: 5 })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('not a point on the curve')
    const unknown = await call('seal_chest', { name: 'Nope', lock: 'Rubber Key', contents: [{ message: 'x' }], height: 5 })
    expect(unknown.text).toContain('You hold no item named or keyed "Rubber Key"')
    await expect(Promise.resolve().then(() => a.openChest({ chest: 'nothing like it' }))).rejects.toBeInstanceOf(Refusal)
    void canonical
  }, 60_000)

  it('no item secret in any answer, log line, or state file but the item store', () => {
    const secrets = [...agents[agents.length - 1].keys.items.values()].map((i) => i.secretHex)
    expect(secrets).toContain(brassSecret)
    // Brass and Silver (found), Glass and Next (forged).
    expect(secrets).toHaveLength(4)
    for (const secret of secrets) {
      for (const answer of answers) expect(answer).not.toContain(secret)
      for (const line of logs) expect(line).not.toContain(secret)
      for (const f of ['bags.json', 'regions.json', 'chests.json', 'taken.json']) {
        let text = ''
        try { text = readFileSync(join(dir, 'keys', f), 'utf8') } catch { /* not written */ }
        expect(text).not.toContain(secret)
      }
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) expect(readFileSync(join(dir, f), 'utf8')).not.toContain(secret)
    }
  })
})
