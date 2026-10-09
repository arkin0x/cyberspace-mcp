// agent.test.ts: an agent on a fresh key, end to end over the fake relay.
// It publishes its profile (and reports the canonical relay's refusal
// verbatim), spawns on its first hop, hops a few gibsons, sees where it is,
// refuses the unsafe things, is refused when the head moves under it before
// or during the proof, hides a message and finds it again, places an object,
// says a line that a second agent standing in the same cube hears, finds a
// key and opens the chests sealed to it and to itself, and restarts whole. A
// second server on the same state directory refuses to start.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Agent, Refusal } from '../src/agent.js'
import { hopTemplate, spawnTemplate } from '../src/chain/builder.js'
import { bytesToHex, signEvent } from '../src/nostr/event.js'
import type { Calibration } from '../src/space/calibration.js'
import { placeFromHex, placeOf } from '../src/space/coords.js'
import type { EntrySummary, OpenedBag } from '../src/space/regionKeys.js'
import { KEY_GENERATED_BY, LockHeldError, StateDir } from '../src/state/dir.js'
import { FakeNetwork } from './fakeRelay.js'

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }

/** A state directory whose key the test generated, written the way the server writes its own. */
function dirWithKey(sk: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-agent-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
  return dir
}

const network = new FakeNetwork()
// The canonical relay's policy as the brief records it: a new key may publish 3333, 33331, 11333 and 23330; kind 0 and 33330 are refused.
const canonical = network.add(CANONICAL, { refuse: (ev) => ([0, 33330, 5, 7, 1111, 10002, 30003].includes(ev.kind) ? 'blocked: not a member yet' : null) })
const mine = network.add(MINE)

const agents: Agent[] = []
afterAll(async () => { for (const a of agents) await a.stop() })

async function startAgent(stateDir: string, extra: Partial<Parameters<typeof Agent.start>[0]> = {}): Promise<Agent> {
  const agent = await Agent.start({
    stateDir, relays: [CANONICAL, MINE], capCallSeconds: 30, capSessionSeconds: 120, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1500, ...extra,
  })
  agents.push(agent)
  return agent
}

const entriesOf = (r: { data: Record<string, unknown> }): EntrySummary[] => (r.data.bags as OpenedBag[]).flatMap((b) => b.entries)

/** Resolves once this chat has heard a line with exactly this text, now or later. */
function heardLine(chat: Agent['chat'], text: string): Promise<void> {
  if (chat.lines.some((l) => l.text === text)) return Promise.resolve()
  return new Promise((resolve) => {
    const onLine = (l: { text: string }): void => { if (l.text === text) { chat.off('line', onLine); resolve() } }
    chat.on('line', onLine)
  })
}

describe('an agent on a fresh key', () => {
  const skA = generateSecretKey()
  const dirA = dirWithKey(skA)
  let a: Agent
  let b: Agent

  it('starts, publishes its profile, and reports the canonical relay\'s refusal verbatim', async () => {
    a = await startAgent(dirA, { operator: getPublicKey(generateSecretKey()), name: 'ferryman' })
    expect(a.pubkey).toBe(getPublicKey(skA))
    const r = await a.identity({ about: 'a test agent' })
    expect(r.data.npub).toBe(a.npub)
    const profile = r.data.profile as { status: string; accepted?: string[]; refused?: Record<string, string> }
    expect(profile.status).toBe('published')
    expect(profile.accepted).toEqual(['wss://mine.example/'])
    expect(profile.refused?.['wss://canonical.example/']).toBe('blocked: not a member yet')
    expect(r.text).toContain('blocked: not a member yet')
    expect((r.data.chain as { status: string; rules: string }).status).toBe('none')
    expect((r.data.chain as { rules: string }).rules).toBe('2026-09-28-virtual-brackets')
    expect(r.data.nonDefaultCanonical).toBe(true)
    expect(r.text).toContain('WARNING')
    const kind0 = mine.published.find((e) => e.kind === 0)!
    expect(JSON.parse(kind0.content).bot).toBe(true)
    expect(kind0.tags.find((t) => t[0] === 'p')?.[3]).toBe('operator')
  }, 30_000)

  it('a second server on the same state directory refuses to start', async () => {
    await expect(Agent.start({ stateDir: dirA, relays: [CANONICAL], capCallSeconds: 1, capSessionSeconds: 1, maxSidestepHeight: 24, allowRespawn: false, websocketImplementation: network.WebSocket, calibration: cal })).rejects.toThrow(LockHeldError)
  })

  it('whereami on a fresh key is the spawn coordinate with no chain', async () => {
    const r = await a.whereami()
    expect((r.data.where as { hex: string }).hex).toBe(a.pubkey)
    expect((r.data.chain as { status: string }).status).toBe('none')
  })

  it('plan_hop prices a short hop within the caps', async () => {
    const r = await a.planHop({ target: { dx: 5, dy: 0, dz: 0 } })
    expect(r.data.refused).toBeNull()
    const plan = r.data.plan as { kind: string; landsOnTarget: boolean; expectedSeconds: number }
    expect(plan.kind).toBe('hop')
    expect(plan.landsOnTarget).toBe(true)
    expect(plan.expectedSeconds).toBeLessThan(5)
  })

  it('the first hop spawns, then hops; the chain is valid and on the canonical relay', async () => {
    const r = await a.hop({ target: { dx: 5, dy: 0, dz: 0 } })
    expect(r.text).toContain('signed your spawn')
    expect(r.data.action).toBe('hop')
    expect(r.data.onTarget).toBe(true)
    const home = placeFromHex(a.pubkey)
    expect((r.data.where as { x: string }).x).toBe((home.position.x + 5n).toString())
    expect((r.data.accepted as string[])).toContain('wss://canonical.example/')
    const chain = canonical.all().filter((e) => e.kind === 3333 && e.pubkey === a.pubkey)
    expect(chain.map((e) => e.tags.find((t) => t[0] === 'A')?.[1]).sort()).toEqual(['hop', 'spawn'])
    const where = await a.whereami()
    expect((where.data.chain as { status: string }).status).toBe('valid')
    expect(a.budget.state().moves).toBe(1)
  }, 60_000)

  it('refuses standing still, an unreachable target, and a step the session cap does not allow', async () => {
    await expect(a.hop({ target: { dx: 0 } })).rejects.toThrow(Refusal)
    const far = placeOf({ x: a.here().position.x ^ (1n << 40n), y: a.here().position.y, z: a.here().position.z }, a.here().plane)
    const plan = await a.planHop({ target: far.hex })
    expect(plan.data.refused).toMatch(/across an h41 wall/)
    await expect(a.hop({ target: far.hex })).rejects.toThrow(/across an h41 wall/)
    const spent = a.budget.spentSeconds
    a.budget.spentSeconds = a.budget.capSessionSeconds
    const headBefore = a.keeper.head()!.id
    await expect(a.hop({ target: { dx: 1 } })).rejects.toThrow(/session has/)
    expect(a.keeper.head()!.id).toBe(headBefore)
    a.budget.spentSeconds = spent
  }, 30_000)

  it('refuses a hop when the head moved under it while planning, and adopts the newer move', async () => {
    const head = a.keeper.head()!
    const spawn = a.keeper.chain()[0]
    const to = { x: head.position.x + 1n, y: head.position.y, z: head.position.z }
    const other = signEvent(hopTemplate({ createdAt: head.createdAt + 1, genesisId: spawn.id, previousId: head.id, prevCoordHex: head.coordHex, to, plane: head.plane, proofHash: 'cd'.repeat(32) }), skA)
    canonical.inject(other)
    const r = await a.whereami()
    expect((r.data.chain as { headId: string }).headId).toBe(other.id)
    expect((r.data.where as { x: string }).x).toBe(to.x.toString())
  }, 30_000)

  it('refuses when the head moves while the proof is computed, and discards the proof unsigned', async () => {
    const target = { dx: 2 }
    let other: ReturnType<typeof signEvent> | null = null
    const proto = a as unknown as Record<string, (...args: unknown[]) => unknown>
    const original = proto.prove.bind(a)
    const spy = vi.spyOn(proto, 'prove').mockImplementation((...args: unknown[]) => {
      // Another device signs in as this identity and publishes from the confirmed head while the proof is being computed.
      const head = a.keeper.head()!
      const spawn = a.keeper.chain()[0]
      other = signEvent(hopTemplate({ createdAt: head.createdAt + 1, genesisId: spawn.id, previousId: head.id, prevCoordHex: head.coordHex, to: { x: head.position.x + 7n, y: head.position.y, z: head.position.z }, plane: head.plane, proofHash: 'ef'.repeat(32) }), skA)
      canonical.inject(other)
      return original(...args)
    })
    try {
      const before = a.budget.state().moves
      await expect(a.hop({ target })).rejects.toThrow(/moved while the proof was computed/)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(a.keeper.head()!.id).toBe(other!.id)
      // The proof was work, so it counts; the event it was for was never signed.
      expect(a.budget.state().moves).toBe(before + 1)
      expect(canonical.all().filter((e) => e.kind === 3333 && e.pubkey === a.pubkey).some((e) => e.tags.find((t) => t[0] === 'e' && t[3] === 'previous')?.[1] === other!.id)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  }, 30_000)

  it('hides a message where it stands and finds it again', async () => {
    const r = await a.hide({ contents: { message: 'chalk on the sidewalk' }, coordinate: { dx: 0 }, height: 6, riddle: 'low and near' })
    expect(r.data.entries).toBe(1)
    expect((r.data.accepted as string[])).toEqual(['wss://mine.example/'])
    expect((r.data.refused as Record<string, string>)['wss://canonical.example/']).toBe('blocked: not a member yet')
    const found = await a.find({})
    const bags = found.data.bags as OpenedBag[]
    expect(bags).toHaveLength(1)
    expect(bags[0].entries[0].label).toBe('chalk on the sidewalk')
    expect(bags[0].riddle).toBe('low and near')
    const again = await a.hide({ contents: { message: 'cashuAeyJ0b2tlbiI6W119 for you' }, coordinate: { dx: 0 }, height: 6 })
    expect(again.data.entries).toBe(2)
    expect(again.data.carried).toBe(1)
    expect(mine.all().filter((e) => e.kind === 33330 && e.pubkey === a.pubkey)).toHaveLength(1)
    expect(entriesOf(await a.find({})).some((e) => e.coin)).toBe(true)
  }, 30_000)

  it('prices a key above the passive scan height and spends what it took', async () => {
    const spentBefore = a.budget.spentSeconds
    const found = await a.find({ max_height: 14 })
    expect((found.data.scanned as { heights: number[] }).heights).toEqual([1, 14])
    expect(a.budget.spentSeconds).toBeGreaterThan(spentBefore)
    // Over the session cap, a high key is refused before it is derived.
    const spent = a.budget.spentSeconds
    a.budget.spentSeconds = a.budget.capSessionSeconds
    await expect(a.find({ max_height: 14 })).rejects.toThrow(/session has/)
    await expect(a.hide({ contents: { message: 'x' }, coordinate: { dx: 0 }, height: 13 })).rejects.toThrow(/session has/)
    await expect(a.look({ heights: [13] })).rejects.toThrow(/session has/)
    a.budget.spentSeconds = spent
  }, 60_000)

  it('places a small object inline and validates payloads', async () => {
    const payload = { v: 2, name: 'tetra', unit: 20, mode: 'solid', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], colors: [1, 2, 3, 4], faces: [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]] }
    const v = a.validateObject({ payload })
    expect(v.data.valid).toBe(true)
    const bad = a.validateObject({ payload: { ...payload, faces: [[0, 1, 9]] } })
    expect(bad.data.valid).toBe(false)
    expect((bad.data.errors as string[])[0]).toMatch(/face 0/)
    const placed = await a.place({ object: payload, coordinate: { dx: 0 }, height: 4 })
    expect(placed.data.entries).toBe(1)
    expect(entriesOf(await a.find({})).map((e) => e.type)).toContain('shard')
  }, 30_000)

  it('a second agent standing in the same cube hears what the first says, and the quiet rule holds', async () => {
    const skB = generateSecretKey()
    const pubB = getPublicKey(skB)
    const spawnB = signEvent(spawnTemplate(pubB, 1_700_000_000), skB)
    const here = a.here()
    const beside = { x: here.position.x + 1n, y: here.position.y, z: here.position.z }
    const hopB = signEvent(hopTemplate({ createdAt: Math.floor(Date.now() / 1000), genesisId: spawnB.id, previousId: spawnB.id, prevCoordHex: pubB, to: beside, plane: here.plane, proofHash: 'ef'.repeat(32) }), skB)
    canonical.seed(spawnB)
    canonical.inject(hopB)
    b = await startAgent(dirWithKey(skB), { name: 'echo' })
    const whereB = await b.whereami()
    expect((whereB.data.where as { x: string }).x).toBe(beside.x.toString())
    expect((whereB.data.chain as { status: string }).status).toBe('valid')
    await b.chat.listening()

    const heardByB = heardLine(b.chat, 'hello echo, is anyone here?')
    const said = await a.say({ text: 'hello echo, is anyone here?' })
    expect((said.data.accepted as string[]).length).toBeGreaterThan(0)
    await heardByB
    const heard = b.listen({ since: 0 })
    const lines = heard.data.lines as Array<{ id: string; text: string; from: string; addressed: boolean }>
    expect(lines.map((l) => l.text)).toContain('hello echo, is anyone here?')
    expect(lines.find((l) => l.from === a.pubkey)?.addressed).toBe(true)

    await expect(a.say({ text: 'too soon' })).rejects.toThrow(/Too soon/)
    const bLine = await b.say({ text: 'I am here' })
    expect(bLine.data.unpromptedAllowance).toBe(0)
    b.chat.lastSaidAt = null
    await expect(b.say({ text: 'and here again' })).rejects.toThrow(/quiet rule/)
    const addressed = lines.find((l) => l.addressed)!
    const heardByA = heardLine(a.chat, 'yes, ferryman, I hear you')
    const reply = await b.say({ text: 'yes, ferryman, I hear you', reply_to: addressed.id })
    expect(reply.data.id).toBeTruthy()
    await heardByA
    expect((a.listen({ since: 0 }).data.lines as Array<{ text: string }>).map((l) => l.text)).toContain('yes, ferryman, I hear you')
    const look = await a.look()
    expect((look.data.people as Array<{ pubkey: string }>).map((p) => p.pubkey)).toContain(pubB)
    expect(look.text).toContain('WHO IS HERE')
  }, 60_000)

  it('finds a key item and holds it, and opens chests sealed to the key and to itself, never reporting a secret', async () => {
    const here = a.here()
    await b.hide({ contents: { key: { name: 'lantern', about: 'lights the way' } }, coordinate: here.hex, height: 5 })
    const found = await a.find({})
    const keyEntry = entriesOf(found).find((e) => e.type === 'key')!
    expect(keyEntry.label).toBe('lantern')
    expect(keyEntry.key?.about).toBe('lights the way')
    const itemPubkey = keyEntry.key!.itemPubkey
    const held = a.keys.items.get(itemPubkey)!
    expect(held.secretHex).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(found.data)).not.toContain(held.secretHex)
    expect(found.text).not.toContain(held.secretHex)

    await b.hide({ contents: { chest: { name: 'strongbox', lock: itemPubkey, requires: 'the lantern', entries: [{ message: 'for the lantern bearer' }] } }, coordinate: here.hex, height: 5 })
    await b.hide({ contents: { chest: { name: 'gift', lock: a.npub, entries: [{ message: 'for you, ferryman' }] } }, coordinate: here.hex, height: 5 })
    const again = await a.find({})
    const chests = entriesOf(again).filter((e) => e.type === 'chest')
    expect(chests).toHaveLength(2)
    const byKey = chests.find((c) => c.label === 'strongbox')!
    expect(byKey.chest?.opened).toBe(true)
    expect(byKey.chest?.openedWith).toBe('held item')
    expect(byKey.chest?.contents?.[0]).toMatchObject({ type: 'message', label: 'for the lantern bearer', author: b.pubkey, verified: true })
    const toMe = chests.find((c) => c.label === 'gift')!
    expect(toMe.chest?.opened).toBe(true)
    expect(toMe.chest?.openedWith).toBe('own key')
    expect(again.text).toContain('for you, ferryman')
    // B found its own lantern while scanning (reading is holding), so the strongbox opens for B too; the gift, sealed to A, stays shut.
    const bSees = entriesOf(await b.find({})).filter((e) => e.type === 'chest')
    expect(bSees.find((c) => c.label === 'strongbox')?.chest?.opened).toBe(true)
    expect(bSees.find((c) => c.label === 'gift')?.chest?.opened).toBe(false)
    expect(bSees.find((c) => c.label === 'gift')?.chest?.requires).toBe('an item you have not found')
  }, 60_000)

  it('wait_for resolves on a chat line and times out otherwise', async () => {
    const quick = await a.waitFor({ chat: {}, timeout_seconds: 1 })
    expect(quick.data.happened).toBe('timeout')
    b.chat.lastSaidAt = null
    b.chat.arrival()
    const waiting = a.waitFor({ chat: { addressed: true }, timeout_seconds: 10 })
    await b.say({ text: 'ferryman, over here' })
    const r = await waiting
    expect(r.data.happened).toBe('chat')
    expect((r.data.line as { text: string }).text).toBe('ferryman, over here')
  }, 30_000)

  it('the outbox shows what the canonical relay refused, verbatim', () => {
    const r = a.outboxState()
    const refused = r.data.refused as Array<{ kind: number; refused: Record<string, string> }>
    expect(refused.some((e) => e.kind === 0 && e.refused['wss://canonical.example/'] === 'blocked: not a member yet')).toBe(true)
    expect((r.data.pending as unknown[]).length).toBe(0)
  })

  it('a restart replays the outbox and remembers the chain', async () => {
    const before = a.keeper.head()!.id
    await a.stop()
    agents.splice(agents.indexOf(a), 1)
    a = await startAgent(dirA, { name: 'ferryman' })
    expect(a.keeper.head()?.id).toBe(before)
    const r = await a.whereami()
    expect((r.data.chain as { status: string }).status).toBe('valid')
  }, 30_000)
})
