// proofWorker.test.ts: the proof of a step on a worker thread (2026-11-09,
// audit B5). The thread computes exactly what the main thread did; while a
// hop's proof computes (a real h17 proof, a few seconds here; never above
// h20), other tools answer and progress goes out; a head moved meanwhile is
// still caught before signing; a cancellation, from the caller or from the
// client over MCP, stops the thread and signs nothing; and stopping the
// server stops a proof in flight. Every relay is the fake one.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { AXIS_CENTER } from 'cyberspace-core'
import { afterAll, describe, expect, it } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { Agent, Refusal } from '../src/agent.js'
import { hopTemplate } from '../src/chain/builder.js'
import { ProofAborted, computeProof, proveInThread, type ProofJob } from '../src/chain/proofWorker.js'
import { bytesToHex, signEvent, type NostrEvent } from '../src/nostr/event.js'
import { createServer } from '../src/server.js'
import type { Calibration } from '../src/space/calibration.js'
import { KEY_GENERATED_BY, StateDir } from '../src/state/dir.js'
import { FakeNetwork, type FakeRelay } from './fakeRelay.js'
import { fakeHopProof } from './fakeHop.js'

const CANONICAL = 'wss://canonical.example'
const cal: Calibration = { version: 1, at: Date.now(), fingerprint: 'test', cantorMsByHeight: { 12: 10, 14: 60, 16: 400 }, sha256PerSec: 2_000_000 }
/**
 * A target that differs from the head only in bit 16 of x: an h17 hop
 * exactly, whatever the spawn's bits (a plain dx could cross a far higher
 * boundary). A few seconds of real work here, well under h20.
 */
function far(a: Agent): { x: string; y: string; z: string; plane: 0 | 1 } {
  const h = a.keeper.head()!
  return { x: (h.position.x ^ (1n << 16n)).toString(), y: h.position.y.toString(), z: h.position.z.toString(), plane: h.plane }
}

const running: Agent[] = []
afterAll(async () => { for (const a of running) await a.stop() })

async function start(): Promise<{ a: Agent; sk: Uint8Array; canonical: FakeRelay }> {
  const network = new FakeNetwork()
  const canonical = network.add(CANONICAL)
  const sk = generateSecretKey()
  const dir = mkdtempSync(join(tmpdir(), 'cyberspace-mcp-proof-'))
  StateDir.open(dir)
  writeFileSync(join(dir, 'key'), JSON.stringify({ generatedBy: KEY_GENERATED_BY, secret: bytesToHex(sk), createdAt: 'test' }), { mode: 0o600 })
  const a = await Agent.start({
    stateDir: dir, relays: [CANONICAL], capCallSeconds: 60, capSessionSeconds: 600, maxSidestepHeight: 24, allowRespawn: false,
    websocketImplementation: network.WebSocket, calibration: cal, relayMaxWaitMs: 1000,
  })
  running.push(a)
  // The spawn and one short hop, so the next hop is a plain hop.
  await a.hop({ target: { dx: 1 } })
  return { a, sk, canonical }
}

const moves = (relay: FakeRelay, pubkey: string): NostrEvent[] => relay.published.filter((e) => e.kind === 3333 && e.pubkey === pubkey)

/** Resolves once the progress callback has heard a phase containing `words`. */
function hearing(words: string): { progress: (phase: string) => Promise<void>; heard: Promise<number>; phases: string[] } {
  let hit: (at: number) => void = () => {}
  const heard = new Promise<number>((resolve) => { hit = resolve })
  const phases: string[] = []
  return { progress: async (phase) => { phases.push(phase); if (phase.includes(words)) hit(performance.now()) }, heard, phases }
}

describe('the proof thread', () => {
  it('computes what the main thread computes: a hop, a sidestep, an entry proof', async () => {
    const c = AXIS_CENTER.toString()
    const id = 'ab'.repeat(32)
    const jobs: ProofJob[] = [
      { kind: 'hop', from: [c, c, c], to: [(AXIS_CENTER + 300n).toString(), c, c], plane: 0, previousId: id, maxComputeHeight: 20 },
      { kind: 'sidestep', from: [c, c, c], to: [(AXIS_CENTER + 5n).toString(), c, c], plane: 0, previousId: id },
      { kind: 'enter', coordHex: 'cd'.repeat(32), previousId: id },
    ]
    for (const job of jobs) expect(await proveInThread(job)).toEqual(computeProof(job))
  }, 60_000)

  it('rejects at once with ProofAborted when its signal aborts, and before starting when it already has', async () => {
    const c = AXIS_CENTER.toString()
    const job: ProofJob = { kind: 'hop', from: [c, c, c], to: [(AXIS_CENTER + 2n ** 16n).toString(), c, c], plane: 0, previousId: 'ab'.repeat(32), maxComputeHeight: 20 }
    const controller = new AbortController()
    const p = proveInThread(job, controller.signal)
    setTimeout(() => controller.abort(), 300)
    const t0 = performance.now()
    await expect(p).rejects.toBeInstanceOf(ProofAborted)
    expect(performance.now() - t0).toBeLessThan(1500)
    await expect(proveInThread(job, AbortSignal.abort())).rejects.toBeInstanceOf(ProofAborted)
  }, 30_000)
})

describe('a hop whose proof runs on its thread', () => {
  it('lets other tools answer and progress go out while it computes, then signs a hop that passes Level 1', async () => {
    const { a, canonical } = await start()
    const before = moves(canonical, a.pubkey).length
    const p = hearing('computing the proof')
    let hopDone = false
    const hop = a.hop({ target: far(a) }, p.progress).finally(() => { hopDone = true })
    await p.heard
    expect(p.phases[0]).toContain('other tools keep answering meanwhile')
    // The main thread is free: these answer while the proof computes.
    const where = await a.whereami()
    expect(where.text).toContain('You stand at')
    expect(a.budgetState().text).toContain('Work:')
    expect(hopDone).toBe(false)
    const r = await hop
    expect(r.data.action).toBe('hop')
    expect(r.text).toContain('(h17,')
    expect(p.phases.some((ph) => ph.startsWith('proof done'))).toBe(true)
    // The agent verified it at Level 1 before sending (hopEventProblems); it is on the relay.
    expect(moves(canonical, a.pubkey).length).toBe(before + 1)
  }, 60_000)

  it('still confirms the head before signing: a move from another device during the proof is adopted and the proof discarded', async () => {
    const { a, sk, canonical } = await start()
    const p = hearing('computing the proof')
    const hop = a.hop({ target: far(a) }, p.progress)
    await p.heard
    const head = a.keeper.head()!
    const spawn = a.keeper.chain()[0]
    const other = signEvent(hopTemplate({ createdAt: head.createdAt + 1, genesisId: spawn.id, previousId: head.id, prevCoordHex: head.coordHex, to: { x: head.position.x + 7n, y: head.position.y, z: head.position.z }, plane: head.plane, ...fakeHopProof('ef') }), sk)
    canonical.inject(other)
    await expect(hop).rejects.toThrow(/moved while the proof was computed.*discarded unsigned/)
    expect(a.keeper.head()!.id).toBe(other.id)
    expect(moves(canonical, a.pubkey).some((e) => e.tags.find((t) => t[0] === 'e' && t[3] === 'previous')?.[1] === other.id)).toBe(false)
  }, 60_000)

  it('canceled by its caller: the thread stops, nothing is signed, the work is charged, and the next hop works', async () => {
    const { a, canonical } = await start()
    const head = a.keeper.head()!.id
    const before = moves(canonical, a.pubkey).length
    const spentBefore = a.budget.state().spentSeconds
    const p = hearing('computing the proof')
    const controller = new AbortController()
    const hop = a.hop({ target: far(a) }, p.progress, controller.signal)
    await p.heard
    await new Promise((r) => setTimeout(r, 200))
    const t0 = performance.now()
    controller.abort()
    const err = await hop.catch((e: unknown) => e)
    expect(performance.now() - t0).toBeLessThan(1500)
    expect(err).toBeInstanceOf(Refusal)
    expect((err as Error).message).toMatch(/stopped while its proof computed .* Nothing was signed/)
    expect(a.keeper.head()!.id).toBe(head)
    expect(moves(canonical, a.pubkey).length).toBe(before)
    expect(a.budget.state().spentSeconds).toBeGreaterThan(spentBefore)
    // The head was released: the next hop goes.
    await a.hop({ target: { dx: 2 } })
    expect(moves(canonical, a.pubkey).length).toBe(before + 1)
  }, 60_000)

  it('canceled by the MCP client: notifications/cancelled reaches the hop, which signs nothing', async () => {
    const { a, canonical } = await start()
    const head = a.keeper.head()!.id
    const before = moves(canonical, a.pubkey).length
    const movesBefore = a.budget.state().moves
    const server = createServer(a)
    const [st, ct] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(ct)
    const controller = new AbortController()
    const call = client.callTool({ name: 'hop', arguments: { target: far(a) } }, undefined, { signal: controller.signal })
    // Wait until the server holds the head for the hop, then a little into the proof, and cancel.
    const deadline = Date.now() + 10_000
    while (!a.keeper.moving && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    expect(a.keeper.moving).toBe(true)
    await new Promise((r) => setTimeout(r, 500))
    controller.abort()
    await expect(call).rejects.toThrow()
    // The server side ends promptly and releases the head; nothing was signed.
    const released = Date.now() + 3000
    while (a.keeper.moving && Date.now() < released) await new Promise((r) => setTimeout(r, 20))
    expect(a.keeper.moving).toBe(false)
    expect(a.keeper.head()!.id).toBe(head)
    expect(moves(canonical, a.pubkey).length).toBe(before)
    // Stopped mid-proof, not finished and then discarded: a finished proof counts a move.
    expect(a.budget.state().moves).toBe(movesBefore)
    await client.close()
  }, 60_000)

  it('stopping the server stops a proof in flight, and the hop is refused unsigned', async () => {
    const { a, canonical } = await start()
    const before = moves(canonical, a.pubkey).length
    const p = hearing('computing the proof')
    const hop = a.hop({ target: far(a) }, p.progress)
    await p.heard
    await new Promise((r) => setTimeout(r, 200))
    const t0 = performance.now()
    await a.stop()
    await expect(hop).rejects.toThrow(/stopped while its proof computed/)
    expect(performance.now() - t0).toBeLessThan(5000)
    expect(moves(canonical, a.pubkey).length).toBe(before)
  }, 60_000)
})
