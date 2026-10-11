// travel.test.ts: the public travel log (agents plan A4; arkinox,
// 2026-10-11), end to end over the fake relays; no real relay is touched.
//
// Off by default and refused in plain words; on only by the human's
// configuration (the flag or config.json), never by the model. When on, a
// kind 1 goes to the agent's own NIP-65 write relays, or, with no relay list,
// to the general relays, after the server publishes a kind 10002 naming them;
// never to the cyberspace relay. It carries the t tag and the place as the
// spec writes places, never the operator (no p tag, no mention) unless the
// human allowed it, and never the operator's private words. Bounded text,
// and a daily limit that a restart does not reset.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { nip19 } from 'nostr-tools'
import * as nip59 from 'nostr-tools/nip59'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Agent, Refusal } from '../src/agent.js'
import { parseArgs, settingsFrom } from '../src/config.js'
import { bytesToHex, nowSeconds, type NostrEvent } from '../src/nostr/event.js'
import { sectorTags, placeFromHex } from '../src/space/coords.js'
import type { Calibration } from '../src/space/calibration.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { normalizeURL } from 'nostr-tools/utils'
import { MAX_TRAVEL_LOG, namesPubkey, repeatsPrivate, type TravelLogSettings } from '../src/travel.js'
import { FakeNetwork, type FakeRelay } from './fakeRelay.js'

const CANONICAL = 'wss://canonical.example'
const MINE = 'wss://mine.example'
const GENERAL = 'wss://general.example'
const GENERAL2 = 'wss://general2.example'
const INBOX = 'wss://inbox.example/'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }

function dirWithKey(sk: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-travel-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
  return dir
}

interface World {
  network: FakeNetwork
  canonical: FakeRelay
  mine: FakeRelay
  general: FakeRelay
  general2: FakeRelay
  inbox: FakeRelay
}

function world(): World {
  const network = new FakeNetwork()
  // The cyberspace relay refuses notes, as onosendai.feeds.relay.tools does.
  const canonical = network.add(CANONICAL, { refuse: (ev) => (ev.kind === 1 || ev.kind === 1059 ? `blocked: kind ${ev.kind} is not accepted here` : null) })
  const mine = network.add(MINE)
  const general = network.add(GENERAL, { requireAuth: false })
  const general2 = network.add(GENERAL2, { requireAuth: false })
  const inbox = network.add(INBOX, { challengeOnReq: true, protectWraps: true, requireAuthToPublish: true })
  return { network, canonical, mine, general, general2, inbox }
}

const running: Agent[] = []
afterAll(async () => { for (const a of running) await a.stop() })

const ON: TravelLogSettings = { enabled: true, maxPerDay: 6, tagOperator: false }

async function start(w: World, dir: string, operator: string, travelLog?: TravelLogSettings): Promise<Agent> {
  const a = await Agent.start({
    stateDir: dir, relays: [CANONICAL, MINE], operator, capCallSeconds: 30, capSessionSeconds: 300, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: w.network.WebSocket, calibration: cal, relayMaxWaitMs: 1500, lookupRelays: [GENERAL, GENERAL2], travelLog,
  })
  running.push(a)
  return a
}

async function stop(a: Agent): Promise<void> {
  await a.stop()
  running.splice(running.indexOf(a), 1)
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try { await p } catch (err) { if (err instanceof Refusal) return err.message; throw err }
  throw new Error('expected a refusal')
}

/** Every EVENT frame the relay received of this kind, accepted or not. */
const framesOf = (relay: FakeRelay, kind: number): NostrEvent[] =>
  relay.received.filter((m) => m[0] === 'EVENT' && (m[1] as NostrEvent).kind === kind).map((m) => m[1] as NostrEvent)

const notesOf = (w: World): NostrEvent[] => [w.canonical, w.mine, w.general, w.general2, w.inbox].flatMap((r) => framesOf(r, 1))

const signed = (sk: Uint8Array, kind: number, tags: string[][], content = '', createdAt = nowSeconds()): NostrEvent =>
  finalizeEvent({ kind, created_at: createdAt, tags, content }, sk) as NostrEvent

describe('the travel log', () => {
  it('is off by default: refused in plain words, nothing posted, no relay list published', async () => {
    const w = world()
    const agentSk = generateSecretKey()
    const op = getPublicKey(generateSecretKey())
    const a = await start(w, dirWithKey(agentSk), op)
    const why = await refusal(a.logTravel({ text: 'Arrived at block 900000.' }))
    expect(why).toContain('travel log is off')
    expect(why).toContain('only your human can turn it on')
    expect(why).toContain('--travel-log')
    await new Promise((r) => setTimeout(r, 100))
    expect(notesOf(w)).toEqual([])
    expect([w.general, w.general2, w.canonical, w.mine].flatMap((r) => framesOf(r, 10002))).toEqual([])
    await stop(a)
  })

  it('posts a kind 1 to the general relays, after publishing a relay list naming them, and never to the cyberspace relay', async () => {
    const w = world()
    const agentSk = generateSecretKey()
    const me = getPublicKey(agentSk)
    const op = getPublicKey(generateSecretKey())
    const a = await start(w, dirWithKey(agentSk), op, ON)
    await a.identity({ name: 'xor' })
    await a.hop({ target: { dx: 5, dy: 0, dz: 0 } })
    const r = await a.logTravel({ text: 'Spawned today and looked around. Quiet sector.' })
    expect(r.data.pending).toBe(false)
    expect((r.data.accepted as string[]).sort()).toEqual([GENERAL, GENERAL2].map((u) => normalizeURL(u)).sort())
    expect(r.text).toContain('public travel log')

    // The relay list the server published for the agent: the general relays, read and write.
    const lists = framesOf(w.general, 10002).filter((e) => e.pubkey === me)
    expect(lists).toHaveLength(1)
    expect(lists[0].tags.filter((t) => t[0] === 'r')).toEqual([['r', GENERAL], ['r', GENERAL2]])
    expect(framesOf(w.canonical, 10002)).toEqual([])

    // The note: on the general relays only.
    const notes = notesOf(w)
    expect(notes.every((n) => n.pubkey === me && n.content === 'Spawned today and looked around. Quiet sector.')).toBe(true)
    expect(framesOf(w.general, 1)).toHaveLength(1)
    expect(framesOf(w.general2, 1)).toHaveLength(1)
    expect(framesOf(w.canonical, 1)).toEqual([])
    expect(framesOf(w.mine, 1)).toEqual([])
    const note = framesOf(w.general, 1)[0]
    expect(note.tags).toContainEqual(['t', 'cyberspace'])
    expect(note.tags).toContainEqual(['client', 'cyberspace-mcp'])
    // The place as the spec writes it: C (the plane is its low bit) and the sector tags from it.
    const here = a.here()
    expect(note.tags).toContainEqual(['C', here.hex])
    for (const t of sectorTags(here.position)) expect(note.tags).toContainEqual(t)
    expect(placeFromHex(here.hex).plane).toBe(here.plane)
    // Never the operator.
    expect(note.tags.some((t) => t[0] === 'p')).toBe(false)
    expect(JSON.stringify(note)).not.toContain(op)

    // place: false leaves the place out.
    await a.logTravel({ text: 'A second entry, no place.', place: false })
    const second = framesOf(w.general, 1).find((n) => n.content === 'A second entry, no place.')!
    expect(second.tags.some((t) => ['C', 'X', 'Y', 'Z', 'S'].includes(t[0]))).toBe(false)
    await stop(a)
  })

  it('uses the agent\'s own write relays from its kind 10002, and publishes no relay list of its own', async () => {
    const w = world()
    const agentSk = generateSecretKey()
    const me = getPublicKey(agentSk)
    const op = getPublicKey(generateSecretKey())
    const WRITE = 'wss://write.example'
    const READ = 'wss://read.example'
    const write = w.network.add(WRITE, { requireAuth: false })
    const read = w.network.add(READ, { requireAuth: false })
    // Its list names the cyberspace relay too, which is skipped: it holds movement, not notes.
    const list = signed(agentSk, 10002, [['r', WRITE, 'write'], ['r', READ, 'read'], ['r', CANONICAL]])
    w.general.seed(list)
    const a = await start(w, dirWithKey(agentSk), op, ON)
    const r = await a.logTravel({ text: 'Rode the line to a stop.' })
    expect(r.data.accepted).toEqual([normalizeURL(WRITE)])
    expect(framesOf(write, 1)).toHaveLength(1)
    expect(framesOf(read, 1)).toEqual([])
    expect(framesOf(w.general, 1)).toEqual([])
    expect(framesOf(w.canonical, 1)).toEqual([])
    expect([w.general, w.general2].flatMap((x) => framesOf(x, 10002)).filter((e) => e.pubkey === me && e.id !== list.id)).toEqual([])
    // No chain yet: no place is claimed.
    expect(framesOf(write, 1)[0].tags.some((t) => t[0] === 'C')).toBe(false)
    await stop(a)
  })

  it('keeps to the daily limit, across a restart; a post no relay took does not count', async () => {
    const w = world()
    const agentSk = generateSecretKey()
    const op = getPublicKey(generateSecretKey())
    const dir = dirWithKey(agentSk)
    let a = await start(w, dir, op, { enabled: true, maxPerDay: 2, tagOperator: false })
    await a.logTravel({ text: 'Entry one.' })
    // Every relay refuses the next: it is refused verbatim and gives its slot back.
    w.general.policy.refuse = (ev) => (ev.kind === 1 ? 'blocked: no notes today' : null)
    w.general2.policy.refuse = (ev) => (ev.kind === 1 ? 'blocked: no notes today' : null)
    const failed = await refusal(a.logTravel({ text: 'Entry that fails.' }))
    expect(failed).toContain('blocked: no notes today')
    expect(failed).toContain('does not count')
    w.general.policy.refuse = () => null
    w.general2.policy.refuse = () => null
    await a.logTravel({ text: 'Entry two.' })
    const over = await refusal(a.logTravel({ text: 'Entry three.' }))
    expect(over).toContain('2 travel log entries in the last 24 hours')
    expect(over).toContain('Nothing was posted')
    await stop(a)
    a = await start(w, dir, op, { enabled: true, maxPerDay: 2, tagOperator: false })
    expect(await refusal(a.logTravel({ text: 'Entry three, after a restart.' }))).toContain('the most your human allows')
    expect(framesOf(w.general, 1).filter((e) => e.content.startsWith('Entry three'))).toEqual([])
    await stop(a)
  })

  it('never names the operator unless the human allowed it, and never repeats their private words', async () => {
    const w = world()
    const opSk = generateSecretKey()
    const op = getPublicKey(opSk)
    const agentSk = generateSecretKey()
    const me = getPublicKey(agentSk)
    w.general.seed(signed(opSk, 10050, [['relay', INBOX]]), signed(opSk, 3, [['p', me]]))
    const dir = dirWithKey(agentSk)
    let a = await start(w, dir, op, ON)
    await a.identity({ name: 'xor' })
    await a.operatorChannel.sync()
    const t0 = nowSeconds()
    w.inbox.seed(
      nip59.wrapEvent({ kind: 14, content: 'Meet me at block 912345 and wait by the eastern stair until I arrive.', tags: [['p', me], ['agent', 'strategy']], created_at: t0 - 20 }, opSk, me) as NostrEvent,
      nip59.wrapEvent({ kind: 14, content: 'The chest code is under the third lamp, keep it secret.', tags: [['p', me]], created_at: t0 - 10 }, opSk, me) as NostrEvent,
    )
    await a.inbox()

    const npub = nip19.npubEncode(op)
    for (const text of [`Traveling with nostr:${npub} today.`, `My human ${npub} says hi.`, `Hello ${op}.`, `See nostr:${nip19.nprofileEncode({ pubkey: op })}`]) {
      expect(await refusal(a.logTravel({ text }))).toContain('names your operator')
    }
    // The STRATEGY and a DM, repeated in other case and spacing, are refused.
    expect(await refusal(a.logTravel({ text: 'Today: MEET ME AT BLOCK 912345 and   wait by the eastern stair. Exciting!' }))).toContain('private words')
    expect(await refusal(a.logTravel({ text: 'Fun fact: the chest code is under the third lamp, keep it secret.' }))).toContain('private words')
    // What it sends privately is private too.
    await a.messageOperator({ text: 'I found a door at the far end of sector nine, it hums.' }).catch(() => {})
    expect(await refusal(a.logTravel({ text: 'News: I found a door at the far end of sector nine, it hums.' }))).toContain('private words')
    expect(notesOf(w)).toEqual([])

    // Its own words go out, still without the operator.
    await a.logTravel({ text: 'Waited by a stair at a busy stop. Saw two bots and a human.' })
    expect(notesOf(w).every((n) => !n.tags.some((t) => t[0] === 'p'))).toBe(true)
    await stop(a)

    // The human allows it: a p tag names the operator, and a mention is allowed.
    a = await start(w, dir, op, { enabled: true, maxPerDay: 6, tagOperator: true })
    await a.logTravel({ text: `Out exploring with nostr:${npub}.` })
    const tagged = framesOf(w.general, 1).find((n) => n.content.startsWith('Out exploring'))!
    expect(tagged.tags).toContainEqual(['p', op])
    await stop(a)
  })

  it('bounds the text', async () => {
    const w = world()
    const a = await start(w, dirWithKey(generateSecretKey()), getPublicKey(generateSecretKey()), ON)
    expect(await refusal(a.logTravel({ text: 'x'.repeat(MAX_TRAVEL_LOG + 1) }))).toContain(`the most is ${MAX_TRAVEL_LOG}`)
    expect(await refusal(a.logTravel({ text: '   ' }))).toContain('empty')
    expect(notesOf(w)).toEqual([])
    const ok = await a.logTravel({ text: 'y'.repeat(MAX_TRAVEL_LOG) })
    expect(ok.data.pending).toBe(false)
    await stop(a)
  })
})

describe('the travel log switch', () => {
  it('is off unless the human turns it on, by the flag or config.json', () => {
    const off = settingsFrom(parseArgs(['--state', '/x']), {})
    expect(off.travelLog).toEqual({ enabled: false, maxPerDay: 6, tagOperator: false })
    expect(settingsFrom(parseArgs(['--state', '/x', '--travel-log']), {}).travelLog.enabled).toBe(true)
    expect(settingsFrom(parseArgs(['--state', '/x', '--travel-log', '--travel-log-max-per-day', '3']), {}).travelLog.maxPerDay).toBe(3)
    const file = settingsFrom(parseArgs(['--state', '/x']), { travelLog: { enabled: true, maxPerDay: 2, tagOperator: true } })
    expect(file.travelLog).toEqual({ enabled: true, maxPerDay: 2, tagOperator: true })
    // Anything but exactly true is off.
    expect(settingsFrom(parseArgs(['--state', '/x']), { travelLog: { enabled: 'yes', tagOperator: 1 } }).travelLog).toEqual({ enabled: false, maxPerDay: 6, tagOperator: false })
    expect(settingsFrom(parseArgs(['--state', '/x']), { travelLog: true }).travelLog.enabled).toBe(false)
  })

  it('finds a mention of a pubkey and a repeat of private words', () => {
    const pk = getPublicKey(generateSecretKey())
    expect(namesPubkey(`hi ${nip19.npubEncode(pk)}`, pk)).toBe(true)
    expect(namesPubkey(`hi ${nip19.npubEncode(getPublicKey(generateSecretKey()))}`, pk)).toBe(false)
    expect(namesPubkey(`look nostr:${nip19.neventEncode({ id: 'ab'.repeat(32), author: pk })}`, pk)).toBe(true)
    expect(namesPubkey(`look nostr:${nip19.naddrEncode({ kind: 33331, pubkey: pk, identifier: 'x' })}`, pk)).toBe(true)
    expect(repeatsPrivate('I will hold now', ['hold'])).toBe(false)
    expect(repeatsPrivate('the eastern stair at dawn, please', ['Go to the eastern stair at dawn, please'])).toBe(false)
    expect(repeatsPrivate('so: the eastern stair at dawn, please and quietly', ['Go to the eastern stair at dawn, please and quietly, then wait'])).toBe(true)
    // A short private text counts whole.
    expect(repeatsPrivate('I was told: ride to block 912345', ['Ride to block 912345'])).toBe(true)
  })
})
