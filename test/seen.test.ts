// seen.test.ts: the agent's 👀 on its operator's orders, and the notices
// every tool result carries (arkinox, 2026-10-12: "when I send my agent a
// message, can we have him ALWAYS react to the message with an 👀 emoji
// immediately when he sees it"; "Anything we can do to improve the
// performance of the chat and responsiveness of the agent. Let's do it.").
// The server's own poll finds an order with no tool called, and sends one
// kind 7 rumor per order, sealed and gift-wrapped like a message, to the
// operator's DM relays with a copy to itself: never twice (a second wrap, a
// reread, a restart), never to a stranger, the agent's own copies, a
// reaction, or a message that waits for the operator's follow. A failed send
// is retried once, in the background. Every tool result says NEW ORDERS until
// inbox reads them. Fake relays only.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import * as nip17 from 'nostr-tools/nip17'
import * as nip59 from 'nostr-tools/nip59'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Agent } from '../src/agent.js'
import { createReactionRumor, createRumor, sealRumor, wrapSeal } from '../src/nostr/dm.js'
import { bytesToHex, nowSeconds, type NostrEvent } from '../src/nostr/event.js'
import { createServer } from '../src/server.js'
import type { Calibration } from '../src/space/calibration.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork, type FakeRelay } from './fakeRelay.js'

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'
const GENERAL = 'wss://general.example'
const INBOX = 'wss://inbox.example/'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }

function dirWithKey(sk: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-seen-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
  return dir
}

interface World { network: FakeNetwork; general: FakeRelay; inbox: FakeRelay }

function world(): World {
  const network = new FakeNetwork()
  network.add(CANONICAL, { refuse: (ev) => (ev.kind === 1059 ? 'blocked: kind 1059 is not accepted here' : null) })
  network.add(MINE)
  const general = network.add(GENERAL, { requireAuth: false })
  const inbox = network.add(INBOX, { challengeOnReq: true, protectWraps: true, requireAuthToPublish: true })
  return { network, general, inbox }
}

const running: Agent[] = []
afterAll(async () => { for (const a of running) await a.stop() })

async function start(w: World, dir: string, operator: string, more: { ordersPollMs?: number; reactionRetryMs?: number; log?: (l: string) => void } = {}): Promise<Agent> {
  const a = await Agent.start({
    stateDir: dir, relays: [CANONICAL, MINE], operator, capCallSeconds: 30, capSessionSeconds: 120, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: w.network.WebSocket, calibration: cal, relayMaxWaitMs: 1500, lookupRelays: [GENERAL], ...more,
  })
  running.push(a)
  return a
}

async function stop(a: Agent): Promise<void> {
  await a.stop()
  running.splice(running.indexOf(a), 1)
}

const sign = (sk: Uint8Array, kind: number, tags: string[][], createdAt = nowSeconds()): NostrEvent =>
  finalizeEvent({ kind, created_at: createdAt, tags, content: '' }, sk) as NostrEvent

/** Every rumor wrapped to `reader` on this relay, opened with its key. */
function rumorsFor(relay: FakeRelay, readerSk: Uint8Array): Array<{ kind: number; pubkey: string; tags: string[][]; content: string; id: string }> {
  const reader = getPublicKey(readerSk)
  return relay.published
    .filter((e) => e.kind === 1059 && e.tags.some((t) => t[0] === 'p' && t[1] === reader))
    .map((e) => nip59.unwrapEvent(e as Parameters<typeof nip59.unwrapEvent>[0], readerSk))
}

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('the 👀 on each order (arkinox, 2026-10-12)', () => {
  it('the server\'s own poll reacts once per order with no tool called: exact shape, a self copy, never twice, never to strangers', async () => {
    const w = world()
    const opSk = generateSecretKey()
    const op = getPublicKey(opSk)
    const agentSk = generateSecretKey()
    const me = getPublicKey(agentSk)
    const strangerSk = generateSecretKey()
    w.general.seed(sign(opSk, 10050, [['relay', INBOX]]), sign(opSk, 3, [['p', me]]))
    const dir = dirWithKey(agentSk)
    const logs: string[] = []
    let a = await start(w, dir, op, { ordersPollMs: 100, log: (l) => logs.push(l) })
    await a.identity({ name: 'courier' })

    const t0 = nowSeconds()
    const order = createRumor({ senderPubkey: op, recipient: me, text: 'secret plan: meet at block 900000', createdAt: t0 - 5 })
    const strategy = createRumor({ senderPubkey: op, recipient: me, text: 'and a STRATEGY', strategy: true, createdAt: t0 - 3 })
    w.inbox.seed(
      // One order in two wraps: one 👀.
      wrapSeal(sealRumor(order, opSk, me, t0), me, t0),
      wrapSeal(sealRumor(order, opSk, me, t0 - 1), me, t0 - 1),
      wrapSeal(sealRumor(strategy, opSk, me, t0), me, t0),
      // A stranger, a stranger's forgery of the operator, and the operator's own reaction to something the agent said: none gets eyes.
      nip17.wrapEvent(strangerSk, { publicKey: me }, 'a stranger') as NostrEvent,
      wrapSeal(sealRumor(createRumor({ senderPubkey: op, recipient: me, text: 'forged', createdAt: t0 }), strangerSk, me, t0), me, t0),
      wrapSeal(sealRumor(createReactionRumor({ senderPubkey: op, recipient: me, eventId: 'a'.repeat(64), createdAt: t0 }), opSk, me, t0), me, t0),
    )

    // No tool is called: the poll finds both orders and reacts.
    await until(() => rumorsFor(w.inbox, opSk).filter((r) => r.kind === 7).length >= 2)
    await a.operatorChannel.reactionsSettled()
    const reactions = rumorsFor(w.inbox, opSk).filter((r) => r.kind === 7)
    expect(reactions).toHaveLength(2)
    const strategyId = strategy.id
    expect(reactions.map((r) => r.tags[0][1]).sort()).toEqual([order.id, strategyId].sort())
    for (const r of reactions) {
      expect(r.pubkey).toBe(me)
      expect(r.content).toBe('👀')
      expect(r.tags).toEqual([['e', r.tags[0][1]], ['p', op]])
    }
    // The agent's own copies, on its DM relays (the operator's set, which it copied).
    expect(rumorsFor(w.inbox, agentSk).filter((r) => r.kind === 7 && r.pubkey === me)).toHaveLength(2)
    // Marked in the state directory by id, with no words of any message.
    const dms = readFileSync(join(dir, 'dms.json'), 'utf8')
    expect(Object.keys(JSON.parse(dms).reacted).sort()).toEqual([order.id, strategyId].sort())
    expect(dms).not.toContain('secret plan')
    expect(logs.join('\n')).not.toContain('secret plan')
    expect(logs.some((l) => l.startsWith(`👀 sent for ${order.id.slice(0, 8)}`))).toBe(true)

    // orders_waiting and inbox see the same orders: no second 👀; the agent's own copies are neither orders nor strangers.
    expect((await a.ordersWaiting()).data.orders).toBe(2)
    const read = await a.inbox()
    expect((read.data.messages as unknown[])).toHaveLength(2)
    expect(read.data.ignored).toBe(2)
    await a.operatorChannel.reactionsSettled()
    expect(rumorsFor(w.inbox, opSk).filter((r) => r.kind === 7)).toHaveLength(2)
    const reread = await a.inbox()
    expect(reread.data.ignored).toBe(0)

    // A restart, a third wrap of the same order, a fresh read: still two.
    await stop(a)
    a = await start(w, dir, op, { ordersPollMs: 100 })
    w.inbox.seed(wrapSeal(sealRumor(order, opSk, me, t0 - 2), me, t0 - 2))
    await a.ordersWaiting()
    await a.inbox()
    await new Promise((r) => setTimeout(r, 400))
    await a.operatorChannel.reactionsSettled()
    expect(rumorsFor(w.inbox, opSk).filter((r) => r.kind === 7)).toHaveLength(2)
    await stop(a)
  }, 60_000)

  it('no eyes while the operator does not follow the agent; they come when the follow does', async () => {
    const w = world()
    const opSk = generateSecretKey()
    const op = getPublicKey(opSk)
    const agentSk = generateSecretKey()
    const me = getPublicKey(agentSk)
    w.general.seed(sign(opSk, 10050, [['relay', INBOX]]), sign(opSk, 3, [['p', getPublicKey(generateSecretKey())]], nowSeconds() - 100))
    const a = await start(w, dirWithKey(agentSk), op, { ordersPollMs: 0 })
    await a.identity({})
    w.inbox.seed(nip17.wrapEvent(opSk, { publicKey: me }, 'are you there?') as NostrEvent)
    expect((await a.ordersWaiting()).data.waitingForFollow).toBe(1)
    expect((await a.inbox()).data.waitingForFollow).toBe(1)
    await a.operatorChannel.reactionsSettled()
    expect(rumorsFor(w.inbox, opSk).filter((r) => r.kind === 7)).toHaveLength(0)

    w.general.seed(sign(opSk, 3, [['p', me]]))
    expect((await a.inbox()).data.messages).toHaveLength(1)
    await a.operatorChannel.reactionsSettled()
    expect(rumorsFor(w.inbox, opSk).filter((r) => r.kind === 7)).toHaveLength(1)
    await stop(a)
  }, 60_000)

  it('a send that fails is retried once in the background, and orders_waiting never waits for it', async () => {
    const w = world()
    const opSk = generateSecretKey()
    const op = getPublicKey(opSk)
    const agentSk = generateSecretKey()
    const me = getPublicKey(agentSk)
    w.general.seed(sign(opSk, 10050, [['relay', INBOX]]), sign(opSk, 3, [['p', me]]))
    const logs: string[] = []
    const a = await start(w, dirWithKey(agentSk), op, { ordersPollMs: 0, reactionRetryMs: 300, log: (l) => logs.push(l) })
    await a.identity({})
    await a.operatorChannel.sync()

    // The operator's inbox refuses the first wrap addressed to the operator, then takes the next.
    let refusals = 1
    const before = w.inbox.policy.refuse
    w.inbox.policy.refuse = (ev) => (ev.kind === 1059 && ev.tags.some((t) => t[1] === op) && refusals-- > 0 ? 'error: try again later' : before(ev))
    w.inbox.seed(nip17.wrapEvent(opSk, { publicKey: me }, 'first') as NostrEvent)
    const t0 = Date.now()
    expect((await a.ordersWaiting()).data.orders).toBe(1)
    // Answered without waiting out the retry.
    expect(Date.now() - t0).toBeLessThan(300)
    await a.operatorChannel.reactionsSettled()
    expect(rumorsFor(w.inbox, opSk).filter((r) => r.kind === 7)).toHaveLength(1)
    expect(logs.some((l) => /not delivered \(attempt 1 of 2\): .*try again later/.test(l))).toBe(true)

    // Refused for good: two attempts, logged, and never a third.
    w.inbox.policy.refuse = (ev) => (ev.kind === 1059 && ev.tags.some((t) => t[1] === op) ? 'blocked: no' : before(ev))
    w.inbox.seed(nip17.wrapEvent(opSk, { publicKey: me }, 'second') as NostrEvent)
    await a.ordersWaiting()
    await a.operatorChannel.reactionsSettled()
    expect(logs.filter((l) => /not delivered \(attempt [12] of 2\): .*blocked: no/.test(l))).toHaveLength(2)
    await a.ordersWaiting()
    await a.operatorChannel.reactionsSettled()
    expect(logs.filter((l) => /blocked: no/.test(l))).toHaveLength(2)
    await stop(a)
  }, 60_000)
})

describe('NEW ORDERS on every tool result (arkinox, 2026-10-12)', () => {
  it('appears on an unrelated tool, ends a wait, and disappears after inbox', async () => {
    const w = world()
    const opSk = generateSecretKey()
    const op = getPublicKey(opSk)
    const agentSk = generateSecretKey()
    const me = getPublicKey(agentSk)
    w.general.seed(sign(opSk, 10050, [['relay', INBOX]]), sign(opSk, 3, [['p', me]]))
    const a = await start(w, dirWithKey(agentSk), op, { ordersPollMs: 100 })
    const server = createServer(a)
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientSide)
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ text: string; data: Record<string, unknown> }> => {
      const r = await client.callTool({ name, arguments: args })
      return { text: (r.content as Array<{ text: string }>).map((c) => c.text).join('\n'), data: (r.structuredContent ?? {}) as Record<string, unknown> }
    }
    await call('identity', {})
    const quiet = await call('budget')
    expect(quiet.text).not.toContain('NEW ORDERS')
    expect(quiet.data.newOrders).toBeUndefined()

    // A wait that would last a minute ends when the poll finds an order.
    const waiting = call('wait_for', { chat: { addressed: true }, timeout_seconds: 60 })
    await new Promise((r) => setTimeout(r, 200))
    w.inbox.seed(nip17.wrapEvent(opSk, { publicKey: me }, 'drop everything and come home') as NostrEvent)
    const ended = await waiting
    expect(ended.data.happened).toBe('orders')
    expect(ended.text).toContain('Call inbox now')

    const busy = await call('budget')
    expect(busy.text).toContain('NEW ORDERS: 1 message(s) from your operator wait. Call inbox now, before continuing.')
    expect(busy.data.newOrders).toBe(1)
    expect(busy.text).not.toContain('come home')
    // A refusal carries it too.
    const refused = await call('render', {})
    expect(refused.text).toContain('REFUSED')
    expect(refused.text).toContain('NEW ORDERS')

    const read = await call('inbox')
    expect(read.text).toContain('drop everything and come home')
    // The 👀 says it arrived; this asks the agent to say it understood before long work (arkinox, 2026-10-12).
    expect(read.text).toContain('Before starting work that takes more than a minute, reply to your operator with message_operator saying what you are about to do.')
    const after = await call('budget')
    expect(after.text).not.toContain('NEW ORDERS')
    expect(after.data.newOrders).toBeUndefined()
    await client.close()
    await stop(a)
  }, 60_000)
})
