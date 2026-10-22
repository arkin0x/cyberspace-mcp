// contentsInterop.test.ts: a bag's `contents` rows, against ONOSENDAI #444
// (b892512), which reads them as spec 7.7 "Contents" has them (cyberspace
// #75): `["contents", "nft", "<count>"]` after `cashu` (ONOSENDAI #441), the
// nonfungible.cash claim links written in a bag's messages, each once per
// message and none inside another URL, under "Publish contents" only, as the
// cashu count is written; counts are positive decimal integers with no cap.
// fixtures/onosendai-contents.json was made with ONOSENDAI's own code
// (scripts/gen-onosendai-contents-fixture.ts): how many links its recognizer
// counts in each text, the rows it writes for fixed bags under each
// setting, the settings it reads from rows, and two bags it sealed with the
// test agent's key, with the rows it writes after each rewrite made here
// through the tools (hide, remove_placed, move_placed), over fake relays only.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Agent } from '../src/agent.js'
import { bagSettingsOf, bagTemplate, HIDDEN_KIND, type BagEntry } from '../src/hidden/bags.js'
import { regionKeyAt } from '../src/hidden/crypto.js'
import { nftLinkCount } from '../src/hidden/nftLink.js'
import type { NostrEvent } from '../src/nostr/event.js'
import { createServer } from '../src/server.js'
import type { Calibration } from '../src/space/calibration.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork, type FakeRelay } from './fakeRelay.js'

interface Fixture {
  agentSecretHex: string; agent: string; base: string
  recognizer: Array<{ text: string; onosendai: number }>
  cases: Array<{ name: string; inners: BagEntry[]; contents: boolean; money: boolean; onosendai: string[][] }>
  reads: Array<{ rows: string[][]; onosendai: { contents: boolean; money: boolean } }>
  ids: { plain: string; nft: string; coin: string; note: string }
  bags: { contentsOn: NostrEvent; moneyAlone: NostrEvent }
  expected: {
    contentsOn: Record<'sealed' | 'afterHide' | 'afterRemovePlain' | 'afterMoveNft' | 'afterMoveNftAcross', string[][]>
    moneyAlone: Record<'sealed' | 'afterHide' | 'afterRemoveCoin', string[][]>
  }
}

const fx = JSON.parse(readFileSync(new URL('./fixtures/onosendai-contents.json', import.meta.url), 'utf8')) as Fixture
const BASE = BigInt(fx.base)
const rowsOf = (t: { tags: string[][] }): string[][] => t.tags.filter((x) => x[0] === 'contents')

describe('contents rows, against ONOSENDAI #444', () => {
  it('counts nonfungible.cash claim links as ONOSENDAI does, text by text, and never a look-alike', () => {
    expect(fx.recognizer.some((r) => r.onosendai > 1)).toBe(true)
    // What the fixture pins (spec 7.7), so a regenerated one that lost a case fails here.
    const inside = fx.recognizer.find((r) => r.text.startsWith('https://a.example/?b=1;https://nonfungible.cash/'))
    expect(inside?.onosendai).toBe(0)
    expect(fx.recognizer.find((r) => r.text.startsWith('see;https://nonfungible.cash/'))?.onosendai).toBe(1)
    for (const r of fx.recognizer) expect(nftLinkCount(r.text), JSON.stringify(r.text)).toBe(r.onosendai)
  })

  it('writes ONOSENDAI\'s rows for the same bag under each setting: nft after cashu, under contents only', async () => {
    const k = regionKeyAt({ x: BASE, y: BASE, z: BASE }, 8, 20)
    for (const c of fx.cases) {
      const t = await bagTemplate(c.inners, k.key, k.lookupId, 8, 1, HIDDEN_KIND, { heightTag: true, hint: null, riddle: '', contents: c.contents, money: c.money })
      expect(rowsOf(t), `${c.name}, contents ${c.contents}, money ${c.money}`).toEqual(c.onosendai)
    }
    // What the fixture pins, so a regenerated one that lost a case fails here.
    const everything = fx.cases.find((c) => c.name === 'everything' && c.contents && !c.money)!
    expect(everything.onosendai.map((r) => r[1])).toEqual(['shard', 'message', 'key', 'chest', 'cashu', 'nft'])
    expect(fx.cases.find((c) => c.name === 'an NFT alone' && !c.contents && c.money)!.onosendai).toEqual([])
  })

  it('reads rows into a bag\'s settings as ONOSENDAI does: a counted nft row is the contents hint, a bare one is nothing', () => {
    // What the fixture pins (spec 7.7): no cap, no sign or leading zero, and money alone only from the bare cashu row.
    const read = (rows: string[][]) => fx.reads.find((r) => JSON.stringify(r.rows) === JSON.stringify(rows))?.onosendai
    expect(read([['contents', 'shard', '1000000']])).toEqual({ contents: true, money: false })
    expect(read([['contents', 'shard', '03']])).toEqual({ contents: false, money: false })
    expect(read([['contents', 'cashu', '0']])).toEqual({ contents: false, money: false })
    expect(read([['contents', 'cashu']])).toEqual({ contents: false, money: true })
    for (const r of fx.reads) {
      const ev = { id: '0'.repeat(64), pubkey: fx.agent, created_at: 1, kind: HIDDEN_KIND, content: '', sig: '', tags: [['d', 'x'], ['H', '8'], ...r.rows] }
      const s = bagSettingsOf(ev, 8)
      expect({ contents: s.contents, money: s.money }, JSON.stringify(r.rows)).toEqual(r.onosendai)
    }
  })
})

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }
type Call = (name: string, args?: Record<string, unknown>) => Promise<{ text: string; data: Record<string, unknown>; isError: boolean }>

const agents: Agent[] = []
afterAll(async () => { for (const a of agents) await a.stop() })

/** The fixture's test agent, on fake relays that hold the two bags ONOSENDAI sealed with its key. */
async function setup(): Promise<{ call: Call; mine: FakeRelay }> {
  const network = new FakeNetwork()
  const canonical = network.add(CANONICAL)
  const mine = network.add(MINE)
  for (const r of [canonical, mine]) { r.seed(fx.bags.contentsOn); r.seed(fx.bags.moneyAlone) }
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-contents-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: fx.agentSecretHex, createdAt: 'test' }), { mode: 0o600 })
  const a = await Agent.start({
    stateDir: dir, relays: [CANONICAL, MINE], capCallSeconds: 30, capSessionSeconds: 120, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1200, ordersPollMs: 0,
  })
  agents.push(a)
  expect(a.pubkey).toBe(fx.agent)
  const server = createServer(a)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientSide)
  const call: Call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    return { text: (r.content as Array<{ text: string }>).map((c) => c.text ?? '').join('\n'), data: (r.structuredContent ?? {}) as Record<string, unknown>, isError: !!r.isError }
  }
  return { call, mine }
}

/** The contents rows of the agent's newest bag at a lookup id, as a relay holds it now. */
function rowsOn(relay: FakeRelay, lookupId: string): string[][] {
  const bags = relay.all().filter((e) => e.kind === HIDDEN_KIND && e.pubkey === fx.agent && e.tags.some((t) => t[0] === 'd' && t[1] === lookupId))
  return rowsOf(bags.reduce((a, b) => (b.created_at > a.created_at ? b : a)))
}

describe('a rewrite of a bag ONOSENDAI sealed keeps its contents rows as ONOSENDAI writes them', () => {
  // z mod 256 is 100 at BASE, so +6 stays in the h8 cube; z mod 8 is 4, so +2 stays in the h3 cube.
  const at = (dz: bigint) => ({ x: BASE.toString(), y: BASE.toString(), z: (BASE + dz).toString(), plane: 0 })

  it('contents on: hide (a note with a link), remove_placed and move_placed (in the bag, across the edge) recompute the rows, nft included', async () => {
    const { call, mine } = await setup()
    const k = regionKeyAt({ x: BASE, y: BASE, z: BASE }, 8, 20)
    expect(rowsOn(mine, k.lookupId)).toEqual(fx.expected.contentsOn.sealed)
    const hid = await call('hide', { contents: { message: fx.ids.note }, coordinate: at(6n), height: 8 })
    expect(hid.isError, hid.text).toBe(false)
    expect(hid.data.carried).toBe(7)
    expect(rowsOn(mine, k.lookupId)).toEqual(fx.expected.contentsOn.afterHide)
    // The note the agent hid carries a link of its own, so the count it wrote went up by one.
    const nftOf = (rows: string[][]): number => Number(rows.find((r) => r[1] === 'nft')?.[2] ?? 0)
    expect(nftOf(fx.expected.contentsOn.afterHide)).toBe(nftOf(fx.expected.contentsOn.sealed) + 1)
    const removed = await call('remove_placed', { target: fx.ids.plain })
    expect(removed.isError, removed.text).toBe(false)
    expect(rowsOn(mine, k.lookupId)).toEqual(fx.expected.contentsOn.afterRemovePlain)
    const moved = await call('move_placed', { target: fx.ids.nft, by: { dz: 1 } })
    expect(moved.isError, moved.text).toBe(false)
    expect(moved.data.sameBag).toBe(true)
    expect(rowsOn(mine, k.lookupId)).toEqual(fx.expected.contentsOn.afterMoveNft)
    // Across the cube's edge (z mod 256 goes from 102 past 255), by its lineage: the move signed it again under a new id.
    const across = await call('move_placed', { target: fx.ids.nft, by: { dz: 200 } })
    expect(across.isError, across.text).toBe(false)
    expect(across.data.sameBag).toBe(false)
    expect(rowsOn(mine, k.lookupId)).toEqual(fx.expected.contentsOn.afterMoveNftAcross)
    // The bag it lands in had none before, so it starts with contents off, as a first hide there would.
    const there = regionKeyAt({ x: BASE, y: BASE, z: BASE + 202n }, 8, 20)
    expect(there.lookupId).not.toBe(k.lookupId)
    expect(rowsOn(mine, there.lookupId)).toEqual([])
  }, 60_000)

  it('money alone: an NFT never shows, and the cashu row goes when the coin does', async () => {
    const { call, mine } = await setup()
    const k = regionKeyAt({ x: BASE, y: BASE, z: BASE }, 3, 20)
    expect(rowsOn(mine, k.lookupId)).toEqual(fx.expected.moneyAlone.sealed)
    const hid = await call('hide', { contents: { message: fx.ids.note }, coordinate: at(2n), height: 3 })
    expect(hid.isError, hid.text).toBe(false)
    expect(rowsOn(mine, k.lookupId)).toEqual(fx.expected.moneyAlone.afterHide)
    const removed = await call('remove_placed', { target: fx.ids.coin })
    expect(removed.isError, removed.text).toBe(false)
    expect(rowsOn(mine, k.lookupId)).toEqual(fx.expected.moneyAlone.afterRemoveCoin)
    expect(fx.expected.moneyAlone.afterRemoveCoin).toEqual([])
  }, 60_000)
})
