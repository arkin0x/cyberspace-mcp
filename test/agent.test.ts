// agent.test.ts: an agent on a fresh key, end to end over the fake relay.
// It publishes its profile (and reports the canonical relay's refusal
// verbatim), spawns on its first hop, hops a few gibsons, sees where it is,
// says a line that a second agent standing in the same cube hears, hides a
// message and finds it again, places an object, validates one, and refuses
// the unsafe things. A second server on the same state directory refuses to
// start.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Agent, Refusal } from '../src/agent.js'
import { hopTemplate, spawnTemplate } from '../src/chain/builder.js'
import { signEvent } from '../src/nostr/event.js'
import type { Calibration } from '../src/space/calibration.js'
import { placeFromHex, placeOf } from '../src/space/coords.js'
import { LockHeldError, StateDir } from '../src/state/dir.js'
import { FakeNetwork } from './fakeRelay.js'

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }
const fresh = (): string => mkdtempSync(join(tmpdir(), 'cyberspace-mcp-agent-'))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const network = new FakeNetwork()
// The canonical relay's policy as the brief records it: a new key may publish 3333, 33331, 11333 and 23330; kind 0 and 33330 are refused.
const canonical = network.add(CANONICAL, { refuse: (ev) => ([0, 33330, 5, 7, 1111, 10002, 30003].includes(ev.kind) ? 'blocked: not a member yet' : null) })
network.add(MINE)

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

describe('an agent on a fresh key', () => {
  const dirA = fresh()
  let a: Agent

  it('starts, publishes its profile, and reports the canonical relay\'s refusal verbatim', async () => {
    a = await startAgent(dirA, { operator: getPublicKey(generateSecretKey()), name: 'ferryman' })
    const r = await a.identity({ about: 'a test agent' })
    expect(r.data.npub).toBe(a.npub)
    const profile = r.data.profile as { status: string; accepted?: string[]; refused?: Record<string, string> }
    expect(profile.status).toBe('published')
    expect(profile.accepted).toEqual(['wss://mine.example/'])
    expect(profile.refused?.['wss://canonical.example/']).toBe('blocked: not a member yet')
    expect(r.text).toContain('blocked: not a member yet')
    expect((r.data.chain as { status: string }).status).toBe('none')
    // The published kind 0 says bot: true and names the operator.
    const kind0 = network.relays.get('wss://mine.example/')!.published.find((e) => e.kind === 0)!
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

  it('refuses a second spawn and a move the caps do not allow', async () => {
    // Already standing here.
    await expect(a.hop({ target: { dx: 0 } })).rejects.toThrow(Refusal)
    // A wall above the sidestep cap.
    const far = placeOf({ x: a.here().position.x ^ (1n << 40n), y: a.here().position.y, z: a.here().position.z }, a.here().plane)
    const plan = await a.planHop({ target: far.hex })
    expect(plan.data.refused).toMatch(/across an h41 wall/)
    await expect(a.hop({ target: far.hex })).rejects.toThrow(/across an h41 wall/)
    // The session cap spent: any step is refused, and nothing is signed.
    const spent = a.budget.spentSeconds
    a.budget.spentSeconds = a.budget.capSessionSeconds
    const headBefore = a.keeper.head()!.id
    await expect(a.hop({ target: { dx: 1 } })).rejects.toThrow(/session has/)
    expect(a.keeper.head()!.id).toBe(headBefore)
    a.budget.spentSeconds = spent
  }, 30_000)

  it('refuses a hop when the head moved under it, and adopts the newer move', async () => {
    // Another device signed in as this identity publishes a hop from the current head.
    const head = a.keeper.head()!
    const spawn = a.keeper.chain()[0]
    const to = { x: head.position.x + 1n, y: head.position.y, z: head.position.z }
    const sk = (a as unknown as { sk: Uint8Array }).sk
    const other = signEvent(hopTemplate({ createdAt: head.createdAt + 1, genesisId: spawn.id, previousId: head.id, prevCoordHex: head.coordHex, to, plane: head.plane, proofHash: 'cd'.repeat(32) }), sk)
    canonical.inject(other)
    const r = await a.whereami()
    expect((r.data.chain as { headId: string }).headId).toBe(other.id)
    expect((r.data.where as { x: string }).x).toBe(to.x.toString())
  }, 30_000)

  it('hides a message where it stands and finds it again', async () => {
    const r = await a.hide({ contents: { message: 'chalk on the sidewalk' }, coordinate: { dx: 0 }, height: 6, riddle: 'low and near' })
    expect(r.data.entries).toBe(1)
    // The canonical relay refuses bags from new keys; the agent's own relay took it, verbatim reasons kept.
    expect((r.data.accepted as string[])).toEqual(['wss://mine.example/'])
    expect((r.data.refused as Record<string, string>)['wss://canonical.example/']).toBe('blocked: not a member yet')
    const found = await a.find({})
    const bags = found.data.bags as Array<{ entries: Array<{ label: string; type: string }>; riddle: string }>
    expect(bags).toHaveLength(1)
    expect(bags[0].entries[0].label).toBe('chalk on the sidewalk')
    expect(bags[0].riddle).toBe('low and near')
    // A second hide in the same cube merges: one bag, two entries.
    const again = await a.hide({ contents: { message: 'cashuAeyJ0b2tlbiI6W119 for you' }, coordinate: { dx: 0 }, height: 6 })
    expect(again.data.entries).toBe(2)
    expect(again.data.carried).toBe(1)
    const bagsOnRelay = network.relays.get('wss://mine.example/')!.all().filter((e) => e.kind === 33330 && e.pubkey === a.pubkey)
    expect(bagsOnRelay).toHaveLength(1)
    const found2 = await a.find({})
    const entries = (found2.data.bags as Array<{ entries: Array<{ coin?: boolean }> }>)[0].entries
    expect(entries.some((e) => e.coin)).toBe(true)
  }, 30_000)

  it('places a small object inline and validates payloads', async () => {
    const payload = { v: 2, name: 'tetra', unit: 20, mode: 'solid', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], colors: [1, 2, 3, 4], faces: [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]] }
    const v = a.validateObject({ payload })
    expect(v.data.valid).toBe(true)
    const bad = a.validateObject({ payload: { ...payload, faces: [[0, 1, 9]] } })
    expect(bad.data.valid).toBe(false)
    expect((bad.data.errors as string[])[0]).toMatch(/face 0/)
    // At the agent's own position: an h4 cube two gibsons over can be a different cube, which the scan around the agent would rightly not find.
    const placed = await a.place({ object: payload, coordinate: { dx: 0 }, height: 4 })
    expect(placed.data.entries).toBe(1)
    const found = await a.find({})
    const kinds = (found.data.bags as Array<{ entries: Array<{ type: string }> }>).flatMap((b) => b.entries.map((e) => e.type))
    expect(kinds).toContain('shard')
  }, 30_000)

  it('a second agent standing in the same cube hears what the first says, and the quiet rule holds', async () => {
    // Agent B's chain is seeded on the relays: a spawn and a hop to a point beside A (the relay does not check proofs).
    const skB = generateSecretKey()
    const pubB = getPublicKey(skB)
    const homeB = placeFromHex(pubB)
    const spawnB = signEvent(spawnTemplate(pubB, 1_700_000_000), skB)
    const here = a.here()
    const beside = { x: here.position.x + 1n, y: here.position.y, z: here.position.z }
    const hopB = signEvent(hopTemplate({ createdAt: Math.floor(Date.now() / 1000), genesisId: spawnB.id, previousId: spawnB.id, prevCoordHex: pubB, to: beside, plane: here.plane, proofHash: 'ef'.repeat(32) }), skB)
    canonical.seed(spawnB)
    // B's other client publishes the hop: the relay fans it out to A's neighborhood subscription.
    canonical.inject(hopB)
    expect(homeB.hex).not.toBe(here.hex)
    const dirB = fresh()
    StateDir.open(dirB)
    // B's key file is written so that B is that identity.
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dirB, 'key'), Buffer.from(skB).toString('hex'), { mode: 0o600 })
    const b = await startAgent(dirB, { name: 'echo' })
    const whereB = await b.whereami()
    expect((whereB.data.where as { x: string }).x).toBe(beside.x.toString())
    expect((whereB.data.chain as { status: string }).status).toBe('valid')
    await sleep(300)

    const said = await a.say({ text: 'hello echo, is anyone here?' })
    expect((said.data.accepted as string[]).length).toBeGreaterThan(0)
    await sleep(300)
    const heard = b.listen({ since: 0 })
    const lines = heard.data.lines as Array<{ text: string; from: string; addressed: boolean }>
    expect(lines.map((l) => l.text)).toContain('hello echo, is anyone here?')
    expect(lines.find((l) => l.from === a.pubkey)?.addressed).toBe(true)

    // Rate rule: a second line within five seconds is refused.
    await expect(a.say({ text: 'too soon' })).rejects.toThrow(/Too soon/)
    // Quiet rule: B's one unprompted line is allowed, the next is not; a reply to the line that addressed it is.
    const bLine = await b.say({ text: 'I am here' })
    expect(bLine.data.unpromptedAllowance).toBe(0)
    ;(b.chat as unknown as { lastSaidAt: number | null }).lastSaidAt = null
    await expect(b.say({ text: 'and here again' })).rejects.toThrow(/quiet rule/)
    const addressed = lines.find((l) => l.addressed)!
    const reply = await b.say({ text: 'yes, ferryman, I hear you', reply_to: (heard.data.lines as Array<{ id: string; text: string }>).find((l) => l.text === addressed.text)!.id })
    expect(reply.data.id).toBeTruthy()
    await sleep(300)
    const aHeard = a.listen({ since: 0 })
    expect((aHeard.data.lines as Array<{ text: string }>).map((l) => l.text)).toContain('yes, ferryman, I hear you')
    // Presence: each sees the other within the 27 sectors.
    const look = await a.look()
    expect((look.data.people as Array<{ pubkey: string }>).map((p) => p.pubkey)).toContain(pubB)
    expect(look.text).toContain('WHO IS HERE')
  }, 60_000)

  it('wait_for resolves on a chat line and times out otherwise', async () => {
    const quick = await a.waitFor({ chat: {}, timeout_seconds: 1 })
    expect(quick.data.happened).toBe('timeout')
    const b = agents[agents.length - 1]
    ;(b.chat as unknown as { lastSaidAt: number | null }).lastSaidAt = null
    b.chat.arrival()
    const waiting = a.waitFor({ chat: { addressed: true }, timeout_seconds: 10 })
    await sleep(200)
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
