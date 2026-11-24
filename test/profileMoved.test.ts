// profileMoved.test.ts: an agent whose profile only older relays hold
// publishes it again on its current ones (the owner's agents panel,
// 2026-11-24: MY AGENTS reads the canonical relay, and an agent set up on the
// old defaults, before #95, had its profile only on cyberspace.nostr1.com
// and onosendai.feeds.relay.tools). identity publishes it again instead of
// saying "unchanged", and serve does it at start without any call. Still
// unchanged while a configured relay holds it; never retried after a
// refusal; never while the profile names another operator.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Agent } from '../src/agent.js'
import { bytesToHex } from '../src/nostr/event.js'
import type { Calibration } from '../src/space/calibration.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork, type FakeRelay } from './fakeRelay.js'

const OLD = 'wss://old.example'
const NEW = 'wss://new.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }

function dirWithKey(sk: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-moved-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
  return dir
}

const running: Agent[] = []
afterEach(async () => { while (running.length) await running.pop()!.stop() })

const relaysOf = new WeakMap<FakeNetwork, Map<string, FakeRelay>>()
function world(newRelay: 'ok' | 'refuses' | 'down' = 'ok'): FakeNetwork {
  const network = new FakeNetwork()
  relaysOf.set(network, new Map([
    [OLD, network.add(OLD)],
    [NEW, network.add(NEW, newRelay === 'refuses' ? { refuse: (ev) => (ev.kind === 0 ? 'blocked: not a member yet' : null) } : newRelay === 'down' ? { reachable: false } : {})],
  ]))
  return network
}

const profileFile = (dir: string) => StateDir.open(dir).readJson<{ content: string; accepted: string[]; refused: Record<string, string> } | null>('profile.json', null)!

async function start(network: FakeNetwork, dir: string, relays: string[], operator: string): Promise<Agent> {
  const a = await Agent.start({
    stateDir: dir, relays, operator, capCallSeconds: 30, capSessionSeconds: 120, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1500, ordersPollMs: 0,
  } as Parameters<typeof Agent.start>[0])
  running.push(a)
  return a
}

/**
 * An agent that published its profile on OLD only, then was stopped: its
 * state directory. `forgotten`: the outbox no longer holds the profile event
 * (it keeps 50 settled events, so an agent that has moved since has long
 * dropped it), so no replay carries it anywhere.
 */
async function publishedOnOld(network: FakeNetwork, operator: string, forgotten = true): Promise<string> {
  const dir = dirWithKey(generateSecretKey())
  const a = await start(network, dir, [OLD], operator)
  const r = await a.identity({ name: 'courier' })
  expect((r.data.profile as { status: string; accepted: string[] }).accepted).toEqual([`${OLD}/`])
  await running.pop()!.stop()
  if (forgotten) writeFileSync(join(dir, 'outbox.json'), JSON.stringify({ version: 1, entries: [] }))
  return dir
}

const profilesOn = (network: FakeNetwork, url: string, pubkey: string) => relaysOf.get(network)!.get(url)!.published.filter((e) => e.kind === 0 && e.pubkey === pubkey)

describe('a profile only older relays hold', () => {
  it('identity publishes it again on the current relays, the same content and operator', async () => {
    const network = world()
    const op = getPublicKey(generateSecretKey())
    const dir = await publishedOnOld(network, op)
    const a = await start(network, dir, [NEW], op)
    const r = await a.identity({})
    const profile = r.data.profile as { status: string; accepted: string[] }
    expect(profile.status).toBe('published')
    expect(profile.accepted).toEqual([`${NEW}/`])
    const [onNew] = profilesOn(network, NEW, a.pubkey)
    const [onOld] = profilesOn(network, OLD, a.pubkey)
    expect(onNew.content).toBe(onOld.content)
    expect(onNew.tags).toContainEqual(['p', op, '', 'operator'])
    // And it is not published a third time: the current relay holds it now.
    expect(((await a.identity({})).data.profile as { status: string }).status).toBe('unchanged')
  })

  it('stays unchanged while a configured relay still holds it', async () => {
    const network = world()
    const op = getPublicKey(generateSecretKey())
    const dir = await publishedOnOld(network, op)
    const a = await start(network, dir, [NEW, OLD], op)
    expect(((await a.identity({})).data.profile as { status: string }).status).toBe('unchanged')
    expect(await a.republishProfileIfMoved()).toEqual({ status: 'unneeded' })
    expect(profilesOn(network, NEW, a.pubkey)).toHaveLength(0)
  })

  it('while the outbox still holds it, its replay carries the same event to the current relay: nothing is signed again', async () => {
    const network = world()
    const op = getPublicKey(generateSecretKey())
    const dir = await publishedOnOld(network, op, false)
    const a = await start(network, dir, [NEW], op)
    const [onOld] = profilesOn(network, OLD, a.pubkey)
    expect(profilesOn(network, NEW, a.pubkey).map((e) => e.id)).toEqual([onOld.id])
    expect(await a.republishProfileIfMoved()).toEqual({ status: 'unneeded' })
    expect(((await a.identity({})).data.profile as { status: string }).status).toBe('unchanged')
    expect(profilesOn(network, NEW, a.pubkey)).toHaveLength(1)
    // profile.json names the current relay too, so doctor does.
    expect(StateDir.open(dir).readJson<{ accepted: string[] }>('profile.json', { accepted: [] }).accepted).toContain(`${NEW}/`)
  })

  it('at serve start, without a call: published once, then nothing more to do', async () => {
    const network = world()
    const op = getPublicKey(generateSecretKey())
    const dir = await publishedOnOld(network, op)
    const a = await start(network, dir, [NEW], op)
    const r = await a.republishProfileIfMoved()
    expect(r).toMatchObject({ status: 'published', accepted: [`${NEW}/`] })
    expect(profilesOn(network, NEW, a.pubkey)).toHaveLength(1)
    expect(await a.republishProfileIfMoved()).toEqual({ status: 'unneeded' })
    expect(profilesOn(network, NEW, a.pubkey)).toHaveLength(1)
  })

  it('a refusal on the current relays is reported, keeps the old acceptance, and is not retried at the next start', async () => {
    const network = world('refuses')
    const op = getPublicKey(generateSecretKey())
    const dir = await publishedOnOld(network, op)
    const a = await start(network, dir, [NEW], op)
    expect(await a.republishProfileIfMoved()).toMatchObject({ status: 'refused' })
    // profile.json still says where it is (doctor, visit), and notes the refusal.
    expect(profileFile(dir).accepted).toEqual([`${OLD}/`])
    expect(profileFile(dir).refused[`${NEW}/`]).toBe('blocked: not a member yet')
    await running.pop()!.stop()
    const b = await start(network, dir, [NEW], op)
    expect(await b.republishProfileIfMoved()).toEqual({ status: 'unneeded' })
  })

  it('a start with the current relays unreachable keeps profile.json as it was, and tries again next time', async () => {
    const network = world('down')
    const op = getPublicKey(generateSecretKey())
    const dir = await publishedOnOld(network, op)
    const a = await start(network, dir, [NEW], op)
    expect(await a.republishProfileIfMoved()).toMatchObject({ status: 'refused' })
    expect(profileFile(dir).accepted).toEqual([`${OLD}/`])
    expect(profileFile(dir).refused[`${NEW}/`]).toBeUndefined()
  })

  it('identity called while the startup republish runs waits for it, and its edit stands', async () => {
    const network = world()
    const op = getPublicKey(generateSecretKey())
    const dir = await publishedOnOld(network, op)
    const a = await start(network, dir, [NEW], op)
    const republish = a.republishProfileIfMoved()
    const r = await a.identity({ about: 'a newer about' })
    await republish
    expect((r.data.profile as { status: string }).status).toBe('published')
    expect(JSON.parse(profileFile(dir).content).about).toBe('a newer about')
    // The newest profile on the current relay is the edit.
    const newest = profilesOn(network, NEW, a.pubkey).sort((x, y) => y.created_at - x.created_at || (x.id < y.id ? 1 : -1))[0]
    expect(JSON.parse(newest.content).about).toBe('a newer about')
  })

  it('never while the profile names another operator than the configured one', async () => {
    const network = world()
    const dir = await publishedOnOld(network, getPublicKey(generateSecretKey()))
    const a = await start(network, dir, [NEW], getPublicKey(generateSecretKey()))
    expect(await a.republishProfileIfMoved()).toEqual({ status: 'unneeded' })
    expect(profilesOn(network, NEW, a.pubkey)).toHaveLength(0)
  })

  it('never for an agent that never published one', async () => {
    const network = world()
    const a = await start(network, dirWithKey(generateSecretKey()), [NEW], getPublicKey(generateSecretKey()))
    expect(await a.republishProfileIfMoved()).toEqual({ status: 'unneeded' })
  })
})
